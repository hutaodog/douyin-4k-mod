/**
 * 二分找出"哪段 CSS 让视频页播放器不初始化"。
 * 用法：node mobile-web/tools/bisect-css.mjs [start] [end]
 *   不给参数 = 测全部；给区间 = 测该区间（按字符下标）。
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { loadPW, UAS, stamp, baseLaunchOptions } from './lib/browser.mjs';

const VIDEO = 'https://www.douyin.com/video/7674450603690852559';
const raw = fs.readFileSync('mobile-web/probe-output/dy4k.css', 'utf8').trim();
const CSS = raw.replace(/^"|"$/g, '').replace(/\\n/g, '\n').replace(/\\"/g, '"');

function splitRules(css) {
  // 按 "}" 切成规则块，保留选择器
  const out = [];
  let depth = 0, start = 0;
  for (let i = 0; i < css.length; i++) {
    const c = css[i];
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) { out.push(css.slice(start, i + 1)); start = i + 1; }
    }
  }
  if (start < css.length) out.push(css.slice(start));
  return out.map((s) => s.trim()).filter(Boolean);
}

const rules = splitRules(CSS);
const from = Number(process.argv[2] || 0);
const to = Number(process.argv[3] || rules.length);
const subset = rules.slice(from, to);
const css = subset.join('\n');

console.log(stamp(), `testing rules [${from},${to}) = ${subset.length} 条 / ${css.length} 字符`);
if (subset.length <= 3) subset.forEach((r) => console.log('   ·', r.slice(0, 120).replace(/\n/g, ' ')));

const { chromium } = loadPW();
const ctx = await chromium.launchPersistentContext(fs.mkdtempSync(path.join('mobile-web/probe-output', '_bis-')),
  { ...baseLaunchOptions({ ua: UAS.desktop }), viewport: { width: 393, height: 844 }, deviceScaleFactor: 2 });

const ck = path.resolve('mobile-web/probe-output/cookies.json');
if (fs.existsSync(ck)) {
  try {
    const list = JSON.parse(fs.readFileSync(ck, 'utf8'));
    await ctx.addCookies(list.filter((c) => c.name && c.name.trim()).map((c) => ({
      name: c.name, value: c.value,
      domain: c.domain && c.domain.startsWith('.') ? c.domain : '.' + String(c.domain || 'douyin.com').replace(/^\./, ''),
      path: c.path || '/', secure: c.secure !== false, httpOnly: !!c.httpOnly,
      sameSite: ['Lax', 'Strict', 'None'].includes(c.sameSite) ? c.sameSite : 'Lax'
    })));
  } catch (e) {}
}

const page = await ctx.newPage();
await page.addInitScript(`(() => {
  const add = () => {
    if (!document.head) return setTimeout(add, 5);
    const s = document.createElement('style');
    s.id = 'bisect'; s.textContent = ${JSON.stringify(css)};
    document.head.appendChild(s);
  };
  add();
})();`);

await page.goto(VIDEO, { waitUntil: 'domcontentloaded', timeout: 45000 });
await page.waitForTimeout(9000);

const res = await page.evaluate(() => {
  const vs = [...document.querySelectorAll('video')];
  return {
    n: vs.length,
    playing: vs.some((v) => v.videoWidth > 0),
    sizes: vs.map((v) => v.videoWidth + 'x' + v.videoHeight)
  };
});
console.log(stamp(), 'video 元素', res.n, '| 有画面:', res.playing, '|', res.sizes.join(' '));
console.log(res.playing ? '=> 这段 CSS 没问题' : '=> 这段 CSS 里有东西阻止播放器初始化');
await ctx.close();
