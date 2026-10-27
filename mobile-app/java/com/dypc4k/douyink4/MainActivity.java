package com.dypc4k.douyink4;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.net.http.SslError;
import android.os.Build;
import android.os.Bundle;
import android.util.Log;
import android.view.Gravity;
import android.view.KeyEvent;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.view.WindowManager;
import android.webkit.ConsoleMessage;
import android.webkit.CookieManager;
import android.webkit.PermissionRequest;
import android.webkit.SslErrorHandler;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.TextView;
import android.widget.Toast;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * 抖音 4K 手机壳。
 *
 * 设计要点：
 *  1. 固定「桌面版 UA」——抖音的移动版网页是引流页（720P 水印流、无清晰度菜单、不拉 AB 配置）；
 *  2. 在 HTML 里注入 assets/dy4k.js（= mobile-web/douyin-4k.user.js），实现：
 *       MANUAL_SWITCH 心跳补写 4K + AB 改写（has_2k=1 / 关自动降级 / 关自动清晰度）
 *     —— 注入点用 shouldInterceptRequest 拿主文档再塞 <script>，保证在页面自己脚本之前执行；
 *     另外在 onPageStarted 再兜一次（脚本内部有 __DY4K_ON__ 幂等保护）。
 *  3. 全屏沉浸 + 竖屏 + 保持常亮 + 返回键/长按返回键等手感补齐，让它像个 App。
 *  4. 打开 WebView 远程调试（chrome://inspect / adb forward），方便用 CDP 在真机上验收。
 */
public class MainActivity extends Activity {

    private static final String TAG = "dy4k";
    /**
     * 开屏先落在这个地址（站点的自然落地页，会自动跳到 /jingxuan），
     * 然后由注入脚本用站内路由切到推荐流。
     * 注意：不要把 START_URL 直接写成 /?recommend=1 —— 实测"直接冷启动到推荐页"时
     * 播放器不初始化（video 永远 0×0），从别的路由 SPA 切过去才正常。
     */
    private static final String START_URL = "https://www.douyin.com/";

    /** 桌面版 UA：必须带 Windows NT + desktop Chrome，抖音才会给 is-mobile-pc 的桌面版页面 */
    private static final String UA_DESKTOP =
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) " +
            "Chrome/131.0.0.0 Safari/537.36";

    private FrameLayout root;
    private WebView web;
    private TextView splash;
    private FrameLayout customContainer;
    private View customView;
    private WebChromeClient.CustomViewCallback customViewCallback;

    private String injectPayload;          // 待注入的 JS（含幂等包裹）
    private boolean pageStartedInjected;   // 本页是否已经走过 onPageStarted 注入
    private long lastBackAt;

    // ==================== 生命周期 ====================

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        enterImmersive();

        if (Build.VERSION.SDK_INT >= 19) {
            WebView.setWebContentsDebuggingEnabled(true);   // 供 adb / chrome://inspect 验收
        }

        injectPayload = buildInjectPayload();

        root = new FrameLayout(this);
        root.setBackgroundColor(Color.BLACK);
        setContentView(root, new ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        web = buildWebView();
        root.addView(web, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        splash = buildSplash();
        root.addView(splash, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        customContainer = new FrameLayout(this);
        customContainer.setBackgroundColor(Color.BLACK);
        customContainer.setVisibility(View.GONE);
        root.addView(customContainer, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        Log.i(TAG, "onCreate; sdk=" + Build.VERSION.SDK_INT + " inject=" + (injectPayload == null ? 0 : injectPayload.length()) + "B");
        logPlatformSupport();
        web.loadUrl(START_URL);

        // 开屏直接进原生推荐流（网页版推荐页在这个 WebView 里播放器起不来）：
        // WebView 在背后继续加载（原生 feed 要借它的 dy4kApi 取数据 + 登录态）。
        // 开屏仍然走网页版（前端改样式这条路），原生 feed 只在用户点「推荐」时用
        // （保留开关：真机验证 web 版够了就彻底删掉）
        if (!feedLaunched && false) {
            feedLaunched = true;
            new android.os.Handler(getMainLooper()).postDelayed(() -> {
                try {
                    startActivity(new Intent(MainActivity.this, FeedActivity.class));
                } catch (Throwable t) {
                    Log.w(TAG, "startup feed failed: " + t);
                }
            }, 400);
        }
    }

    private static boolean feedLaunched = false;

    /** 起播前先把"能不能解 HEVC"这件事查清楚：4K 码流只有 HEVC，平台没硬解就白搭 */
    private void logPlatformSupport() {
        try {
            android.content.pm.PackageInfo wi = (Build.VERSION.SDK_INT >= 26)
                    ? WebView.getCurrentWebViewPackage() : null;
            Log.i(TAG, "WebView pkg: " + (wi == null ? "?" : wi.packageName + " " + wi.versionName));
        } catch (Throwable t) {
            Log.w(TAG, "webview pkg probe failed: " + t);
        }
        try {
            android.media.MediaCodecList list = new android.media.MediaCodecList(android.media.MediaCodecList.REGULAR_CODECS);
            StringBuilder sb = new StringBuilder();
            int n = 0;
            for (android.media.MediaCodecInfo ci : list.getCodecInfos()) {
                if (ci.isEncoder()) continue;
                try {
                    for (String type : ci.getSupportedTypes()) {
                        if (type == null || !type.toLowerCase().contains("hevc")) continue;
                        if (n++ > 0) sb.append("; ");
                        sb.append(ci.getName()).append(" [").append(type).append("] hw=").append(ci.isHardwareAccelerated());
                    }
                } catch (Throwable ignore) {}
            }
            Log.i(TAG, "HEVC decoders(" + n + "): " + (n == 0 ? "NONE" : sb.toString()));
        } catch (Throwable t) {
            Log.w(TAG, "codec probe failed: " + t);
        }
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        if (intent != null && intent.getData() != null) {
            web.loadUrl(intent.getData().toString());
        }
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) enterImmersive();
    }

    @Override
    protected void onResume() {
        super.onResume();
        enterImmersive();
        if (web != null) web.onResume();
    }

    @Override
    protected void onPause() {
        if (web != null) web.onPause();
        super.onPause();
    }

    @Override
    protected void onDestroy() {
        if (web != null) {
            root.removeView(web);
            web.destroy();
            web = null;
        }
        super.onDestroy();
    }

    // ==================== 系统栏：状态栏保留，导航栏隐藏 ====================
    // 用户要求"上方把手机状态栏显示出来"：所以不再 FULLSCREEN，只隐藏底部导航条。

    @SuppressWarnings("deprecation")
    private void enterImmersive() {
        try {
            Window w = getWindow();
            if (Build.VERSION.SDK_INT >= 21) {
                w.addFlags(WindowManager.LayoutParams.FLAG_DRAWS_SYSTEM_BAR_BACKGROUNDS);
                w.clearFlags(WindowManager.LayoutParams.FLAG_TRANSLUCENT_STATUS);
                w.setStatusBarColor(Color.BLACK);
                w.setNavigationBarColor(Color.BLACK);
            }
            if (Build.VERSION.SDK_INT >= 30) {
                w.setDecorFitsSystemWindows(true);          // 内容从状态栏下面开始
                WindowInsetsController c = w.getInsetsController();
                if (c != null) {
                    c.show(WindowInsets.Type.statusBars());
                    c.hide(WindowInsets.Type.navigationBars());
                    c.setSystemBarsBehavior(WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
                }
            } else {
                int flags = View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                        | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                        | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY;
                w.getDecorView().setSystemUiVisibility(flags);
            }
        } catch (Throwable t) {
            Log.w(TAG, "systemUi failed: " + t);
        }
    }

    // ==================== WebView 组装 ====================

    @SuppressLint("SetJavaScriptEnabled")
    private WebView buildWebView() {
        WebView v = new WebView(this);
        WebSettings s = v.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setUserAgentString(UA_DESKTOP);
        s.setLoadWithOverviewMode(false);
        s.setUseWideViewPort(true);
        s.setSupportZoom(false);
        s.setBuiltInZoomControls(false);
        s.setDisplayZoomControls(false);
        s.setJavaScriptCanOpenWindowsAutomatically(true);
        s.setSupportMultipleWindows(false);
        s.setMediaPlaybackRequiresUserGesture(false);   // 允许自动播放
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE);
        if (Build.VERSION.SDK_INT >= 26) s.setSafeBrowsingEnabled(false);
        if (Build.VERSION.SDK_INT >= 33) {
            s.setAlgorithmicDarkeningAllowed(false);
        }

        CookieManager cm = CookieManager.getInstance();
        cm.setAcceptCookie(true);
        if (Build.VERSION.SDK_INT >= 21) cm.setAcceptThirdPartyCookies(v, true);

        v.setBackgroundColor(Color.BLACK);
        v.setOverScrollMode(View.OVER_SCROLL_NEVER);
        v.setScrollBarStyle(View.SCROLLBARS_INSIDE_OVERLAY);
        v.setVerticalScrollBarEnabled(false);
        v.setHorizontalScrollBarEnabled(false);

        v.setWebViewClient(new ShellClient());
        v.setWebChromeClient(new ShellChrome());
        v.setLongClickable(false);
        v.setHapticFeedbackEnabled(false);

        // 注入脚本 -> 原生播放器的桥（4K 只有 HEVC，系统 WebView 拿不到，只能交给原生硬解）
        v.addJavascriptInterface(new NativeBridge(), "dy4kNative");
        WebData.attach(v);
        return v;
    }

    private static final int REQ_PROFILE = 1001;

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode == REQ_PROFILE && resultCode == RESULT_OK && data != null) {
            String awemeId = data.getStringExtra("awemeId");
            if (awemeId != null && awemeId.length() > 5 && web != null) {
                Log.i(TAG, "profile -> open video " + awemeId);
                web.loadUrl("https://www.douyin.com/video/" + awemeId);
            }
        }
        super.onActivityResult(requestCode, resultCode, data);
    }

    /** JS 侧接口：window.dy4kNative.* */
    public class NativeBridge {

        @android.webkit.JavascriptInterface
        public String platform() {
            return "android";
        }

        @android.webkit.JavascriptInterface
        public void log(String msg) {
            Log.i(TAG, "js: " + msg);
        }

        /** 用原生 MediaPlayer（硬件 HEVC 解码）全屏播放 4K 直链 */
        @android.webkit.JavascriptInterface
        public void play4k(String url, int w, int h, String title) {
            try {
                Log.i(TAG, "play4k " + w + "x" + h + " "
                        + (url == null ? "null" : url.substring(0, Math.min(100, url.length()))));
                if (url == null || url.length() < 10) return;
                Intent i = new Intent(MainActivity.this, PlayerActivity.class);
                i.putExtra("url", url);
                i.putExtra("w", w);
                i.putExtra("h", h);
                i.putExtra("title", title == null ? "" : title);
                startActivity(i);
            } catch (Throwable t) {
                Log.e(TAG, "play4k failed: " + t);
            }
        }

        /** 打开原生「作者主页 / 个人主页」（secUid 为空表示"我的"） */
        @android.webkit.JavascriptInterface
        public void openProfile(String secUid, String nick) {
            try {
                Log.i(TAG, "openProfile " + secUid + " / " + nick);
                Intent i = new Intent(MainActivity.this, ProfileActivity.class);
                i.putExtra(ProfileActivity.EXTRA_SEC_UID, secUid == null ? "" : secUid);
                i.putExtra(ProfileActivity.EXTRA_NICK, nick == null ? "" : nick);
                startActivityForResult(i, REQ_PROFILE);
            } catch (Throwable t) {
                Log.e(TAG, "openProfile failed: " + t);
            }
        }

        /** 页面把数据送回来（rid 由 WebData 生成，页面原样回传） */
        @android.webkit.JavascriptInterface
        public void profileData(String rid, String json) {
            WebData.deliver(rid, json);
        }

        @android.webkit.JavascriptInterface
        public void postsData(String rid, String json) {
            WebData.deliver(rid, json);
        }

        @android.webkit.JavascriptInterface
        public void relatedData(String rid, String json) {
            WebData.deliver(rid, json);
        }

        @android.webkit.JavascriptInterface
        public void commentsData(String rid, String json) {
            WebData.deliver(rid, json);
        }

        @android.webkit.JavascriptInterface
        public void detailData(String rid, String json) {
            WebData.deliver(rid, json);
        }

        /** 打开原生推荐流（seed 可为空，脚本里会兜一个种子视频） */
        @android.webkit.JavascriptInterface
        public void openFeed(String seedAwemeId) {
            try {
                Log.i(TAG, "openFeed seed=" + seedAwemeId);
                Intent i = new Intent(MainActivity.this, FeedActivity.class);
                i.putExtra(FeedActivity.EXTRA_SEED, seedAwemeId == null ? "" : seedAwemeId);
                startActivity(i);
            } catch (Throwable t) {
                Log.e(TAG, "openFeed failed: " + t);
            }
        }
    }

    private TextView buildSplash() {
        TextView t = new TextView(this);
        t.setText(getString(R.string.loading));
        t.setTextColor(0xFF9AA0A6);
        t.setTextSize(13f);
        t.setGravity(Gravity.CENTER);
        t.setBackgroundColor(Color.BLACK);
        return t;
    }

    // ==================== 注入脚本 ====================

    /** 读 assets/dy4k.js，包一层幂等保护（同一页面重复注入不会重复装钩子） */
    private String buildInjectPayload() {
        try {
            String js = readAsset("dy4k.js");
            // 把结束标签打散，避免内联进 HTML 时提前闭合
            js = js.replace("</script", "<\\/script");
            StringBuilder sb = new StringBuilder(js.length() + 256);
            sb.append("if(!window.__DY4K_ON__){window.__DY4K_ON__=1;window.__DY4K_APP__=1;\n");
            sb.append(js).append("\n}");
            return sb.toString();
        } catch (Throwable t) {
            Log.e(TAG, "read asset dy4k.js failed: " + t);
            return null;
        }
    }

    private String readAsset(String name) throws Exception {
        InputStream in = getAssets().open(name);
        ByteArrayOutputStream bos = new ByteArrayOutputStream();
        byte[] buf = new byte[8192];
        int n;
        while ((n = in.read(buf)) > 0) bos.write(buf, 0, n);
        in.close();
        return new String(bos.toByteArray(), StandardCharsets.UTF_8);
    }

    private String injectIntoHtml(String html, boolean videoPage) {
        if (injectPayload == null) return html;
        // viewport 分页面处理（实测）：
        //   视频/图文页：站点的播放器容器 min-width 852px，按 786 排版会算成 0 高度，
        //                必须把它压到设备宽度（initial-scale=1）才会渲染成全屏播放器；
        //   其它页面（精选/关注/朋友）：站点按 786 排版再缩 0.5，什么都不动才是对的。
        String fixed = html;
        // 统一压到设备宽度（initial-scale=1）：站点会按"手机版布局"渲染，视频页/关注页都变成单列，
        // 再用 CSS 把固定宽度改成百分比 → 真正的弹性适配。
        // （站点自带的 0.5 缩放是"桌面版整体缩小"，字小、上下黑边大，不是我们要的。）
        if (true) {
            fixed = html.replaceAll(
                    "(?is)<meta[^>]*name=[\"']viewport[\"'][^>]*>",
                    "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no,viewport-fit=cover\">");
        }
        String tag = "<script id=\"dy4k-inline\">" + injectPayload + "</script>";
        int lower = fixed.toLowerCase().indexOf("<head");
        if (lower >= 0) {
            int close = fixed.indexOf('>', lower);
            if (close > 0) {
                return fixed.substring(0, close + 1) + tag + fixed.substring(close + 1);
            }
        }
        int htmlStart = fixed.toLowerCase().indexOf("<html");
        if (htmlStart >= 0) {
            int close = fixed.indexOf('>', htmlStart);
            if (close > 0) return fixed.substring(0, close + 1) + tag + fixed.substring(close + 1);
        }
        return tag + fixed;
    }

    // ==================== WebViewClient ====================

    private class ShellClient extends WebViewClient {

        @Override
        public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest req) {
            try {
                if (req == null || req.getUrl() == null) return null;
                String url = req.getUrl().toString();
                boolean isMain = Build.VERSION.SDK_INT >= 21 && req.isForMainFrame();
                if (!isMain) return null;
                if (!"GET".equalsIgnoreCase(req.getMethod())) return null;
                if (!url.startsWith("http")) return null;
                if (!url.contains("douyin.com")) return null;
                return fetchAndInject(url);
            } catch (Throwable t) {
                Log.w(TAG, "intercept failed: " + t);
                return null;
            }
        }

        @Override
        public void onPageStarted(WebView view, String url, android.graphics.Bitmap favicon) {
            super.onPageStarted(view, url, favicon);
            pageStartedInjected = false;
            Log.i(TAG, "page started: " + url);
            // 兜底：万一 HTML 注入没成功（CSP / 非 douyin 域名），这里再塞一次
            if (injectPayload != null && url != null && url.contains("douyin.com")) {
                view.evaluateJavascript(injectPayload, null);
                pageStartedInjected = true;
            }
            if (splash != null) {
                splash.setText(getString(R.string.loading));
                splash.setVisibility(View.VISIBLE);
            }
        }

        @Override
        public void onPageFinished(WebView view, String url) {
            super.onPageFinished(view, url);
            Log.i(TAG, "page finished: " + url);
            if (splash != null) splash.setVisibility(View.GONE);
        }

        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) {
            try {
                Uri u = req.getUrl();
                String s = u.toString();
                if (s.startsWith("http")) {
                    if (s.contains("douyin.com")) return false;
                    // 站外链接交给系统浏览器
                    startActivity(new Intent(Intent.ACTION_VIEW, u));
                    return true;
                }
                // bytedance:// / snssdk1128:// 这类深链：忽略，别让它唤起抖音 App
                Log.i(TAG, "block scheme: " + s);
                return true;
            } catch (Throwable t) {
                return false;
            }
        }

        @Override
        public void onReceivedSslError(WebView view, SslErrorHandler handler, SslError error) {
            Log.w(TAG, "ssl error: " + error);
            handler.cancel();
        }

        @Override
        public void onReceivedError(WebView view, WebResourceRequest req, android.webkit.WebResourceError err) {
            if (Build.VERSION.SDK_INT >= 21 && req.isForMainFrame()) {
                Log.e(TAG, "main frame error: " + err.getErrorCode() + " " + err.getDescription());
                showNetError();
            }
        }
    }

    private void showNetError() {
        if (splash != null) {
            splash.setText(getString(R.string.net_error));
            splash.setVisibility(View.VISIBLE);
            splash.setOnClickListener(v -> {
                splash.setVisibility(View.VISIBLE);
                splash.setText(getString(R.string.loading));
                web.loadUrl(START_URL);
            });
        }
    }

    /** 主文档自己抓一遍，再把脚本塞进 <head> 里，保证在页面 JS 之前执行 */
    private WebResourceResponse fetchAndInject(String url) {
        HttpURLConnection c = null;
        try {
            c = (HttpURLConnection) new URL(url).openConnection();
            c.setInstanceFollowRedirects(true);
            c.setConnectTimeout(15000);
            c.setReadTimeout(20000);
            String cookie = CookieManager.getInstance().getCookie(url);
            if (cookie != null && cookie.length() > 0) c.setRequestProperty("Cookie", cookie);
            c.setRequestProperty("Accept-Encoding", "identity");
            c.setRequestProperty("User-Agent", UA_DESKTOP);
            c.setRequestProperty("Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8");
            c.setRequestProperty("Accept-Language", "zh-CN,zh;q=0.9");

            int code = c.getResponseCode();
            Map<String, List<String>> hdr = c.getHeaderFields();

            // 把服务端下发的 Set-Cookie 同步回 WebView 的 CookieManager
            for (String key : new String[]{"Set-Cookie", "set-cookie"}) {
                List<String> sc = hdr.get(key);
                if (sc == null) continue;
                for (String one : sc) {
                    try { CookieManager.getInstance().setCookie(url, one); } catch (Throwable ignore) {}
                }
            }

            String ct = c.getContentType();
            if (ct == null || !ct.toLowerCase().contains("text/html")) {
                Log.i(TAG, "skip inject (not html): " + code + " " + ct + " " + url);
                return null;
            }
            if (code < 200 || code >= 400) return null;

            InputStream in = c.getInputStream();
            ByteArrayOutputStream bos = new ByteArrayOutputStream(Math.max(16384, c.getContentLength()));
            byte[] buf = new byte[16384];
            int n;
            while ((n = in.read(buf)) > 0) bos.write(buf, 0, n);
            in.close();

            String html = new String(bos.toByteArray(), StandardCharsets.UTF_8);
            boolean videoPage = url != null && (url.contains("/video/") || url.contains("/note/"));
            String out = injectIntoHtml(html, videoPage);
            byte[] bytes = out.getBytes(StandardCharsets.UTF_8);

            Map<String, String> rh = new HashMap<>();
            rh.put("Content-Type", "text/html; charset=utf-8");
            rh.put("Cache-Control", "no-store");
            Log.i(TAG, "injected main doc: " + url + " (" + html.length() + " -> " + out.length() + " chars)");
            return new WebResourceResponse("text/html", "utf-8", code, "OK", rh, new ByteArrayInputStream(bytes));
        } catch (Throwable t) {
            Log.w(TAG, "fetchAndInject failed (" + url + "): " + t);
            return null;
        } finally {
            if (c != null) c.disconnect();
        }
    }

    // ==================== WebChromeClient ====================

    private class ShellChrome extends WebChromeClient {

        @Override
        public void onProgressChanged(WebView view, int newProgress) {
            if (splash != null && splash.getVisibility() == View.VISIBLE && newProgress > 55) {
                splash.setVisibility(View.GONE);
            }
        }

        @Override
        public boolean onConsoleMessage(ConsoleMessage m) {
            try {
                String msg = m.message();
                // 只把脚本自己的日志和报错打到 logcat，避免刷屏
                if (msg != null && (msg.contains("[dy4k]") || m.messageLevel() == ConsoleMessage.MessageLevel.ERROR)) {
                    Log.i(TAG, "console/" + m.messageLevel() + ": " + msg + " @" + m.sourceId() + ":" + m.lineNumber());
                }
            } catch (Throwable ignore) {}
            return true;
        }

        @Override
        public void onPermissionRequest(PermissionRequest request) {
            // 登录用不到摄像头/麦克风；一律拒绝（避免被静默授权）
            try { request.deny(); } catch (Throwable ignore) {}
        }

        @Override
        public boolean onCreateWindow(WebView view, boolean isDialog, boolean isUserGesture, android.os.Message resultMsg) {
            // 不弹新窗口，直接把新链接在当前 WebView 打开
            try {
                WebView.HitTestResult r = view.getHitTestResult();
                if (r != null && r.getExtra() != null) view.loadUrl(r.getExtra());
            } catch (Throwable ignore) {}
            return false;
        }

        @Override
        public void onShowCustomView(View view, CustomViewCallback callback) {
            Log.i(TAG, "enter html5 fullscreen");
            if (customView != null) {
                callback.onCustomViewHidden();
                return;
            }
            customView = view;
            customViewCallback = callback;
            customContainer.addView(view, new FrameLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
            customContainer.setVisibility(View.VISIBLE);
            web.setVisibility(View.GONE);
            enterImmersive();
        }

        @Override
        public void onHideCustomView() {
            Log.i(TAG, "exit html5 fullscreen");
            if (customView == null) return;
            customContainer.removeView(customView);
            customContainer.setVisibility(View.GONE);
            web.setVisibility(View.VISIBLE);
            customView = null;
            if (customViewCallback != null) {
                customViewCallback.onCustomViewHidden();
                customViewCallback = null;
            }
            enterImmersive();
        }
    }

    // ==================== 按键 ====================

    @Override
    public void onBackPressed() {
        if (customView != null) {
            ((ShellChrome) web.getWebChromeClient()).onHideCustomView();
            return;
        }
        if (web != null && web.canGoBack()) {
            web.goBack();
            return;
        }
        long now = System.currentTimeMillis();
        if (now - lastBackAt < 2000) {
            super.onBackPressed();
        } else {
            lastBackAt = now;
            Toast.makeText(this, "再按一次返回退出；长按返回 = 重新加载", Toast.LENGTH_SHORT).show();
        }
    }

    @Override
    public boolean onKeyLongPress(int keyCode, KeyEvent event) {
        if (keyCode == KeyEvent.KEYCODE_BACK) {
            Log.i(TAG, "long-press back -> reload");
            if (web != null) web.reload();
            Toast.makeText(this, "已重新加载", Toast.LENGTH_SHORT).show();
            return true;
        }
        return super.onKeyLongPress(keyCode, event);
    }

    @Override
    public boolean onKeyDown(int keyCode, KeyEvent event) {
        if (keyCode == KeyEvent.KEYCODE_BACK) {
            event.startTracking();      // 让长按能触发 onKeyLongPress
            return true;
        }
        return super.onKeyDown(keyCode, event);
    }

    @Override
    public boolean onKeyUp(int keyCode, KeyEvent event) {
        if (keyCode == KeyEvent.KEYCODE_BACK) {
            if (event.isTracking() && !event.isCanceled() && event.getEventTime() - event.getDownTime() > 700) {
                // 长按已在 onKeyLongPress 里处理，这里吞掉，避免又触发一次"返回"
                return true;
            }
            onBackPressed();
            return true;
        }
        return super.onKeyUp(keyCode, event);
    }
}
