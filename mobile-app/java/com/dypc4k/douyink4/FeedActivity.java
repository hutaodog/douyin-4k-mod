package com.dypc4k.douyink4;

import android.app.Activity;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.os.Build;
import android.os.Bundle;
import android.util.Log;
import android.util.TypedValue;
import android.view.GestureDetector;
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.SurfaceHolder;
import android.view.SurfaceView;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.view.WindowManager;
import android.widget.FrameLayout;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;

/**
 * 原生推荐流（替代网页版推荐页）。
 *
 * 为什么自己画：网页版推荐流在 WebView 里播放器起不来（video 恒 0×0），
 * 而接口（aweme/related）和原生播放器都已经验证可用，所以直接自己做：
 *   数据 dy4kApi.related() → 原生 MediaPlayer + HttpMediaSource（带 Referer）播放最高档 mp4
 *   交互 上下滑切视频 / 单击显隐信息 / 点评论拉起底部抽屉 / 左右滑不动
 *
 * 入口：MainActivity 的 JS 桥 openFeed(seedAwemeId)（底部「推荐」按钮）。
 */
public class FeedActivity extends Activity implements SurfaceHolder.Callback {

    private static final String TAG = "dy4k";
    public static final String EXTRA_SEED = "seed";

    private static final int BG = 0xFF000000;
    private static final int TEXT = 0xFFF2F2F5;
    private static final int SUB = 0xFFB9B9C0;
    private static final int ACCENT = 0xFFFE2C55;

    private FrameLayout root;
    private SurfaceView surface;
    private MediaPlayerHolder player;   // 轻量包装，见文件末尾

    private LinearLayout overlay;       // 底部作者/文案
    private LinearLayout rail;          // 右侧互动
    private ImageView avatarIv;
    private TextView nameTv, descTv, likeTv, cmtTv, shareTv, backTv, hintTv;

    private FrameLayout sheet;
    private LinearLayout sheetBody;
    private boolean sheetOpen = false;

    private final List<JSONObject> items = new ArrayList<>();
    private int index = -1;
    private String seed = "";
    private boolean loading = false;
    private int retries = 0;

    // ---------------- 生命周期 ----------------

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        seed = getIntent().getStringExtra(EXTRA_SEED);
        if (seed == null) seed = "";
        setupWindow();
        buildUi();
        applyInsets();
        Log.i(TAG, "FeedActivity seed=" + seed);
        loadFeed(seed, true);
    }

    @SuppressWarnings("deprecation")
    private void setupWindow() {
        try {
            Window w = getWindow();
            w.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            if (Build.VERSION.SDK_INT >= 21) {
                w.addFlags(WindowManager.LayoutParams.FLAG_DRAWS_SYSTEM_BAR_BACKGROUNDS);
                w.setStatusBarColor(Color.TRANSPARENT);      // 状态栏透明，视频铺到状态栏下面
                w.setNavigationBarColor(Color.BLACK);
            }
            if (Build.VERSION.SDK_INT >= 30) {
                // false = 内容延伸到状态栏下面（手机版的观感）；隐藏导航栏
                w.setDecorFitsSystemWindows(false);
                WindowInsetsController c = w.getInsetsController();
                if (c != null) {
                    c.show(WindowInsets.Type.statusBars());
                    c.hide(WindowInsets.Type.navigationBars());
                    c.setSystemBarsBehavior(WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
                }
            } else if (Build.VERSION.SDK_INT >= 21) {
                w.getDecorView().setSystemUiVisibility(
                        View.SYSTEM_UI_FLAG_LAYOUT_STABLE | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN);
            }
        } catch (Throwable t) {
            Log.w(TAG, "feed window: " + t);
        }
    }

    /** 视频铺满（含状态栏区域），只把"按钮层"往下让出状态栏高度 */
    private void applyInsets() {
        try {
            root.setOnApplyWindowInsetsListener((v, insets) -> {
                int top;
                if (Build.VERSION.SDK_INT >= 30) {
                    android.graphics.Insets sb = insets.getInsets(WindowInsets.Type.statusBars());
                    top = sb.top;
                } else {
                    int id = getResources().getIdentifier("status_bar_height", "dimen", "android");
                    top = id > 0 ? getResources().getDimensionPixelSize(id) : dp(28);
                }
                if (backTv != null) {
                    FrameLayout.LayoutParams lp = (FrameLayout.LayoutParams) backTv.getLayoutParams();
                    int want = top + dp(4);
                    if (lp.topMargin != want) {
                        lp.topMargin = want;
                        backTv.setLayoutParams(lp);
                    }
                }
                return insets;
            });
            root.requestApplyInsets();
        } catch (Throwable t) {
            Log.w(TAG, "insets: " + t);
        }
    }

    private int dp(float v) { return Math.round(v * getResources().getDisplayMetrics().density); }

    @Override
    protected void onDestroy() {
        if (player != null) player.release();
        super.onDestroy();
    }

    @Override
    protected void onPause() {
        super.onPause();
        if (player != null) player.pause();
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (player != null) player.resume();
    }

    // ---------------- 界面 ----------------

    private void buildUi() {
        root = new FrameLayout(this);
        root.setBackgroundColor(BG);
        setContentView(root);

        surface = new SurfaceView(this);
        surface.getHolder().addCallback(this);
        root.addView(surface, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        // 顶部返回 + 提示
        backTv = new TextView(this);
        backTv.setText("‹");
        backTv.setTextColor(0xCCFFFFFF);
        backTv.setTextSize(TypedValue.COMPLEX_UNIT_SP, 30);
        backTv.setPadding(dp(12), dp(2), dp(12), dp(6));
        backTv.setOnClickListener(v -> finish());
        FrameLayout.LayoutParams blp = new FrameLayout.LayoutParams(dp(48), dp(46), Gravity.TOP | Gravity.START);
        blp.topMargin = dp(6);
        root.addView(backTv, blp);

        hintTv = new TextView(this);
        hintTv.setTextColor(0xCCFFFFFF);
        hintTv.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12);
        hintTv.setText("加载中…");
        hintTv.setGravity(Gravity.CENTER);
        root.addView(hintTv, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.CENTER));

        // 底部：作者 + 文案 + 数据
        overlay = new LinearLayout(this);
        overlay.setOrientation(LinearLayout.VERTICAL);
        overlay.setPadding(dp(14), dp(40), dp(86), dp(14));
        GradientDrawable shade = new GradientDrawable(GradientDrawable.Orientation.TOP_BOTTOM,
                new int[]{0x00000000, 0x99000000, 0xE6000000});
        overlay.setBackground(shade);

        LinearLayout authorRow = new LinearLayout(this);
        authorRow.setOrientation(LinearLayout.HORIZONTAL);
        authorRow.setGravity(Gravity.CENTER_VERTICAL);
        avatarIv = new ImageView(this);
        GradientDrawable ring = new GradientDrawable();
        ring.setShape(GradientDrawable.OVAL);
        ring.setColor(0xFF26262B);
        avatarIv.setBackground(ring);
        avatarIv.setClipToOutline(true);
        authorRow.addView(avatarIv, new LinearLayout.LayoutParams(dp(34), dp(34)));
        nameTv = new TextView(this);
        nameTv.setTextColor(TEXT);
        nameTv.setTextSize(TypedValue.COMPLEX_UNIT_SP, 14);
        nameTv.setTypeface(Typeface.DEFAULT_BOLD);
        nameTv.setPadding(dp(8), 0, 0, 0);
        authorRow.addView(nameTv);
        overlay.addView(authorRow);

        descTv = new TextView(this);
        descTv.setTextColor(0xFFEDEDF2);
        descTv.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13);
        descTv.setLineSpacing(dp(2), 1f);
        descTv.setPadding(0, dp(7), 0, 0);
        descTv.setMaxLines(4);
        overlay.addView(descTv);

        LinearLayout stats = new LinearLayout(this);
        stats.setOrientation(LinearLayout.HORIZONTAL);
        stats.setPadding(0, dp(8), 0, 0);
        likeTv = statChip(stats, "♥", "0", v -> toast("点赞请在网页里操作"));
        cmtTv = statChip(stats, "💬", "0", v -> openSheet());
        shareTv = statChip(stats, "↗", "0", v -> toast("分享请在网页里操作"));
        overlay.addView(stats);

        FrameLayout.LayoutParams olp = new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT,
                Gravity.BOTTOM | Gravity.START);
        root.addView(overlay, olp);

        // 右侧竖排
        rail = new LinearLayout(this);
        rail.setOrientation(LinearLayout.VERTICAL);
        rail.setGravity(Gravity.CENTER_HORIZONTAL);
        rail.setPadding(0, 0, 0, dp(24));
        addRailItem(rail, "♥", "0", () -> toast("点赞请在网页里操作"));
        addRailItem(rail, "💬", "0", this::openSheet);
        addRailItem(rail, "↗", "0", () -> toast("分享请在网页里操作"));
        FrameLayout.LayoutParams rlp = new FrameLayout.LayoutParams(
                dp(64), ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.END | Gravity.BOTTOM);
        rlp.rightMargin = dp(6);
        rlp.bottomMargin = dp(24);
        root.addView(rail, rlp);

        buildSheet();

        // 手势：上滑下一条、下滑上一条、单击显隐信息
        final GestureDetector gd = new GestureDetector(this, new GestureDetector.SimpleOnGestureListener() {
            @Override
            public boolean onDown(MotionEvent e) {
                return true;                 // 必须吃掉 down，后面的 fling 才会派发
            }

            @Override
            public boolean onFling(MotionEvent e1, MotionEvent e2, float vx, float vy) {
                if (e1 == null || e2 == null) return false;
                float dy = e1.getY() - e2.getY();
                if (Math.abs(dy) < dp(60)) return false;
                if (dy > 0) playNext(); else playPrev();
                return true;
            }

            @Override
            public boolean onSingleTapConfirmed(MotionEvent e) {
                toggleOverlay();
                return true;
            }
        });
        // 手势挂在视频层上：浮层/右侧按钮要能收到自己的点击，不能被根容器吃掉
        surface.setOnTouchListener((v, ev) -> {
            gd.onTouchEvent(ev);
            return true;
        });
    }

    private TextView statChip(LinearLayout parent, String icon, String val, View.OnClickListener cb) {
        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.HORIZONTAL);
        box.setGravity(Gravity.CENTER_VERTICAL);
        box.setPadding(0, 0, dp(16), 0);
        TextView i = new TextView(this);
        i.setText(icon);
        i.setTextSize(TypedValue.COMPLEX_UNIT_SP, 14);
        i.setTextColor(0xFFFFFFFF);
        TextView t = new TextView(this);
        t.setText(" " + val);
        t.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12);
        t.setTextColor(0xFFEDEDF2);
        box.addView(i);
        box.addView(t);
        if (cb != null) box.setOnClickListener(cb);
        parent.addView(box);
        return t;
    }

    private void addRailItem(LinearLayout parent, String icon, String val, Runnable cb) {
        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setGravity(Gravity.CENTER_HORIZONTAL);
        box.setPadding(0, dp(10), 0, dp(10));
        TextView i = new TextView(this);
        i.setText(icon);
        i.setTextSize(TypedValue.COMPLEX_UNIT_SP, 24);
        i.setTextColor(0xFFFFFFFF);
        TextView t = new TextView(this);
        t.setText(val);
        t.setTextSize(TypedValue.COMPLEX_UNIT_SP, 11);
        t.setTextColor(0xFFEDEDF2);
        box.addView(i);
        box.addView(t);
        box.setTag(t);
        box.setOnClickListener(v -> { if (cb != null) cb.run(); });
        parent.addView(box);
    }

    private void toggleOverlay() {
        boolean vis = overlay.getVisibility() == View.VISIBLE;
        overlay.setVisibility(vis ? View.GONE : View.VISIBLE);
        rail.setVisibility(vis ? View.GONE : View.VISIBLE);
        backTv.setVisibility(vis ? View.GONE : View.VISIBLE);
    }

    // ---------------- 评论抽屉 ----------------

    private void buildSheet() {
        FrameLayout mask = new FrameLayout(this);
        mask.setBackgroundColor(0x88000000);
        mask.setVisibility(View.GONE);
        mask.setOnClickListener(v -> closeSheet());
        root.addView(mask, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        mask.setTag("mask");

        sheet = new FrameLayout(this);
        GradientDrawable bg = new GradientDrawable();
        bg.setColor(0xFF161618);
        bg.setCornerRadii(new float[]{dp(16), dp(16), dp(16), dp(16), 0, 0, 0, 0});
        sheet.setBackground(bg);
        sheet.setVisibility(View.GONE);

        LinearLayout col = new LinearLayout(this);
        col.setOrientation(LinearLayout.VERTICAL);

        TextView head = new TextView(this);
        head.setText("评论");
        head.setTextColor(0xFFE9E9EE);
        head.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13);
        head.setGravity(Gravity.CENTER);
        head.setPadding(0, dp(10), 0, dp(10));
        head.setOnClickListener(v -> closeSheet());
        col.addView(head);

        ScrollView sv = new ScrollView(this);
        sheetBody = new LinearLayout(this);
        sheetBody.setOrientation(LinearLayout.VERTICAL);
        sheetBody.setPadding(dp(14), 0, dp(14), dp(16));
        sv.addView(sheetBody);
        col.addView(sv, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f));

        sheet.addView(col, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        root.addView(sheet, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, 0, Gravity.BOTTOM));
    }

    private void openSheet() {
        if (index < 0 || index >= items.size()) return;
        final String id = items.get(index).optString("aweme_id", "");
        sheetBody.removeAllViews();
        TextView loading = new TextView(this);
        loading.setText("加载评论…");
        loading.setTextColor(SUB);
        loading.setPadding(0, dp(20), 0, dp(20));
        sheetBody.addView(loading);

        View mask = root.findViewWithTag("mask");
        sheet.setVisibility(View.VISIBLE);
        if (mask != null) mask.setVisibility(View.VISIBLE);
        sheetOpen = true;
        FrameLayout.LayoutParams lp = (FrameLayout.LayoutParams) sheet.getLayoutParams();
        lp.height = (int) (getResources().getDisplayMetrics().heightPixels * 0.62);
        sheet.setLayoutParams(lp);

        WebData.requestComments(id, 0, json -> runOnUiThread(() -> renderComments(json)));
    }

    private void renderComments(String json) {
        if (!sheetOpen) return;
        sheetBody.removeAllViews();
        List<JSONObject> list = new ArrayList<>();
        try {
            JSONObject j = new JSONObject(json == null ? "{}" : json);
            JSONArray arr = j.optJSONArray("comments");
            if (arr != null) for (int i = 0; i < arr.length(); i++) {
                JSONObject c = arr.optJSONObject(i);
                if (c != null) list.add(c);
            }
        } catch (Throwable t) {
            Log.w(TAG, "comments parse: " + t);
        }
        if (list.isEmpty()) {
            TextView tv = new TextView(this);
            tv.setText("没拿到评论（可能需要登录）");
            tv.setTextColor(SUB);
            tv.setPadding(0, dp(20), 0, dp(20));
            sheetBody.addView(tv);
            return;
        }
        for (JSONObject c : list) {
            LinearLayout row = new LinearLayout(this);
            row.setOrientation(LinearLayout.HORIZONTAL);
            row.setPadding(0, dp(9), 0, dp(9));

            JSONObject user = c.optJSONObject("user");
            ImageView av = new ImageView(this);
            GradientDrawable ring = new GradientDrawable();
            ring.setShape(GradientDrawable.OVAL);
            ring.setColor(0xFF26262B);
            av.setBackground(ring);
            av.setClipToOutline(true);
            String au = user == null ? "" : firstUrl(user.optJSONObject("avatar_thumb"));
            ImgLoader.load(av, au, dp(34), dp(34));
            row.addView(av, new LinearLayout.LayoutParams(dp(34), dp(34)));

            LinearLayout box = new LinearLayout(this);
            box.setOrientation(LinearLayout.VERTICAL);
            box.setPadding(dp(9), 0, 0, 0);
            TextView nick = new TextView(this);
            nick.setText(user == null ? "" : user.optString("nickname", ""));
            nick.setTextColor(0xFF9A9AA2);
            nick.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12);
            TextView text = new TextView(this);
            text.setText(c.optString("text", ""));
            text.setTextColor(0xFFE9E9EE);
            text.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13);
            box.addView(nick);
            box.addView(text);
            row.addView(box, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));

            TextView digg = new TextView(this);
            digg.setText("♥ " + c.optLong("digg_count"));
            digg.setTextColor(0xFF8B8B93);
            digg.setTextSize(TypedValue.COMPLEX_UNIT_SP, 11);
            row.addView(digg);

            sheetBody.addView(row);
        }
    }

    private void closeSheet() {
        sheetOpen = false;
        sheet.setVisibility(View.GONE);
        View mask = root.findViewWithTag("mask");
        if (mask != null) mask.setVisibility(View.GONE);
    }

    // ---------------- 数据 ----------------

    private void loadFeed(String seedId, boolean reset) {
        if (loading) return;
        loading = true;
        if (reset) {
            items.clear();
            index = -1;
        }
        hintTv.setText("加载中…");
        hintTv.setVisibility(View.VISIBLE);
        WebData.requestRelated(seedId, json -> runOnUiThread(() -> {
            loading = false;
            List<JSONObject> got = new ArrayList<>();
            try {
                JSONObject j = new JSONObject(json == null ? "{}" : json);
                JSONArray arr = j.optJSONArray("aweme_list");
                if (arr != null) for (int i = 0; i < arr.length(); i++) {
                    JSONObject a = arr.optJSONObject(i);
                    if (a != null && a.optJSONObject("video") != null) got.add(a);
                }
            } catch (Throwable t) {
                Log.w(TAG, "feed parse: " + t);
            }
            Log.i(TAG, "feed items=" + got.size() + " from=" + seedId);
            if (got.isEmpty()) {
                // WebView 还没就绪/接口失败：短间隔重试（WebData 里也有超时兜底，不会永久卡住）
                if (retries < 12) {
                    retries++;
                    hintTv.setText("加载中…");
                    new android.os.Handler(android.os.Looper.getMainLooper())
                            .postDelayed(() -> loadFeed(seedId, reset), 600);
                    return;
                }
                hintTv.setText("没拿到推荐数据：先回网页随便看一条视频，再点「推荐」");
                return;
            }
            retries = 0;
            items.addAll(got);
            hintTv.setVisibility(View.GONE);
            playIndex(reset ? 0 : Math.max(0, index));
        }));
    }

    private void playNext() {
        if (items.isEmpty()) return;
        if (index + 1 >= items.size()) { loadFeed(items.get(items.size() - 1).optString("aweme_id", ""), false); return; }
        playIndex(index + 1);
    }

    private void playPrev() {
        if (items.isEmpty()) return;
        playIndex(Math.max(0, index - 1));
    }

    private void playIndex(int i) {
        if (i < 0 || i >= items.size()) return;
        index = i;
        JSONObject a = items.get(i);
        bindOverlay(a);
        // related 列表里的直链是网页签名的，原生播不了；先取一次 detail，用它的码流（已验证可播）
        final String id = a.optString("aweme_id", "");
        JSONObject cached = detailCache.get(id);
        if (cached != null) {
            startPlay(cached);
            prefetchNext();
            return;
        }
        hintTv.setText("加载视频…");
        hintTv.setVisibility(View.VISIBLE);
        WebData.requestDetail(id, json -> runOnUiThread(() -> {
            if (index < 0 || index >= items.size()) return;
            String wantId = items.get(index).optString("aweme_id", "");
            if (!wantId.equals(id)) return;          // 已经切到别的视频了
            JSONObject aw = null;
            try {
                JSONObject j = new JSONObject(json == null ? "{}" : json);
                aw = j.optJSONObject("aweme_detail");
            } catch (Throwable ignore) {}
            if (aw != null) detailCache.put(id, aw);
            startPlay(aw != null ? aw : items.get(index));
            prefetchNext();
        }));
    }

    private final java.util.HashMap<String, JSONObject> detailCache = new java.util.HashMap<>();

    /** 后台把下一条的 detail（含可播码流）先取回来，滑动切视频就不卡了 */
    private void prefetchNext() {
        int n = index + 1;
        if (n < 0 || n >= items.size()) return;
        final String nid = items.get(n).optString("aweme_id", "");
        if (nid.length() < 8 || detailCache.containsKey(nid)) return;
        detailCache.put(nid, null);              // 占位，避免重复请求
        WebData.requestDetail(nid, json -> runOnUiThread(() -> {
            try {
                JSONObject j = new JSONObject(json == null ? "{}" : json);
                JSONObject aw = j.optJSONObject("aweme_detail");
                if (aw != null) detailCache.put(nid, aw);
                else detailCache.remove(nid);
            } catch (Throwable t) {
                detailCache.remove(nid);
            }
        }));
    }

    private void bindOverlay(JSONObject a) {
        try {
            JSONObject user = a.optJSONObject("author");
            String nick = user == null ? "" : user.optString("nickname", "");
            nameTv.setText("@" + nick);
            String au = user == null ? "" : firstUrl(user.optJSONObject("avatar_thumb"));
            ImgLoader.load(avatarIv, au, dp(34), dp(34));
            descTv.setText(a.optString("desc", "").replaceAll("\\s+", " "));
            JSONObject st = a.optJSONObject("statistics");
            long digg = st == null ? 0 : st.optLong("digg_count");
            long cmt = st == null ? 0 : st.optLong("comment_count");
            long shr = st == null ? 0 : st.optLong("share_count");
            likeTv.setText(" " + fmt(digg));
            cmtTv.setText(" " + fmt(cmt));
            shareTv.setText(" " + fmt(shr));
            updateRail(digg, cmt, shr);
        } catch (Throwable t) {
            Log.w(TAG, "bindOverlay: " + t);
        }
    }

    private void updateRail(long digg, long cmt, long shr) {
        try {
            if (rail.getChildCount() < 3) return;
            ((TextView) ((LinearLayout) rail.getChildAt(0)).getTag()).setText(fmt(digg));
            ((TextView) ((LinearLayout) rail.getChildAt(1)).getTag()).setText(fmt(cmt));
            ((TextView) ((LinearLayout) rail.getChildAt(2)).getTag()).setText(fmt(shr));
        } catch (Throwable ignore) {}
    }

    // ---------------- 播放 ----------------

    private JSONObject pendingAweme;

    private void startPlay(JSONObject aweme) {
        pendingAweme = aweme;
        if (surface == null || surface.getHolder().getSurface() == null || !surface.getHolder().getSurface().isValid()) {
            return;  // 等 surfaceCreated
        }
        String url = bestMp4Url(aweme);
        Log.i(TAG, "feed url len=" + url.length() + " head=" + (url.length() > 90 ? url.substring(0, 90) : url));
        if (url.length() < 10) {
            toast("这条没有可直连的 mp4 流，跳下一条");
            playNext();
            return;
        }
        if (player == null) player = new MediaPlayerHolder();
        player.play(url, () -> hintTv.setVisibility(View.GONE), msg -> {
            Log.w(TAG, "feed play error: " + msg);
            toast("播放失败：" + msg);
        });
    }

    /** 从 bit_rate 里挑最高档的可直连 mp4 */
    private static String bestMp4Url(JSONObject aweme) {
        try {
            JSONObject video = aweme.optJSONObject("video");
            if (video == null) return "";
            JSONArray br = video.optJSONArray("bit_rate");
            String bestUrl = "";
            int bestH = -1;
            long bestBr = -1;
            if (br != null) {
                for (int i = 0; i < br.length(); i++) {
                    JSONObject b = br.optJSONObject(i);
                    if (b == null) continue;
                    if (!"mp4".equals(String.valueOf(b.optString("format")))) continue;
                    JSONObject pa = b.optJSONObject("play_addr");
                    if (pa == null) continue;
                    JSONArray urls = pa.optJSONArray("url_list");
                    if (urls == null || urls.length() == 0) continue;
                    int h = pa.optInt("height");
                    long bit = b.optLong("bit_rate");
                    if (h > bestH || (h == bestH && bit > bestBr)) {
                        bestH = h;
                        bestBr = bit;
                        bestUrl = urls.optString(0, "");
                    }
                }
            }
            if (bestUrl.length() == 0) {
                JSONObject pa = video.optJSONObject("play_addr");
                if (pa != null) {
                    JSONArray urls = pa.optJSONArray("url_list");
                    if (urls != null && urls.length() > 0) bestUrl = urls.optString(0, "");
                }
            }
            return bestUrl;
        } catch (Throwable t) {
            return "";
        }
    }

    @Override
    public void surfaceCreated(SurfaceHolder holder) {
        if (pendingAweme != null) {
            JSONObject a = pendingAweme;
            pendingAweme = null;
            startPlay(a);
        }
    }

    @Override
    public void surfaceChanged(SurfaceHolder holder, int format, int width, int height) {}

    @Override
    public void surfaceDestroyed(SurfaceHolder holder) {}

    // ---------------- 工具 ----------------

    private static String firstUrl(JSONObject obj) {
        if (obj == null) return "";
        JSONArray arr = obj.optJSONArray("url_list");
        if (arr == null || arr.length() == 0) return "";
        return arr.optString(0, "");
    }

    private static String fmt(long n) {
        if (n >= 100000000L) return trim(n / 100000000.0) + "亿";
        if (n >= 10000L) return trim(n / 10000.0) + "万";
        return String.valueOf(n);
    }

    private static String trim(double v) {
        String s = String.format("%.1f", v);
        return s.endsWith(".0") ? s.substring(0, s.length() - 2) : s;
    }

    private void toast(String m) {
        try { Toast.makeText(this, m, Toast.LENGTH_SHORT).show(); } catch (Throwable ignore) {}
    }

    @Override
    public void onBackPressed() {
        if (sheetOpen) { closeSheet(); return; }
        super.onBackPressed();
    }

    // =================== MediaPlayer 包装 ===================

    private class MediaPlayerHolder {
        private android.media.MediaPlayer mp;
        private HttpMediaSource src;
        private boolean prepared;

        void play(String url, Runnable onPrepared, java.util.function.Consumer<String> onError) {            release();
            try {
                mp = new android.media.MediaPlayer();
                if (Build.VERSION.SDK_INT >= 23) {
                    Log.i(TAG, "feed datasource: HttpMediaSource");
                    src = new HttpMediaSource(url, "https://www.douyin.com/",
                            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36");
                    mp.setDataSource(src);
                } else {
                    mp.setDataSource(url);
                }
                mp.setDisplay(surface.getHolder());
                mp.setScreenOnWhilePlaying(true);
                mp.setOnPreparedListener(m -> {
                    prepared = true;
                    m.setLooping(true);          // 和手机版一致：单条循环，不会播完黑屏
                    m.start();
                    Log.i(TAG, "feed prepared " + m.getVideoWidth() + "x" + m.getVideoHeight() + " dur=" + m.getDuration());
                    if (onPrepared != null) onPrepared.run();
                });
                mp.setOnErrorListener((m, what, extra) -> {
                    if (onError != null) onError.accept("what=" + what + " extra=" + extra);
                    return true;
                });
                mp.prepareAsync();
            } catch (Throwable t) {
                if (onError != null) onError.accept(String.valueOf(t));
            }
        }

        void pause() {
            try { if (prepared && mp != null && mp.isPlaying()) mp.pause(); } catch (Throwable ignore) {}
        }

        void resume() {
            try { if (prepared && mp != null && !mp.isPlaying()) mp.start(); } catch (Throwable ignore) {}
        }

        void release() {
            try {
                if (mp != null) { mp.reset(); mp.release(); }
            } catch (Throwable ignore) {}
            mp = null;
            try { if (src != null) src.close(); } catch (Throwable ignore) {}
            src = null;
            prepared = false;
        }
    }
}
