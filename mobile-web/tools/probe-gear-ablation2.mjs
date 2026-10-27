/**
 * 第二轮对照：模拟客户端 detail 请求里的特殊参数，看档位表是否被裁剪。
 * 用法：node probe-gear-ablation2.mjs <aweme_id>
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { loadPW, UAS, stamp, baseLaunchOptions } from './lib/browser.mjs';

const ID = process.argv[2] || '7701294669032614565';
const OUT = path.resolve('mobile-web/probe-output');

const { chromium } = loadPW();
const ctx = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(OUT, '_abl2-')),
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
  const BASE = 'device_platform=webapp&aid=6383&channel=channel_pc_web&pc_client_type=2&pc_libra_divert=Windows&support_h265=1';
  const cases = [
    ['基准（网页等价）', `${BASE}`],
    ['+origin_type=quick_player', `${BASE}&request_source=600&origin_type=quick_player`],
    ['+origin_type 单独', `${BASE}&origin_type=quick_player`],
    ['+request_source=600 单独', `${BASE}&request_source=600`],
    ['+support_dash=1', `${BASE}&support_dash=1`],
    ['+webcast 那串', `${BASE}&support_dash=1&webcast_sdk_version=170400&webcast_version_code=`],
    ['客户端完整式', `${BASE}&request_source=600&origin_type=quick_player&support_dash=1&webcast_sdk_version=170400`]
  ];
  const out = [];
  for (const [name, q] of cases) {
    try {
      const r = await fetch(`/aweme/v1/web/aweme/detail/?aweme_id=${id}&` + q, { credentials: 'include' });
      const txt = await r.text();
      let j = null; try { j = JSON.parse(txt); } catch (e) {}
      const aw = j && j.aweme_detail;
      if (!aw || !aw.video) { out.push({ name, status: r.status, n: -1, max: -1 }); continue; }
      const gears = (aw.video.bit_rate || []).map((b) => ({
        h: b.play_addr && b.play_addr.height, g: b.gear_name,
        c: (b.is_h265 || b.is_bytevc1) ? 'h265' : 'h264'
      }));
      out.push({ name, status: r.status, n: gears.length, max: gears.reduce((m, x) => Math.max(m, x.h || 0), 0) });
    } catch (e) { out.push({ name, status: -1, n: -1, max: -1, err: String(e).slice(0, 40) }); }
  }
  return out;
}, ID);

console.log(stamp(), '视频', ID, '—— 客户端参数模拟');
console.log('  ' + '情形'.padEnd(28) + 'status   档位数   最高档');
for (const r of res) {
  console.log('  ' + r.name.padEnd(28) + String(r.status).padStart(4) + '   ' + String(r.n).padStart(5) + '   ' + String(r.max).padStart(6) + (r.err ? '  err=' + r.err : ''));
}
try { await ctx.close(); } catch (e) {}
