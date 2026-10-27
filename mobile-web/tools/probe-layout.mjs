/**
 * 布局探针：抓"真实类名 + 布局骨架"，用来替掉 userscript 里那堆猜的 CSS 选择器。
 *
 * 输出：
 *   1) #root 骨架树（深度/宽度都截断过）：tag、class、rect、position、z-index、text 摘要
 *   2) 关键词 → 真实类名映射（header / sidebar / download / app / login / comment / player / mask …）
 *   3) 所有 position:fixed/sticky 的浮层（"打开App""下载条""登录浮层"就在这里）
 *   4) 截图
 *
 * 用法：
 *   node mobile-web/tools/probe-layout.mjs --url https://www.douyin.com/jingxuan --out mobile-web/probe-output/layout
 *   node mobile-web/tools/probe-layout.mjs --url <视频页> --click-first --autoplay
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { loadPW, findChrome, UAS, parseArgs, stamp, baseLaunchOptions } from './lib/browser.mjs';

const a = parseArgs(process.argv.slice(2));
const URL_ARG = String(a.url || 'https://www.douyin.com/jingxuan');
const OUT = path.resolve(String(a.out || 'mobile-web/probe-output/layout'));
const UA = a['ua-android'] ? UAS.android : a['ua-iphone'] ? UAS.iphone : (a.ua && a.ua !== true ? String(a.ua) : UAS.desktop);
const WAIT = Number(a.wait || 12000);
const CLICK = !!a['click-first'];
const HEADED = !!a.headed;

fs.mkdirSync(OUT, { recursive: true });
const log = (...m) => console.log(stamp(), ...m);

const { chromium } = loadPW();
const ctx = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(OUT, '_profile-')),
  baseLaunchOptions({ headed: HEADED, ua: UA }));
if (a.script && a.script !== true) {
  const code = fs.readFileSync(path.resolve(String(a.script)), 'utf8');
  await ctx.addInitScript({ content: code });
  log('injected', a.script, code.length, 'bytes');
}
const page = ctx.pages()[0] || await ctx.newPage();
log('chrome', findChrome());
log('ua    ', UA.slice(0, 60));
try {
  await page.goto(URL_ARG, { waitUntil: 'domcontentloaded', timeout: 45000 });
} catch (e) { log('goto err', String(e).slice(0, 160)); }
await page.waitForTimeout(WAIT);

if (CLICK) {
  const clicked = await page.evaluate(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const hits = [];
    const cands = [].slice.call(document.querySelectorAll('a[href*="/video/"], [class*="videoCard"], [class*="VideoCard"], [class*="card"] , [class*="Card"]')).slice(0, 6);
    for (const el of cands) {
      const r = el.getBoundingClientRect();
      if (r.width < 60 || r.height < 60) continue;
      hits.push({ cls: String(el.className || '').slice(0, 60), href: el.getAttribute && el.getAttribute('href'), rect: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)] });
      try { el.click(); } catch (e) {}
      await sleep(2500);
      break;
    }
    return hits;
  });
  log('clicked', JSON.stringify(clicked).slice(0, 300));
  await page.waitForTimeout(6000);
}

const layout = await page.evaluate(() => {
  const MAXN = 500;
  let n = 0;
  const short = (s, k) => (s || '').replace(/\s+/g, ' ').trim().slice(0, k);
  const desc = (el) => {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    const o = {
      t: el.tagName.toLowerCase(),
      r: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)],
      p: cs.position,
      z: cs.zIndex === 'auto' ? '' : cs.zIndex,
      o: cs.overflow !== 'visible' ? cs.overflow : ''
    };
    const cls = typeof el.className === 'string' ? el.className : '';
    if (cls) o.c = short(cls, 120);
    if (el.id) o.i = el.id;
    const txt = [].slice.call(el.childNodes).filter((x) => x.nodeType === 3).map((x) => x.textContent).join('');
    if (short(txt, 40)) o.x = short(txt, 40);
    return o;
  };
  function walk(el, depth, out) {
    if (n++ > MAXN) return;
    out.push({ d: depth, ...desc(el) });
    if (depth >= 5) return;
    for (const c of el.children) walk(c, depth + 1, out);
  }
  const root = document.querySelector('#root') || document.body;
  const tree = [];
  walk(root, 0, tree);

  const rootSel = ['header', 'nav', 'aside', 'footer', 'main'];
  const domNodes = [].slice.call(document.querySelectorAll('body *')).slice(0, 8000);

  const KEYWORDS = ['header', 'Header', 'nav', 'Nav', 'sidebar', 'Sidebar', 'side', 'download', 'Download',
    'openapp', 'openApp', 'OpenApp', 'app', 'login', 'Login', 'search', 'Search', 'tabbar', 'Tabbar', 'tab',
    'bottom', 'Bottom', 'comment', 'Comment', 'player', 'Player', 'mask', 'Mask', 'modal', 'Modal', 'dialog',
    'Dialog', 'guide', 'Guide', 'qrcode', 'Qrcode', 'swiper', 'feed', 'Feed', 'recommend', 'Recommend',
    'video', 'Video', 'control', 'Control', 'toolbar', 'Toolbar', 'footer', 'Footer', 'close', 'Close'];
  const kw = {};
  for (const k of KEYWORDS) kw[k] = { count: 0, classes: {}, text: {} };
  for (const el of domNodes) {
    if (typeof el.className !== 'string' || !el.className) continue;
    const txt = short(el.innerText, 30);
    for (const k of KEYWORDS) {
      if (el.className.indexOf(k) < 0) continue;
      const rec = kw[k];
      rec.count++;
      for (const cls of el.className.split(/\s+/)) {
        if (!cls || cls.indexOf(k) < 0) continue;
        rec.classes[cls] = (rec.classes[cls] || 0) + 1;
        if (txt && !rec.text[cls]) rec.text[cls] = txt;
      }
    }
  }
  for (const k of Object.keys(kw)) {
    const c = kw[k];
    const top = Object.entries(c.classes).sort((x, y) => y[1] - x[1]).slice(0, 8);
    c.top = top.map(([cls, cnt]) => ({ cls, cnt, text: c.text[cls] || '' }));
    delete c.classes; delete c.text;
  }

  const fixedish = domNodes.filter((el) => {
    const cs = getComputedStyle(el);
    if (cs.position !== 'fixed' && cs.position !== 'sticky') return false;
    const r = el.getBoundingClientRect();
    return r.width > 80 && r.height > 16;
  }).slice(0, 80).map((el) => {
    const d = desc(el);
    d.x = short(el.innerText, 60);
    d.aria = el.getAttribute('aria-label') || '';
    d.title = el.getAttribute('title') || '';
    return d;
  });

  const videos = [].slice.call(document.querySelectorAll('video')).map((v) => ({
    w: v.videoWidth, h: v.videoHeight, paused: v.paused, rs: v.readyState,
    cls: String(v.className || '').slice(0, 100),
    src: short(v.currentSrc || v.src, 120)
  }));

  return {
    url: location.href,
    title: document.title,
    viewport: [innerWidth, innerHeight],
    rootClass: root.className,
    tree,
    keywordMap: kw,
    fixedish,
    videos,
    semantic: rootSel.map((s) => ({ tag: s, n: document.querySelectorAll(s).length })),
    textSample: short(document.body.innerText, 600)
  };
});

const ts = new Date().toISOString().replace(/[:.]/g, '-');
fs.writeFileSync(path.join(OUT, `layout-${ts}.json`), JSON.stringify(layout, null, 2), 'utf8');
await page.screenshot({ path: path.join(OUT, `layout-${ts}.png`) });
log('saved', path.join(OUT, `layout-${ts}.json`));
log('videos', layout.videos.map((v) => `${v.w}x${v.h}${v.paused ? '(paused)' : '(playing)'}`).join(' , ') || 'none');
log('fixed layers:', layout.fixedish.length);
for (const f of layout.fixedish.slice(0, 15)) log('  fixed', JSON.stringify({ c: f.c, r: f.r, z: f.z, x: f.x }));
console.log(JSON.stringify({ ok: true, json: path.join(OUT, `layout-${ts}.json`) }));
await ctx.close();
