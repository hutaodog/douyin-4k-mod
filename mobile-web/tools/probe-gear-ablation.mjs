/**
 * 逐参数对照：每次只去掉/添加一个查询参数，看档位表怎么变。
 * 用法：node probe-gear-ablation.mjs <aweme_id>
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { loadPW, UAS, stamp, baseLaunchOptions } from './lib/browser.mjs';

const ID = process.argv[2] || '7701294669032614565';
const OUT = path.resolve('mobile-web/probe-output');

const { chromium } = loadPW();
const ctx = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(OUT, '_abl-')),
  { ...baseLaunchOptions({ ua: UAS.desktop }), viewport: { width: 1280, height: 900 } });

const ck = path.join(OUT, 'cookies.json');
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
await page.goto(`https://www.douyin.com/video/${ID}`, { waitUntil: 'domcontentloaded', timeout: 45000 });
await page.waitForTimeout(5000);

const res = await page.evaluate(async (id) => {
  const FULL = {
    device_platform: 'webapp',
    aid: '6383',
    channel: 'channel_pc_web',
    pc_client_type: '2',
    version_code: '807000',
    pc_libra_divert: 'Windows',
    support_h265: '1'
  };
  function build(drop) {
    const q = Object.entries(FULL).filter(([k]) => !drop.includes(k)).map(([k, v]) => k + '=' + v).join('&');
    return `/aweme/v1/web/aweme/detail/?aweme_id=${id}&` + q;
  }
  const cases = [
    ['全部参数（基准）', []],
    ['去掉 channel', ['channel']],
    ['去掉 device_platform', ['device_platform']],
    ['去掉 aid', ['aid']],
    ['去掉 pc_client_type', ['pc_client_type']],
    ['去掉 version_code', ['version_code']],
    ['去掉 support_h265', ['support_h265']],
    ['只留 aweme_id', Object.keys(FULL)]
  ];
  const out = [];
  for (const [name, drop] of cases) {
    const url = drop.length === Object.keys(FULL).length ? `/aweme/v1/web/aweme/detail/?aweme_id=${id}` : build(drop);
    try {
      const r = await fetch(url, { credentials: 'include' });
      const txt = await r.text();
      let j = null; try { j = JSON.parse(txt); } catch (e) {}
      const aw = j && j.aweme_detail;
      if (!aw || !aw.video) { out.push({ name, status: r.status, n: -1, max: -1 }); continue; }
      const gears = (aw.video.bit_rate || []).map((b) => ({
        h: b.play_addr && b.play_addr.height,
        g: b.gear_name,
        c: (b.is_h265 || b.is_bytevc1) ? 'h265' : 'h264'
      }));
      const uniq = [...new Map(gears.map((x) => [x.h + x.c + x.g, x])).values()];
      const maxH = gears.reduce((m, x) => Math.max(m, x.h || 0), 0);
      out.push({ name, status: r.status, n: gears.length, max: maxH });
    } catch (e) {
      out.push({ name, status: -1, n: -1, max: -1, err: String(e).slice(0, 50) });
    }
  }
  return out;
}, ID);

console.log(stamp(), '视频', ID, '—— 逐参数对照');
console.log('  ' + '情形'.padEnd(22) + 'status   档位数   最高档');
for (const r of res) {
  console.log('  ' + r.name.padEnd(22) + String(r.status).padStart(4) + '   ' + String(r.n).padStart(5) + '   ' + String(r.max).padStart(6) + (r.err ? '   err=' + r.err : ''));
}
try { await ctx.close(); } catch (e) {}
