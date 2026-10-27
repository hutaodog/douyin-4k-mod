/**
 * 接口鉴权体检：把每个接口用「最小参数」在页面上下文里重放一遍，判断它属于哪一类：
 *   A 免签：只要 cookie（登录态）+ 基本参数就能拿数据
 *   B 需签名：缺 a_bogus / msToken / X-Bogus 会被拒（返回空数据或 4xx）
 *   C 需登录：未登录直接空
 *
 * 用法：
 *   node mobile-app/tools/device.mjs cookies mobile-web/probe-output/cookies.json
 *   node mobile-web/tools/check-auth.mjs                       # 用内置接口清单
 *   node mobile-web/tools/check-auth.mjs --cookies <file> --out <dir>
 *
 * 产物：<out>/auth-check.json + 控制台表格
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { loadPW, UAS, parseArgs, stamp, baseLaunchOptions } from './lib/browser.mjs';

const a = parseArgs(process.argv.slice(2));
const OUT = path.resolve(String(a.out || 'mobile-web/probe-output/api'));
const COOKIES = a.cookies && a.cookies !== true ? path.resolve(String(a.cookies))
  : path.resolve('mobile-web/probe-output/cookies.json');

fs.mkdirSync(OUT, { recursive: true });
const log = (...m) => console.log(stamp(), ...m);

// 账号/样本 ID（换成你自己的也能跑）
const AWEME = '7686426147004976393';
const SEC = 'MS4wLjABAAAAAmSgIbQLcw0G88p5U2uAwOt-A9On9Bx2FKZJATLR5WM';
const BASE = 'device_platform=webapp&aid=6383&channel=channel_pc_web';

/** 最小参数集（故意不带 a_bogus/msToken/X-Bogus） */
const SPECS = [
  { path: '/aweme/v1/web/aweme/detail/', q: `aweme_id=${AWEME}` },
  { path: '/aweme/v1/web/comment/list/', q: `aweme_id=${AWEME}&cursor=0&count=20` },
  { path: '/aweme/v1/web/comment/list/reply/', q: `item_id=${AWEME}&comment_id=0&cursor=0&count=10` },
  { path: '/aweme/v1/web/aweme/related/', q: `aweme_id=${AWEME}&count=20&filterGids=0` },
  { path: '/aweme/v1/web/aweme/post/', q: `sec_user_id=${SEC}&max_cursor=0&count=20` },
  { path: '/aweme/v1/web/aweme/favorite/', q: `sec_user_id=${SEC}&max_cursor=0&count=20` },
  { path: '/aweme/v1/web/user/profile/self/', q: '' },
  { path: '/aweme/v1/web/user/profile/other/', q: `sec_user_id=${SEC}` },
  { path: '/aweme/v1/web/hot/search/list/', q: 'detail_list=1' },
  { path: '/aweme/v1/web/general/search/single/', q: `keyword=${encodeURIComponent('猫')}&offset=0&count=10&search_channel=aweme_general` },
  { path: '/aweme/v1/web/search/item/', q: `keyword=${encodeURIComponent('猫')}&offset=0&count=10` },
  { path: '/aweme/v1/web/danmaku/get_v2/', q: `group_id=${AWEME}&format=json` },
  { path: '/aweme/v1/web/music/aweme/', q: `music_id=7412345678901234567&cursor=0&count=10` },
  { path: '/aweme/v1/web/mix/aweme/', q: `mix_id=7372484719360453395&cursor=0&count=10` },
  { path: '/aweme/v1/web/im/user/info/', q: 'sec_user_ids=%5B%22' + encodeURIComponent(SEC) + '%22%5D' },
  { path: '/aweme/v1/web/notice/count/', q: 'is_new_notice=1&need_social_count=1' },
  { path: '/aweme/v1/web/im/spotlight/relation/', q: 'count=10&source=1' },
  { path: '/aweme/v1/web/mix/listcollection/', q: 'cursor=0&count=10' },
  { path: '/service/2/abtest_config/', q: '' },
  { path: '/aweme/v1/web/user/settings/', q: '' }
];

const { chromium } = loadPW();
const ctx = await chromium.launchPersistentContext(
  fs.mkdtempSync(path.join(OUT, '_auth-')),
  baseLaunchOptions({ ua: UAS.desktop })
);

let cookieCount = 0;
try {
  const list = JSON.parse(fs.readFileSync(COOKIES, 'utf8'));
  const ck = list.filter((c) => c && c.name && c.name.trim())
    .map((c) => ({
      name: c.name, value: c.value,
      domain: c.domain && c.domain.startsWith('.') ? c.domain : '.' + String(c.domain || 'douyin.com').replace(/^\./, ''),
      path: c.path || '/', secure: c.secure !== false, httpOnly: !!c.httpOnly,
      sameSite: ['Lax', 'Strict', 'None'].includes(c.sameSite) ? c.sameSite : 'Lax'
    }));
  await ctx.addCookies(ck);
  cookieCount = ck.length;
} catch (e) { log('cookie load failed', String(e).slice(0, 120)); }
log('cookies:', cookieCount);

const page = await ctx.newPage();
try {
  await page.goto('https://www.douyin.com/?recommend=1', { waitUntil: 'domcontentloaded', timeout: 45000 });
} catch (e) { log('goto:', String(e).slice(0, 100)); }
await page.waitForTimeout(5000);

// 用 context 自带的 HTTP 客户端发请求：共享同一份 cookie，且有硬超时，不会被页面卡死
const api = ctx.request;

async function probe(spec) {
  const url = 'https://www.douyin.com' + spec.path + '?' + (spec.q ? spec.q + '&' : '') + BASE;
  try {
    const r = await api.get(url, {
      timeout: 12000,
      headers: {
        accept: 'application/json, text/plain, */*',
        referer: 'https://www.douyin.com/',
        'user-agent': UAS.desktop
      }
    });
    const text = await r.text();
    let j = null;
    try { j = JSON.parse(text); } catch (e) {}
    const out = { status: r.status(), len: text.length, ok: false, code: null, keys: [], arrays: [], hint: '' };
    if (!j) { out.hint = text.slice(0, 60); return out; }
    out.code = j.status_code !== undefined ? j.status_code : null;
    out.keys = Object.keys(j).slice(0, 10);
    for (const k of Object.keys(j)) {
      const v = j[k];
      if (Array.isArray(v)) { out.arrays.push(k + ':' + v.length); if (v.length) out.ok = true; }
      else if (v && typeof v === 'object' && Object.keys(v).length) out.ok = true;
      else if (typeof v === 'string' && v.length) out.ok = true;
    }
    if (out.code !== null && out.code !== 0) out.ok = false;
    out.hint = text.slice(0, 80);
    return out;
  } catch (e) {
    return { status: -1, err: String(e).slice(0, 90) };
  }
}

const results = [];
for (const spec of SPECS) {
  const r = await probe(spec);
  const verdict = r.status === 200 && r.ok ? 'A 免签可用'
    : r.status === 200 && !r.ok ? 'B 返回空(需签名/需权限)'
      : 'C 被拒 HTTP ' + (r.status || '?');
  const row = { ...spec, ...r, verdict };
  results.push(row);
  log(String(r.status).padStart(4) + '  ' + verdict.padEnd(24) + spec.path +
      '  len=' + (r.len || 0) + '  ' + (r.arrays || []).join(' ') + ' ' + (r.err || ''));
}

fs.writeFileSync(path.join(OUT, 'auth-check.json'), JSON.stringify({
  checkedAt: new Date().toISOString(), cookies: cookieCount, results
}, null, 2), 'utf8');
log('saved:', path.join(OUT, 'auth-check.json'));
log('');
log('==== 汇总 ====');
for (const r of results) log((r.verdict || '').padEnd(26) + r.path);
try { await ctx.close(); } catch (e) {}
