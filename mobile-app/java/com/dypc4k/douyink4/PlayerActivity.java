package com.dypc4k.douyink4;

import android.app.Activity;
import android.graphics.Color;
import android.media.MediaPlayer;
import android.os.Build;
import android.os.Bundle;
import android.util.Log;
import android.view.Gravity;
import android.view.KeyEvent;
import android.view.MotionEvent;
import android.view.SurfaceHolder;
import android.view.SurfaceView;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.view.WindowManager;
import android.widget.FrameLayout;
import android.widget.MediaController;
import android.widget.TextView;
import android.widget.Toast;

/**
 * 原生 4K 播放器。
 *
 * 为什么要它：4K 码流只有 HEVC，而系统 WebView（本机 104）没有把 HEVC 暴露给网页层，
 * 网页播放器最多只能到 1080P H.264。平台本身有 HEVC 硬解（OMX.qcom.video.decoder.hevc hw=true），
 * 所以这里直接用 MediaPlayer（走 MediaCodec 硬解）播放 4K 直链。
 *
 * 入口：App 内注入脚本点「原生 4K」按钮 → JS 调 dy4kNative.play4k(...) → 本 Activity；
 * 也可以单独拉起做实验：
 *   adb shell am start -n com.dypc4k.douyink4/.PlayerActivity --es url "<4K mp4 直链>"
 */
public class PlayerActivity extends Activity implements SurfaceHolder.Callback {

    private static final String TAG = "dy4k";
    private static final String UA_DESKTOP =
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) " +
            "Chrome/131.0.0.0 Safari/537.36";

    private SurfaceView surfaceView;
    private TextView hud;
    private FrameLayout root;
    private MediaPlayer player;
    private MediaController controller;
    private com.dypc4k.douyink4.HttpMediaSource mediaSource;
    private boolean refererAware = true;   // 用 HttpMediaSource（带 Referer）拉流
    private String codecMime;              // 视频轨编码（video/hevc 之类）
    private boolean scaleCover = false;    // false=完整显示（等比），true=铺满裁切
    private android.os.Handler hudHandler;

    private String url;
    private String title;
    private int expectW, expectH;
    private boolean prepared;
    private int videoW, videoH;
    private long startedAt;
    private boolean firstFrameLogged;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        enterImmersive();

        url = getIntent().getStringExtra("url");
        title = getIntent().getStringExtra("title");
        expectW = getIntent().getIntExtra("w", 0);
        expectH = getIntent().getIntExtra("h", 0);
        Log.i(TAG, "PlayerActivity url=" + (url == null ? "null" : url.substring(0, Math.min(120, url.length())))
                + " expect=" + expectW + "x" + expectH);
        if (url == null || url.length() < 10) {
            Toast.makeText(this, "没有播放地址", Toast.LENGTH_LONG).show();
            finish();
            return;
        }

        root = new FrameLayout(this);
        root.setBackgroundColor(Color.BLACK);
        setContentView(root, new ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        surfaceView = new SurfaceView(this);
        surfaceView.getHolder().addCallback(this);
        root.addView(surfaceView, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        hud = new TextView(this);
        hud.setTextColor(0xFF7EE787);
        hud.setTextSize(11f);
        hud.setShadowLayer(3f, 0f, 1f, Color.BLACK);
        hud.setPadding(dp(8), dp(6), dp(8), dp(6));
        FrameLayout.LayoutParams lp = new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        lp.gravity = Gravity.TOP | Gravity.START;
        lp.topMargin = dp(24);
        lp.leftMargin = dp(8);
        root.addView(hud, lp);
        hud.setText("正在起播…\n" + (title == null ? "" : title));

        // 单击 = 控制条，双击 = 完整/铺满
        final android.view.GestureDetector gd = new android.view.GestureDetector(this,
                new android.view.GestureDetector.SimpleOnGestureListener() {
                    @Override
                    public boolean onSingleTapConfirmed(MotionEvent e) {
                        toggleController();
                        return true;
                    }

                    @Override
                    public boolean onDoubleTap(MotionEvent e) {
                        scaleCover = !scaleCover;
                        applyAspect();
                        updateHud(prepared ? "playing" : "…");
                        return true;
                    }
                });
        root.setOnTouchListener((v, ev) -> {
            gd.onTouchEvent(ev);
            return true;
        });

        hudHandler = new android.os.Handler(android.os.Looper.getMainLooper());
        hudHandler.postDelayed(new Runnable() {
            @Override
            public void run() {
                try {
                    if (player != null && prepared) updateHud(player.isPlaying() ? "playing" : "paused");
                } catch (Throwable ignore) {}
                if (hudHandler != null) hudHandler.postDelayed(this, 1000);
            }
        }, 1000);
    }

    private int dp(float v) {
        return Math.round(v * getResources().getDisplayMetrics().density);
    }

    private void toggleController() {
        if (controller == null) return;
        if (controller.isShowing()) controller.hide();
        else controller.show();
    }

    // ---------------- Surface ----------------

    @Override
    public void surfaceCreated(SurfaceHolder holder) {
        startPlayback(holder);
    }

    @Override
    public void surfaceChanged(SurfaceHolder holder, int format, int width, int height) {
    }

    @Override
    public void surfaceDestroyed(SurfaceHolder holder) {
        release();
    }

    private void startPlayback(SurfaceHolder holder) {
        release();
        try {
            player = new MediaPlayer();
            // CDN 对 4K 直链要求 Referer，MediaPlayer 加不了头 -> 用自带的 HttpMediaSource 走 Range 拉流
            if (Build.VERSION.SDK_INT >= 23 && refererAware) {
                mediaSource = new HttpMediaSource(url, "https://www.douyin.com/", UA_DESKTOP);
                player.setDataSource(mediaSource);
                Log.i(TAG, "data source: HttpMediaSource (referer-aware)");
            } else {
                player.setDataSource(url);
                Log.i(TAG, "data source: plain url");
            }
            player.setDisplay(holder);
            player.setScreenOnWhilePlaying(true);
            player.setOnPreparedListener(mp -> {
                prepared = true;
                startedAt = System.currentTimeMillis();
                mp.start();
                int vw = mp.getVideoWidth(), vh = mp.getVideoHeight();
                videoW = vw;
                videoH = vh;
                Log.i(TAG, "prepared duration=" + mp.getDuration() + "ms size=" + vw + "x" + vh);
                logTrackInfo(mp);
                applyAspect();
                updateHud("playing");
            });
            player.setOnVideoSizeChangedListener((mp, w, h) -> {
                videoW = w;
                videoH = h;
                Log.i(TAG, "video size -> " + w + "x" + h);
                applyAspect();
                updateHud("playing");
            });
            player.setOnInfoListener((mp, what, extra) -> {
                Log.i(TAG, "info what=" + what + " extra=" + extra);
                if (what == MediaPlayer.MEDIA_INFO_VIDEO_RENDERING_START && !firstFrameLogged) {
                    firstFrameLogged = true;
                    Log.i(TAG, "FIRST FRAME after " + (System.currentTimeMillis() - startedAt) + "ms");
                    updateHud("playing");
                }
                return false;
            });
            player.setOnErrorListener((mp, what, extra) -> {
                Log.e(TAG, "media error what=" + what + " extra=" + extra + " url=" + url.substring(0, Math.min(60, url.length())));
                runOnUiThread(() -> {
                    Toast.makeText(PlayerActivity.this, "解码失败 what=" + what + " extra=" + extra, Toast.LENGTH_LONG).show();
                    updateHud("ERROR what=" + what + " extra=" + extra);
                });
                return true;
            });
            player.setOnCompletionListener(mp -> updateHud("ended"));
            player.prepareAsync();

            controller = new MediaController(this);
            controller.setMediaPlayer(new MediaController.MediaPlayerControl() {
                public void start() { try { player.start(); } catch (Throwable ignore) {} }
                public void pause() { try { player.pause(); } catch (Throwable ignore) {} }
                public int getDuration() { try { return prepared ? player.getDuration() : 0; } catch (Throwable t) { return 0; } }
                public int getCurrentPosition() { try { return prepared ? player.getCurrentPosition() : 0; } catch (Throwable t) { return 0; } }
                public void seekTo(int pos) { try { if (prepared) player.seekTo(pos); } catch (Throwable ignore) {} }
                public boolean isPlaying() { try { return prepared && player.isPlaying(); } catch (Throwable t) { return false; } }
                public int getBufferPercentage() { return 100; }
                public boolean canPause() { return true; }
                public boolean canSeekBackward() { return true; }
                public boolean canSeekForward() { return true; }
                public int getAudioSessionId() { try { return player.getAudioSessionId(); } catch (Throwable t) { return 0; } }
            });
            controller.setAnchorView(surfaceView);
            controller.setKeepScreenOn(true);
        } catch (Throwable t) {
            Log.e(TAG, "startPlayback failed: " + t);
            Toast.makeText(this, "起播失败：" + t, Toast.LENGTH_LONG).show();
        }
    }

    private void updateHud(String state) {
        if (hud == null) return;
        StringBuilder sb = new StringBuilder();
        sb.append(videoW > 0 ? videoW + "x" + videoH : (expectW > 0 ? expectW + "x" + expectH + " (期望)" : "?"))
          .append("  ").append(state);
        if (codecMime != null) sb.append("  ").append(codecMime);
        try {
            if (prepared) {
                int ms = player.getDuration();
                sb.append("\n时长 ").append(ms / 1000).append("s");
                sb.append("  位置 ").append(player.getCurrentPosition() / 1000).append("s");
                sb.append("  ").append(scaleCover ? "铺满" : "完整");
                if (videoW > 0 && videoH > 0 && Math.max(videoW, videoH) >= 2160) sb.append("  ★4K");
            }
        } catch (Throwable ignore) {}
        hud.setText(sb.toString());
    }

    /** 按视频宽高比摆放 SurfaceView，避免被拉变形（双指双击切换 完整/铺满） */
    private void applyAspect() {
        if (surfaceView == null || videoW <= 0 || videoH <= 0) return;
        int pw = root.getWidth(), ph = root.getHeight();
        if (pw <= 0 || ph <= 0) return;
        float videoAspect = (float) videoW / (float) videoH;
        float parentAspect = (float) pw / (float) ph;
        int nw, nh;
        boolean cover = scaleCover;
        boolean widerThanParent = videoAspect > parentAspect;
        if (cover == widerThanParent) {
            // 铺满：宽高都按更大的那个维度撑满（会裁掉一部分）
            nh = ph;
            nw = Math.round(ph * videoAspect);
            if (nw < pw) { nw = pw; nh = Math.round(pw / videoAspect); }
        } else {
            // 完整：等比缩放到刚好装下
            nw = pw;
            nh = Math.round(pw / videoAspect);
            if (nh > ph) { nh = ph; nw = Math.round(ph * videoAspect); }
        }
        FrameLayout.LayoutParams lp = new FrameLayout.LayoutParams(nw, nh);
        lp.gravity = Gravity.CENTER;
        surfaceView.setLayoutParams(lp);
        Log.i(TAG, "aspect " + (cover ? "cover" : "fit") + " -> " + nw + "x" + nh + " (video " + videoW + "x" + videoH + ")");
    }

    /** 从 MediaPlayer 的 track info 里把视频编码报出来，用来证明"确实走的 HEVC 硬解" */
    private void logTrackInfo(MediaPlayer mp) {
        try {
            android.media.MediaPlayer.TrackInfo[] infos = mp.getTrackInfo();
            if (infos == null) return;
            for (android.media.MediaPlayer.TrackInfo ti : infos) {
                if (ti == null) continue;
                try {
                    android.media.MediaFormat f = ti.getFormat();
                    if (f == null) continue;
                    String mime = f.getString("mime");
                    if (mime == null || !mime.startsWith("video/")) continue;
                    codecMime = mime;
                    int w = f.containsKey("width") ? f.getInteger("width") : 0;
                    int h = f.containsKey("height") ? f.getInteger("height") : 0;
                    Log.i(TAG, "VIDEO TRACK mime=" + mime + " size=" + w + "x" + h);
                } catch (Throwable ignore) {}
            }
        } catch (Throwable t) {
            Log.w(TAG, "track info failed: " + t);
        }
    }

    private void release() {
        try {
            if (player != null) {
                player.reset();
                player.release();
            }
        } catch (Throwable ignore) {
        } finally {
            player = null;
            prepared = false;
        }
        try {
            if (mediaSource != null) {
                mediaSource.close();
                mediaSource = null;
            }
        } catch (Throwable ignore) {}
    }

    // ---------------- 生命周期 / 按键 ----------------

    @Override
    protected void onPause() {
        super.onPause();
        try { if (prepared && player.isPlaying()) player.pause(); } catch (Throwable ignore) {}
    }

    @Override
    protected void onResume() {
        super.onResume();
        enterImmersive();
    }

    @Override
    protected void onDestroy() {
        hudHandler = null;
        release();
        super.onDestroy();
    }

    @Override
    public boolean onKeyDown(int keyCode, KeyEvent event) {
        if (keyCode == KeyEvent.KEYCODE_BACK) {
            finish();
            return true;
        }
        return super.onKeyDown(keyCode, event);
    }

    @SuppressWarnings("deprecation")
    private void enterImmersive() {
        try {
            if (Build.VERSION.SDK_INT >= 30) {
                getWindow().setDecorFitsSystemWindows(false);
                WindowInsetsController c = getWindow().getInsetsController();
                if (c != null) {
                    c.hide(WindowInsets.Type.statusBars() | WindowInsets.Type.navigationBars());
                    c.setSystemBarsBehavior(WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
                }
            } else {
                getWindow().getDecorView().setSystemUiVisibility(
                        View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                                | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                                | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                                | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                                | View.SYSTEM_UI_FLAG_FULLSCREEN
                                | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY);
            }
        } catch (Throwable t) {
            Log.w(TAG, "immersive failed: " + t);
        }
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) enterImmersive();
    }
}
