/**
 * 只读诊断：同一视频，不同接口上下文返回的码流档位对比。
 * 用法：node mobile-web/tools/probe-gears.mjs <aweme_id>
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { loadPW, UAS, stamp, baseLaunchOptions } from './lib/browser.mjs';

const ID = process.argv[2] || '7697138912099061055';
const OUT = path.resolve('mobile-web/probe-output');
fs.mkdirSync(OUT, { recursive: true });
const log = (...m) => console.log(stamp(), ...m);

const { chromium } = loadPW();
const ctx = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(OUT, '_gears-')),
  { ...baseLaunchOptions({ ua: UAS.desktop }), viewport: { width: 1200, height: 900 } });

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
await page.waitForTimeout(8000);

const res = await page.evaluate(async (id) => {
  const B = 'device_platform=webapp&aid=6383&channel=channel_pc_web';
  const out = {};
  async function grab(tag, url, pick) {
    try {
      const r = await fetch(url, { credentials: 'include' });
      const j = await r.json();
      const aweme = pick(j);
      if (!aweme) { out[tag] = { status: r.status, note: 'no aweme' }; return; }
      const v = aweme.video || {};
      const gears = (v.bit_rate || []).map((b) => ({
        gear: b.gear_name,
        qt: b.quality_type,
        w: b.play_addr && b.play_addr.width,
        h: b.play_addr && b.play_addr.height,
        kbps: Math.round((b.bit_rate || 0) / 1000),
        fps: b.FPS,
        h265: !!(b.is_h265 || b.is_bytevc1),
        fmt: b.format,
        bytes: b.play_addr && b.play_addr.data_size,
        url: b.play_addr && b.play_addr.url_list && b.play_addr.url_list[0]
          ? b.play_addr.url_list[0].slice(0, 60) : ''
      }));
      gears.sort((a, b) => (b.h || 0) - (a.h || 0) || (b.kbps || 0) - (a.kbps || 0));
      out[tag] = {
        status: r.status, gears: gears.length,
        top: gears.slice(0, 6),
        play_addr: v.play_addr ? (v.play_addr.width + 'x' + v.play_addr.height) : '',
        play_addr_265: v.play_addr_265 ? (v.play_addr_265.width + 'x' + v.play_addr_265.height) : '',
        play_addr_h264: v.play_addr_h264 ? (v.play_addr_h264.width + 'x' + v.play_addr_h264.height) : '',
        duration: v.duration
      };
    } catch (e) {
      out[tag] = { err: String(e).slice(0, 100) };
    }
  }

  // 1) 网页 detail（客户端同源）
  await grab('web_detail', `/aweme/v1/web/aweme/detail/?aweme_id=${id}&${B}`, (j) => j.aweme_detail);

  // 2) 网页 detail + 明确要 1080/2K 的 quality 参数（试探服务端是否按请求裁剪）
  await grab('web_detail_q1080',
    `/aweme/v1/web/aweme/detail/?aweme_id=${id}&video_quality_type=2&support_h265=1&support_bytevc1=1&${B}`,
    (j) => j.aweme_detail);

  // 3) app 风格接口（同源，读一遍看看给不给）
  await grab('app_detail',
    `/aweme/v1/aweme/detail/?aweme_id=${id}&aid=1128&device_platform=android&version_code=290100&support_h265=1&support_bytevc1=1`,
    (j) => j.aweme_detail);

  return out;
}, ID);

console.log('=== 视频', ID, '===');
for (const [k, v] of Object.entries(res)) {
  console.log('\n## ' + k);
  console.log(JSON.stringify(v, null, 1).slice(0, 1600));
}
fs.writeFileSync(path.join(OUT, `gears-${ID}.json`), JSON.stringify(res, null, 2), 'utf8');
log('saved', path.join(OUT, `gears-${ID}.json`));
try { await ctx.close(); } catch (e) {}
