/**
 * 主机制对照：同一个 detail 接口，www.douyin.com vs www-hj.douyin.com
 * 用法：node probe-host-ablation.mjs <aweme_id>
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { loadPW, UAS, stamp, baseLaunchOptions } from './lib/browser.mjs';

const ID = process.argv[2] || '7701294669032614565';
const OUT = path.resolve('mobile-web/probe-output');
const Q = 'device_platform=webapp&aid=6383&channel=channel_pc_web&pc_client_type=2&pc_libra_divert=Windows&support_h265=1&request_source=600&origin_type=quick_player';

const { chromium } = loadPW();
const ctx = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(OUT, '_host-')),
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
await page.goto('https://www.douyin.com/', { waitUntil: 'domcontentloaded', timeout: 45000 });
await page.waitForTimeout(4000);

const hosts = ['www.douyin.com', 'www-hj.douyin.com'];
console.log(stamp(), '视频', ID);
for (const host of hosts) {
  const url = `https://${host}/aweme/v1/web/aweme/detail/?aweme_id=${ID}&${Q}`;
  let line = `  ${host.padEnd(22)}`;
  try {
    const r = await ctx.request.get(url, {
      timeout: 15000,
      headers: { accept: 'application/json', referer: 'https://www.douyin.com/', 'user-agent': UAS.desktop }
    });
    const txt = await r.text();
    let j = null; try { j = JSON.parse(txt); } catch (e) {}
    const aw = j && j.aweme_detail;
    if (!aw || !aw.video) { console.log(line + `status=${r.status()} 无 aweme_detail（len=${txt.length}）`); continue; }
    const gears = (aw.video.bit_rate || []).map((b) => ({
      h: b.play_addr && b.play_addr.height, g: b.gear_name
    }));
    const maxH = gears.reduce((m, x) => Math.max(m, x.h || 0), 0);
    const names = gears.map((x) => x.g).filter(Boolean).slice(0, 6);
    console.log(line + `status=${r.status()}  档位=${gears.length}  最高=${maxH}p  ${names.join(',')}`);
  } catch (e) {
    console.log(line + 'ERR ' + String(e).slice(0, 60));
  }
}
try { await ctx.close(); } catch (e) {}
