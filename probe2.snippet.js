/* ==== dypc4k-probe2 begin ==== */
/* 诊断探针 v2：记录
 *   1) 页面主世界里对 sessionStorage['MANUAL_SWITCH'] 的每一次 set / remove（含调用栈头）
 *   2) 每个 <video> 的真实解码分辨率 / currentSrc 变化
 *   3) 清晰度菜单里当前能看到的档位文案（菜单打开时）
 *   4) 补丁自己的写入
 * 输出：%APPDATA%\douyin\dypc4k-diag.log
 *
 * 用 webFrame.executeJavaScript 把钩子装进"页面主世界"——这是客户端自己的 preload 也在用的通道
 * （它用同一招给页面派发 JSBridge 事件），所以我们不改任何文件也能拿到主世界视角。
 */
;(function () {
  if (!/^(www\.)?douyin\.com$/.test((location && location.hostname) || '')) return;
  var fs, path, LOG, seq = 0, t0 = Date.now();
  var WID = Math.random().toString(36).slice(2, 7);   // 每个渲染世界一个短 ID，避免多窗口日志混在一起
  try {
    fs = require('fs');
    path = require('path');
    var dir = process.env.APPDATA + '\\douyin';
    LOG = path.join(dir, 'dypc4k-diag.log');
  } catch (e) { return; }
  function stamp() {
    try { return new Date().toISOString().slice(11, 23); } catch (e) { return String(Date.now() - t0) + 'ms'; }
  }
  function write(kind, data) {
    try {
      if (fs.statSync(LOG).size > 1024 * 1024) fs.truncateSync(LOG, 0);
    } catch (e) {}
    try {
      fs.appendFileSync(LOG, stamp() + '\t' + WID + '\t+' + (Date.now() - t0) + 'ms\t' + kind + '\t' + data + '\n');
    } catch (e) {}
  }

  // ---------- 1) 主世界钩子 ----------
  var MAIN_HOOK = '(' + function () {
    if (window.__dypc4kHook) return;
    window.__dypc4kHook = 1;
    var post = function (payload) {
      try { window.postMessage({ __dypc4k: 1, payload: payload }, '*'); } catch (e) {}
    };
    var K = 'MANUAL_SWITCH';
    var proto = window.Storage && window.Storage.prototype;
    if (!proto) return;
    var set = proto.setItem, rem = proto.removeItem, get = proto.getItem;
    var stack = function () {
      try { return (new Error()).stack.split('\n').slice(1, 5).join(' | ').replace(/\s+/g, ' ').slice(0, 260); }
      catch (e) { return ''; }
    };
    proto.setItem = function (k, v) {
      var r = set.apply(this, arguments);
      try { if (String(k) === K) post({ op: 'set', v: String(v).slice(0, 600), stack: stack() }); } catch (e) {}
      return r;
    };
    proto.removeItem = function (k) {
      var r = rem.apply(this, arguments);
      try { if (String(k) === K) post({ op: 'remove', stack: stack() }); } catch (e) {}
      return r;
    };
    var getCount = 0;
    proto.getItem = function (k) {
      var r = get.apply(this, arguments);
      try { if (String(k) === K && getCount++ < 12) post({ op: 'get', got: String(r).slice(0, 200) }); } catch (e) {}
      return r;
    };
    post({ op: 'hooked' });
  }.toString() + ')()';

  try {
    // 需要在主世界执行：preload 里 webFrame.executeJavaScript 就是主世界
    require('electron').webFrame.executeJavaScript(MAIN_HOOK).catch(function () {});
    write('info', 'main-world hook dispatched');
  } catch (e) {
    write('error', 'executeJavaScript failed: ' + e.message);
  }

  window.addEventListener('message', function (ev) {
    var d = ev && ev.data;
    if (!d || d.__dypc4k !== 1) return;
    var p = d.payload || {};
    write('storage.' + (p.op || '?'), JSON.stringify({ v: p.v, got: p.got, stack: p.stack }));
  }, false);

  // ---------- 2) 分辨率 / currentSrc / 缓冲 / 媒体事件 ----------
  var lastRes = '', lastSrc = '', seen = [];
  function instrument(v) {
    if (!v || seen.indexOf(v) >= 0) return;
    seen.push(v);
    var tag = function (n) {
      return function () {
        var extra = '';
        try {
          if (n === 'error') extra = ' code=' + (v.error && v.error.code) + ' msg=' + String(v.error && v.error.message).slice(0, 60);
          else extra = ' rs=' + v.readyState + ' ns=' + v.networkState + ' ' + (v.videoWidth || 0) + 'x' + (v.videoHeight || 0);
        } catch (e) {}
        write('media.' + n, extra);
      };
    };
    ['error', 'waiting', 'stalled', 'emptied', 'loadedmetadata', 'resize', 'suspend'].forEach(function (n) {
      try { v.addEventListener(n, tag(n), false); } catch (e) {}
    });
  }
  function bufAhead(v) {
    try {
      if (!v.buffered || !v.buffered.length) return -1;
      return Math.round((v.buffered.end(v.buffered.length - 1) - (v.currentTime || 0)) * 10) / 10;
    } catch (e) { return -1; }
  }
  function scanVideo() {
    try {
      var vs = [].slice.call(document.querySelectorAll('video'));
      vs.forEach(instrument);
      var res = vs.map(function (v) { return (v.videoWidth || 0) + 'x' + (v.videoHeight || 0); });
      var srcs = vs.map(function (v) { return String(v.currentSrc || '').slice(0, 140); });
      // 把第一个"在播"视频的缓冲也带上，便于判断是不是卡了才降档
      var live = null;
      for (var i = 0; i < vs.length; i++) if (vs[i].videoWidth && !vs[i].paused) { live = vs[i]; break; }
      var sigInfo = res.join(',') + ' | buf=' + (live ? bufAhead(live) : 'n/a') + ' rs=' + (live ? live.readyState : '-');
      var resSig = JSON.stringify(res);
      var srcSig = JSON.stringify(srcs);
      if (sigInfo !== lastRes) { lastRes = sigInfo; write('video.res', resSig + '  buf=' + (live ? bufAhead(live) : 'n/a')); }
      if (srcSig !== lastSrc) { lastSrc = srcSig; write('video.src', srcSig); }
    } catch (e) {}
  }

  // ---------- 3) 清晰度菜单文案 ----------
  var lastMenu = '';
  function scanMenu() {
    try {
      var texts = [];
      var nodes = document.querySelectorAll('[class*="clarity" i], [class*="playclarity" i]');
      for (var i = 0; i < nodes.length && i < 80; i++) {
        var t = (nodes[i].innerText || '').trim();
        if (t && t.length < 200) texts.push(t.replace(/\s+/g, ' '));
      }
      var uniq = [];
      for (var j = 0; j < texts.length; j++) if (uniq.indexOf(texts[j]) < 0) uniq.push(texts[j]);
      var sig = JSON.stringify(uniq);
      if (sig !== lastMenu) { lastMenu = sig; write('menu', sig); }
    } catch (e) {}
  }

  scanVideo(); scanMenu();
  setInterval(scanVideo, 300);
  setInterval(scanMenu, 800);
  write('info', 'probe2 ready');
})();
/* ==== dypc4k-probe2 end ==== */
