package com.dypc4k.douyink4;

import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.util.LruCache;
import android.widget.ImageView;

import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * 极简图片加载器（不引第三方库）：
 * 抖音的图床（douyinpic / douyinstatic）要带 Referer 才给图，ImageView 自己带不了头，所以自己拉。
 * 带内存缓存 + 两线程队列 + 按目标尺寸降采样。
 */
public final class ImgLoader {

    private static final String REFERER = "https://www.douyin.com/";
    private static final String UA =
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) " +
            "Chrome/131.0.0.0 Safari/537.36";

    private static final ExecutorService POOL = Executors.newFixedThreadPool(3);
    private static final LruCache<String, Bitmap> CACHE;

    static {
        int maxKb = (int) (Runtime.getRuntime().maxMemory() / 1024 / 8);
        CACHE = new LruCache<String, Bitmap>(Math.min(maxKb, 32 * 1024)) {
            @Override
            protected int sizeOf(String key, Bitmap value) {
                return value.getByteCount() / 1024;
            }
        };
    }

    private ImgLoader() {}

    public static void load(final ImageView iv, final String url) {
        load(iv, url, 0, 0);
    }

    public static void load(final ImageView iv, final String url, final int reqW, final int reqH) {
        if (iv == null) return;
        if (url == null || url.length() < 8) { iv.setImageDrawable(null); return; }
        iv.setTag(url);
        Bitmap cached = CACHE.get(url);
        if (cached != null) { iv.setImageBitmap(cached); return; }
        iv.setImageDrawable(null);
        final int w = reqW > 0 ? reqW : iv.getWidth();
        final int h = reqH > 0 ? reqH : iv.getHeight();
        POOL.execute(() -> {
            final Bitmap bmp = fetch(url, w, h);
            if (bmp == null) return;
            CACHE.put(url, bmp);
            iv.post(() -> {
                Object tag = iv.getTag();
                if (tag != null && tag.equals(url)) iv.setImageBitmap(bmp);
            });
        });
    }

    private static Bitmap fetch(String url, int reqW, int reqH) {
        HttpURLConnection c = null;
        try {
            c = (HttpURLConnection) new URL(url).openConnection();
            c.setConnectTimeout(12000);
            c.setReadTimeout(15000);
            c.setInstanceFollowRedirects(true);
            c.setRequestProperty("Referer", REFERER);
            c.setRequestProperty("User-Agent", UA);
            c.setRequestProperty("Accept", "image/*,*/*");
            int code = c.getResponseCode();
            if (code < 200 || code >= 400) return null;

            // 先只读头部算出采样率，再重新请求一遍（图床支持 Range，但这里简化处理）
            int sample = 1;
            if (reqW > 0) {
                int cw = c.getContentLength() > 0 ? 0 : 0; // 尺寸未知，用短边目标估算
                while (reqW * sample < 600 && sample < 8) sample++;
            }
            BitmapFactory.Options o = new BitmapFactory.Options();
            o.inSampleSize = Math.max(1, sample);
            o.inPreferredConfig = Bitmap.Config.RGB_565;
            InputStream in = c.getInputStream();
            Bitmap bmp = BitmapFactory.decodeStream(in, null, o);
            in.close();
            return bmp;
        } catch (Throwable t) {
            return null;
        } finally {
            if (c != null) c.disconnect();
        }
    }
}
