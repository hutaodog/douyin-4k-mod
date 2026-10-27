// ==UserScript==
// @name         抖音 4K 固定 + 类 App 界面（手机网页版）
// @namespace    dypc4k
// @version      2.0.0
// @description  在手机浏览器（Kiwi/Tampermonkey）里加载 www.douyin.com 的桌面版网页，固定最高清晰度、关掉自动降档，并把界面改成接近 App 的全屏竖屏形态
// @author       dypc4k
// @match        https://www.douyin.com/*
// @match        https://www-hj.douyin.com/*
// @match        https://m.douyin.com/*
// @grant        none
// @run-at       document-start
// ==/UserScript==

/*
 * ============================ 先看这里 ============================
 * 1) 手机浏览器必须切「桌面版网站 / Request desktop site」。
 *    移动版网页（m.douyin.com 那套引流页）只给 720P 带 logo 的 playwm 流，
 *    没有清晰度菜单、也不拉 AB 配置。脚本会检测到并提示你切换。
 *
 * 2) 4K 码流是 HEVC（h265）。网页客户端用一个 isHas2K() 卡住 2K/4K：
 *       isHas2K() = AB 的 has_2k 为真
 *                 || (Windows 且 CPU 核数 > 8)
 *                 || (Mac / 鸿蒙 且 CPU 核数 >= 8)
 *    手机只可能靠第一条。实测服务端下发的是 data.has_2k.val = 2，而 2 不解锁 4K
 *    （手选 4K 后客户端会把 4K/2K 从列表里剔掉，回落到 1080P/720P）；
 *    强制改成 1 才稳定（CFG.force2k）。改法有两条通道：响应改写 + window.abTestData 轮询。
 *
 * 3) 三件事分工：
 *      第 1 层  sessionStorage['MANUAL_SWITCH'] = 超清 4K   （让播放器以为你手选了 4K）
 *      第 2 层  AB 响应改写：has_2k=1 + 关掉自动重选/降档（真正止血的一层）
 *      第 3 层  界面对齐：全屏播放器 / 隐藏 web 外壳 / 底部标签栏 / HUD
 * ==================================================================
 */
(function () {
  'use strict';

  // ================== 配置（都能在控制台用 dy4k.* 改） ==================
  var CFG = {
    target: '4k',        // 4khdr / 4k / 2k / 1080p
    abPatch: true,       // 关掉服务端 AB 里的自动重选/降档
    force2k: true,       // ★ 把 AB 的 has_2k 打开（手机能不能上 2K/4K 的唯一开关）
    forceHdr: false,     // 可选：has_hdr 打开（需要设备真支持 10bit HDR，一般别开）
    killAutoDefi: true,  // 关掉播放器的"自动清晰度"（isPlayAutoDefi / isOpenAutoDefi）
    uiRestyle: true,     // 类 App 界面（全屏播放器 + 隐藏 web 外壳 + 底部标签栏）
    hud: false,          // 角标：分辨率 / 档位 / 实测 fps / 实测码率（默认关，dy4k.hud(true) 打开）
    tabbar: true,        // 底部标签栏（从网页版左侧导航克隆）
    nativeBtn: true,     // App 内：视频页显示「原生 4K」按钮（WebView 没有 HEVC，只能交给原生硬解）
    debug: false         // 控制台打印
  };

  var PRESETS = {
    '4khdr': { gearType: -3, gearClarity: '30', gearName: '超清 4K HDR', qualityType: 1 },
    '4k':    { gearType: -2, gearClarity: '20', gearName: '超清 4K',     qualityType: 1 },
    '2k':    { gearType: -1, gearClarity: '10', gearName: '超清 2K',     qualityType: 1 },
    '1080p': { gearType: 1,  gearClarity: '5',  gearName: '高清 1080P',  qualityType: 1 }
  };
  var p = PRESETS[CFG.target] || PRESETS['4k'];
  var K = 'MANUAL_SWITCH';
  var RAW = '__DY4K_RAW__';
  var TAG = '[dy4k]';

  // 统计（HUD 用）
  var STAT = { abHits: 0, abKeys: [], storeWrites: 0, downgrades: 0, patchAt: 0, nsHits: 0 };

  function log() {
    if (!CFG.debug) return;
    try { console.log.apply(console, [TAG].concat([].slice.call(arguments))); } catch (e) {}
  }
  function nowMs() { try { return Math.round(performance.now()); } catch (e) { return 0; } }
  function safeGet(store, k) { try { return store.getItem(k); } catch (e) { return null; } }
  function safeSet(store, k, v) { try { store.setItem(k, v); return true; } catch (e) { return false; } }

  // ================== 1) 学习客户端真实写入 + 心跳补写 ==================
  // 客户端 mount 时会 removeItem('MANUAL_SWITCH')，所以要"学模板 + 定时补写"。
  try {
    var proto = window.Storage && window.Storage.prototype;
    if (proto && proto.setItem && !proto.__dy4k) {
      var origSet = proto.setItem;
      var origRemove = proto.removeItem;
      proto.setItem = function (k, v) {
        var r = origSet.apply(this, arguments);
        try {
          if (String(k) === K) {
            STAT.storeWrites++;
            var o = JSON.parse(v);
            if (o && typeof o === 'object') {
              // 只学"比目标低"的真实结构当模板（保留 clarityReal / qualityType 等字段）
              safeSet(localStorage, RAW, JSON.stringify(o));
              if (Number(o.gearType) !== p.gearType) {
                STAT.downgrades++;
                log('client wrote lower gear', o.gearType, o.gearName);
              }
            }
          }
        } catch (e) {}
        return r;
      };
      proto.removeItem = function (k) {
        var r = origRemove.apply(this, arguments);
        try { if (String(k) === K) { log('client removed MANUAL_SWITCH -> refill'); tick(); } } catch (e) {}
        return r;
      };
      proto.__dy4k = 1;
    }
  } catch (e) {}

  function want() {
    var tpl = null;
    try { tpl = JSON.parse(safeGet(localStorage, RAW) || 'null'); } catch (e) {}
    var o = {};
    if (tpl && typeof tpl === 'object') for (var k in tpl) o[k] = tpl[k];
    o.done = 1;
    o.gearType = p.gearType;
    o.gearClarity = p.gearClarity;
    o.gearName = p.gearName;
    if (!(tpl && String(tpl.gearClarity) === p.gearClarity && typeof tpl.qualityType === 'number')) o.qualityType = p.qualityType;
    return JSON.stringify(o);
  }

  // 只在"缺失 / 被改成别的档"时补写，不跟用户自己的手动选择抢
  function tick() {
    try {
      var v = want(), c = safeGet(sessionStorage, K);
      if (c === v) return;
      var keep = false;
      try {
        var o = JSON.parse(c);
        keep = !!o && Number(o.gearType) === p.gearType && String(o.gearClarity) === p.gearClarity;
      } catch (e) {}
      if (!keep) { safeSet(sessionStorage, K, v); log('MANUAL_SWITCH ->', v); }
    } catch (e) {}
  }

  // ================== 2) 改写 AB 响应（关键） ==================
  // 线上 web 包里的 AB 响应结构是 data.<key>.val / data.<key>.vid（每个键还带一个 vid 做校验），
  // 所以"把键直接改成 0"会破坏结构；正确做法是只改里面的 val。
  var AB_OFF = ['auto_clarity_reselect', 'switch_clarity_timing', 'smooth_switch_clarity'];
  var AB_ZERO_ANY = ['maxDownSwitchLevel', 'rebufferDegrade', 'safeRebufferDegrade'];
  // 播放器里的"自动清晰度"两个开关（PC 端第 3 层锁的就是它俩：isPlayAutoDefi / isOpenAutoDefi）。
  // 只在 CFG.killAutoDefi=true 时关掉——实测网络抖一下它就会把 4K 拽回 540P。
  var AB_AUTO_DEFI = ['isOpenAutoDefi', 'isPlayAutoDefi'];
  var AB_FORCE = { 'has_2k': 1 };            // 新增（或强置）的键：手机端 isHas2K() 的唯一开关
  var AB_URL = /ab\/params|mobile\/ab|abtest|abtest_config/i;

  // ---- 嗅探：给"原生 4K"按钮收集 4K 直链（只在 App 内用得上）----
  var SNIFF_URL = /\/aweme\/v1\/web\/(aweme\/(detail|post|related|series)|\w+\/aweme|comment\/)/i;
  var GEARS = {};          // awemeId -> { best:{url,w,h,kbps,h265,gear}, all:[...] }
  var RAW_STREAM = {};     // awemeId -> 原始 video 对象（调试用）
  var AWEME = {};          // awemeId -> 整个 aweme 对象（作者/文案/统计），用来画自己的浮层
  var COMMENTS = {};       // awemeId -> [{nick, text, digg, avatar}]
  var COMMENT_URL = /comment\/(list|reply)/i;

  // 把一个"可能是 {val:...} 包装"的值清零
  function zeroValue(holder, key) {
    var v = holder[key];
    if (v && typeof v === 'object') {
      if ('val' in v) {
        if (Number(v.val) !== 0) { v.val = 0; return 1; }
        return 0;
      }
      return patchABObj(v, 1);
    }
    if (v !== 0 && Number(v) !== 0) { holder[key] = 0; return 1; }
    return 0;
  }

  // 强置一个键的值。缺键时按线上真实形状补成 { val: … }（客户端是按 .val 读的）
  function forceValue(holder, key, val) {
    var v = holder[key];
    if (v === undefined) { holder[key] = { val: val }; return 1; }
    if (v && typeof v === 'object') {
      if ('val' in v) {
        if (String(v.val) === String(val)) return 0;
        v.val = val;
        return 1;
      }
      holder[key] = { val: val };
      return 1;
    }
    if (String(v) !== String(val)) { holder[key] = val; return 1; }
    return 0;
  }

  // "看起来像 AB 配置表"：抖音的 AB 响应是 data.<key>.{val,vid}，靠几个已知键认出来
  function looksLikeABTable(o) {
    return !!(o && typeof o === 'object' && (
      o['has_2k'] !== undefined ||
      o['auto_clarity_reselect'] !== undefined ||
      o['switch_clarity_timing'] !== undefined ||
      o['abr_config'] !== undefined ||
      o['bitrate_selector'] !== undefined
    ));
  }

  function patchABObj(o, depth) {
    if (!o || typeof o !== 'object' || depth > 8) return 0;
    var n = 0;
    for (var k in o) {
      if (!Object.prototype.hasOwnProperty.call(o, k)) continue;
      var v = o[k];
      if (AB_OFF.indexOf(k) >= 0) { n += zeroValue(o, k); }
      else if (AB_ZERO_ANY.indexOf(k) >= 0) { n += zeroValue(o, k); }
      else if (AB_AUTO_DEFI.indexOf(k) >= 0) {
        if (CFG.killAutoDefi && v !== false) { o[k] = false; n++; }
      }
      else if (v && typeof v === 'object') { n += patchABObj(v, depth + 1); }
    }
    // 强制开启的键（has_2k / has_hdr）只往"AB 表"那一层塞，别污染别处
    if (looksLikeABTable(o)) {
      for (var fk in AB_FORCE) {
        if (!Object.prototype.hasOwnProperty.call(AB_FORCE, fk)) continue;
        n += forceValue(o, fk, AB_FORCE[fk]);
      }
    }
    return n;
  }

  function refreshForceKeys() {
    AB_FORCE = {};
    if (CFG.force2k) AB_FORCE['has_2k'] = 1;
    if (CFG.forceHdr) AB_FORCE['has_hdr'] = 1;
  }
  refreshForceKeys();

  function statHits(n, where, url) {
    if (!n) return;
    STAT.abHits += n;
    STAT.patchAt = Date.now();
    log('ab(' + where + ') changed', n, (url || '').slice(0, 70));
  }

  function installABPatch() {
    if (!CFG.abPatch) return;
    // ---- fetch ----
    try {
      var of = window.fetch;
      if (typeof of === 'function' && !of.__dy4k) {
        var wrapped = function (input, init) {
          var url = '';
          try { url = String(typeof input === 'string' ? input : (input && input.url) || ''); } catch (e) {}
          var pr = of.apply(this, arguments);
          if (!AB_URL.test(url)) {
            // 顺手嗅一下视频详情，给"原生 4K"按钮准备直链
            if (SNIFF_URL.test(url)) {
              try { pr.then(function (r) { try { r.clone().text().then(sniffBody, function () {}); } catch (e) {} }); } catch (e) {}
            }
            return pr;
          }
          return pr.then(function (res) {
            return res.text().then(function (txt) {
              var j = null;
              try { j = JSON.parse(txt); } catch (e) {}
              if (!j) return new Response(txt, { status: res.status, statusText: res.statusText, headers: res.headers });
              var n = patchABObj(j, 0);
              statHits(n, 'fetch', url);
              return new Response(JSON.stringify(j), { status: res.status, statusText: res.statusText, headers: res.headers });
            });
          });
        };
        wrapped.__dy4k = 1;
        window.fetch = wrapped;
      }
    } catch (e) {}

    // ---- XHR（响应体是 getter，必须重写 getter） ----
    try {
      var XO = window.XMLHttpRequest;
      if (XO && XO.prototype && !XO.prototype.__dy4k) {
        var xopen = XO.prototype.open;
        XO.prototype.open = function (m, u) {
          try { this.__dy4kUrl = String(u || ''); } catch (e) {}
          return xopen.apply(this, arguments);
        };
        var dText = Object.getOwnPropertyDescriptor(XO.prototype, 'responseText');
        if (dText && dText.get) {
          Object.defineProperty(XO.prototype, 'responseText', {
            configurable: true,
            get: function () {
              var t = dText.get.call(this);
              try {
                if (this.__dy4kUrl && AB_URL.test(this.__dy4kUrl) && this.readyState === 4 && t) {
                  var j = JSON.parse(t), n = patchABObj(j, 0);
                  statHits(n, 'xhr', this.__dy4kUrl);
                  return JSON.stringify(j);
                }
                if (this.__dy4kUrl && SNIFF_URL.test(this.__dy4kUrl) && this.readyState === 4 && t) sniffBody(t);
              } catch (e) {}
              return t;
            }
          });
        }
        var dResp = Object.getOwnPropertyDescriptor(XO.prototype, 'response');
        if (dResp && dResp.get) {
          Object.defineProperty(XO.prototype, 'response', {
            configurable: true,
            get: function () {
              var r = dResp.get.call(this);
              try {
                if (this.__dy4kUrl && AB_URL.test(this.__dy4kUrl) && this.readyState === 4) {
                  if (r && typeof r === 'object') { var n1 = patchABObj(r, 0); statHits(n1, 'xhr-obj', this.__dy4kUrl); return r; }
                  if (typeof r === 'string' && r) { var j = JSON.parse(r), n2 = patchABObj(j, 0); statHits(n2, 'xhr-str', this.__dy4kUrl); return JSON.stringify(j); }
                }
              } catch (e) {}
              return r;
            }
          });
        }
        XO.prototype.__dy4k = 1;
      }
    } catch (e) {}

    // ---- 页面预置的那份（TTE_ENV.layoutInitialProps 里的 allAbParams） ----
    try {
      var lp = window.TTE_ENV && window.TTE_ENV.layoutInitialProps;
      if (lp) { var n3 = patchABObj(lp, 0); statHits(n3, 'tte', 'layoutInitialProps'); }
    } catch (e) {}

    // ---- 兜底：客户端把 AB 数据挂在 window.abTestData 上（alias 形态，has2K 就是它） ----
    setInterval(function () {
      try {
        var ab = window.abTestData;
        if (!ab || typeof ab !== 'object') return;
        if (CFG.force2k && !ab.has2K) { ab.has2K = 1; STAT.nsHits++; log('window.abTestData.has2K -> 1'); }
        if (CFG.force2k && !ab.has_2k) { ab.has_2k = { val: 1 }; }
        if (CFG.forceHdr && !ab.hasHDR) ab.hasHDR = 1;
        if (ab.autoClarityReselect) { ab.autoClarityReselect = 0; STAT.nsHits++; }
        if (CFG.killAutoDefi) {
          // abrConfig 可能是 "值本身"，也可能还包着 {val}
          var br = ab.abrConfig;
          var targets = [ab, br, br && br.val];
          for (var i = 0; i < targets.length; i++) {
            var t = targets[i];
            if (!t || typeof t !== 'object') continue;
            if (t.isOpenAutoDefi) { t.isOpenAutoDefi = false; STAT.nsHits++; }
            if (t.isPlayAutoDefi) { t.isPlayAutoDefi = false; STAT.nsHits++; }
          }
        }
      } catch (e) {}
    }, 700);
  }

  // ================== 3) 手机版界面（复刻 App 的壳） ==================
  // 线上真实类名（2026-10 抓的 DOM）：
  //   #douyin-navigation 左侧导航 / #douyin-header 顶栏 / #douyin-right-container 主内容
  //   .basePlayerContainer / .xgplayer 播放器；[class*=video-detail-container] 视频页容器
  //   [class*=comment-mainContent] 评论区；a[href*="/user/"] 作者链接
  //   类名大量带 hash 后缀，所以一律用「前缀/包含」匹配；ID 优先。
  var TAB_H = 52;   // 底部导航高度（不含安全区）

  var CSS = [
    /* --- 全局 --- */
    'html,body{overscroll-behavior:none!important;background:#000!important;}',
    'body{overflow-x:hidden!important;-webkit-tap-highlight-color:transparent!important;',
    '  font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Noto Sans CJK SC",sans-serif;}',
    '::-webkit-scrollbar{width:0!important;height:0!important;}',

    /* --- 桌面版外壳 --- */
    '#douyin-navigation{display:none!important;}',
    '#douyin-header,header{display:none!important;}',
    'footer,[class*="site-footer"],[class*="footer-nav"],[class*="FooterNav"]{display:none!important;}',

    /* ===== 弹性适配：站点里那些写死的 px 宽度，全部改成百分比/100vw ===== */
    'html,body{width:100%!important;max-width:100vw!important;overflow-x:hidden!important;}',
    '[class*="route-scroll-container"],[class*="parent-route-container"]{width:100%!important;max-width:100vw!important;min-width:0!important;}',
    '#douyin-right-container{width:100%!important;max-width:100vw!important;min-width:0!important;margin:0!important;padding:0!important;left:0!important;}',
    '[class*="playerContainer"],[class*="basePlayerContainer"],[class*="xg-video-container"],xg-video-container{width:100%!important;max-width:100vw!important;}',
    '[class*="swiper-slide"],[class*="swiper-wrapper"]{width:100%!important;max-width:100vw!important;}',

    /* --- 去掉精选 / AI抖音入口（左侧导航里的两项 + 任何同名 tab / AI 浮标） --- */
    '[class*="tab-discover"],[class*="tab-aisearch"],[class*="aisearch"],[class*="ai-search"],',
    '[class*="ai-entry"],[class*="aiEntry"],[class*="aiButton"],[class*="ai-button"],',
    '[class*="AiEntry"],[class*="AiSearch"]{display:none!important;}',

    /* --- 移动版引流条 --- */
    '.adapt-login-header,img.banner-bg{display:none!important;}',
    '.bottom-btn-con-new-dyselect,[class*="bottom-btn-con-new"]{display:none!important;}',
    '[class*="openApp"],[class*="open-app"],[class*="downloadApp"],[class*="download-app"],',
    '[class*="smartBanner"],[class*="smart-banner"],[class*="appGuide"],[class*="guide-open"]{display:none!important;}',
    '.right-con img.d-icon{display:none!important;}',

    /* --- 不要去限制 html/body 宽度或给根节点加 margin：实测在 WebView 里会让视频页播放器不初始化 --- */
    '.dy4k-panx{--dy4k-panx:0px;}',

    /* --- 图文页：去掉中间重叠的左右切换箭头（手机上直接左右滑） --- */
    '[class*="swiper-button-next"],[class*="swiper-button-prev"],[class*="image-switch"],[class*="imageSwitch"],',
    '[class*="switch-btn"],[class*="switchBtn"],[class*="arrow-btn"],[class*="arrowBtn"],',
    '[class*="prev-image"],[class*="next-image"]{display:none!important;}',

    /* --- 弹幕：字号对齐手机版，只在上半屏 --- */
    '.dy4k-dm{font-size:13px!important;line-height:1.32!important;letter-spacing:0!important;}',
    '.dy4k-dm-out{display:none!important;}',

    /* --- 播放器里 App 没有的按钮：小窗 / 网页全屏 / 音量 / 上一集下一集 / 收起箭头 --- */
    '[class*="mini-win"],[class*="page-full-screen"],[class*="xgplayer-volume"],[class*="xgplayer-playbackrate"],',
    '[class*="xgplayer-playswitch"],[class*="prev-video"],[class*="next-video"],[class*="switch-video"],',
    '[class*="xgplayer-arrow"],[class*="fold-btn"],[class*="collapse-btn"],[class*="popup-close"],',
    '[class*="close-btn"],[class*="xgplayer-mini-header"],[class*="xgplayer-sound-guide"],',
    '[class*="blur-bg"],[class*="blur-mask"],[class*="safetyBar"],[class*="safety-bar"]{display:none!important;}',
    '.dy4k-hide{display:none!important;}',

    /* --- 沉浸：播放器独占全屏（用 vw/vh 明确给尺寸，父容器塌了也不受影响） --- */
    'html.dy4k-immersive,body.dy4k-immersive{height:100%!important;overflow:hidden!important;}',
    'html.dy4k-immersive .dy4k-stage{position:fixed!important;left:0!important;top:0!important;',
    '  width:100vw!important;height:100vh!important;max-width:100vw!important;max-height:100vh!important;',
    '  min-width:0!important;min-height:0!important;z-index:2147482000!important;background:#000!important;',
    '  margin:0!important;padding:0!important;transform:none!important;overflow:hidden!important;border-radius:0!important;}',
    'html.dy4k-immersive .dy4k-stage video{width:100%!important;height:100%!important;object-fit:contain!important;display:block!important;}',

    /* --- 视频页信息块（作者/文案/点赞数）钉到底部，替代桌面版的"视频+下方信息"布局 --- */
    'html.dy4k-immersive .dy4k-info{position:fixed!important;left:0!important;right:0!important;',
    '  bottom:calc(' + (TAB_H + 6) + 'px + env(safe-area-inset-bottom,0px))!important;top:auto!important;',
    '  z-index:2147482500!important;padding:34px 12px 6px!important;margin:0!important;',
    '  background:linear-gradient(to bottom,rgba(0,0,0,0) 0%,rgba(0,0,0,.55) 42%,rgba(0,0,0,.82) 100%)!important;',
    '  max-height:44vh!important;overflow:hidden!important;transform:none!important;}',
    'html.dy4k-immersive .dy4k-info .dy4k-hide{display:none!important;}',

    /* --- 个人主页/作者页：单列手机版 --- */
    'body.dy4k-user [class*="user-detail"],[class*="userDetail"]{width:100%!important;max-width:100vw!important;}',
    'body.dy4k-user [class*="side"],[class*="Side"],[class*="aside"]{display:none!important;}',
    'body.dy4k-user [class*="header"],[class*="banner"]:not([class*="avatar"]){max-width:100vw!important;}',

    /* --- 底部导航（图标 + 文字）；尺寸乘 --dy4k-k，宽版页面缩放后仍保持手机版大小 --- */
    '#dy4k-tabbar{position:fixed;left:0;right:0;bottom:0;z-index:2147483000;display:flex;',
    '  height:calc(' + TAB_H + 'px * var(--dy4k-k,1) + env(safe-area-inset-bottom,0px));',
    '  padding-bottom:env(safe-area-inset-bottom,0px);background:rgba(10,10,12,.97);',
    '  border-top:.5px solid rgba(255,255,255,.10);}',
    '#dy4k-tabbar .dy4k-tab{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;',
    '  gap:calc(2px * var(--dy4k-k,1));color:#8b8b93;text-decoration:none;background:none;border:0;padding:0;',
    '  position:relative;font-size:calc(10px * var(--dy4k-k,1));line-height:1;-webkit-tap-highlight-color:transparent;}',
    '#dy4k-tabbar .dy4k-tab svg{width:calc(23px * var(--dy4k-k,1));height:calc(23px * var(--dy4k-k,1));display:block;fill:currentColor;}',
    '#dy4k-tabbar .dy4k-tab.on{color:#fff;}',
    '#dy4k-tabbar .dy4k-tab.on .dy4k-badge{background:#fe2c55;}',

    /* --- 评论区：从底部滑出的半屏抽屉 --- */
    '#dy4k-sheet-mask{position:fixed;inset:0;z-index:2147482600;background:rgba(0,0,0,.5);',
    '  opacity:0;pointer-events:none;transition:opacity .22s ease;}',
    '#dy4k-sheet-mask.on{opacity:1;pointer-events:auto;}',
    '#dy4k-sheet{position:fixed;left:0;right:0;bottom:0;z-index:2147482610;height:62vh;',
    '  background:#161618;border-radius:16px 16px 0 0;transform:translateY(102%);',
    '  transition:transform .26s cubic-bezier(.22,.9,.3,1);display:flex;flex-direction:column;',
    '  box-shadow:0 -8px 30px rgba(0,0,0,.5);overflow:hidden;}',
    '#dy4k-sheet.on{transform:translateY(0);}',
    '#dy4k-sheet .dy4k-sheet-head{flex:0 0 auto;padding:8px 12px 6px;text-align:center;color:#cfcfd4;',
    '  font-size:13px;position:relative;border-bottom:.5px solid rgba(255,255,255,.08);}',
    '#dy4k-sheet .dy4k-sheet-head i{position:absolute;left:50%;top:5px;width:36px;height:4px;margin-left:-18px;',
    '  border-radius:2px;background:rgba(255,255,255,.22);display:block;}',
    '#dy4k-sheet .dy4k-sheet-head b{font-weight:500;}',
    '#dy4k-sheet .dy4k-sheet-close{position:absolute;right:10px;top:8px;color:#9a9aa2;font-size:18px;line-height:1;',
    '  padding:4px 8px;}',
    '#dy4k-sheet .dy4k-sheet-body{flex:1 1 auto;overflow-y:auto;-webkit-overflow-scrolling:touch;padding:4px 12px 18px;}',
    '#dy4k-sheet .dy4k-sheet-body *{max-width:100%!important;}',
    '#dy4k-sheet .dy4k-sheet-body img{width:34px!important;height:34px!important;border-radius:50%!important;}',

    /* --- HUD --- */
    '#dy4k-hud{position:fixed;left:calc(8px * var(--dy4k-k,1));',
    '  bottom:calc(' + (TAB_H + 8) + 'px * var(--dy4k-k,1) + env(safe-area-inset-bottom,0px));',
    '  z-index:2147482400;background:rgba(0,0,0,.55);color:#7ee787;',
    '  font:calc(10px * var(--dy4k-k,1))/1.4 ui-monospace,Menlo,Consolas,monospace;',
    '  padding:calc(4px * var(--dy4k-k,1)) calc(7px * var(--dy4k-k,1));border-radius:calc(6px * var(--dy4k-k,1));',
    '  pointer-events:none;white-space:pre;text-shadow:0 1px 2px #000;opacity:.92;}',
    '#dy4k-toast{position:fixed;left:50%;top:calc(56px + env(safe-area-inset-top,0px));transform:translateX(-50%);',
    '  z-index:2147483001;background:rgba(254,44,85,.95);color:#fff;',
    '  font:calc(13px * var(--dy4k-k,1))/1.5 -apple-system,sans-serif;',
    '  padding:calc(9px * var(--dy4k-k,1)) calc(14px * var(--dy4k-k,1));',
    '  border-radius:calc(8px * var(--dy4k-k,1));max-width:88vw;box-shadow:0 6px 20px rgba(0,0,0,.45);}'
  ].join('\n');

  function ensureStyle() {
    try {
      if (document.getElementById('dy4k-style')) return;
      var st = document.createElement('style');
      st.id = 'dy4k-style';
      st.textContent = CSS;
      (document.head || document.documentElement).appendChild(st);
    } catch (e) {}
  }

  // 早期的"只改一次 initial-scale"逻辑：现在完全不动 viewport（站点自己下发 initial-scale=0.5 更自洽），
  // 只同步我们自己的 UI 缩放系数。
  function patchViewport() {
    try {
      syncScale();
      return true;
    } catch (e) { return false; }
  }

  function watchViewport() {
    try {
      syncScale();
      window.addEventListener('resize', syncScale, false);
      setTimeout(syncScale, 800);
      setTimeout(syncScale, 2500);
    } catch (e) {}
  }

  function toast(msg, ms) {
    try {
      var t = document.getElementById('dy4k-toast');
      if (!t) {
        t = document.createElement('div');
        t.id = 'dy4k-toast';
        (document.body || document.documentElement).appendChild(t);
      }
      t.textContent = msg;
      t.style.display = 'block';
      clearTimeout(t.__hide);
      t.__hide = setTimeout(function () { t.style.display = 'none'; }, ms || 5000);
      log('toast:', msg);
    } catch (e) {}
  }

  // 移动版引流页检测：这类页面只给 720P 水印流，且没有清晰度菜单
  function isMobileShell() {
    try {
      if (/^m\./i.test(location.host)) return true;
      if (document.querySelector('.adapt-login-header,.bottom-btn-con-new-dyselect')) return true;
      if (document.querySelector('video#video-player')) return true;
      return false;
    } catch (e) { return false; }
  }

  function activeVideo() {
    // 优先选"可见面积最大"的视频：页面里常有几个预创建/浮层播放器，只按 paused 选会选错
    var vs = document.querySelectorAll('video'), i, v, r, best = null, bestArea = 0;
    for (i = 0; i < vs.length; i++) {
      v = vs[i];
      r = v.getBoundingClientRect();
      if (r.width < 40 || r.height < 40) continue;
      var area = r.width * r.height;
      if (!v.videoWidth) area *= 0.01;             // 还没出画的降权
      if (area > bestArea) { best = v; bestArea = area; }
    }
    if (best) return best;
    for (i = 0; i < vs.length; i++) { v = vs[i]; if (!v.paused && v.videoWidth) return v; }
    for (i = 0; i < vs.length; i++) { v = vs[i]; if (v.videoWidth) return v; }
    for (i = 0; i < vs.length; i++) { v = vs[i]; if (v.readyState > 0) return v; }
    return vs[0] || null;
  }

  // 沉浸模式：把"视频真正的舞台"钉成全屏
  //   优先找带播放器类名的祖先（douyin-player / xgplayer …），找不到再退化到父节点；
  //   永远不把 body / html 当舞台（曾经因为向上爬太多把整页钉住了）。
  function findStage(v) {
    var el = v.parentElement;
    var hop = 0;
    while (el && hop < 6) {
      var cls = String(el.className || '');
      if (/douyin-player|xgplayer|dy-player|player-container|playerContainer|PlayerContainer/i.test(cls)) return el;
      el = el.parentElement;
      hop++;
    }
    var p1 = v.parentElement;
    if (p1 && p1 !== document.body && p1 !== document.documentElement) return p1;
    return null;
  }

  function immersive(on) {
    try {
      var v = activeVideo();
      if (!on) {
        document.documentElement.classList.remove('dy4k-immersive');
        if (document.body) document.body.classList.remove('dy4k-immersive');
        var old = document.querySelectorAll('.dy4k-stage');
        for (var i = 0; i < old.length; i++) old[i].classList.remove('dy4k-stage');
        return false;
      }
      if (!v) return false;
      // 只要媒体解码出尺寸就可以接管；用 videoWidth 判断，不要用元素 rect
      // （桌面版播放器的元素在没被接管前常常是 0x0）
      if (!v.videoWidth) return false;
      var target = findStage(v);
      if (!target) return false;
      var old2 = document.querySelectorAll('.dy4k-stage');
      for (var j = 0; j < old2.length; j++) if (old2[j] !== target) old2[j].classList.remove('dy4k-stage');
      target.classList.add('dy4k-stage');
      document.documentElement.classList.add('dy4k-immersive');
      if (document.body) document.body.classList.add('dy4k-immersive');
      return true;
    } catch (e) { return false; }
  }

  // 桌面版网页按 786px 排版、被缩到 393px 的手机上时，右侧推荐栏会"漏"进可视区。
  // 这类浮层的左边界已经 >= 可视宽度，永远看不到全貌，直接隐藏。
  function hideOffscreenLayers() {
    try {
      var vw = (window.visualViewport && window.visualViewport.width) || window.innerWidth;
      var els = document.querySelectorAll('#root div,#root section,#root aside,#root ul');
      for (var i = 0; i < els.length; i++) {
        var el = els[i];
        if (el.classList.contains('dy4k-hide') || el.classList.contains('dy4k-stage')) continue;
        var cs = getComputedStyle(el);
        if (cs.position !== 'fixed' && cs.position !== 'sticky' && cs.position !== 'absolute') continue;
        var r = el.getBoundingClientRect();
        if (r.width < 20 || r.height < 20) continue;
        if (r.left >= vw - 2) el.classList.add('dy4k-hide');
      }
    } catch (e) {}
  }

  // 只藏"播放器同一层、排在播放器后面"的兄弟（信息块/评论区），
  // 绝对不往上走多层——往上走会把播放器自己的父级干掉，页面直接黑屏。
  function focusStage() {
    try {
      var stage = document.querySelector('.dy4k-stage');
      if (!stage || !stage.parentElement) return;
      var sib = stage.nextElementSibling;
      while (sib) {
        var bad = (sib.id && sib.id.indexOf('dy4k') === 0) ||
                  sib.tagName === 'SCRIPT' || sib.tagName === 'STYLE' ||
                  (sib.querySelector && (sib.querySelector('.dy4k-stage') || sib.querySelector('video')));
        if (!bad && !sib.classList.contains('dy4k-hide')) sib.classList.add('dy4k-hide');
        sib = sib.nextElementSibling;
      }
    } catch (e) {}
  }

  // 切换出详情页时，把我们加的沉浸标记全部撤掉，恢复页面原样
  function stripFocusMarks() {
    try {
      document.documentElement.classList.remove('dy4k-immersive');
      if (document.body) document.body.classList.remove('dy4k-immersive');
      var stages = document.querySelectorAll('.dy4k-stage');
      for (var i = 0; i < stages.length; i++) stages[i].classList.remove('dy4k-stage');
      var hid = document.querySelectorAll('.dy4k-hide');
      for (var j = 0; j < hid.length; j++) {
        if (hid[j].id && hid[j].id.indexOf('dy4k') === 0) continue;
        hid[j].classList.remove('dy4k-hide');
      }
      var ov = document.getElementById('dy4k-overlay');
      if (ov) ov.style.display = 'none';
    } catch (e) {}
  }

  // ============ viewport 分页面策略（关键） ============
  // 实测：视频/图文页要 initial-scale=1（393 宽）播放器才渲染成全屏；
  //      精选/关注/朋友要站点原生的 0.5（786 宽）才不会被裁。
  // 但**运行时切 viewport 会把播放器初始化搞坏**，所以策略只在"整页加载"时生效：
  //   - App 拦截 HTML 时按 URL 决定（视频页改成 scale=1）；
  //   - 底部导航用整页跳转（location.href）而不是 SPA，切换时自然带上正确策略。
  function applyViewportPolicy() {
    try {
      var isVideo = /^\/(video|note)\//.test(location.pathname);
      var want = isVideo
        ? 'width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no,viewport-fit=cover'
        : 'width=device-width,initial-scale=0.5,user-scalable=no,viewport-fit=cover';
      var m = document.querySelector('meta[name="viewport"]');
      if (!m) return;
      if (m.getAttribute('content') === want) { syncScale(); return; }
      // 只在"还没出画"的时候才允许改，出画后一律不动（改了会打断播放器）
      var vs = document.querySelectorAll('video');
      for (var i = 0; i < vs.length; i++) if (vs[i].videoWidth > 0) return;
      m.setAttribute('content', want);
      log('viewport ->', isVideo ? 'scale1(video)' : 'scale0.5(rest)');
      setTimeout(syncScale, 60);
    } catch (e) {}
  }

  // ============ 窄屏模式（393）：站点按手机版布局渲染，我们用百分比改造成弹性布局 ============
  // 为什么不再用站点的 initial-scale=0.5：那是"桌面版整体缩一半"，字小、上下大片黑边，
  // 而且视频只有画面中间一小块。压到设备宽度后站点会走它自己的手机版分支，才是我们想要的。
  function syncScale() {
    try {
      // 窄屏模式下 scale=1，我们自己的 UI 不需要补偿
      document.documentElement.style.setProperty('--dy4k-k', '1');
      return 1;
    } catch (e) { return 1; }
  }

  function fitViewport() { return syncScale(); }

  // 站点偶尔会把 meta 改回 initial-scale=0.5，改回去（视频出画后就不动，避免打断播放器）
  var VP_WANT = 'width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no,viewport-fit=cover';
  function guardViewport() {
    try {
      var m = document.querySelector('meta[name="viewport"]');
      if (!m) return;
      if (m.getAttribute('content') === VP_WANT) return;
      var vs = document.querySelectorAll('video');
      for (var i = 0; i < vs.length; i++) if (vs[i].videoWidth > 0) return;
      m.setAttribute('content', VP_WANT);
      log('viewport re-forced to scale=1');
    } catch (e) {}
  }
  function deviceWidth() {
    try {
      var w = window.screen && window.screen.width;
      if (w && w >= 200 && w <= 1400) return w;
    } catch (e) {}
    return window.innerWidth;
  }

  // ============ 屏蔽桌面版外壳（左侧图标栏 / 顶部搜索头） ============
  function hideDesktopChrome() {
    try {
      var vh = window.innerHeight, vw = window.innerWidth;

      // 1) 左侧竖排图标栏：贴左、窄、高、里面一堆图标
      var cands = document.querySelectorAll('div,aside,nav');
      for (var i = 0; i < cands.length; i++) {
        var el = cands[i];
        if (el.id && el.id.indexOf('dy4k') === 0) continue;
        if (el.classList.contains('dy4k-hide')) continue;
        var r = el.getBoundingClientRect();
        if (r.left > 12 || r.width < 40 || r.width > 110 || r.height < vh * 0.5) continue;
        var cs = getComputedStyle(el);
        if (cs.position !== 'fixed' && cs.position !== 'absolute') continue;
        var icons = el.querySelectorAll('svg,img,span[class*="icon"]').length;
        if (icons < 3) continue;
        el.classList.add('dy4k-hide');
        log('hide left rail', Math.round(r.width) + 'x' + Math.round(r.height));
      }

      // 2) 顶部搜索头：贴顶、全宽、高度 40~110，里面有 input
      var heads = document.querySelectorAll('div,header');
      for (var j = 0; j < heads.length; j++) {
        var h = heads[j];
        if (h.id && h.id.indexOf('dy4k') === 0) continue;
        if (h.classList.contains('dy4k-hide')) continue;
        var hr = h.getBoundingClientRect();
        if (hr.top > 8 || hr.height < 40 || hr.height > 110 || hr.width < vw * 0.6) continue;
        var hc = getComputedStyle(h);
        if (hc.position !== 'fixed' && hc.position !== 'absolute' && hc.position !== 'sticky') continue;
        if (!h.querySelector('input,textarea')) continue;
        h.classList.add('dy4k-hide');
        log('hide top header', Math.round(hr.width) + 'x' + Math.round(hr.height));
      }
    } catch (e) {}
  }

  // ============ 关注/朋友页：去掉左侧那条竖栏（列表/正在直播/我的关注） ============
  function hideSideRail() {
    try {
      if (!/^\/(follow|friend)/.test(location.pathname)) {
        document.documentElement.style.setProperty('--dy4k-panx', '0px');
        return;
      }
      var vh = window.innerHeight, hit = false, railW = 0;
      var cands = document.querySelectorAll('div,aside');
      for (var i = 0; i < cands.length; i++) {
        var el = cands[i];
        if (el.id && el.id.indexOf('dy4k') === 0) continue;
        if (el.classList.contains('dy4k-hide')) continue;
        var r = el.getBoundingClientRect();
        // 左侧竖栏：贴左、比手机屏窄但比图标条宽、占了大半屏高
        if (r.left > 10 || r.width < 36 || r.width > 270 || r.height < vh * 0.3) continue;
        var cs = getComputedStyle(el);
        if (cs.position !== 'fixed' && cs.position !== 'absolute' && cs.position !== 'relative') continue;
        var imgs = el.querySelectorAll('img').length;
        var txt = (el.innerText || '').replace(/\s+/g, '');
        var looksRail = imgs >= 2 || /搜索用户名|正在直播|我的关注|列表/.test(txt);
        if (!looksRail) continue;
        el.classList.add('dy4k-hide');
        hit = true;
        railW = Math.max(railW, Math.round(r.width));
        // 左栏藏了但布局还留着它的宽度：把同一层的内容列撑满
        try {
          var parent = el.parentElement;
          if (parent) {
            for (var k = 0; k < parent.children.length; k++) {
              var sib = parent.children[k];
              if (sib === el) continue;
              if (sib.getBoundingClientRect().width < 100) continue;
              sib.style.setProperty('flex', '1 1 auto', 'important');
              sib.style.setProperty('width', '100%', 'important');
              sib.style.setProperty('max-width', '100%', 'important');
            }
          }
        } catch (e2) {}
        log('hideSideRail', Math.round(r.width) + 'x' + Math.round(r.height), String(el.className).slice(0, 24));
      }
      // 左栏藏掉后，播放器还是被挤成一个窄条（居中有黑边）——把它和它上 3 层容器撑满整屏
      if (hit) {
        // 左栏藏了但布局还占着它的宽度：把整个内容区左移补上，并加宽同样的量
        try {
          var par = null;
          var hiddenRail = document.querySelector('.dy4k-hide');
          if (hiddenRail) par = hiddenRail.parentElement;
          if (par) {
            par.style.setProperty('margin-left', (-railW) + 'px', 'important');
            par.style.setProperty('width', 'calc(100% + ' + railW + 'px)', 'important');
            par.style.setProperty('max-width', 'none', 'important');
          }
        } catch (e2) {}
        // 再把播放器撑满
        try {
          var vs2 = document.querySelectorAll('video');
          for (var vi = 0; vi < vs2.length; vi++) {
            if (!vs2[vi].videoWidth) continue;
            var up = vs2[vi];
            for (var d = 0; d < 4 && up && up !== document.body; d++) {
              up.style.setProperty('width', '100%', 'important');
              up.style.setProperty('max-width', '100vw', 'important');
              up.style.setProperty('left', '0', 'important');
              up.style.setProperty('margin-left', '0', 'important');
              up = up.parentElement;
            }
            break;
          }
        } catch (e3) {}
      }
      if (hit) {
        // 左栏没了但布局还留着它的空位：把整页左移这么多，然后按新宽度重新算缩放
        document.documentElement.style.setProperty('--dy4k-panx', (-railW) + 'px');
        setTimeout(function () { fitViewport(true); }, 300);
      }
    } catch (e) {}
  }

  // ============ 弹幕：只在上半屏显示 + 字号跟手机版一致 ============
  // ============ 弹幕：只显示在视频画面内、上 55% 区域，字号对齐手机版 ============
  // 弹幕容器默认铺满整个播放器（含上下黑边），所以要把它的盒子收进"真正的画面区域"。
  function fitDanmakuBox() {
    try {
      var v = activeVideo();
      if (!v || !v.videoWidth || !v.videoHeight) return;
      var r = v.getBoundingClientRect();
      if (r.width < 40 || r.height < 40) return;
      var sc = Math.min(r.width / v.videoWidth, r.height / v.videoHeight);
      var cw = v.videoWidth * sc, ch = v.videoHeight * sc;
      var left = r.left + (r.width - cw) / 2;
      var top = r.top + (r.height - ch) / 2;
      var conts = document.querySelectorAll('[class*="danmu"],[class*="danMu"]');
      for (var i = 0; i < conts.length; i++) {
        var c = conts[i];
        if (c.classList && /danMuText/.test(c.className)) continue;   // 弹幕条目，不是容器
        var cs = getComputedStyle(c);
        if (cs.position !== 'absolute' && cs.position !== 'fixed') continue;
        c.style.setProperty('top', top + 'px', 'important');
        c.style.setProperty('left', left + 'px', 'important');
        c.style.setProperty('width', cw + 'px', 'important');
        c.style.setProperty('height', (ch * 0.55) + 'px', 'important');
        c.style.setProperty('overflow', 'hidden', 'important');
      }
    } catch (e) {}
  }

  function tidyDanmaku() {
    try {
      var half = window.innerHeight * 0.5;
      var items = document.querySelectorAll('[class*="danMuText"],[class*="danmuText"],[class*="DanmuText"]');
      for (var i = 0; i < items.length; i++) {
        var el = items[i];
        if (!el.__dy4kDm) { el.__dy4kDm = 1; el.classList.add('dy4k-dm'); }
        var r = el.getBoundingClientRect();
        if (r.top > half && !el.classList.contains('dy4k-dm-out')) el.classList.add('dy4k-dm-out');
      }
      fitDanmakuBox();
    } catch (e) {}
  }

  // 底部导航（复刻 App：4 个入口 + 手机版图标 + 站内秒切）
  // 关键：用 history.pushState + popstate 让站内路由自己切页（实测 300ms 内），不再整页重载
  var HOME_FEED = '/?recommend=1';
  var TABS = [
    {
      key: 'recommend', text: '推荐', href: HOME_FEED,
      icon: '<svg viewBox="0 0 24 24"><path d="M12 2.1 2.6 8.2v11.1c0 .9.7 1.6 1.6 1.6h15.6c.9 0 1.6-.7 1.6-1.6V8.2L12 2.1zm0 3.1 6.6 4.3v9.9H5.4v-9.9L12 5.2z"/><path d="M10.3 8.2v7.6l5.6-3.8-5.6-3.8z"/></svg>'
    },
    {
      key: 'follow', text: '关注', href: '/follow',
      icon: '<svg viewBox="0 0 24 24"><path d="M12 21s-8-4.9-8-10.6A4.6 4.6 0 0 1 12 7.1 4.6 4.6 0 0 1 20 10.4C20 16.1 12 21 12 21z" fill="none" stroke="currentColor" stroke-width="2"/></svg>'
    },
    {
      key: 'friend', text: '朋友', href: '/friend',
      icon: '<svg viewBox="0 0 24 24"><path d="M4 3.5h16c1.1 0 2 .9 2 2v9c0 1.1-.9 2-2 2H9.2L4.5 20.2c-.7.6-1.8.1-1.8-.8V5.5c0-1.1.9-2 1.3-2z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><circle cx="8.5" cy="10" r="1.3"/><circle cx="12" cy="10" r="1.3"/><circle cx="15.5" cy="10" r="1.3"/></svg>'
    },
    {
      key: 'mine', text: '我的', href: '/user/self',
      icon: '<svg viewBox="0 0 24 24"><path d="M12 12a4.2 4.2 0 1 0 0-8.4A4.2 4.2 0 0 0 12 12z"/><path d="M3.8 21c0-4.2 3.7-6.9 8.2-6.9s8.2 2.7 8.2 6.9H3.8z"/></svg>'
    }
  ];

  // 站内跳转：pushState + popstate，让 SPA 路由自己切页（不重载）
  function spaGo(path) {
    try {
      if (location.pathname + location.search === path) return 'same';
      history.pushState({}, '', path);
      window.dispatchEvent(new PopStateEvent('popstate', { state: {} }));
      return 'spa';
    } catch (e) {
      try { location.href = path; return 'href'; } catch (e2) { return 'fail'; }
    }
  }

  function currentTabKey() {
    var p = location.pathname, q = location.search || '';
    if (/^\/user\//.test(p)) return 'mine';
    if (/^\/follow/.test(p)) return 'follow';
    if (/^\/friend/.test(p)) return 'friend';
    if (/recommend/.test(q) || p === '/' || p === '') return 'recommend';
    return '';                                   // /jingxuan 精选不在导航里
  }

  function navigateTab(tab) {
    if (tab.key === currentTabKey() && tab.key !== 'recommend') return 'already';
    closeSheet();
    // 「我的」在 App 里开原生主页（网页版用户页是宽屏三栏，跟手机版差太远）
    if (tab.key === 'mine' && window.dy4kNative && window.dy4kNative.openProfile) {
      window.dy4kNative.openProfile('', '');
      return 'native-profile';
    }
    // 注意：这里用整页跳转，不用 SPA。
    // 因为视频页和网格页需要不同的 viewport（scale=1 / 0.5），而运行中改 viewport 会把播放器搞坏，
    // 只有"整页加载"才能在 HTML 阶段就带上正确的 meta。
    var href;
    if (tab.key === 'recommend') {
      var seed = lastSeed();
      href = seed ? ('/video/' + seed) : tab.href;
    } else {
      href = tab.href;
    }
    log('tab nav (full load)', tab.key, href);
    location.href = href;
    return 'href';
  }

  // 记住最后看过的视频 id，作为「推荐」首页的种子
  function lastSeed() {
    try {
      var m = /\/video\/(\d{8,25})/.exec(location.pathname);
      if (m) { localStorage.setItem('dy4k-seed', m[1]); return m[1]; }
      return localStorage.getItem('dy4k-seed') || '';
    } catch (e) { return ''; }
  }

  function buildTabbar() {
    if (!CFG.tabbar) return false;
    try {
      var bar = document.getElementById('dy4k-tabbar');
      var cur = currentTabKey();
      // 只在"选中项变了 / 还没建过"时重画：之前每 1.2s 重建一次 innerHTML，白白卡顿
      if (bar && bar.getAttribute('data-cur') === cur && bar.childElementCount === TABS.length) return true;
      if (!bar) {
        bar = document.createElement('div');
        bar.id = 'dy4k-tabbar';
        (document.body || document.documentElement).appendChild(bar);
      }
      bar.textContent = '';
      bar.setAttribute('data-cur', cur);
      for (var i = 0; i < TABS.length; i++) {
        (function (tab) {
          var b = document.createElement('button');
          b.type = 'button';
          b.className = 'dy4k-tab' + (tab.key === cur ? ' on' : '');
          b.setAttribute('data-tab', tab.key);
          b.innerHTML = tab.icon + '<span>' + tab.text + '</span>';
          b.addEventListener('click', function (ev) {
            ev.preventDefault();
            ev.stopPropagation();
            navigateTab(tab);
            setTimeout(buildTabbar, 60);
            setTimeout(buildTabbar, 600);
          }, false);
          bar.appendChild(b);
        })(TABS[i]);
      }
      return true;
    } catch (e) { return false; }
  }

  // ============ 视频页浮层：作者 / 文案 / 数据 / 按钮（复刻 App 的压屏信息区） ============
  // 数据全部来自我们嗅探到的 aweme 对象，不依赖页面 DOM 结构，改版也不容易坏。
  var ovEl = null;

  function fmtCount(n) {
    n = Number(n) || 0;
    if (n >= 100000000) return (n / 100000000).toFixed(1).replace(/\.0$/, '') + '亿';
    if (n >= 10000) return (n / 10000).toFixed(1).replace(/\.0$/, '') + '万';
    return String(n);
  }

  function authorOf(a) { return (a && a.author) || {}; }
  function secUidOf(a) { var au = authorOf(a); return au.sec_uid || au.secUid || ''; }
  function avatarOf(a) {
    var au = authorOf(a);
    var t = au.avatar_thumb || au.avatar_medium || au.avatar_larger || {};
    return (t.url_list && t.url_list[0]) || '';
  }

  // 去作者主页：App 内直接开原生主页；浏览器里退回点页面链接/改地址
  function gotoAuthor() {
    try {
      var a = AWEME[currentAwemeId()];
      var su = secUidOf(a);
      var nm = authorOf(a).nickname || '';
      if (window.dy4kNative && window.dy4kNative.openProfile) {
        window.dy4kNative.openProfile(su || '', nm);
        return 'native';
      }
      var links = [].slice.call(document.querySelectorAll('a[href*="/user/"]'));
      for (var i = 0; i < links.length; i++) {
        var r = links[i].getBoundingClientRect();
        if (r.width > 20 && r.height > 20) { links[i].click(); return 'spa'; }
      }
      if (su) { location.href = 'https://www.douyin.com/user/' + su; return 'href'; }
      var id = authorOf(a).uid;
      if (id) { location.href = 'https://www.douyin.com/user/' + id; return 'href-uid'; }
    } catch (e) {}
    return 'fail';
  }

  // App 内：页面上任何"点用户"的地方都改成开原生主页（capture 阶段拦，先于 React 处理）
  function installUserLinkInterceptor() {
    if (!window.dy4kNative || !window.dy4kNative.openProfile) return;
    if (window.__dy4kUserLink) return;
    window.__dy4kUserLink = 1;
    document.addEventListener('click', function (ev) {
      try {
        var el = ev.target;
        if (!el || !el.closest) return;
        var a = el.closest('a[href*="/user/"]');
        if (!a) return;
        var href = a.getAttribute('href') || '';
        var m = /\/user\/([^\/?#]+)/.exec(href);
        if (!m) return;
        ev.preventDefault();
        ev.stopPropagation();
        var nm = (a.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 20);
        window.dy4kNative.openProfile(decodeURIComponent(m[1]), nm);
      } catch (e) {}
    }, true);
  }

  // ============ App 桥：原生主页用的数据接口（在页面上下文里 fetch，天然带登录态） ============
  // 见 docs/12-抖音网页版接口逆向总览.md：页面里发请求时，站点自己的 fetch 包装器会补 a_bogus/msToken，
  // 所以这些接口「必须从页面上下文发」，换成 native 直连会 403。
  function apiJson(path) {
    return fetch(path, { credentials: 'include' }).then(function (r) { return r.json(); });
  }
  var API_BASE = 'device_platform=webapp&aid=6383&channel=channel_pc_web';
  window.dy4kApi = {
    profile: function (secUid) {
      var url = secUid
        ? '/aweme/v1/web/user/profile/other/?device_platform=webapp&aid=6383&sec_user_id=' + encodeURIComponent(secUid)
        : '/aweme/v1/web/user/profile/self/?device_platform=webapp&aid=6383';
      return apiJson(url).then(function (j) {
        return (j && (j.user || j.data)) || {};
      });
    },
    posts: function (secUid, cursor) {
      var url = '/aweme/v1/web/aweme/post/?device_platform=webapp&aid=6383' +
        '&sec_user_id=' + encodeURIComponent(secUid || '') +
        '&max_cursor=' + (cursor || 0) + '&count=24';
      return apiJson(url).then(function (j) {
        return { list: (j && j.aweme_list) || [], has_more: j && j.has_more, cursor: j && j.max_cursor };
      });
    },

    // ---- 以下是 docs/12 里验证过的其它常用接口 ----
    detail: function (awemeId) {
      return apiJson('/aweme/v1/web/aweme/detail/?aweme_id=' + encodeURIComponent(awemeId || '') + '&' + API_BASE);
    },
    comments: function (awemeId, cursor, count) {
      return apiJson('/aweme/v1/web/comment/list/?aweme_id=' + encodeURIComponent(awemeId || '') +
        '&cursor=' + (cursor || 0) + '&count=' + (count || 20) + '&' + API_BASE);
    },
    related: function (awemeId, count) {
      return apiJson('/aweme/v1/web/aweme/related/?aweme_id=' + encodeURIComponent(awemeId || '') +
        '&count=' + (count || 20) + '&filterGids=0&' + API_BASE);
    },
    favorite: function (secUid, cursor) {
      return apiJson('/aweme/v1/web/aweme/favorite/?sec_user_id=' + encodeURIComponent(secUid || '') +
        '&max_cursor=' + (cursor || 0) + '&count=20&' + API_BASE);
    },
    hot: function () {
      return apiJson('/aweme/v1/web/hot/search/list/?detail_list=1&' + API_BASE);
    },
    search: function (kw, offset) {
      return apiJson('/aweme/v1/web/search/item/?keyword=' + encodeURIComponent(kw || '') +
        '&offset=' + (offset || 0) + '&count=10&' + API_BASE);
    },
    danmaku: function (awemeId) {
      return apiJson('/aweme/v1/web/danmaku/get_v2/?group_id=' + encodeURIComponent(awemeId || '') +
        '&format=json&' + API_BASE);
    },
    music: function (musicId, cursor) {
      return apiJson('/aweme/v1/web/music/aweme/?music_id=' + encodeURIComponent(musicId || '') +
        '&cursor=' + (cursor || 0) + '&count=20&' + API_BASE);
    },
    mix: function (mixId, cursor) {
      return apiJson('/aweme/v1/web/mix/aweme/?mix_id=' + encodeURIComponent(mixId || '') +
        '&cursor=' + (cursor || 0) + '&count=20&' + API_BASE);
    },

    /** 从 aweme 里挑最高档的可直连 mp4（4K 是 adapt_lowest_4_1 + h265） */
    bestMp4: function (aweme) {
      var list = (aweme && aweme.video && aweme.video.bit_rate) || [];
      var ok = list.filter(function (b) {
        return b && b.play_addr && b.play_addr.url_list && b.play_addr.url_list.length &&
          String(b.format) === 'mp4';
      }).sort(function (a, b) {
        return (b.play_addr.height || 0) - (a.play_addr.height || 0) ||
          (b.bit_rate || 0) - (a.bit_rate || 0);
      });
      var best = ok[0];
      if (!best) return null;
      return {
        url: best.play_addr.url_list[0],
        w: best.play_addr.width, h: best.play_addr.height,
        kbps: Math.round((best.bit_rate || 0) / 1000),
        h265: !!(best.is_h265 || best.is_bytevc1),
        gear: best.gear_name
      };
    }
  };

  function ensureOverlay() {
    try {
      var onVideo = /\/video\//.test(location.pathname);
      var id = currentAwemeId();
      var a = onVideo ? AWEME[id] : null;
      if (!a) { if (ovEl) ovEl.style.display = 'none'; return; }
      if (!ovEl) {
        ovEl = document.createElement('div');
        ovEl.id = 'dy4k-overlay';
        ovEl.style.cssText =
          'position:fixed;left:0;right:0;' +
          'bottom:calc(' + (TAB_H + 4) + 'px * var(--dy4k-k,1) + env(safe-area-inset-bottom,0px));' +
          'z-index:2147482500;padding:calc(26px * var(--dy4k-k,1)) calc(12px * var(--dy4k-k,1)) calc(8px * var(--dy4k-k,1));color:#fff;' +
          'background:linear-gradient(to bottom,rgba(0,0,0,0) 0%,rgba(0,0,0,.45) 45%,rgba(0,0,0,.78) 100%);' +
          'font:calc(13px * var(--dy4k-k,1))/1.5 -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif;pointer-events:auto;';
        (document.body || document.documentElement).appendChild(ovEl);
      }
      var au = authorOf(a);
      var st = a.statistics || a.stats || {};
      var nick = au.nickname || '作者';
      var desc = (a.desc || '').replace(/\s+/g, ' ').slice(0, 120);
      var av = avatarOf(a);
      ovEl.innerHTML = '';
      ovEl.style.display = 'block';

      // 作者行
      var row = document.createElement('div');
      row.style.cssText = 'display:flex;align-items:center;gap:8px;margin-bottom:6px;';
      var img = document.createElement('img');
      img.src = av;
      img.style.cssText = 'width:calc(34px * var(--dy4k-k,1));height:calc(34px * var(--dy4k-k,1));border-radius:50%;object-fit:cover;background:#333;flex:0 0 auto;border:1px solid rgba(255,255,255,.35)';
      var nm = document.createElement('div');
      nm.textContent = '@' + nick;
      nm.style.cssText = 'font-weight:600;font-size:14px;text-shadow:0 1px 3px rgba(0,0,0,.7)';
      row.appendChild(img);
      row.appendChild(nm);
      row.addEventListener('click', function (ev) { ev.stopPropagation(); gotoAuthor(); }, false);
      ovEl.appendChild(row);

      // 文案
      if (desc) {
        var d = document.createElement('div');
        d.textContent = desc;
        d.style.cssText = 'font-size:13px;line-height:1.45;max-height:3.9em;overflow:hidden;' +
          'text-shadow:0 1px 3px rgba(0,0,0,.75);margin-bottom:8px;';
        ovEl.appendChild(d);
      }

      // 数据 + 按钮
      var bar = document.createElement('div');
      bar.style.cssText = 'display:flex;align-items:center;gap:18px;font-size:12px;color:#f0f0f3;';
      function stat(icon, val, onClick) {
        var b = document.createElement('div');
        b.style.cssText = 'display:flex;align-items:center;gap:4px;padding:4px 2px;';
        b.innerHTML = '<span style="font-size:15px;line-height:1">' + icon + '</span>' +
          '<span style="text-shadow:0 1px 3px rgba(0,0,0,.75)">' + val + '</span>';
        if (onClick) b.addEventListener('click', function (ev) { ev.stopPropagation(); onClick(); }, false);
        return b;
      }
      var likeEl = stat('❤', fmtCount(st.digg_count), function () {
        // 借页面自己的点赞按钮
        var cands = document.querySelectorAll('[class*="like"],[class*="Like"],[class*="digg"]');
        for (var i = 0; i < cands.length; i++) {
          var r = cands[i].getBoundingClientRect();
          if (r.width > 16 && r.height > 16) { cands[i].click(); toast('已点赞'); return; }
        }
        toast('没找到点赞按钮');
      });
      var cmtEl = stat('💬', fmtCount(st.comment_count), openSheet);
      var shrEl = stat('↗', fmtCount(st.share_count), function () { toast('分享请用网页内的分享'); });
      bar.appendChild(likeEl);
      bar.appendChild(cmtEl);
      bar.appendChild(shrEl);
      ovEl.appendChild(bar);
    } catch (e) {}
  }

  // ============ 评论：底部半屏抽屉 ============
  var sheetEl = null, sheetMask = null, sheetBody = null, sheetOpen = false;

  function ensureSheet() {
    if (sheetEl) return sheetEl;
    try {
      sheetMask = document.createElement('div');
      sheetMask.id = 'dy4k-sheet-mask';
      sheetMask.addEventListener('click', function () { closeSheet(); }, false);

      sheetEl = document.createElement('div');
      sheetEl.id = 'dy4k-sheet';
      var head = document.createElement('div');
      head.className = 'dy4k-sheet-head';
      head.innerHTML = '<i></i><b>评论</b><span class="dy4k-sheet-close">✕</span>';
      head.querySelector('.dy4k-sheet-close').addEventListener('click', function () { closeSheet(); }, false);

      sheetBody = document.createElement('div');
      sheetBody.className = 'dy4k-sheet-body';
      sheetEl.appendChild(head);
      sheetEl.appendChild(sheetBody);

      var host = document.body || document.documentElement;
      host.appendChild(sheetMask);
      host.appendChild(sheetEl);
      return sheetEl;
    } catch (e) { return null; }
  }

  // 把评论填进抽屉：优先用嗅探到的真实评论数据；没有就搬页面里的评论区
  function fillSheet() {
    if (!sheetBody) return;
    try {
      var id = currentAwemeId();
      var list = COMMENTS[id] || [];
      sheetBody.innerHTML = '';
      if (list.length) {
        var frag = document.createDocumentFragment();
        for (var i = 0; i < list.length && i < 80; i++) {
          var c = list[i];
          var row = document.createElement('div');
          row.style.cssText = 'display:flex;gap:9px;padding:9px 2px;border-bottom:.5px solid rgba(255,255,255,.07)';
          var av = document.createElement('img');
          av.src = c.avatar || '';
          av.style.cssText = 'width:34px;height:34px;border-radius:50%;object-fit:cover;background:#2a2a2e;flex:0 0 auto';
          var box = document.createElement('div');
          box.style.cssText = 'flex:1 1 auto;min-width:0;color:#e9e9ee;font-size:13px;line-height:1.5';
          var nm = document.createElement('div');
          nm.textContent = c.nick || '';
          nm.style.cssText = 'color:#9a9aa2;font-size:12px;margin-bottom:2px';
          var tx = document.createElement('div');
          tx.textContent = c.text || '';
          tx.style.cssText = 'white-space:pre-wrap;word-break:break-word';
          box.appendChild(nm);
          box.appendChild(tx);
          row.appendChild(av);
          row.appendChild(box);
          if (c.digg) {
            var dg = document.createElement('div');
            dg.textContent = '♥ ' + fmtCount(c.digg);
            dg.style.cssText = 'color:#8b8b93;font-size:11px;flex:0 0 auto;padding-top:3px';
            row.appendChild(dg);
          }
          frag.appendChild(row);
        }
        sheetBody.appendChild(frag);
        return;
      }
      // 兜底：搬页面里的评论区（保留它自己的渲染）
      var src = document.querySelector('[class*="comment-mainContent"]') ||
                document.querySelector('[class*="comment-list"],[class*="commentList"]');
      if (src) {
        try {
          sheetBody.appendChild(src);
          sheetBody.setAttribute('data-moved', '1');
          return;
        } catch (e) {}
      }
      var items = document.querySelectorAll('[class*="comment-item"]');
      if (!items.length) {
        sheetBody.innerHTML = '<div style="padding:30px 8px;color:#8b8b93;text-align:center;font-size:13px">' +
          '还没拿到评论数据<br><span style="font-size:12px;opacity:.7">滑到下一条视频再回来点评论试试</span></div>';
        return;
      }
      var frag2 = document.createDocumentFragment();
      for (var k = 0; k < items.length && k < 40; k++) {
        var r2 = document.createElement('div');
        r2.style.cssText = 'padding:8px 2px;border-bottom:.5px solid rgba(255,255,255,.06);color:#e6e6ea;font-size:13px';
        r2.appendChild(items[k].cloneNode(true));
        frag2.appendChild(r2);
      }
      sheetBody.appendChild(frag2);
    } catch (e) {}
  }

  function openSheet() {
    ensureSheet();
    if (!sheetEl) return false;
    fillSheet();
    sheetOpen = true;
    sheetEl.classList.add('on');
    sheetMask.classList.add('on');
    return true;
  }

  function closeSheet() {
    sheetOpen = false;
    try {
      if (sheetEl) sheetEl.classList.remove('on');
      if (sheetMask) sheetMask.classList.remove('on');
    } catch (e) {}
  }

  // 页面自己的"评论"按钮 → 改成开我们的抽屉
  function patchCommentButtons() {
    try {
      var links = document.querySelectorAll('a,button,div,span');
      for (var i = 0; i < links.length; i++) {
        var el = links[i];
        if (el.__dy4kCmt) continue;
        var txt = (el.innerText || '').replace(/\s+/g, '');
        if (txt !== '评论' && txt !== '查看评论' && txt !== '全部评论') continue;
        if (el.children.length > 1) continue;
        el.__dy4kCmt = 1;
        el.addEventListener('click', function (ev) {
          ev.preventDefault();
          ev.stopPropagation();
          openSheet();
        }, true);
      }
    } catch (e) {}
  }

  // 右下角常驻的评论入口（半屏抽屉的按钮）
  var cmtBtn = null;
  function ensureCommentBtn() {
    try {
      var onVideo = /\/video\//.test(location.pathname);
      if (!onVideo) { if (cmtBtn) cmtBtn.style.display = 'none'; return; }
      if (!cmtBtn) {
        cmtBtn = document.createElement('div');
        cmtBtn.id = 'dy4k-comment-btn';
        cmtBtn.style.cssText =
          'position:fixed;right:calc(10px * var(--dy4k-k,1));' +
          'bottom:calc(160px * var(--dy4k-k,1) + env(safe-area-inset-bottom,0px));' +
          'z-index:2147483001;width:calc(44px * var(--dy4k-k,1));height:calc(44px * var(--dy4k-k,1));' +
          'border-radius:50%;background:rgba(0,0,0,.55);' +
          'display:flex;align-items:center;justify-content:center;color:#fff;' +
          'box-shadow:0 3px 12px rgba(0,0,0,.4);backdrop-filter:blur(6px);';
        cmtBtn.innerHTML =
          '<svg viewBox="0 0 24 24" width="22" height="22" style="width:calc(22px * var(--dy4k-k,1));height:calc(22px * var(--dy4k-k,1))"><path fill="currentColor" ' +
          'd="M12 3C6.9 3 2.8 6.4 2.8 10.6c0 2.4 1.3 4.6 3.3 6l-.9 3.5c-.1.4.3.7.6.5l4-2.1c.7.1 1.5.2 2.2.2 5.1 0 9.2-3.4 9.2-7.6S17.1 3 12 3z"/></svg>';
        cmtBtn.addEventListener('click', function (ev) {
          ev.preventDefault();
          ev.stopPropagation();
          openSheet();
        }, false);
        (document.body || document.documentElement).appendChild(cmtBtn);
      }
      cmtBtn.style.display = 'flex';
    } catch (e) {}
  }

  // ============ 去掉页面上的 AI 浮标 ============
  // 只做"文字精确等于 AI / AI抖音 / AI搜索"这一种匹配。
  // 试过 [data-e2e*="ai"] 这类模糊属性选择器，会把播放器容器一起干掉（页面直接黑屏），已弃用。
  function hideAiEntries() {
    try {
      var els = document.querySelectorAll('div,span,button,a');
      for (var i = 0; i < els.length; i++) {
        var el = els[i];
        if (el.classList.contains('dy4k-hide')) continue;
        var t = (el.textContent || '').replace(/[\s\n]/g, '');
        if (t !== 'AI' && t !== 'AI抖音' && t !== 'AI搜索') continue;
        var r = el.getBoundingClientRect();
        if (r.width < 14 || r.height < 14 || r.width > 190 || r.height > 190) continue;
        (el.closest('[class*="ai"],[class*="Ai"],button,a') || el).classList.add('dy4k-hide');
      }
    } catch (e) {}
  }

  // ============ 个人主页/作者页：单列手机版 ============
  function applyUserPageMode() {
    try {
      var isUser = /\/user\//.test(location.pathname);
      if (isUser) document.body.classList.add('dy4k-user');
      else document.body.classList.remove('dy4k-user');
    } catch (e) {}
  }

  // ============ 网页播放器没自动播时，帮它一把 ============
  // 关键：每个 <video> 只推一次！之前是每 1.2s 检查"暂停就 play()"，
  // 结果用户手动点暂停后 1 秒就被我们重新播起来了。
  function nudgePlay() {
    try {
      var vs = document.querySelectorAll('video');
      for (var i = 0; i < vs.length; i++) {
        var v = vs[i];
        if (v.__dy4kNudged) continue;
        if (!v.paused) { v.__dy4kNudged = 1; continue; }       // 本来就在播，标记掉
        if (v.videoWidth && v.readyState >= 2) {
          v.__dy4kNudged = 1;                                   // 只推一次，之后不再干预
          try { var p = v.play(); if (p && p.catch) p.catch(function () {}); } catch (e) {}
        }
      }
    } catch (e) {}
  }
  
  // ================== 4) HUD（分辨率 / 档位 / fps / 码率） ==================
  var hudEl = null;
  var fpsState = { v: null, n: 0, t0: 0, fps: null };
  var bwState = { bytes: 0, t: 0, mbps: null, at: 0, anchorT: 0, anchorBytes: 0 };
  var xhrBytes = { total: 0 };   // XHR progress 累计
  var fetchBytes = { total: 0 }; // fetch 流式字节统计
  var sawMediaBytes = false;     // 到底测到过字节没有（没有就显示 --，别显示 0.00）

  // 实测帧率：requestVideoFrameCallback 滚 1 秒窗口
  function watchFps(v) {
    if (!v || fpsState.v === v) return;
    fpsState = { v: v, n: 0, t0: 0, fps: null };
    if (typeof v.requestVideoFrameCallback !== 'function') return;
    var step = function (now) {
      if (fpsState.v !== v) return;
      if (!v.paused && !v.ended) {
        if (!fpsState.t0) fpsState.t0 = now;
        fpsState.n++;
        if (now - fpsState.t0 >= 1000) {
          fpsState.fps = (fpsState.n * 1000 / (now - fpsState.t0)).toFixed(1);
          fpsState.n = 0;
          fpsState.t0 = now;
        }
      }
      try { v.requestVideoFrameCallback(step); } catch (e) {}
    };
    try { v.requestVideoFrameCallback(step); } catch (e) {}
  }

  // 实测码率：XHR progress + fetch 流字节数；都没有时退化成 Resource Timing（跨域常被屏蔽为 0）
  var MEDIA_RE = /douyinvod|bytecdn|bytecdntp|zjcdn|vod-hls|tos-cn-.*(video|audio)|\/aweme\/v1\/play|mime_type=(video|audio)|\.m4s|\.ts\b/i;

  function installByteCounter() {
    // ---- XHR：用 progress 事件的 loaded 增量 ----
    try {
      var XO = window.XMLHttpRequest;
      if (XO && XO.prototype && !XO.prototype.__dy4kBytes) {
        var xopen = XO.prototype.open;
        XO.prototype.open = function (m, u) {
          var url = String(u || '');
          if (MEDIA_RE.test(url)) {
            var self = this;
            try {
              self.addEventListener('progress', function (e) {
                var d = e.loaded - (self.__dy4kLoaded || 0);
                if (d > 0) { xhrBytes.total += d; self.__dy4kLoaded = e.loaded; sawMediaBytes = true; }
              });
            } catch (e) {}
          }
          return xopen.apply(this, arguments);
        };
        XO.prototype.__dy4kBytes = 1;
      }
    } catch (e) {}

    // ---- fetch：clone 一份流着读，只数字节不存内容 ----
    try {
      var of = window.fetch;
      if (typeof of === 'function' && !of.__dy4kBytes) {
        var wrapped = function (input, init) {
          var url = '';
          try { url = String(typeof input === 'string' ? input : (input && input.url) || ''); } catch (e) {}
          var pr = of.apply(this, arguments);
          if (!MEDIA_RE.test(url)) return pr;
          return pr.then(function (res) {
            try {
              var cl = res.clone();
              if (cl.body && cl.body.getReader) {
                var rd = cl.body.getReader();
                var pump = function () {
                  rd.read().then(function (r) {
                    if (r.done) return;
                    if (r.value && r.value.byteLength) { fetchBytes.total += r.value.byteLength; sawMediaBytes = true; }
                    pump();
                  }).catch(function () {});
                };
                pump();
              }
            } catch (e) {}
            return res;
          });
        };
        wrapped.__dy4kBytes = 1;
        window.fetch = wrapped;
      }
    } catch (e) {}
  }

  function mediaBytesFromTiming() {
    var s = 0;
    try {
      var es = performance.getEntriesByType('resource');
      for (var i = 0; i < es.length; i++) {
        var e = es[i];
        if (!e.name || !MEDIA_RE.test(e.name)) continue;
        s += e.transferSize || e.encodedBodySize || 0;
      }
    } catch (e) {}
    return s;
  }

  function sampleBw() {
    // 优先 XHR progress（最精确），其次是 fetch 流计数，最后才退到 Resource Timing（跨域常为 0）
    var b = xhrBytes.total || fetchBytes.total || mediaBytesFromTiming();
    var t = (function () { try { return performance.now(); } catch (e) { return Date.now(); } })();
    if (!bwState.anchorT) { bwState.anchorT = t; bwState.anchorBytes = b; }
    // 2 秒一个窗口，避免分段预取把瞬时值冲到 100Mbps
    var dt = (t - bwState.anchorT) / 1000;
    if (dt >= 2) {
      if (b > bwState.anchorBytes) {
        var mbps = (b - bwState.anchorBytes) * 8 / dt / 1e6;
        if (mbps > 0.02) { bwState.mbps = mbps.toFixed(2); bwState.at = t; }
      }
      bwState.anchorT = t;
      bwState.anchorBytes = b;
    }
    // 缓冲满了没在下载时别闪 0.00：6 秒没有新字节就显示 --
    if (bwState.at && t - bwState.at > 6000) bwState.mbps = null;
  }

  function hevcOk() {
    try {
      var v = document.createElement('video');
      var t1 = v.canPlayType && v.canPlayType('video/mp4; codecs="hvc1.1.6.L183.B0"');
      var t2 = window.MediaSource && MediaSource.isTypeSupported && MediaSource.isTypeSupported('video/mp4; codecs="hvc1.1.6.L183.B0"');
      return !!(t1 || t2);
    } catch (e) { return false; }
  }

  function gearName() {
    var ms = null;
    try { ms = JSON.parse(safeGet(sessionStorage, K) || 'null'); } catch (e) {}
    if (!ms) return '-';
    return ms.gearName || String(ms.gearType);
  }

  function renderHud() {
    if (!CFG.hud) { if (hudEl) hudEl.style.display = 'none'; return; }
    try {
      var v = activeVideo();
      watchFps(v);
      sampleBw();
      if (!hudEl) {
        hudEl = document.createElement('div');
        hudEl.id = 'dy4k-hud';
        (document.body || document.documentElement).appendChild(hudEl);
      }
      hudEl.style.display = 'block';
      var res = v && v.videoWidth ? (v.videoWidth + 'x' + v.videoHeight) : 'no video';
      var g = gearName();
      var fps = fpsState.fps ? fpsState.fps : (v && v.paused ? '0.0' : '--');
      var bw = (sawMediaBytes && bwState.mbps) ? (bwState.mbps + 'Mbps') : '--';
      var ab = STAT.abHits ? ('ab' + STAT.abHits) : (CFG.abPatch ? 'ab…' : 'ab off');
      var h2 = '?';
      try {
        var v2 = window.abTestData && window.abTestData.has2K;
        if (v2 !== undefined && v2 !== null) h2 = String(v2);
      } catch (e) {}
      hudEl.textContent =
        res + '  ' + g + '\n' +
        'fps ' + fps + '  ' + bw + '\n' +
        ab + '  hevc ' + (hevcOk() ? '✓' : '✗') + '  has2k=' + h2;
    } catch (e) {}
  }

  // ================== 5) App 桥：原生 4K 播放（只有在本 App 里才启用） ==================
  // 为什么需要它：4K 码流只有 HEVC，而 Android 系统 WebView（本机是 104）没有把 HEVC 暴露给网页层，
  // 网页播放器最高只能到 1080P H.264。App 侧用 MediaPlayer 走硬件 HEVC 解码播 4K 直链。
  // 这里负责：从页面自己的接口响应里把 bit_rate[] 抓下来 → 挑最高档的 mp4 直链 → 交给原生。
  function pickBestGear(list) {
    if (!list || !list.length) return null;
    var all = [], best = null, i, b, pa, u, rec;
    for (i = 0; i < list.length; i++) {
      b = list[i];
      if (!b) continue;
      pa = b.play_addr || {};
      u = (pa.url_list && pa.url_list[0]) || '';
      if (!u) continue;
      if (String(b.format) !== 'mp4') continue;      // dash 是分片的，MediaPlayer 播不了
      rec = {
        url: u,
        w: Number(pa.width) || 0,
        h: Number(pa.height) || 0,
        kbps: Math.round((Number(b.bit_rate) || 0) / 1000),
        h265: !!(b.is_h265 || b.is_bytevc1),
        gear: b.gear_name || ''
      };
      all.push(rec);
      if (!best || rec.h > best.h || (rec.h === best.h && rec.kbps > best.kbps)) best = rec;
    }
    return best ? { best: best, all: all } : null;
  }

  function collectAweme(o, depth) {
    if (!o || typeof o !== 'object' || depth > 9) return;
    if (o.aweme_id && o.video) {
      var got = pickBestGear(o.video.bit_rate);
      var id = String(o.aweme_id);
      AWEME[id] = o;                       // 作者/文案/统计都在这
      if (got) {
        var prev = GEARS[id];
        // 同一个 aweme 可能在 detail / related / series 里各来一次，字段多少不一样：
        // 一定保留"档位最高"的那一次，别被后面的精简响应覆盖成 1080P
        if (!prev || !prev.best ||
            got.best.h > prev.best.h ||
            (got.best.h === prev.best.h && got.best.kbps > prev.best.kbps)) {
          GEARS[id] = got;
          RAW_STREAM[id] = o.video;
        }
      }
    }
    for (var k in o) {
      var v = o[k];
      if (v && typeof v === 'object') collectAweme(v, depth + 1);
    }
  }

  // 评论列表：抓 {comments:[{user:{nickname,avatar_thumb},text,digg_count}]}
  function collectComments(o, depth) {
    if (!o || typeof o !== 'object' || depth > 6) return;
    var list = o.comments || o.comment_list;
    if (list && list.length && list[0] && (list[0].text !== undefined || list[0].content !== undefined)) {
      var aid = String(o.aweme_id || (o.comment_info && o.comment_info.aweme_id) || currentAwemeId());
      var arr = COMMENTS[aid] || (COMMENTS[aid] = []);
      for (var i = 0; i < list.length; i++) {
        var c = list[i];
        if (!c || (!c.text && !c.content)) continue;
        var u = c.user || {};
        arr.push({
          nick: u.nickname || '',
          avatar: (u.avatar_thumb && u.avatar_thumb.url_list && u.avatar_thumb.url_list[0]) || '',
          text: c.text || c.content || '',
          digg: c.digg_count || 0
        });
      }
      log('comments sniffed', aid, arr.length);
    }
    for (var k in o) {
      var v = o[k];
      if (v && typeof v === 'object') collectComments(v, depth + 1);
    }
  }

  function sniffBody(txt) {
    if (!txt || txt.length < 80) return;
    if (txt.indexOf('bit_rate') >= 0) {
      try { collectAweme(JSON.parse(txt), 0); log('sniff gears, known =', Object.keys(GEARS).length); } catch (e) {}
    }
    if (txt.indexOf('"comments"') >= 0 || txt.indexOf('comment_list') >= 0) {
      try { collectComments(JSON.parse(txt), 0); } catch (e) {}
    }
  }

  // 视频页首屏数据在 <script id="RENDER_DATA">（URL 编码的 JSON）里，
  // 这条路径不经过 fetch/XHR，必须单独捞一次，否则有些视频只会拿到精简过的 1080P 列表。
  function collectFromRenderData() {
    try {
      var el = document.getElementById('RENDER_DATA');
      if (!el || !el.textContent || el.__dy4kParsed) return;
      el.__dy4kParsed = 1;
      var txt = el.textContent;
      if (txt.indexOf('bit_rate') < 0) txt = decodeURIComponent(txt);
      if (txt.indexOf('bit_rate') < 0) return;
      collectAweme(JSON.parse(txt), 0);
      log('RENDER_DATA gears, known =', Object.keys(GEARS).length);
    } catch (e) {}
  }

  function currentAwemeId() {
    var m = /\/video\/(\d{8,25})/.exec(location.pathname);
    return m ? m[1] : '';
  }

  var nativeBtn = null;
  function ensureNativeBtn() {
    if (!window.dy4kNative || !CFG.nativeBtn) return;
    collectFromRenderData();
    var id = currentAwemeId();
    var g = id && GEARS[id];
    if (!g || !g.best) {
      if (nativeBtn) nativeBtn.style.display = 'none';
      return;
    }
    if (!nativeBtn) {
      nativeBtn = document.createElement('div');
      nativeBtn.id = 'dy4k-native-btn';
      nativeBtn.style.cssText =
        'position:fixed;right:calc(10px * var(--dy4k-k,1));' +
        'bottom:calc(112px * var(--dy4k-k,1) + env(safe-area-inset-bottom,0px));' +
        'z-index:2147483001;background:#fe2c55;color:#fff;' +
        'font:600 calc(12px * var(--dy4k-k,1))/1 -apple-system,sans-serif;' +
        'padding:calc(9px * var(--dy4k-k,1)) calc(12px * var(--dy4k-k,1));' +
        'border-radius:999px;box-shadow:0 4px 14px rgba(254,44,85,.45);' +
        'white-space:nowrap;letter-spacing:.3px;';
      (document.body || document.documentElement).appendChild(nativeBtn);
    }
    var b = g.best;
    nativeBtn.textContent = '原生 ' + (b.h >= 2160 ? '4K ' : '') + b.w + 'x' + b.h + (b.h265 ? ' HEVC' : '');
    nativeBtn.style.display = 'block';
    nativeBtn.onclick = function (ev) {
      try { ev.preventDefault(); ev.stopPropagation(); } catch (e) {}
      playNative();
    };
  }

  function playNative(id) {
    try {
      if (!window.dy4kNative) return '只在 App 里可用（浏览器里没有 window.dy4kNative）';
      id = id || currentAwemeId();
      var g = GEARS[id];
      if (!g || !g.best) return '还没抓到这条视频的码流，先把视频播一下再试';
      // 先把网页里的声音停掉，避免和原生播放器双声道
      try {
        var vs = document.querySelectorAll('video');
        for (var i = 0; i < vs.length; i++) vs[i].pause();
      } catch (e) {}
      var t = (document.title || '') + ' @' + id;
      log('playNative', g.best.w + 'x' + g.best.h, g.best.kbps + 'kbps', g.best.gear);
      window.dy4kNative.play4k(g.best.url, g.best.w, g.best.h, t);
      return 'native player -> ' + g.best.w + 'x' + g.best.h;
    } catch (e) { return 'playNative error: ' + String(e).slice(0, 120); }
  }

  // ================== 启动 ==================
  refreshForceKeys();
  installABPatch();
  installByteCounter();
  if (CFG.uiRestyle) watchViewport();
  tick();
  [0, 30, 80, 160, 320, 600, 1000, 1600, 2600, 4000].forEach(function (ms) { setTimeout(tick, ms); });
  setInterval(tick, 400);
  try {
    document.addEventListener('visibilitychange', function () { tick(); renderHud(); }, false);
    window.addEventListener('pageshow', function () { tick(); }, false);
    document.addEventListener('dblclick', function (e) { e.preventDefault(); }, { passive: false });
  } catch (e) {}

  var booted = false;
  var uiRefresh = null;
  function applyUiSoon() { try { if (uiRefresh) uiRefresh(); } catch (e) {} }
  function boot() {
    if (booted) return;
    booted = true;
    ensureStyle();
    patchViewport();
    log('boot', CFG);

    var hintShown = false;
    function applyUI() {
      ensureStyle();
      var mobileShell = isMobileShell();
      if (mobileShell && !hintShown) {
        hintShown = true;
        toast('检测到「移动版网页」：只有 720P 水印流。\n请切到「桌面版网站 / Request desktop site」再刷新。', 9000);
      }
      if (!mobileShell && CFG.uiRestyle) {
        var isVideoPage = /\/video\//.test(location.pathname);
        buildTabbar();
        applyUserPageMode();
        if (isVideoPage) {
          // 详情页：接管成全屏播放器 + 自己的浮层
          immersive(true);
          ensureOverlay();
          patchCommentButtons();
        } else if (/^\/(follow|friend)/.test(location.pathname)) {
          // 关注/朋友页其实也是"一条视频一屏"：站点排的是三栏桌面布局（左栏+视频+右栏），
          // 这里直接复用视频页的接管方式，把播放器拉成全屏，左栏在 hideSideRail 里已经藏掉。
          var vv = activeVideo();
          if (vv && vv.videoWidth > 0) {
            immersive(true);
            ensureOverlay();
          }
        } else {
          // 推荐流/关注/朋友/我的：页面本身就是手机版布局，别去动它
          immersive(false);
          stripFocusMarks();
        }
        hideDesktopChrome();   // 左侧图标栏 / 顶部搜索头
        hideSideRail();        // 关注/朋友页左侧那一大列
        syncScale();           // 站点按 786 排版缩 0.5，把我们自己的 UI 放大回来
        tidyDanmaku();         // 弹幕只在上半屏 + 手机版字号
        ensureCommentBtn();
      }
      installUserLinkInterceptor();
      renderHud();
      ensureNativeBtn();
    }
    applyUI();
    uiRefresh = applyUI;
    // 首屏之后再补几轮（React 是异步渲染的）
    [200, 600, 1200, 2400].forEach(function (ms) { setTimeout(applyUI, ms); });

    // 开屏落在「全屏视频页」而不是精选瀑布：首页就是一条条全屏视频（和 App 一致）
    var homeTried = 0;
    function goVideoHome() {
      if (/\/video\//.test(location.pathname)) return;
      // 只在「落地页」才跳到全屏视频；/follow、/friend、/user 这些是有意的整页跳转，别抢回去
      var p0 = location.pathname;
      if (!(p0 === '/' || p0 === '/jingxuan' || p0 === '')) return;
      if (homeTried >= 2) return;
      homeTried++;
      var seed = lastSeed();
      if (seed) {
        log('boot -> video home (full load)', seed);
        location.href = '/video/' + seed;      // 整页加载，才能把 viewport 设成 scale=1
        return;
      }
      try {
        if (!window.dy4kApi) { setTimeout(goVideoHome, 900); return; }
        window.dy4kApi.related('', 10).then(function (j) {
          var a = (j && j.aweme_list && j.aweme_list[0]) || null;
          if (!a || !a.aweme_id) return;
          try { localStorage.setItem('dy4k-seed', a.aweme_id); } catch (e) {}
          log('boot -> video home (fetched)', a.aweme_id);
          location.href = '/video/' + a.aweme_id;
        });
      } catch (e) {}
    }
    setTimeout(goVideoHome, 900);

    // SPA 路由变化：只重建我们自己的壳，不重载页面
    var lastPath = location.pathname + location.search;
    setInterval(function () {
      var np = location.pathname + location.search;
      if (np === lastPath) return;
      lastPath = np;
      log('route change', np);
      closeSheet();
      buildTabbar();
      setTimeout(applyUI, 120);
      setTimeout(applyUI, 500);
      setTimeout(applyUI, 1200);
    }, 400);

    // 轻量持续任务（1.2s）：只做"便宜"的事，重活放到 applyUI / 低频
    if (CFG.uiRestyle) {
      setInterval(function () {
        if (isMobileShell()) return;
        var isVideoPage = /\/video\//.test(location.pathname);
        nudgePlay();                                     // 顺手先把播放推起来
        tidyDanmaku();
        if (isVideoPage) {
          var v = activeVideo();
          if (v) {
            var stage = document.querySelector('.dy4k-stage');
            if (!stage || !stage.contains(v)) immersive(true);
          }
          ensureOverlay();
          patchCommentButtons();
          ensureCommentBtn();
        }
      }, 1200);
      // 低频（6s）：AI 浮标扫描要遍历全站 div，别每 1.2s 跑一次
      setInterval(function () {
        if (!isMobileShell()) hideAiEntries();
      }, 6000);
      // 布局/侧栏：路由切换后 1~2 次就够，跟随 3s 复查一次（页面异步渲染）
      setInterval(function () {
        if (isMobileShell()) return;
        hideSideRail();
        fitViewport();
      }, 3000);
    }

    if (CFG.hud) {
      renderHud();
      setInterval(renderHud, 800);
    }

    // App 内：盯着当前视频有没有 4K 直链，有了就亮出「原生 4K」按钮
    if (window.dy4kNative) {
      setInterval(ensureNativeBtn, 1000);
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
  else boot();

  // ================== 控制台 API ==================
  window.dy4k = {
    cfg: CFG,
    stat: function () { return STAT; },
    state: function () {
      var ms = null;
      try { ms = safeGet(sessionStorage, K); } catch (e) {}
      var parsed = null;
      try { parsed = JSON.parse(ms || 'null'); } catch (e) {}
      return {
        cfg: CFG,
        target: CFG.target,
        manual: ms,
        clarityReal: parsed && parsed.clarityReal ? parsed.clarityReal : null,
        abHits: STAT.abHits,
        has2K: !!(window.abTestData && window.abTestData.has2K),
        autoDefi: (function () {
          try {
            var br = window.abTestData && window.abTestData.abrConfig;
            return br ? { open: br.isOpenAutoDefi, play: br.isPlayAutoDefi } : null;
          } catch (e) { return null; }
        })(),
        hevc: hevcOk(),
        mobileShell: isMobileShell(),
        hud: hudEl ? hudEl.textContent : null,
        video: (function () { var v = activeVideo(); return v ? { rw: v.videoWidth, rh: v.videoHeight, paused: v.paused, t: v.currentTime } : null; })()
      };
    },
    target: function (t) {
      if (!PRESETS[t]) return 'target: 4khdr | 4k | 2k | 1080p';
      CFG.target = t; p = PRESETS[t]; tick();
      return 'target=' + t;
    },
    hud: function (on) { CFG.hud = !!on; renderHud(); return 'hud=' + CFG.hud; },
    tabbar: function (on) {
      CFG.tabbar = !!on;
      var b = document.getElementById('dy4k-tabbar');
      if (!on && b) b.parentNode.removeChild(b);
      if (on) buildTabbar();
      return 'tabbar=' + CFG.tabbar;
    },
    immersive: function (on) { return immersive(on === undefined ? true : !!on); },
    // App 桥：这条视频抓到哪些档位 / 直接交给原生播
    gears: function (id) {
      id = id || currentAwemeId();
      var g = GEARS[id];
      if (!g) return { id: id, known: Object.keys(GEARS).length, gears: null };
      return { id: id, best: g.best, count: g.all.length, gears: g.all };
    },
    playNative: function (id) { return playNative(id); },
    // 兜底：个别视频客户端自己不给 4K 档，手动点一下菜单里的「超清 4K」即可
    // 用法：先手动点开清晰度菜单，再在控制台执行 dy4k.pickGear('超清 4K')
    pickGear: function (name) {
      name = name || p.gearName;
      try {
        var cands = document.querySelectorAll('div,span,li,button,p,a');
        for (var i = 0; i < cands.length; i++) {
          var el = cands[i];
          if (el.children.length) continue;
          var t = (el.textContent || '').trim();
          if (t !== name && t.indexOf(name) !== 0) continue;
          var r = el.getBoundingClientRect();
          if (r.width < 1 || r.height < 1) continue;
          el.click();
          return 'clicked: ' + name;
        }
        return '没找到「' + name + '」这一项，先手动点开清晰度菜单再试';
      } catch (e) { return 'pickGear error: ' + String(e).slice(0, 120); }
    },
    force2k: function (on) {
      CFG.force2k = !!on; refreshForceKeys();
      return 'force2k=' + CFG.force2k + '（已 patch 的响应不会回滚，重开页面才彻底生效）';
    },
    debug: function (on) { CFG.debug = !!on; return 'debug=' + CFG.debug; },
    tick: tick,
    toast: toast
  };
  log('installed', nowMs());
})();
