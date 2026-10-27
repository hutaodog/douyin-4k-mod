/**
 * 抖音网页版接口抓取器
 *
 * 做法：把手机上（已登录）的 cookie 导进 Playwright，用桌面版 UA 走一遍常用场景，
 * 把每个 XHR/fetch 的「方法 / 路径 / 查询参数 / 状态 / 响应结构」记录下来，按路径聚合。
 *
 * 用法：
 *   node mobile-app/tools/device.mjs cookies mobile-web/probe-output/cookies.json     # 先导出登录态
 *   node mobile-web/tools/capture-api.mjs                                            # 全场景抓
 *   node mobile-web/tools/capture-api.mjs --only feed,video                          # 只跑部分场景
 *   node mobile-web/tools/capture-api.mjs --cookies <file> --out <dir>
 *
 * 产物：
 *   <out>/api-catalog.json   机器可读：每个接口的方法/参数/状态/响应 schema
 *   <out>/api-catalog.md     人肉可读的表格
 *   <out>/raw-<scenario>.json 每个场景的原始记录（便于复查）
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { loadPW, UAS, parseArgs, stamp, baseLaunchOptions } from './lib/browser.mjs';

const a = parseArgs(process.argv.slice(2));
const OUT = path.resolve(String(a.out || 'mobile-web/probe-output/api'));
const COOKIES = a.cookies && a.cookies !== true
  ? path.resolve(String(a.cookies))
  : fs.existsSync('mobile-web/probe-output/cookies.json')
    ? path.resolve('mobile-web/probe-output/cookies.json')
    : null;
const WAIT = Number(a.wait || 9000);
const ONLY = a.only ? String(a.only).split(',') : null;
const KEEP_SAMPLES = a.samples !== 'false';

fs.mkdirSync(OUT, { recursive: true });
const log = (...m) => console.log(stamp(), ...m);

// ---------------- 场景 ----------------
const SCEN = [
  { name: 'feed', url: 'https://www.douyin.com/?recommend=1', wait: 12000 },
  { name: 'video', url: 'https://www.douyin.com/video/7686426147004976393', wait: 12000, scroll: 2 },
  { name: 'comments', url: 'https://www.douyin.com/video/7697934740980125171', wait: 10000, scroll: 4 },
  { name: 'profile', url: 'https://www.douyin.com/user/MS4wLjABAAAAAmSgIbQLcw0G88p5U2uAwOt-A9On9Bx2FKZJATLR5WM', wait: 11000, scroll: 2 },
  { name: 'search', url: 'https://www.douyin.com/search/%E7%8C%AB?type=general', wait: 11000, scroll: 2 },
  { name: 'search_video', url: 'https://www.douyin.com/search/%E7%8C%AB?type=video', wait: 10000 },
  { name: 'search_user', url: 'https://www.douyin.com/search/%E7%8C%AB?type=user', wait: 10000 },
  { name: 'hot', url: 'https://www.douyin.com/hot', wait: 10000 },
  { name: 'live', url: 'https://www.douyin.com/live', wait: 10000 },
  { name: 'jingxuan', url: 'https://www.douyin.com/jingxuan', wait: 10000 },
  { name: 'note', url: 'https://www.douyin.com/note/7698625748663597241', wait: 9000 },
  { name: 'music', url: 'https://www.douyin.com/music/7412345678901234567', wait: 8000 },
  { name: 'collection', url: 'https://www.douyin.com/collection/7372484719360453395', wait: 8000 },
  { name: 'self', url: 'https://www.douyin.com/user/self', wait: 9000 }
];

// ---------------- 工具 ----------------
const API_HOST = /(^|\.)(douyin|douyinvod|douyinpic|douyinstatic|bytedance|byteimg|pstatp|snssdk|amemv|ixigua)\.(com|net)/i;
const SKIP_PATH = /\/(webcast\/imp|report|log|monitor|slardar|\w*\/log\b|favicon)/i;

function normalizeUrl(u) {
  try {
    const url = new URL(u);
    return { host: url.host, path: url.pathname, url };
  } catch (e) {
    return null;
  }
}

/** 响应结构指纹：顶层类型 + 每个顶层 key 的类型；数组只取第一个元素的 key 列表 */
function fingerprint(v, depth = 0) {
  if (v === null) return 'null';
  if (Array.isArray(v)) {
    if (!v.length) return 'array<empty>';
    if (depth > 1) return 'array';
    return 'array<' + fingerprint(v[0], depth + 1) + '>';
  }
  const t = typeof v;
  if (t !== 'object') return t;
  if (depth > 1) return 'object';
  const out = {};
  const keys = Object.keys(v).slice(0, 24);
  for (const k of keys) out[k] = fingerprint(v[k], depth + 1);
  return out;
}

function sizeOf(x) {
  try { return Buffer.byteLength(JSON.stringify(x)); } catch (e) { return 0; }
}

// ---------------- 抓取 ----------------
const { chromium } = loadPW();

function cookiesFor(cookieList) {
  if (!cookieList) return [];
  return cookieList
    .filter((c) => c && c.name && c.name.trim().length > 0)
    .map((c) => ({
      name: c.name,
      value: c.value,
      domain: c.domain && c.domain.startsWith('.') ? c.domain : '.' + String(c.domain || 'douyin.com').replace(/^\./, ''),
      path: c.path || '/',
      secure: c.secure !== false,
      httpOnly: !!c.httpOnly,
      sameSite: c.sameSite === 'Lax' || c.sameSite === 'Strict' || c.sameSite === 'None' ? c.sameSite : 'Lax'
    }));
}

const catalog = new Map();   // key: host+path -> record
const perScenario = {};

function record(scenario, rec) {
  const { host, path: p, method, status, mime, len, queryKeys, querySample, fp, sample } = rec;
  const key = host + p;
  let e = catalog.get(key);
  if (!e) {
    e = {
      host, path: p, methods: new Set(), statuses: new Set(), mime: mime || '',
      queryKeys: new Set(), querySample: querySample || '', schema: fp || null,
      scenes: new Set(), count: 0, maxLen: 0, sampleFile: ''
    };
    catalog.set(key, e);
  }
  e.methods.add(method);
  e.statuses.add(status);
  if (!e.mime && mime) e.mime = mime;
  (queryKeys || []).forEach((k) => e.queryKeys.add(k));
  if (!e.schema && fp) e.schema = fp;
  e.scenes.add(scenario);
  e.count++;
  e.maxLen = Math.max(e.maxLen, len || 0);
  if (!e.querySample && querySample) e.querySample = querySample;

  if (KEEP_SAMPLES && sample && !e.sampleFile) {
    const f = path.join(OUT, 'samples', key.replace(/[^\w.-]+/g, '_').slice(0, 90) + '.json');
    fs.mkdirSync(path.dirname(f), { recursive: true });
    try { fs.writeFileSync(f, sample, 'utf8'); e.sampleFile = path.basename(f); } catch (err) {}
  }
  if (!perScenario[scenario]) perScenario[scenario] = [];
  perScenario[scenario].push(rec);
}

async function runScenario(ctx, scen) {
  const page = await ctx.newPage();
  const recs = [];
  page.on('response', async (res) => {
    try {
      const req = res.request();
      const type = req.resourceType();
      if (type !== 'xhr' && type !== 'fetch') return;
      const nu = normalizeUrl(res.url());
      if (!nu) return;
      if (!API_HOST.test(nu.host)) return;
      if (SKIP_PATH.test(nu.path)) return;
      const qKeys = [...nu.url.searchParams.keys()];
      const clone = new URL(nu.url.toString());
      const querySample = [...clone.searchParams.entries()]
        .map(([k, v]) => k + '=' + (v.length > 18 ? v.slice(0, 18) + '…' : v))
        .join('&').slice(0, 400);
      clone.search = '';
      let mime = '', len = 0, fp = null, sample = '';
      try {
        mime = res.headers()['content-type'] || '';
        const body = await res.text();
        len = body.length;
        if (/json/i.test(mime) || /^[\[{]/.test(body.trim().slice(0, 1))) {
          const j = JSON.parse(body);
          fp = fingerprint(j);
          if (KEEP_SAMPLES) {
            const trimmed = JSON.stringify(j);
            sample = trimmed.length > 60000 ? trimmed.slice(0, 60000) + '…(truncated)' : trimmed;
          }
        }
      } catch (e) {}
      const r = {
        scene: scen.name, host: nu.host, path: nu.path, method: req.method(), status: res.status(),
        mime: (mime || '').split(';')[0], len, queryKeys: qKeys, querySample, fp, sample,
        fullUrl: clone.toString()
      };
      recs.push(r);
      record(scen.name, r);
    } catch (e) {}
  });

  try {
    await page.goto(scen.url, { waitUntil: 'domcontentloaded', timeout: 45000 });
  } catch (e) { log('  goto err', String(e).slice(0, 90)); }
  await page.waitForTimeout(scen.wait || WAIT);

  // 滚动触发分页/懒加载
  if (scen.scroll) {
    for (let i = 0; i < scen.scroll; i++) {
      await page.mouse.wheel(0, 1600);
      await page.waitForTimeout(1600);
    }
  }
  await page.waitForTimeout(1200);
  log('  ' + scen.name.padEnd(14) + ' requests=' + String(recs.length).padStart(3) +
      '  urls=' + new Set(recs.map((r) => r.host + r.path)).size);
  try { await page.close(); } catch (e) {}
}

// ---------------- 主流程 ----------------
const pw = loadPW();
const ctx = await pw.chromium.launchPersistentContext(
  fs.mkdtempSync(path.join(OUT, '_profile-')),
  baseLaunchOptions({ ua: UAS.desktop })
);

let cookieCount = 0;
if (COOKIES && fs.existsSync(COOKIES)) {
  const list = JSON.parse(fs.readFileSync(COOKIES, 'utf8'));
  const ck = cookiesFor(list);
  try {
    await ctx.addCookies(ck);
    cookieCount = ck.length;
  } catch (e) { log('  cookie inject failed:', String(e).slice(0, 120)); }
}
log('cookies      :', cookieCount, COOKIES ? path.basename(COOKIES) : '(none)');
log('scenarios    :', (ONLY ? SCEN.filter((s) => ONLY.includes(s.name)) : SCEN).length);

for (const scen of SCEN) {
  if (ONLY && !ONLY.includes(scen.name)) continue;
  log('--- ' + scen.name + ' : ' + scen.url);
  await runScenario(ctx, scen);
}

try { await ctx.close(); } catch (e) {}

// ---------------- 输出 ----------------
const rows = [...catalog.values()].map((e) => ({
  host: e.host,
  path: e.path,
  methods: [...e.methods],
  statuses: [...e.statuses],
  mime: e.mime,
  queryKeys: [...e.queryKeys],
  querySample: e.querySample,
  schema: e.schema,
  scenes: [...e.scenes],
  count: e.count,
  maxLen: e.maxLen,
  sampleFile: e.sampleFile
})).sort((x, y) => x.path.localeCompare(y.path));

fs.writeFileSync(path.join(OUT, 'api-catalog.json'), JSON.stringify({
  capturedAt: new Date().toISOString(),
  cookies: cookieCount,
  ua: UAS.desktop,
  total: rows.length,
  endpoints: rows
}, null, 2), 'utf8');

for (const [name, list] of Object.entries(perScenario)) {
  fs.writeFileSync(path.join(OUT, `raw-${name}.json`), JSON.stringify(list.map((r) => ({
    method: r.method, host: r.host, path: r.path, status: r.status, mime: r.mime, len: r.len,
    queryKeys: r.queryKeys, querySample: r.querySample, fp: r.fp
  })), null, 1), 'utf8');
}

// markdown 表格
const md = [];
md.push('# 抖音网页版接口抓取结果（自动生成）\n');
md.push(`- 抓取时间：${new Date().toISOString()}`);
md.push(`- 登录态 cookie：${cookieCount} 条`);
md.push(`- 接口数：${rows.length}\n`);
md.push('| 方法 | 路径 | 场景 | 状态 | 大小 | 主要参数 |');
md.push('|---|---|---|---|---|---|');
for (const r of rows) {
  md.push(`| ${r.methods.join(',')} | \`${r.path}\` | ${r.scenes.join(',')} | ${r.statuses.join(',')} | ${r.maxLen} | ${r.queryKeys.slice(0, 8).join(', ')} |`);
}
fs.writeFileSync(path.join(OUT, 'api-catalog.md'), md.join('\n'), 'utf8');

log('');
log('==== 抓到接口 ' + rows.length + ' 个 ====');
for (const r of rows) log('  ' + r.methods.join(',') + ' ' + r.path + '  [' + r.mime + ' ' + r.maxLen + 'B]');
log('saved:', path.join(OUT, 'api-catalog.json'), '/ api-catalog.md');
