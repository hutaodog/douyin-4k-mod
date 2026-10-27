/* ==== dypc4k begin ==== */
/* 探针：确认这段代码是否被 Electron 当作 preload 执行，以及 preload 里能用哪些通道 */
;(function () {
  var MARK = 'dypc4k-probe';
  var record = function (how, payload) {
    var line = new Date().toISOString() + ' ' + how + ' ' + JSON.stringify(payload) + '\n';
    var done = false;
    // 1) 直接写文件（sandbox=false 时可用）
    try {
      var fs = require('fs');
      var path = require('path');
      var dir = process.env.APPDATA ? process.env.APPDATA + '\\douyin' : '.';
      fs.appendFileSync(path.join(dir, 'dypc4k-probe.log'), line);
      done = true;
    } catch (e) {}
    // 2) localStorage（会随 LevelDB 落盘）
    try {
      localStorage.setItem('__DYPC4K_PROBE__', line);
      done = true;
    } catch (e) {}
    // 3) cookie（落 Cookies sqlite）
    try { document.cookie = '__DYPC4K_PROBE__=1; path=/'; done = true; } catch (e) {}
    return done;
  };
  try {
    record('loaded', {
      href: String(location && location.href),
      host: String(location && location.hostname),
      isolated: (typeof process !== 'undefined' && process.contextIsolated) || null,
      hasRequire: typeof require,
      hasElectron: (function () { try { return typeof require('electron').ipcRenderer; } catch (e) { return 'err:' + e.message; } })(),
      hasSession: (function () { try { sessionStorage.setItem('__p', '1'); sessionStorage.removeItem('__p'); return true; } catch (e) { return 'err:' + e.message; } })(),
      hasLocal: (function () { try { localStorage.setItem('__p', '1'); localStorage.removeItem('__p'); return true; } catch (e) { return 'err:' + e.message; } })(),
      hasStorageClass: typeof Storage
    });
    // 再在 document 就绪和 2s 后各补一次，确认时序
    try { document.addEventListener('DOMContentLoaded', function () { record('dom-ready', { href: String(location.href) }); }, false); } catch (e) {}
    setTimeout(function () { record('later', { href: String(location.href) }); }, 2000);
  } catch (e) {}
})();
/* ==== dypc4k end ==== */
