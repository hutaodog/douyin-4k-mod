/**
 * 验证「签名是哪来的」：
 *   同样的 URL，一个用 Node 侧 HTTP 客户端发（只带 cookie），一个在页面里 fetch 发。
 *   如果页面里 200、外面 403 → 说明签名是页面 JS 在请求前自动追加的（a_bogus / msToken）。
 *
 * 用法：node mobile-web/tools/verify-signature.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { loadPW, UAS, stamp, baseLaunchOptions } from './lib/browser.mjs';

const OUT = path.resolve('mobile-web/probe-output/api');
const COOKIES = path.resolve('mobile-web/probe-output/cookies.json');
const log = (...m) => console.log(stamp(), ...m);

const AWEME = '7686426147004976393';
const SEC = 'MS4wLjABAAAAAmSgIbQLcw0G88p5U2uAwOt-A9On9Bx2FKZJATLR5WM';
const BASE = 'device_platform=webapp&aid=6383&channel=channel_pc_web';

const SPECS = [
  ['aweme/detail', `/aweme/v1/web/aweme/detail/?aweme_id=${AWEME}&${BASE}`],
  ['aweme/post', `/aweme/v1/web/aweme/post/?sec_user_id=${SEC}&max_cursor=0&count=20&${BASE}`],
  ['aweme/favorite', `/aweme/v1/web/aweme/favorite/?sec_user_id=${SEC}&max_cursor=0&count=20&${BASE}`],
  ['comment/list', `/aweme/v1/web/comment/list/?aweme_id=${AWEME}&cursor=0&count=20&${BASE}`],
  ['music/aweme', `/aweme/v1/web/music/aweme/?music_id=7412345678901234567&cursor=0&count=10&${BASE}`],
  ['mix/aweme', `/aweme/v1/web/mix/aweme/?mix_id=7372484719360453395&cursor=0&count=10&${BASE}`],
  ['aweme/related', `/aweme/v1/web/aweme/related/?aweme_id=${AWEME}&count=20&filterGids=0&${BASE}`],
  ['user/profile/other', `/aweme/v1/web/user/profile/other/?sec_user_id=${SEC}&${BASE}`]
];

const { chromium } = loadPW();
const ctx = await chromium.launchPersistentContext(
  fs.mkdtempSync(path.join(OUT, '_sig-')),
  baseLaunchOptions({ ua: UAS.desktop })
);
try {
  const list = JSON.parse(fs.readFileSync(COOKIES, 'utf8'));
  await ctx.addCookies(list.filter((c) => c.name && c.name.trim()).map((c) => ({
    name: c.name, value: c.value,
    domain: c.domain && c.domain.startsWith('.') ? c.domain : '.' + String(c.domain || 'douyin.com').replace(/^\./, ''),
    path: c.path || '/', secure: c.secure !== false, httpOnly: !!c.httpOnly,
    sameSite: ['Lax', 'Strict', 'None'].includes(c.sameSite) ? c.sameSite : 'Lax'
  })));
} catch (e) { log('cookie:', String(e).slice(0, 100)); }

const page = await ctx.newPage();
// 拦截一次页面自己的请求，看看它加了什么参数（这是"签名"的直接证据）
const seen = [];
page.on('request', (req) => {
  const u = req.url();
  if (!/aweme\/v1\/web\/(aweme|comment|music|mix)\//.test(u)) return;
  try {
    const sp = new URL(u).searchParams;
    seen.push({
      path: new URL(u).pathname,
      a_bogus: (sp.get('a_bogus') || '').slice(0, 24),
      msToken: (sp.get('msToken') || '').slice(0, 16),
      X_Bogus: (sp.get('X-Bogus') || '').slice(0, 16),
      verifyFp: (sp.get('verifyFp') || '').slice(0, 20),
      keys: [...sp.keys()].length
    });
  } catch (e) {}
});

try {
  await page.goto(`https://www.douyin.com/video/${AWEME}`, { waitUntil: 'domcontentloaded', timeout: 45000 });
} catch (e) {}
await page.waitForTimeout(9000);

// 1) Node 侧（只有 cookie）
const outer = [];
for (const [name, u] of SPECS) {
  let st = -1, len = 0, err = '';
  try {
    const r = await ctx.request.get('https://www.douyin.com' + u, {
      timeout: 12000,
      headers: { accept: 'application/json, text/plain, */*', referer: 'https://www.douyin.com/', 'user-agent': UAS.desktop }
    });
    st = r.status();
    len = (await r.text()).length;
  } catch (e) { err = String(e).slice(0, 60); }
  outer.push({ name, status: st, len, err });
}

// 2) 页面里（网站自己的 fetch 包装器会签名）
const inner = [];
for (const [name, u] of SPECS) {
  let r = null;
  try {
    r = await page.evaluate(async (u) => {
      const ctl = new AbortController();
      const t = setTimeout(() => { try { ctl.abort(); } catch (e) {} }, 9000);
      try {
        const res = await fetch(u, { credentials: 'include', signal: ctl.signal });
        const txt = await res.text();
        clearTimeout(t);
        return { status: res.status, len: txt.length, head: txt.slice(0, 90) };
      } catch (e) {
        clearTimeout(t);
        return { status: -1, err: String(e).slice(0, 70) };
      }
    }, u);
  } catch (e) { r = { status: -2, err: String(e).slice(0, 70) }; }
  inner.push({ name, ...r });
}

log('');
log('=== 页面自己发出的请求，参数里带了什么 ===');
const uniq = new Map();
for (const s of seen) if (!uniq.has(s.path)) uniq.set(s.path, s);
for (const [p, s] of uniq) {
  log('  ' + p.padEnd(34) + ' keys=' + String(s.keys).padEnd(3) +
      ' a_bogus=' + (s.a_bogus || '-') + ' msToken=' + (s.msToken || '-') + ' verifyFp=' + (s.verifyFp || '-'));
}

log('');
log('=== 对照表 ===');
log('  接口'.padEnd(22) + 'Node(仅cookie)'.padEnd(20) + '页面内 fetch');
for (let i = 0; i < SPECS.length; i++) {
  const o = outer[i], n = inner[i];
  log('  ' + o.name.padEnd(20) + (String(o.status) + ' / ' + o.len + 'B').padEnd(20) + String(n.status) + ' / ' + (n.len || 0) + 'B');
}

fs.writeFileSync(path.join(OUT, 'signature-check.json'), JSON.stringify({
  at: new Date().toISOString(), pageRequests: [...uniq.values()], outer, inner
}, null, 2), 'utf8');
log('saved:', path.join(OUT, 'signature-check.json'));
try { await ctx.close(); } catch (e) {}
