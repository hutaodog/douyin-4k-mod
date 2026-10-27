/* ==== dypc4k-gearprobe begin ==== */
/* 码流档位探针（只读，不改变任何行为）
 * 目的：搞清楚"客户端自己拿到的档位表"里到底有哪些档、以及请求带了什么参数。
 *   - 钩主世界的 fetch / XMLHttpRequest，抓含 bit_rate 的响应
 *   - 记录每个 aweme 的档位：gear_name / quality_type / 宽高 / 码率 / 编码 / format
 *   - 记录 <video> 真实解码分辨率（用来对照"客户端到底播了哪档"）
 *   - 记录请求 URL 里的关键参数（pc_client_type / version_code / device_platform）
 * 输出：%APPDATA%\douyin\dypc4k-gear.log
 */
;(function () {
  var fs, path, LOG;
  try {
    fs = require('fs');
    path = require('path');
    var dir = process.env.APPDATA + '\\douyin';
    try { fs.mkdirSync(dir); } catch (e) {}
    LOG = path.join(dir, 'dypc4k-gear.log');
  } catch (e) { return; }

  var WID = Math.random().toString(36).slice(2, 6);
  var t0 = Date.now();
  function stamp() {
    try { return new Date().toISOString().slice(11, 23); } catch (e) { return String(Date.now() - t0); }
  }
  function write(line) {
    try {
      try { if (fs.statSync(LOG).size > 2 * 1024 * 1024) fs.truncateSync(LOG, 0); } catch (e) {}
      fs.appendFileSync(LOG, line + '\n');
    } catch (e) {}
  }
  write('# gearprobe start ' + new Date().toISOString() + ' wid=' + WID);

  // ---------------- 主世界钩子 ----------------
  var MAIN = '(' + function (wid) {
    if (window.__dy4kGearHooked) return;
    window.__dy4kGearHooked = 1;
    window.__dy4kGear = [];
    var seen = {};
    var MAXQ = 400;

    function push(ev) {
      try {
        if (window.__dy4kGear.length > MAXQ) window.__dy4kGear.shift();
        ev.wid = wid;
        ev.t = Date.now();
        window.__dy4kGear.push(ev);
      } catch (e) {}
    }

    function params(url) {
      try {
        var u = new URL(url, location.href);
        var keep = ['device_platform', 'aid', 'pc_client_type', 'version_code', 'pc_libra_divert',
          'support_h265', 'support_bytevc1', 'video_quality_type', 'aweme_id', 'aweme_ids'];
        var o = {};
        keep.forEach(function (k) { if (u.searchParams.has(k)) o[k] = u.searchParams.get(k); });
        o._path = u.pathname;
        return o;
      } catch (e) { return { _path: String(url).slice(0, 80) }; }
    }

    // 从任意 JSON 里挖 aweme + 档位表
    function dig(root, url) {
      var out = [];
      var stack = [{ v: root, d: 0 }];
      var budget = 4000;
      while (stack.length && budget-- > 0) {
        var it = stack.pop();
        var v = it.v;
        if (!v || typeof v !== 'object' || it.d > 6) continue;
        if (Array.isArray(v)) {
          for (var i = 0; i < v.length && i < 60; i++) stack.push({ v: v[i], d: it.d + 1 });
          continue;
        }
        var vid = v.video;
        if (vid && typeof vid === 'object' && Array.isArray(vid.bit_rate) && vid.bit_rate.length) {
          var gears = vid.bit_rate.map(function (b) {
            var pa = b && b.play_addr || {};
            return {
              g: b && b.gear_name, qt: b && b.quality_type,
              w: pa.width, h: pa.height,
              k: Math.round(((b && b.bit_rate) || 0) / 1000),
              c: (b && (b.is_h265 || b.is_bytevc1)) ? 'h265' : 'h264',
              f: b && b.format
            };
          });
          var maxH = 0;
          gears.forEach(function (g) { if ((g.h || 0) > maxH) maxH = g.h; });
          out.push({ id: String(v.aweme_id || ''), n: gears.length, maxH: maxH, gears: gears });
        }
        for (var k in v) {
          if (!Object.prototype.hasOwnProperty.call(v, k)) continue;
          var child = v[k];
          if (child && typeof child === 'object') stack.push({ v: child, d: it.d + 1 });
        }
      }
      return out;
    }

    function handle(url, text) {
      try {
        if (!text || text.length < 200 || text.length > 6 * 1024 * 1024) return;
        if (text.indexOf('bit_rate') < 0) return;
        var j;
        try { j = JSON.parse(text); } catch (e) { return; }
        var found = dig(j, url);
        if (!found.length) return;
        var p = params(url);
        found.forEach(function (f) {
          var key = f.id + '|' + f.n + '|' + f.maxH;
          if (seen[key]) return;
          seen[key] = 1;
          push({ type: 'gears', id: f.id, n: f.n, maxH: f.maxH, gears: f.gears, req: p });
        });
      } catch (e) {}
    }

    // --- fetch ---
    var realFetch = window.fetch;
    if (realFetch) {
      window.fetch = function (input, init) {
        var url = (typeof input === 'string') ? input : (input && input.url) || '';
        var pr = realFetch.apply(this, arguments);
        try {
          pr.then(function (res) {
            try {
              var ct = (res.headers && res.headers.get && res.headers.get('content-type')) || '';
              if (ct.indexOf('json') < 0) return;
              res.clone().text().then(function (t) { handle(url, t); }).catch(function () {});
            } catch (e) {}
            return res;
          }).catch(function () {});
        } catch (e) {}
        return pr;
      };
    }

    // --- XHR ---
    var XP = window.XMLHttpRequest && window.XMLHttpRequest.prototype;
    if (XP && XP.open && XP.send) {
      var realOpen = XP.open, realSend = XP.send;
      XP.open = function (m, u) { this.__u = u; return realOpen.apply(this, arguments); };
      XP.send = function () {
        var self = this;
        try {
          self.addEventListener('load', function () {
            try {
              var ct = self.getResponseHeader && self.getResponseHeader('content-type') || '';
              if (ct.indexOf('json') < 0) return;
              if (self.responseType && self.responseType !== '' && self.responseType !== 'text') return;
              handle(self.__u, self.responseText);
            } catch (e) {}
          });
        } catch (e) {}
        return realSend.apply(this, arguments);
      };
    }

    // --- <video> 真实解码分辨率 ---
    function watchVideo(v) {
      if (!v || v.__dy4kWatched) return;
      v.__dy4kWatched = 1;
      function rec(tag) {
        try {
          push({
            type: 'video', tag: tag,
            w: v.videoWidth, h: v.videoHeight,
            src: String(v.currentSrc || v.src || '').split('?')[0].slice(-60),
            page: (location.pathname || '').slice(0, 40)
          });
        } catch (e) {}
      }
      v.addEventListener('loadedmetadata', function () { rec('meta'); });
      v.addEventListener('resize', function () { rec('resize'); });
      v.addEventListener('playing', function () { rec('playing'); });
    }
    function scanVideos() {
      try {
        var vs = document.querySelectorAll('video');
        for (var i = 0; i < vs.length; i++) watchVideo(vs[i]);
      } catch (e) {}
    }
    scanVideos();
    try { setInterval(scanVideos, 2000); } catch (e) {}

    // 清晰度菜单里的文案（打开菜单时能看到"可选档位"）
    try {
      new MutationObserver(function () {
        try {
          var txt = document.body && document.body.innerText || '';
          var m = txt.match(/可选档位[\s:：]*([^\n]{0,120})/);
          if (m && !window.__dy4kMenuLogged) {
            window.__dy4kMenuLogged = 1;
            push({ type: 'menu', text: m[1].trim() });
          }
        } catch (e) {}
      }).observe(document.documentElement, { subtree: true, childList: true });
    } catch (e) {}
  } + ')';

  // ---------------- 注入主世界 ----------------
  var inject = null;
  try {
    var wf = require('electron').webFrame;
    if (wf && wf.executeJavaScript) {
      inject = function (code) { try { wf.executeJavaScript(code, true); } catch (e) {} };
    }
  } catch (e) {}
  if (!inject && window.top === window) {
    // 兜底：直接写 script 标签
    inject = function (code) {
      try {
        var s = document.createElement('script');
        s.textContent = code;
        (document.head || document.documentElement).appendChild(s);
        s.remove();
      } catch (e) {}
    };
  }
  if (inject) inject(MAIN + '(' + JSON.stringify(WID) + ')');

  // ---------------- 轮询主世界缓冲，落盘 ----------------
  var flush = null;
  try {
    var wf2 = require('electron').webFrame;
    if (wf2 && wf2.executeJavaScript) {
      flush = function () {
        try {
          var pr = wf2.executeJavaScript(
            '(function(){try{var a=window.__dy4kGear||[];window.__dy4kGear=[];return JSON.stringify(a)}catch(e){return "[]"}})()',
            true);
          if (pr && pr.then) {
            pr.then(function (s) {
              try {
                var arr = JSON.parse(s || '[]');
                arr.forEach(function (e) {
                  write(stamp() + '\t' + (e.type === 'gears' ? 'G' : e.type === 'video' ? 'V' : 'M') + '\t' +
                    JSON.stringify(e));
                });
              } catch (e2) {}
            }).catch(function () {});
          }
        } catch (e) {}
      };
    }
  } catch (e) {}
  if (flush) {
    try { setInterval(flush, 1500); } catch (e) {}
    setTimeout(flush, 4000);
  } else {
    write(stamp() + '\tE\tno webFrame, cannot flush');
  }
})();
/* ==== dypc4k-gearprobe end ==== */
