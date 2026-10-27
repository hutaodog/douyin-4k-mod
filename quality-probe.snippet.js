/* ==== dypc4k-probe begin ==== */
/* 质量探针（可选装）：把页面上每个 <video> 的真实解码分辨率 + 当前 MANUAL_SWITCH
 * 追加写到 %APPDATA%\douyin\dypc4k-quality.log，用来从外部确认"到底是不是 2160p"。
 * 注意：DOM 在隔离世界与页面共享，所以 preload 里能读到页面 <video> 的 videoWidth/videoHeight。
 * 不需要时用 uninstall-preload.ps1 或手动删掉本段。
 */
;(function () {
  if (!/^(www\.)?douyin\.com$/.test((location && location.hostname) || '')) return;
  var dir = (typeof process !== 'undefined' && process.env && process.env.APPDATA)
    ? process.env.APPDATA + '\\douyin' : null;
  if (!dir) return;
  var fs, path, LOG;
  try {
    fs = require('fs');
    path = require('path');
    LOG = path.join(dir, 'dypc4k-quality.log');
  } catch (e) { return; }

  var last = '';
  function tick() {
    try {
      var videos = [].slice.call(document.querySelectorAll('video'));
      var rows = videos.map(function (v) {
        return {
          w: v.videoWidth || 0,
          h: v.videoHeight || 0,
          paused: !!v.paused,
          t: Math.round(v.currentTime || 0),
          src: (function () {
            try { return new URL(v.currentSrc || '').host; } catch (e) { return ''; }
          })()
        };
      }).filter(function (r) { return r.w || r.h; });
      if (!rows.length) return;
      var ms = sessionStorage.getItem('MANUAL_SWITCH');
      var sig = JSON.stringify([rows.map(function (r) { return r.w + 'x' + r.h; }), ms]);
      if (sig === last) return;
      last = sig;
      var line = new Date().toISOString() + ' ' + sig + '\n';
      var st = null;
      try { st = fs.statSync(LOG); } catch (e) {}
      if (st && st.size > 512 * 1024) fs.truncateSync(LOG, 0);   // 简单封顶
      fs.appendFileSync(LOG, line);
    } catch (e) {}
  }
  tick();
  setInterval(tick, 1500);
})();
/* ==== dypc4k-probe end ==== */
