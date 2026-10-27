import fs from 'node:fs';

const P = 'mobile-web/douyin-4k.user.js';
let t = fs.readFileSync(P, 'utf8');

const startMark = '  // ============ 宽版页面自适应 ============';
const endMark = '  // ============ 关注/朋友页：去掉左侧那条竖栏';

const i = t.indexOf(startMark);
const j = t.indexOf(endMark);
if (i < 0 || j < 0 || j < i) {
  console.error('markers not found', i, j);
  process.exit(1);
}

const replacement = `  // ============ 缩放同步：页面按 786px 排版再整体缩 0.5，我们自己的 UI 反向放大 ============
  // 抖音桌面版固定下发 initial-scale=0.5：页面在 786 逻辑像素上排版、整页缩一半显示。
  // 这个**不去改**（改了页面反而按 628 排版溢出屏幕、右边被裁），只用 --dy4k-k = 1/scale
  // 把自己的 UI（底部导航/浮层/HUD）放大回来，屏幕上还是手机版尺寸。
  function syncScale() {
    try {
      var s = (window.visualViewport && window.visualViewport.scale) || 1;
      var k = (s > 0 && s < 1) ? (1 / s) : 1;
      document.documentElement.style.setProperty('--dy4k-k', k.toFixed(3));
      return k;
    } catch (e) { return 1; }
  }

  // 兼容旧调用点
  function fitViewport() { return syncScale(); }
  function guardViewport() { return syncScale(); }
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

`;

t = t.slice(0, i) + replacement + t.slice(j);
fs.writeFileSync(P, t, 'utf8');
console.log('replaced block:', (j - i), '->', replacement.length);
