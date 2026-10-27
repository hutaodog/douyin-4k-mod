package com.dypc4k.douyink4;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.os.Build;
import android.os.Bundle;
import android.text.TextUtils;
import android.util.Log;
import android.util.TypedValue;
import android.view.Gravity;
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
 * 原生「作者主页 / 个人主页」。
 *
 * 为什么自己画：抖音桌面网页版的用户页是宽屏三栏布局，跟手机 App 差得太远，用 CSS 改不出来。
 * 这里按手机版的结构 1:1 重排：顶部返回栏 → 头像/昵称/抖音号/签名 → 关注·粉丝·获赞 → 作品/喜欢 分栏 → 3 列作品瀑布。
 *
 * 数据不自己拼请求：转给主 WebView 里的 dy4kApi（带登录态和站内参数），再回调 native。
 * 入口：MainActivity 的 JS 桥 openProfile(secUid, nick)；secUid 为空表示"我的"。
 */
public class ProfileActivity extends Activity {

    private static final String TAG = "dy4k";

    public static final String EXTRA_SEC_UID = "secUid";
    public static final String EXTRA_NICK = "nick";

    private static final int BG = 0xFF0B0B0D;
    private static final int TEXT = 0xFFF2F2F5;
    private static final int SUB = 0xFF9A9AA2;
    private static final int ACCENT = 0xFFFE2C55;

    private String secUid = "";
    private String nick = "";
    private String selfUid = "";
    private boolean isSelf;

    private LinearLayout root;
    private LinearLayout headerBox;
    private LinearLayout gridBox;
    private TextView titleView;
    private TextView emptyView;

    private final List<JSONObject> posts = new ArrayList<>();
    private final List<TextView> tabViews = new ArrayList<>();

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        secUid = getIntent().getStringExtra(EXTRA_SEC_UID);
        nick = getIntent().getStringExtra(EXTRA_NICK);
        if (secUid == null) secUid = "";
        if (nick == null) nick = "";
        isSelf = secUid.length() == 0 || "self".equals(secUid);

        setupWindow();
        buildShell();
        loadProfile();
    }

    // ---------------- 窗口 ----------------

    @SuppressWarnings("deprecation")
    private void setupWindow() {
        try {
            Window w = getWindow();
            if (Build.VERSION.SDK_INT >= 21) {
                w.addFlags(WindowManager.LayoutParams.FLAG_DRAWS_SYSTEM_BAR_BACKGROUNDS);
                w.setStatusBarColor(Color.BLACK);
                w.setNavigationBarColor(Color.BLACK);
            }
            if (Build.VERSION.SDK_INT >= 30) {
                w.setDecorFitsSystemWindows(true);
                WindowInsetsController c = w.getInsetsController();
                if (c != null) {
                    c.show(WindowInsets.Type.statusBars());
                    c.hide(WindowInsets.Type.navigationBars());
                    c.setSystemBarsBehavior(WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
                }
            }
        } catch (Throwable t) {
            Log.w(TAG, "profile window: " + t);
        }
    }

    // ---------------- 骨架 ----------------

    private int dp(float v) { return Math.round(v * getResources().getDisplayMetrics().density); }

    private void buildShell() {
        root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setBackgroundColor(BG);
        setContentView(root);

        // 顶部返回栏
        LinearLayout bar = new LinearLayout(this);
        bar.setOrientation(LinearLayout.HORIZONTAL);
        bar.setGravity(Gravity.CENTER_VERTICAL);
        bar.setPadding(dp(6), dp(4), dp(12), dp(4));
        bar.setBackgroundColor(BG);

        TextView back = new TextView(this);
        back.setText("‹");
        back.setTextColor(TEXT);
        back.setTextSize(TypedValue.COMPLEX_UNIT_SP, 30);
        back.setGravity(Gravity.CENTER);
        back.setPadding(dp(10), 0, dp(10), dp(4));
        back.setOnClickListener(v -> finish());
        bar.addView(back, new LinearLayout.LayoutParams(dp(48), dp(44)));

        titleView = new TextView(this);
        titleView.setText(nick.length() > 0 ? nick : "主页");
        titleView.setTextColor(TEXT);
        titleView.setTextSize(TypedValue.COMPLEX_UNIT_SP, 16);
        titleView.setTypeface(Typeface.DEFAULT_BOLD);
        titleView.setSingleLine(true);
        titleView.setEllipsize(TextUtils.TruncateAt.END);
        bar.addView(titleView, new LinearLayout.LayoutParams(0, dp(44), 1f));

        root.addView(bar, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(48)));

        ScrollView sv = new ScrollView(this);
        sv.setBackgroundColor(BG);
        sv.setFillViewport(true);
        LinearLayout body = new LinearLayout(this);
        body.setOrientation(LinearLayout.VERTICAL);
        sv.addView(body, new ScrollView.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        root.addView(sv, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f));

        headerBox = new LinearLayout(this);
        headerBox.setOrientation(LinearLayout.VERTICAL);
        body.addView(headerBox, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        TextView loading = new TextView(this);
        loading.setText("加载中…");
        loading.setTextColor(SUB);
        loading.setGravity(Gravity.CENTER);
        loading.setPadding(0, dp(40), 0, dp(40));
        headerBox.addView(loading);

        gridBox = new LinearLayout(this);
        gridBox.setOrientation(LinearLayout.VERTICAL);
        body.addView(gridBox, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        emptyView = new TextView(this);
        emptyView.setTextColor(SUB);
        emptyView.setGravity(Gravity.CENTER);
        emptyView.setPadding(0, dp(40), 0, dp(40));
        emptyView.setVisibility(View.GONE);
        body.addView(emptyView);
    }

    // ---------------- 数据 ----------------

    private void loadProfile() {
        WebData.requestProfile(isSelf ? "" : secUid, json -> runOnUiThread(() -> {
            if (json == null || json.length() < 10) {
                toast("拿不到用户资料（要在 App 里登录）");
                return;
            }
            try {
                JSONObject u = new JSONObject(json);
                if (u.has("user")) u = u.optJSONObject("user");
                renderHeader(u);
                String su = u.optString("sec_uid", secUid);
                selfUid = su;
                if (titleView != null) {
                    String n = u.optString("nickname", nick);
                    if (n.length() > 0) titleView.setText(n);
                }
                loadPosts(su);
            } catch (Throwable t) {
                toast("用户数据解析失败");
                Log.w(TAG, "profile parse: " + t);
            }
        }));
    }

    private void loadPosts(String su) {
        WebData.requestPosts(su, 0, json -> runOnUiThread(() -> {
            posts.clear();
            if (json != null && json.length() > 10) {
                try {
                    JSONObject j = new JSONObject(json);
                    JSONArray list = j.optJSONArray("list");
                    if (list != null) {
                        for (int i = 0; i < list.length(); i++) {
                            JSONObject a = list.optJSONObject(i);
                            if (a != null) posts.add(a);
                        }
                    }
                } catch (Throwable t) {
                    Log.w(TAG, "posts parse: " + t);
                }
            }
            renderGrid();
        }));
    }

    // ---------------- 渲染 ----------------

    private void renderHeader(JSONObject u) {
        headerBox.removeAllViews();
        if (u == null) return;

        String nick = u.optString("nickname", "");
        String uid = u.optString("unique_id", "");
        String sign = u.optString("signature", "");
        String verify = u.optString("custom_verify", u.optString("enterprise_verify_reason", ""));
        String avatar = firstUrl(u.optJSONObject("avatar_larger"));
        if (avatar.length() == 0) avatar = firstUrl(u.optJSONObject("avatar_medium"));
        String cover = coverOf(u);
        long following = u.optLong("following_count");
        long fans = u.optLong("follower_count");
        long likes = u.optLong("total_favorited");
        int awemeCount = u.optInt("aweme_count");

        // ---------- 顶部背景图（手机版主页头图）+ 头像压在图上 ----------
        FrameLayout banner = new FrameLayout(this);
        LinearLayout.LayoutParams bLp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, dp(152));
        GradientDrawable fallback = new GradientDrawable(GradientDrawable.Orientation.TOP_BOTTOM,
                new int[]{0xFF33333A, 0xFF141418});
        banner.setBackground(fallback);
        ImageView coverIv = new ImageView(this);
        coverIv.setScaleType(ImageView.ScaleType.CENTER_CROP);
        banner.addView(coverIv, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        if (cover.length() > 0) ImgLoader.load(coverIv, cover, dp(400), dp(152));
        headerBox.addView(banner, bLp);

        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setPadding(dp(16), 0, dp(16), dp(8));

        ImageView av = new ImageView(this);
        GradientDrawable ring = new GradientDrawable();
        ring.setShape(GradientDrawable.OVAL);
        ring.setColor(0xFF1C1C20);
        av.setBackground(ring);
        av.setClipToOutline(true);
        LinearLayout.LayoutParams avLp = new LinearLayout.LayoutParams(dp(84), dp(84));
        avLp.topMargin = -dp(40);                 // 头像压在背景图上，和手机版一致
        box.addView(av, avLp);
        ImgLoader.load(av, avatar, dp(84), dp(84));

        // 昵称 + 认证
        LinearLayout nameRow = new LinearLayout(this);
        nameRow.setOrientation(LinearLayout.HORIZONTAL);
        nameRow.setGravity(Gravity.CENTER_VERTICAL);
        nameRow.setPadding(0, dp(10), 0, 0);

        TextView nm = new TextView(this);
        nm.setText(nick);
        nm.setTextColor(TEXT);
        nm.setTextSize(TypedValue.COMPLEX_UNIT_SP, 19);
        nm.setTypeface(Typeface.DEFAULT_BOLD);
        nameRow.addView(nm);

        if (verify.length() > 0) {
            TextView vf = new TextView(this);
            vf.setText(" " + verify + " ");
            vf.setTextColor(0xFF1B1B1F);
            vf.setTextSize(TypedValue.COMPLEX_UNIT_SP, 9);
            GradientDrawable vbg = new GradientDrawable();
            vbg.setColor(0xFFE7C36B);
            vbg.setCornerRadius(dp(3));
            vf.setBackground(vbg);
            LinearLayout.LayoutParams vlp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, dp(16));
            vlp.leftMargin = dp(6);
            vlp.gravity = Gravity.CENTER_VERTICAL;
            nameRow.addView(vf, vlp);
        }
        box.addView(nameRow);

        // 抖音号
        if (uid.length() > 0) {
            TextView idv = new TextView(this);
            idv.setText("抖音号：" + uid);
            idv.setTextColor(SUB);
            idv.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12);
            idv.setPadding(0, dp(4), 0, 0);
            box.addView(idv);
        }

        // 签名
        if (sign.length() > 0) {
            TextView sg = new TextView(this);
            sg.setText(sign);
            sg.setTextColor(0xFFD6D6DC);
            sg.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13);
            sg.setLineSpacing(dp(2), 1f);
            sg.setPadding(dp(16), dp(8), dp(16), dp(2));
            box.addView(sg);
        }

        // 关注 / 粉丝 / 获赞
        LinearLayout stats = new LinearLayout(this);
        stats.setOrientation(LinearLayout.HORIZONTAL);
        stats.setPadding(0, dp(12), 0, dp(10));
        stats.addView(statCell(fmt(following), "关注"));
        stats.addView(statCell(fmt(fans), "粉丝"));
        stats.addView(statCell(fmt(likes), "获赞"));
        box.addView(stats);

        // 按钮：自己=编辑资料，别人=关注 + 私信
        LinearLayout btns = new LinearLayout(this);
        btns.setOrientation(LinearLayout.HORIZONTAL);
        if (isSelf) {
            TextView edit = button("编辑资料", false);
            edit.setOnClickListener(v -> toast("编辑资料请回网页操作"));
            btns.addView(edit, weightLp());
            btns.addView(gap(), gapLp());
            TextView share = button("分享主页", true);
            share.setOnClickListener(v -> toast("分享请回网页操作"));
            btns.addView(share, weightLp());
        } else {
            TextView follow = button("关注", true);
            follow.setOnClickListener(v -> toast("关注请回网页操作（原生侧还没接写接口）"));
            btns.addView(follow, weightLp());
            btns.addView(gap(), gapLp());
            TextView dm = button("私信", false);
            dm.setOnClickListener(v -> toast("私信请回网页操作"));
            btns.addView(dm, weightLp());
        }
        box.addView(btns);

        // 作品 / 喜欢 分栏
        LinearLayout tabs = new LinearLayout(this);
        tabs.setOrientation(LinearLayout.HORIZONTAL);
        tabs.setPadding(0, dp(14), 0, 0);
        TextView t1 = tabItem("作品 " + (awemeCount > 0 ? awemeCount : posts.size()), true);
        TextView t2 = tabItem("喜欢 " + u.optInt("favoriting_count", 0), false);
        tabViews.clear();
        tabViews.add(t1);
        tabViews.add(t2);
        tabs.addView(t1, weightLp());
        tabs.addView(t2, weightLp());
        box.addView(tabs);

        headerBox.addView(box);
    }

    private TextView statCell(String value, String label) {
        TextView tv = new TextView(this);
        tv.setText(value + "\n" + label);
        tv.setTextColor(SUB);
        tv.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12);
        tv.setPadding(0, 0, dp(26), 0);
        tv.setLineSpacing(dp(3), 1f);
        // 第一行数字放大
        tv.setText(value + "\n" + label);
        return tv;
    }

    private View gap() {
        View v = new View(this);
        return v;
    }

    private LinearLayout.LayoutParams gapLp() {
        return new LinearLayout.LayoutParams(dp(10), 1);
    }

    private LinearLayout.LayoutParams weightLp() {
        return new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f);
    }

    private TextView button(String text, boolean primary) {
        TextView b = new TextView(this);
        b.setText(text);
        b.setGravity(Gravity.CENTER);
        b.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13);
        b.setPadding(0, dp(8), 0, dp(8));
        b.setTextColor(primary ? 0xFFFFFFFF : 0xFFE6E6EA);
        GradientDrawable bg = new GradientDrawable();
        bg.setCornerRadius(dp(6));
        bg.setColor(primary ? ACCENT : 0xFF232327);
        b.setBackground(bg);
        return b;
    }

    private TextView tabItem(String text, boolean active) {
        TextView t = new TextView(this);
        t.setText(text);
        t.setGravity(Gravity.CENTER);
        t.setTextSize(TypedValue.COMPLEX_UNIT_SP, 14);
        t.setTextColor(active ? TEXT : SUB);
        t.setTypeface(active ? Typeface.DEFAULT_BOLD : Typeface.DEFAULT);
        t.setPadding(0, dp(8), 0, dp(8));
        return t;
    }

    private void renderGrid() {
        gridBox.removeAllViews();
        if (posts.isEmpty()) {
            emptyView.setVisibility(View.VISIBLE);
            emptyView.setText("还没有作品（或需要登录）");
            return;
        }
        emptyView.setVisibility(View.GONE);
        int cols = 3;
        int gap = dp(2);
        LinearLayout row = null;
        for (int i = 0; i < posts.size(); i++) {
            if (i % cols == 0) {
                row = new LinearLayout(this);
                row.setOrientation(LinearLayout.HORIZONTAL);
                LinearLayout.LayoutParams rlp = new LinearLayout.LayoutParams(
                        ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
                rlp.topMargin = gap;
                gridBox.addView(row, rlp);
            }
            JSONObject a = posts.get(i);
            View cell = buildCell(a);
            LinearLayout.LayoutParams clp = new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f);
            clp.rightMargin = gap;
            row.addView(cell, clp);
        }
    }

    private View buildCell(JSONObject a) {
        final String id = a.optString("aweme_id", "");
        JSONObject video = a.optJSONObject("video");
        String cover = "";
        if (video != null) {
            cover = firstUrl(video.optJSONObject("cover"));
            if (cover.length() == 0) cover = firstUrl(video.optJSONObject("dynamic_cover"));
            if (cover.length() == 0) cover = firstUrl(video.optJSONObject("origin_cover"));
        }
        JSONObject st = a.optJSONObject("statistics");
        long digg = st == null ? 0 : st.optLong("digg_count");

        FrameLayout cell = new FrameLayout(this);
        RatioImageView iv = new RatioImageView(this);
        iv.setScaleType(ImageView.ScaleType.CENTER_CROP);
        GradientDrawable ph = new GradientDrawable();
        ph.setColor(0xFF191A1E);
        iv.setBackground(ph);
        cell.addView(iv, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        ImgLoader.load(iv, cover, dp(130), dp(174));

        // 左下角播放量/点赞
        LinearLayout badge = new LinearLayout(this);
        badge.setOrientation(LinearLayout.HORIZONTAL);
        badge.setGravity(Gravity.CENTER_VERTICAL);
        badge.setPadding(dp(5), dp(3), dp(5), dp(3));
        TextView heart = new TextView(this);
        heart.setText("♥");
        heart.setTextColor(0xFFFFFFFF);
        heart.setTextSize(TypedValue.COMPLEX_UNIT_SP, 9);
        TextView cnt = new TextView(this);
        cnt.setText(" " + fmt(digg));
        cnt.setTextColor(0xFFFFFFFF);
        cnt.setTextSize(TypedValue.COMPLEX_UNIT_SP, 10);
        badge.addView(heart);
        badge.addView(cnt);
        FrameLayout.LayoutParams blp = new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT,
                Gravity.BOTTOM | Gravity.START);
        blp.leftMargin = dp(4);
        blp.bottomMargin = dp(4);
        cell.addView(badge, blp);

        // 置顶
        if (a.optInt("is_top", 0) == 1) {
            TextView top = new TextView(this);
            top.setText("置顶");
            top.setTextColor(0xFFFFFFFF);
            top.setTextSize(TypedValue.COMPLEX_UNIT_SP, 9);
            GradientDrawable tbg = new GradientDrawable();
            tbg.setCornerRadius(dp(3));
            tbg.setColor(0xCC000000);
            top.setBackground(tbg);
            top.setPadding(dp(4), dp(1), dp(4), dp(1));
            FrameLayout.LayoutParams tlp = new FrameLayout.LayoutParams(
                    ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT,
                    Gravity.TOP | Gravity.START);
            tlp.leftMargin = dp(4);
            tlp.topMargin = dp(4);
            cell.addView(top, tlp);
        }

        cell.setOnClickListener(v -> {
            if (id.length() == 0) return;
            Intent r = new Intent();
            r.putExtra("awemeId", id);
            setResult(RESULT_OK, r);
            finish();
        });
        return cell;
    }

    // ---------------- 工具 ----------------

    private static String firstUrl(JSONObject obj) {
        if (obj == null) return "";
        JSONArray arr = obj.optJSONArray("url_list");
        if (arr == null || arr.length() == 0) return "";
        return arr.optString(0, "");
    }

    /** 主页背景图。实测字段：cover_and_head_image_info.{profile_cover_list,cover_list} / cover_url[] / white_cover_url[] */
    private static String coverOf(JSONObject u) {
        try {
            String s = pickFromList(u.optJSONObject("cover_and_head_image_info"), "profile_cover_list");
            if (s.length() > 0) return s;
            s = pickFromList(u.optJSONObject("cover_and_head_image_info"), "cover_list");
            if (s.length() > 0) return s;
            s = pickFromList(u, "cover_url");
            if (s.length() > 0) return s;
            s = pickFromList(u, "white_cover_url");
            if (s.length() > 0) return s;
        } catch (Throwable ignore) {}
        return "";
    }

    /** 从一个 { key: [ "url" | {url_list:[…]} ] } 里取第一张图 */
    private static String pickFromList(JSONObject holder, String key) {
        if (holder == null) return "";
        try {
            Object v = holder.opt(key);
            if (v == null) return "";
            if (v instanceof JSONArray) {
                JSONArray arr = (JSONArray) v;
                for (int i = 0; i < arr.length(); i++) {
                    Object it = arr.opt(i);
                    if (it instanceof String && ((String) it).startsWith("http")) return (String) it;
                    if (it instanceof JSONObject) {
                        String s = firstUrl((JSONObject) it);
                        if (s.length() > 0) return s;
                    }
                }
                return "";
            }
            if (v instanceof JSONObject) return firstUrl((JSONObject) v);
            if (v instanceof String && ((String) v).startsWith("http")) return (String) v;
        } catch (Throwable ignore) {}
        return "";
    }

    private static String fmt(long n) {
        if (n >= 100000000L) {
            double v = n / 100000000.0;
            return trim(v) + "亿";
        }
        if (n >= 10000L) {
            double v = n / 10000.0;
            return trim(v) + "万";
        }
        return String.valueOf(n);
    }

    private static String trim(double v) {
        String s = String.format("%.1f", v);
        if (s.endsWith(".0")) s = s.substring(0, s.length() - 2);
        return s;
    }

    private void toast(String m) {
        try { Toast.makeText(this, m, Toast.LENGTH_SHORT).show(); } catch (Throwable ignore) {}
    }
}
