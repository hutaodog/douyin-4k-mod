/*
 * dypc4k payload —— 抖音 PC 客户端「固定 4K 清晰度」注入脚本
 *
 * 目标：https://www.douyin.com 页面主世界（main world）
 *
 * 原理（逆向自 8.7.0 线上 web 包）：
 *   播放器的"手动清晰度"状态存在 sessionStorage['MANUAL_SWITCH']。
 *   播放器构造时读它的 gearType 作为 userselection：
 *     - 有值 → 跳过推荐流那套「高清白名单 + 码率过滤」，直接用你手选的档位
 *     - 没值 → 走自适应（ABR）白名单，最高只到 normal_1080_0 = 1080P
 *   而 sessionStorage 不落盘，关掉抖音就没了 → 下次又回到 1080P。
 *   本脚本把它一直保持为目标档位，并持久化到 localStorage。
 *
 * 档位取值（chunk player-Clarity 里的 gear 表）：
 *   超清 4K HDR : gearType -3 / gearClarity "30" / gearName "超清 4K HDR"
 *   超清 4K     : gearType -2 / gearClarity "20" / gearName "超清 4K"
 *   超清 2K     : gearType -1 / gearClarity "10" / gearName "超清 2K"
 *   高清 1080P  : gearType  1 / gearClarity  "5" / gearName "高清 1080P"
 *   智能(自动)  : gearType  0 / gearClarity  "0"
 *
 * 改配置（F12 控制台执行后不用刷新）：
 *   __DYPC4K__.setTarget('4k' | '4khdr' | '2k' | '1080p')
 *   __DYPC4K__.setMode('force' | 'remember')
 *   __DYPC4K__.status()
 */
(function () {
  'use strict';
  if (window.__DYPC4K__ && window.__DYPC4K__.version) return;
  // 只在抖音域名下工作
  try {
    var host = (location && location.hostname) || '';
    if (host !== 'douyin.com' && !/(^|\.)douyin\.com$/.test(host)) return;
  } catch (e) { return; }

  var KEY = 'MANUAL_SWITCH';          // 客户端 SessionStorageKeys.manualSwitch
  var CFG_KEY = '__DYPC4K_CFG__';     // localStorage: 用户配置
  var SHAPE_KEY = '__DYPC4K_SHAPE__'; // localStorage: 客户端写过的真实结构（模板）
  var RAW_KEY = '__DYPC4K_RAW__';     // localStorage: 客户端写过的原始字符串
  var STATE_KEY = '__DYPC4K_STATE__'; // localStorage: 最近一次动作（排查用）

  var PRESETS = {
    '4khdr': { gearType: -3, gearClarity: '30', gearName: '超清 4K HDR', qualityType: 1 },
    '4k':    { gearType: -2, gearClarity: '20', gearName: '超清 4K',     qualityType: 1 },
    '2k':    { gearType: -1, gearClarity: '10', gearName: '超清 2K',     qualityType: 1 },
    '1080p': { gearType: 1,  gearClarity: '5',  gearName: '高清 1080P',  qualityType: 1 },
    'auto':  { gearType: 0,  gearClarity: '0',  gearName: '',            qualityType: 0 }
  };
  var DEFAULTS = { target: '4k', mode: 'force' };

  function readJSON(storage, key) {
    try { var raw = storage.getItem(key); return raw ? JSON.parse(raw) : null; }
    catch (e) { return null; }
  }
  function writeJSON(storage, key, value) {
    try { storage.setItem(key, JSON.stringify(value)); } catch (e) {}
  }
  function cfg() {
    var c = readJSON(localStorage, CFG_KEY) || {};
    return {
      target: PRESETS[c.target] ? c.target : DEFAULTS.target,
      mode: c.mode === 'remember' ? 'remember' : DEFAULTS.mode,
      qualityType: typeof c.qualityType === 'number' ? c.qualityType : null
    };
  }
  function preset(c) {
    return PRESETS[c.target] || PRESETS[DEFAULTS.target];
  }
  function buildValue(c) {
    var p = preset(c);
    var base = readJSON(localStorage, SHAPE_KEY);
    var out = {};
    if (base && typeof base === 'object') {
      for (var k in base) if (Object.prototype.hasOwnProperty.call(base, k)) out[k] = base[k];
    }
    out.done = 1;
    out.gearType = p.gearType;
    out.gearClarity = p.gearClarity;
    out.gearName = p.gearName;
    out.qualityType = c.qualityType === null ? p.qualityType : c.qualityType;
    return out;
  }
  function ssGet() {
    try { return sessionStorage.getItem(KEY); } catch (e) { return null; }
  }
  function ssSet(raw) {
    try { sessionStorage.setItem(KEY, raw); return true; } catch (e) { return false; }
  }
  function ssAvailable() {
    try { return !!window.sessionStorage && !!sessionStorage; } catch (e) { return false; }
  }

  var last = { at: 0, action: 'none', value: '' };
  function note(action, value) {
    last = { at: Date.now(), action: action, value: value || '' };
  }

  // 心跳：写进 localStorage（会落盘），用来在客户端外部确认注入确实跑起来了
  var lastBeat = 0;
  function beat(why) {
    var now = Date.now();
    if (now - lastBeat < 1500) return;
    lastBeat = now;
    try {
      localStorage.setItem(STATE_KEY, JSON.stringify({
        at: now, by: 'dypc4k', why: why || '',
        target: cfg().target, mode: cfg().mode,
        manualSwitch: ssGet()
      }));
    } catch (e) {}
  }

  function tick() {
    if (!ssAvailable()) return;
    var c = cfg();
    var cur = ssGet();
    beat('tick');

    if (c.mode === 'remember') {
      if (!cur) {
        var persisted = null;
        try { persisted = localStorage.getItem(RAW_KEY); } catch (e) {}
        if (persisted && ssSet(persisted)) note('restore', persisted);
      }
      // cur 存在时：setItem 钩子已经把结构 / 原始串写进 localStorage，这里不用再处理
      return;
    }

    var p = preset(c);
    var want = JSON.stringify(buildValue(c));
    if (cur === want) return;

    var keep = false;
    if (cur) {
      try {
        var parsed = JSON.parse(cur);
        keep = parsed && parsed.gearType === p.gearType && String(parsed.gearClarity) === p.gearClarity;
      } catch (e) {}
    }
    if (!keep && ssSet(want)) note('force', want);
  }

  // 观察客户端自己的写入：学习结构（模板）/ remember 模式记录
  try {
    var proto = window.Storage && window.Storage.prototype;
    if (proto && proto.setItem && !proto.__dypc4k) {
      var origSet = proto.setItem;
      proto.setItem = function (k, v) {
        var r = origSet.apply(this, arguments);
        try {
          if (String(k) === KEY) {
            var o = null;
            try { o = JSON.parse(v); } catch (e) {}
            if (o && typeof o === 'object') {
              writeJSON(localStorage, SHAPE_KEY, o);
              try { localStorage.setItem(RAW_KEY, String(v)); } catch (e) {}
            }
          }
        } catch (e) {}
        return r;
      };
      // 关键：客户端根布局挂载时会 pC(MANUAL_SWITCH) = removeItem，这里当场补回去
      var origRemove = proto.removeItem;
      if (origRemove) {
        proto.removeItem = function (k) {
          var r = origRemove.apply(this, arguments);
          try {
            if (String(k) === KEY && cfg().mode === 'force') {
              note('restore-after-remove', '');
              ssSet(JSON.stringify(buildValue(cfg())));
            }
          } catch (e) {}
          return r;
        };
      }
      proto.__dypc4k = 1;
    }
  } catch (e) {}

  tick();
  // 启动阶段密集补写（客户端 mount 时会清一次），之后降频常驻
  [0, 30, 80, 160, 320, 600, 1000, 1600].forEach(function (ms) { setTimeout(tick, ms); });
  setInterval(tick, 400);
  document.addEventListener('visibilitychange', tick, false);
  window.addEventListener('focus', tick, false);
  window.addEventListener('pageshow', tick, false);

  window.__DYPC4K__ = {
    version: 1,
    key: KEY,
    status: function () {
      return { target: cfg().target, mode: cfg().mode, sessionStorage: ssGet(), last: last };
    },
    get config() { return cfg(); },
    get value() { return ssGet(); },
    get last() { return last; },
    setTarget: function (t) {
      if (!PRESETS[t]) return 'target 必须是: ' + Object.keys(PRESETS).join(' / ');
      var c = readJSON(localStorage, CFG_KEY) || {};
      c.target = t; writeJSON(localStorage, CFG_KEY, c); tick();
      return 'target=' + t;
    },
    setMode: function (m) {
      if (m !== 'force' && m !== 'remember') return 'mode 必须是 force / remember';
      var c = readJSON(localStorage, CFG_KEY) || {};
      c.mode = m; writeJSON(localStorage, CFG_KEY, c); tick();
      return 'mode=' + m;
    },
    reset: function () { try { localStorage.removeItem(CFG_KEY); } catch (e) {} tick(); return 'reset'; },
    push: tick
  };
})();
