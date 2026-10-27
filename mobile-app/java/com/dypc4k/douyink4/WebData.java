package com.dypc4k.douyink4;

import android.util.Log;
import android.webkit.WebView;

import org.json.JSONObject;

import java.lang.ref.WeakReference;
import java.util.HashMap;
import java.util.Map;

/**
 * 用主 WebView 当"数据代理"：抖音的接口要登录态和一堆站内参数，
 * 在 native 里拼 HttpURLConnection 很容易被拒；而在页面上下文里 fetch 天然带着 cookie。
 * 所以这里把 WebView 存一份引用，需要数据时在页面里跑一段 JS，拿到结果再回调 native。
 *
 * 关键设计（都是踩过坑才加的）：
 *   1. 每个请求带一个 rid，页面原样回传 —— 之前用 FIFO 队列，预取请求会和当前请求错位；
 *   2. 先探测 window.dy4kApi 是否存在，没就绪立刻回调 null（调用方重试），不要傻等；
 *   3. 每个请求都有超时兜底。
 */
public final class WebData {

    public interface Cb {
        void onData(String json);
    }

    private static final String TAG = "dy4k";
    private static final long TIMEOUT_MS = 9000;

    private static WeakReference<WebView> webRef = new WeakReference<>(null);
    private static final Map<String, Cb> PENDING = new HashMap<>();
    private static int seq = 0;

    private WebData() {}

    public static void attach(WebView w) {
        webRef = new WeakReference<>(w);
    }

    public static void detach() {
        webRef = new WeakReference<>(null);
    }

    private static String nextRid() {
        return "r" + (++seq);
    }

    // ---------------- 具体请求 ----------------

    public static void requestProfile(String secUid, Cb cb) {
        String rid = nextRid();
        String api = secUid == null || secUid.length() == 0
                ? "window.dy4kApi.profile('')"
                : "window.dy4kApi.profile(" + JSONObject.quote(secUid) + ")";
        wrap(rid, api, "profileData", cb);
    }

    public static void requestPosts(String secUid, long cursor, Cb cb) {
        String rid = nextRid();
        wrap(rid, "window.dy4kApi.posts(" + JSONObject.quote(secUid == null ? "" : secUid) + "," + cursor + ")", "postsData", cb);
    }

    public static void requestRelated(String seedAwemeId, Cb cb) {
        String rid = nextRid();
        wrap(rid, "window.dy4kApi.related(" + JSONObject.quote(seedAwemeId == null ? "" : seedAwemeId) + ",20)", "relatedData", cb);
    }

    public static void requestComments(String awemeId, long cursor, Cb cb) {
        String rid = nextRid();
        wrap(rid, "window.dy4kApi.comments(" + JSONObject.quote(awemeId == null ? "" : awemeId) + "," + cursor + ",20)", "commentsData", cb);
    }

    public static void requestDetail(String awemeId, Cb cb) {
        String rid = nextRid();
        wrap(rid, "window.dy4kApi.detail(" + JSONObject.quote(awemeId == null ? "" : awemeId) + ")", "detailData", cb);
    }

    /** 把 dy4kApi 的 Promise 结果通过 dy4kNative.<bridge>(rid, json) 送回 native */
    private static void wrap(String rid, String apiCall, String bridge, Cb cb) {
        String expr = "(function(){var __r=" + JSONObject.quote(rid) + ";"
                + "function __send(j){try{window.dy4kNative." + bridge + "(__r, JSON.stringify(j||{}))}catch(e){}}"
                + "if(!window.dy4kApi){__send({});return;}"
                + "try{ " + apiCall + ".then(function(j){__send(j)}, function(){__send({})}); }catch(e){ __send({}); }"
                + "})()";
        run(rid, expr, cb);
    }

    private static void run(final String rid, final String expr, final Cb cb) {
        final WebView w = webRef.get();
        if (w == null || cb == null) {
            if (cb != null) cb.onData(null);
            return;
        }
        try {
            w.evaluateJavascript("!!(window.dy4kApi)", value -> {
                if (value == null || !value.contains("true")) {
                    Log.i(TAG, "dy4kApi not ready -> null");
                    cb.onData(null);
                    return;
                }
                PENDING.put(rid, cb);
                new android.os.Handler(android.os.Looper.getMainLooper()).postDelayed(() -> {
                    Cb c = PENDING.remove(rid);
                    if (c != null) {
                        Log.w(TAG, "WebData timeout " + rid);
                        c.onData(null);
                    }
                }, TIMEOUT_MS);
                try {
                    w.evaluateJavascript(expr, null);
                } catch (Throwable t) {
                    PENDING.remove(rid);
                    Log.w(TAG, "evaluateJavascript failed: " + t);
                    cb.onData(null);
                }
            });
        } catch (Throwable t) {
            Log.w(TAG, "probe failed: " + t);
            cb.onData(null);
        }
    }

    /** 带 rid 的回调入口 */
    public static void deliver(String rid, String json) {
        Cb cb = rid == null ? null : PENDING.remove(rid);
        if (cb == null) {
            Log.w(TAG, "deliver: no pending for " + rid);
            return;
        }
        cb.onData(json == null ? "{}" : json);
    }
}
