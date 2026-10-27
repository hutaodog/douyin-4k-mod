/**
 * 网页包源码检索：把线上页面加载的 JS chunk 拉下来，按关键字定位实现。
 *
 * 为什么需要它：抖音网页的关键判断（比如"这台设备能不能上 2K/4K"的 isHas2K()）
 * 都在 CDN 的 chunk 里，只看 DOM 是猜不出来的。这个工具把 bundle 落到本地缓存再 grep。
 *
 * 用法：
 *   node mobile-web/tools/find-code.mjs --url https://www.douyin.com/ --grep isHas2K
 *   node mobile-web/tools/find-code.mjs --url <视频页> --grep "auto_clarity_reselect|MANUAL_SWITCH"
 *   node mobile-web/tools/find-code.mjs --url <视频页> --grep isHas2K --download 4      # 只下载命中的 chunk 前 4 个
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { loadPW, UAS, parseArgs, stamp, baseLaunchOptions } from './lib/browser.mjs';

const a = parseArgs(process.argv.slice(2));
const URL_ARG = String(a.url || 'https://www.douyin.com/');
const GREP = new RegExp(String(a.grep || 'isHas2K'), 'g');
const OUT = path.resolve(String(a.out || 'mobile-web/probe-output/code'));
const UA = a['ua-android'] ? UAS.android : (a.ua && a.ua !== true ? String(a.ua) : UAS.desktop);
const MAX_DL = Number(a.download || 0);
const CTX = Number(a.ctx || 220);
const log = (...m) => console.log(stamp(), ...m);

fs.mkdirSync(OUT, { recursive: true });
const cacheDir = path.join(OUT, '_chunks');
fs.mkdirSync(cacheDir, { recursive: true });

const { chromium } = loadPW();
const ctx = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(OUT, '_profile-')),
  baseLaunchOptions({ headed: !!a.headed, ua: UA }));
const page = ctx.pages()[0];
try { await page.goto(URL_ARG, { waitUntil: 'domcontentloaded', timeout: 45000 }); } catch (e) { log('goto', String(e).slice(0, 120)); }
await page.waitForTimeout(Number(a.wait || 12000));

// 页面加载过的全部脚本
const scripts = await page.evaluate(() => {
  const set = new Set();
  performance.getEntriesByType('resource').forEach((e) => {
    if (e.initiatorType === 'script' || /\.js(\?|$)/.test(e.name)) set.add(e.name);
  });
  document.querySelectorAll('script[src]').forEach((s) => set.add(s.src));
  return [...set];
});
log('scripts on page:', scripts.length);

// 全部是公开 CDN，直接 node 侧拉取（带 referer 更稳）
const results = [];
let dl = 0;
for (const url of scripts) {
  let txt = null;
  const cacheName = path.join(cacheDir, url.split('/').pop().split('?')[0].replace(/[^\w.-]/g, '_'));
  try {
    if (fs.existsSync(cacheName)) txt = fs.readFileSync(cacheName, 'utf8');
  } catch (e) {}
  if (!txt) {
    try {
      const res = await fetch(url, { headers: { referer: 'https://www.douyin.com/', 'user-agent': UA } });
      if (!res.ok) { log('  skip', res.status, url.slice(-60)); continue; }
      txt = await res.text();
      try { fs.writeFileSync(cacheName, txt, 'utf8'); } catch (e) {}
    } catch (e) { log('  fail', String(e).slice(0, 80), url.slice(-60)); continue; }
  }
  GREP.lastIndex = 0;
  const hits = [];
  let m;
  while ((m = GREP.exec(txt)) && hits.length < 12) {
    hits.push({ at: m.index, ctx: txt.slice(Math.max(0, m.index - CTX), m.index + CTX).replace(/\s+/g, ' ') });
  }
  if (hits.length) {
    results.push({ url: url.slice(0, 200), file: cacheName, size: txt.length, hits });
    if (MAX_DL && dl < MAX_DL) { dl++; fs.writeFileSync(path.join(OUT, 'match-' + dl + '-' + path.basename(cacheName)), txt, 'utf8'); }
  }
}

log('==== 命中 ' + results.length + ' 个 chunk ====');
for (const r of results) {
  log('■', r.url);
  for (const h of r.hits) log('   @' + h.at + ' …', h.ctx);
}
fs.writeFileSync(path.join(OUT, 'grep-' + String(a.grep || 'x').replace(/[^\w.-]/g, '_') + '.json'),
  JSON.stringify({ url: URL_ARG, grep: String(a.grep), scripts: scripts.length, results }, null, 2), 'utf8');
log('saved:', path.join(OUT, 'grep-*.json'), '| chunks cached in', cacheDir);
await ctx.close();
