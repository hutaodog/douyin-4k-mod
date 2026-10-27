(() => {
  const out = [];
  const iw = innerWidth;
  out.push('viewport=' + iw + 'x' + innerHeight +
    ' de.clientW=' + document.documentElement.clientWidth +
    ' body.scrollW=' + document.body.scrollWidth +
    ' de.scrollW=' + document.documentElement.scrollWidth);

  // 1) 谁把页面撑宽了 / 谁被 transform 缩放
  const wide = [];
  const scaled = [];
  [...document.querySelectorAll('body *')].forEach((el) => {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    if (r.width > iw + 8 && r.height > 40 && wide.length < 12) {
      wide.push(String(el.className || el.tagName).slice(0, 40) + ' w=' + Math.round(r.width) + ' x=' + Math.round(r.left));
    }
    if (cs.transform && cs.transform !== 'none' && r.width > 200 && scaled.length < 8) {
      scaled.push(String(el.className || el.tagName).slice(0, 40) + ' ' + cs.transform);
    }
  });
  out.push('--- 超宽元素 ---'); wide.forEach((x) => out.push('  ' + x));
  out.push('--- transform 元素 ---'); scaled.forEach((x) => out.push('  ' + x));

  // 2) 弹幕容器
  const dm = [];
  [...document.querySelectorAll('[class*="danmu"],[class*="Danmu"],[class*="danmaku"]')].slice(0, 10).forEach((el) => {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    dm.push(String(el.className).slice(0, 44) + ' [' + Math.round(r.left) + ',' + Math.round(r.top) + ' ' +
      Math.round(r.width) + 'x' + Math.round(r.height) + '] fs=' + cs.fontSize + ' z=' + cs.zIndex);
  });
  out.push('--- 弹幕容器 ---'); dm.forEach((x) => out.push('  ' + x));

  // 3) 左侧栏 / 竖排头像条（关注页那种）
  const rails = [];
  [...document.querySelectorAll('div')].forEach((el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 20 || r.width > 110) return;
    if (r.height < 200) return;
    if (r.left > 60) return;
    const cs = getComputedStyle(el);
    if (cs.position !== 'fixed' && cs.position !== 'absolute' && cs.position !== 'relative') return;
    rails.push(String(el.className || 'DIV').slice(0, 40) + ' [' + Math.round(r.left) + ',' + Math.round(r.top) + ' ' +
      Math.round(r.width) + 'x' + Math.round(r.height) + '] ' + cs.position + ' kids=' + el.children.length);
  });
  out.push('--- 左侧竖条候选 ---'); rails.slice(0, 10).forEach((x) => out.push('  ' + x));

  // 4) 图文左右切换按钮（中间那对）
  const arrows = [];
  [...document.querySelectorAll('div,span,button')].forEach((el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 16 || r.width > 90 || r.height < 16 || r.height > 90) return;
    if (r.top < innerHeight * 0.2 || r.top > innerHeight * 0.8) return;
    const cs = getComputedStyle(el);
    if (cs.position !== 'absolute' && cs.position !== 'fixed') return;
    if (!el.querySelector('svg') && !/prev|next|arrow|switch|left|right/i.test(String(el.className))) return;
    arrows.push(String(el.className || el.tagName).slice(0, 44) + ' [' + Math.round(r.left) + ',' + Math.round(r.top) + ']');
  });
  out.push('--- 中部绝对定位小按钮（图文左右箭头候选）---');
  [...new Set(arrows)].slice(0, 12).forEach((x) => out.push('  ' + x));

  out.push('--- url --- ' + location.href);
  return out.join('\n');
})()
