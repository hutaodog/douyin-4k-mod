/**
 * 393 宽下诊断页面布局：找出是谁把宽度撑到 628，以及怎么改成自适应。
 * 用法：node mobile-web/tools/diag-narrow.mjs [url]
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { loadPW, UAS, stamp, baseLaunchOptions } from './lib/browser.mjs';

const URL_ = process.argv[2] || 'https://www.douyin.com/?recommend=1';
const OUT = path.resolve('mobile-web/probe-output');
fs.mkdirSync(OUT, { recursive: true });

const { chromium } = loadPW();
const ctx = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(OUT, '_narrow-')),
  { ...baseLaunchOptions({ ua: UAS.desktop }), viewport: { width: 393, height: 844 }, deviceScaleFactor: 2 });

const cookies = path.resolve('mobile-web/probe-output/cookies.json');
if (fs.existsSync(cookies)) {
  try {
    const list = JSON.parse(fs.readFileSync(cookies, 'utf8'));
    await ctx.addCookies(list.filter((c) => c.name && c.name.trim()).map((c) => ({
      name: c.name, value: c.value,
      domain: c.domain && c.domain.startsWith('.') ? c.domain : '.' + String(c.domain || 'douyin.com').replace(/^\./, ''),
      path: c.path || '/', secure: c.secure !== false, httpOnly: !!c.httpOnly,
      sameSite: ['Lax', 'Strict', 'None'].includes(c.sameSite) ? c.sameSite : 'Lax'
    })));
  } catch (e) {}
}

const page = await ctx.newPage();
page.on('console', (m) => { if (m.type() === 'error') console.log(stamp(), 'console:', m.text().slice(0, 90)); });
await page.goto(URL_, { waitUntil: 'domcontentloaded', timeout: 45000 });
await page.waitForTimeout(9000);

const info = await page.evaluate(() => {
  const out = {
    iw: innerWidth, ih: innerHeight,
    deSW: document.documentElement.scrollWidth,
    bodySW: document.body.scrollWidth,
    meta: (document.querySelector('meta[name=viewport]') || {}).content || '',
    suspects: [], chain: []
  };
  // 谁比视口宽
  const all = [...document.querySelectorAll('body *')];
  for (const el of all) {
    const r = el.getBoundingClientRect();
    if (r.width <= innerWidth + 4 || r.height < 40) continue;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') continue;
    out.suspects.push({
      cls: String(el.className).slice(0, 60),
      tag: el.tagName,
      w: Math.round(r.width),
      left: Math.round(r.left),
      display: cs.display,
      width: cs.width,
      minW: cs.minWidth,
      maxW: cs.maxWidth,
      flexBasis: cs.flexBasis,
      grid: cs.gridTemplateColumns,
      position: cs.position
    });
    if (out.suspects.length >= 14) break;
  }
  // 视频/网格元素的祖先链宽度
  const v = document.querySelector('video') || document.querySelector('[class*=waterfall]') || document.querySelector('[class*=grid]');
  let el = v;
  for (let i = 0; el && i < 10; i++) {
    const cs = getComputedStyle(el);
    out.chain.push({
      cls: String(el.className).slice(0, 46),
      w: Math.round(el.getBoundingClientRect().width),
      width: cs.width, minW: cs.minWidth, maxW: cs.maxWidth,
      display: cs.display, flex: cs.flex, grid: cs.gridTemplateColumns
    });
    el = el.parentElement;
  }
  return out;
});

console.log('viewport :', info.iw + 'x' + info.ih, '| de.scrollW', info.deSW, '| body.scrollW', info.bodySW);
console.log('meta     :', info.meta.slice(0, 90));
console.log('--- 比视口宽的元素 ---');
for (const s of info.suspects) {
  console.log(`  ${s.tag}.${s.cls} w=${s.w} left=${s.left} display=${s.display} width=${s.width} minW=${s.minW} maxW=${s.maxW} grid=${s.grid.slice(0, 30)}`);
}
console.log('--- 视频/网格 祖先链 ---');
for (const c of info.chain) {
  console.log(`  ${c.cls} w=${c.w} width=${c.width} minW=${c.minW} display=${c.display} grid=${c.grid.slice(0, 26)}`);
}

await page.screenshot({ path: path.join(OUT, 'narrow-before.png') });
console.log('saved', path.join(OUT, 'narrow-before.png'));

// 试一次"强制回流"：把最外层容器宽度改成 100vw，看能不能自适应
const applied = await page.evaluate(() => {
  const css = `
    html, body { width: 100vw !important; max-width: 100vw !important; overflow-x: hidden !important; }
    #root, #root > div { width: 100vw !important; max-width: 100vw !important; min-width: 0 !important; }
    [class*=route-scroll-container], [class*=parent-route-container] { width: 100vw !important; min-width: 0 !important; }
  `;
  const s = document.createElement('style');
  s.id = 'dy4k-narrow-test';
  s.textContent = css;
  document.head.appendChild(s);
  return document.documentElement.scrollWidth;
});
await page.waitForTimeout(1200);
const after = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, bsw: document.body.scrollWidth }));
console.log('强制 100vw 之后 scrollWidth =', after.sw, '/', after.bsw);
await page.screenshot({ path: path.join(OUT, 'narrow-after.png') });
console.log('saved', path.join(OUT, 'narrow-after.png'));

await ctx.close();
