package com.dypc4k.douyink4;

import android.media.MediaDataSource;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * 带请求头的分块 HTTP 数据源。
 *
 * 为什么需要：抖音 CDN（douyinvod）对 4K 直链要求带 `Referer: https://www.douyin.com/`，
 * 不带就是 403；而 MediaPlayer.setDataSource(String) 没法加请求头。
 * 这里实现 MediaDataSource，用 Range 请求自己取数据，顺带做 1MB 块的滑动缓存。
 *
 * 实测：不带 Referer → 403；带上 → 200 + Content-Length(119,582,918)。
 */
public class HttpMediaSource extends MediaDataSource {

    private static final int BLOCK = 1 << 20;      // 1 MB / 块
    private static final int MAX_BLOCKS = 24;      // ~24 MB 缓存，够 4K 顺序播

    private final String url;
    private final String referer;
    private final String userAgent;
    private final String cookie;      // 抖音的 4K/直链会校验 webid 等 cookie，必须带上

    private long totalSize = -1;
    private boolean closed;

    private final LinkedHashMap<Long, byte[]> cache =
            new LinkedHashMap<Long, byte[]>(16, 0.75f, true) {
                @Override
                protected boolean removeEldestEntry(Map.Entry<Long, byte[]> eldest) {
                    return size() > MAX_BLOCKS;
                }
            };

    public HttpMediaSource(String url, String referer, String userAgent) {
        this.url = url;
        this.referer = referer;
        this.userAgent = userAgent;
        String ck = null;
        try {
            // CDN 域名（douyinvod.com）自己没 cookie，鉴权用的是 douyin.com 的（webid 等），
            // 所以两个都取一遍，谁有就带谁。
            ck = android.webkit.CookieManager.getInstance().getCookie(url);
            if (ck == null || ck.length() == 0) {
                ck = android.webkit.CookieManager.getInstance().getCookie("https://www.douyin.com/");
            }
        } catch (Throwable t) {
            android.util.Log.w("dy4k", "cookie lookup failed: " + t);
        }
        this.cookie = ck;
        android.util.Log.i("dy4k", "HttpMediaSource cookie=" + (ck == null ? "null" : ck.length() + "B"));
    }

    private String hostOf() {
        try { return new URL(url).getHost(); } catch (Throwable t) { return "?"; }
    }

    private HttpURLConnection open(long start, long end) throws IOException {        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        c.setInstanceFollowRedirects(true);
        c.setConnectTimeout(15000);
        c.setReadTimeout(25000);
        c.setRequestProperty("Referer", referer);
        c.setRequestProperty("User-Agent", userAgent);
        if (cookie != null && cookie.length() > 0) c.setRequestProperty("Cookie", cookie);
        c.setRequestProperty("Accept-Encoding", "identity");
        c.setRequestProperty("Accept", "*/*");
        if (start >= 0) c.setRequestProperty("Range", "bytes=" + start + "-" + end);
        return c;
    }

    private void probeSize() throws IOException {
        if (totalSize >= 0) return;
        android.util.Log.i("dy4k", "probeSize start thread=" + Thread.currentThread().getName());
        HttpURLConnection c = null;
        try {
            c = open(0, 0);
            int code = c.getResponseCode();
            android.util.Log.i("dy4k", "probeSize http=" + code + " len=" + c.getContentLengthLong());
            if (code != 200 && code != 206) throw new IOException("probe HTTP " + code);
            String cr = c.getHeaderField("Content-Range");     // bytes 0-0/119582918
            if (cr != null) {
                int slash = cr.indexOf('/');
                if (slash > 0) {
                    try { totalSize = Long.parseLong(cr.substring(slash + 1).trim()); } catch (Exception ignore) {}
                }
            }
            if (totalSize < 0) {
                long len = c.getContentLengthLong();
                if (len > 0) totalSize = len;
            }
        } finally {
            if (c != null) c.disconnect();
        }
        if (totalSize <= 0) throw new IOException("cannot determine size");
    }

    private byte[] fetchBlock(long start) throws IOException {
        long end = start + BLOCK - 1;
        for (int attempt = 0; attempt < 2; attempt++) {
            HttpURLConnection c = null;
            try {
                c = open(start, end);
                int code = c.getResponseCode();
                if (code != 200 && code != 206) {
                    android.util.Log.w("dy4k", "HttpMediaSource HTTP " + code + " @" + start + " host=" + hostOf());
                    throw new IOException("block HTTP " + code);
                }
                if (totalSize < 0) {
                    String cr = c.getHeaderField("Content-Range");
                    if (cr != null) {
                        int slash = cr.indexOf('/');
                        if (slash > 0) {
                            try { totalSize = Long.parseLong(cr.substring(slash + 1).trim()); } catch (Exception ignore) {}
                        }
                    }
                }
                InputStream in = c.getInputStream();
                ByteArrayOutputStream bos = new ByteArrayOutputStream(BLOCK);
                byte[] buf = new byte[65536];
                int n;
                while ((n = in.read(buf)) > 0) bos.write(buf, 0, n);
                in.close();
                if (bos.size() == 0) throw new IOException("empty block");
                return bos.toByteArray();
            } catch (IOException e) {
                if (attempt == 1) throw e;
                try { Thread.sleep(150); } catch (InterruptedException ignore) {}
            } finally {
                if (c != null) c.disconnect();
            }
        }
        return null;
    }

    private byte[] block(long start) throws IOException {
        synchronized (cache) {
            byte[] b = cache.get(start);
            if (b != null) return b;
        }
        byte[] fresh = fetchBlock(start);
        if (fresh == null) return null;
        synchronized (cache) { cache.put(start, fresh); }
        return fresh;
    }

    @Override
    public int readAt(long position, byte[] buffer, int offset, int size) throws IOException {
        if (closed || size <= 0) return -1;
        if (totalSize < 0) probeSize();
        if (totalSize > 0 && position >= totalSize) return -1;

        long blockStart = (position / BLOCK) * BLOCK;
        int inBlock = (int) (position - blockStart);
        byte[] blk = block(blockStart);
        if (blk == null) return -1;
        int avail = blk.length - inBlock;
        if (avail <= 0) return -1;
        int n = Math.min(size, avail);
        System.arraycopy(blk, inBlock, buffer, offset, n);
        return n;
    }

    @Override
    public long getSize() throws IOException {
        if (totalSize < 0) probeSize();
        return totalSize;
    }

    @Override
    public void close() {
        closed = true;
        synchronized (cache) { cache.clear(); }
    }
}
