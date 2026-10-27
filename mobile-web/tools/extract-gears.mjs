/**
 * 档位提取器：把一条视频服务端给的全部档位（gear_name / 分辨率 / 码率 / 编码）展开成人话。
 *
 * 回答的问题：
 *   - 这个视频到底有没有 2160P（4K）码流？
 *   - 4K 是 h264 还是 h265/hevc？
 *   - 菜单里的「超清 4K」对应哪个 gear_name？
 *
 * 用法：
 *   node mobile-web/tools/extract-gears.mjs --url https://www.douyin.com/video/7697934740980125171
 *   node mobile-web/tools/extract-gears.mjs --url <任意视频页> --out mobile-web/probe-output/gears.json
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { loadPW, UAS, parseArgs, stamp, baseLaunchOptions } from './lib/browser.mjs';

const a = parseArgs(process.argv.slice(2));
const URL_ARG = String(a.url || 'https://www.douyin.com/');
const OUT = path.resolve(String(a.out || 'mobile-web/probe-output/gears.json'));
const UA = a['ua-android'] ? UAS.android : (a.ua && a.ua !== true ? String(a.ua) : UAS.desktop);
const log = (...m) => console.log(stamp(), ...m);

fs.mkdirSync(path.dirname(OUT), { recursive: true });
const { chromium } = loadPW();
const ctx = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(path.dirname(OUT), '_profile-')),
  baseLaunchOptions({ headed: !!a.headed, ua: UA }));

const found = [];
ctx.on('response', async (res) => {
  const u = res.url();
  if (!/aweme\/(detail|related|series|post)|play/i.test(u)) return;
  let j;
  try { j = await res.json(); } catch (e) { return; }
  // 递归找 bit_rate 数组 / play_addr
  (function walk(o, depth) {
    if (!o || typeof o !== 'object' || depth > 8) return;
    if (Array.isArray(o.bit_rate)) {
      for (const b of o.bit_rate) {
        const pa = b.play_addr || {};
        const urls = (pa.url_list || []);
        found.push({
          src: u.slice(0, 90),
          gear_name: b.gear_name,
          quality_type: b.quality_type,
          is_h265: b.is_h265,
          is_bytevc1: b.is_bytevc1,
          format: b.format,
          bit_rate: b.bit_rate,
          kbps: b.bit_rate ? Math.round(b.bit_rate / 1000) : null,
          width: pa.width, height: pa.height,
          data_size: b.data_size,
          fps: b.FPS || b.fps,
          url: urls[0] || '',
          urlHint: (urls.join(' ').match(/ratio=[^&\s]+|h265|bytevc1|logo_name=[^&\s]+/g) || []).join(' ')
        });
      }
    }
    for (const k in o) if (o[k] && typeof o[k] === 'object') walk(o[k], depth + 1);
  })(j, 0);
});

const page = ctx.pages()[0];
try { await page.goto(URL_ARG, { waitUntil: 'domcontentloaded', timeout: 45000 }); } catch (e) { log('goto', String(e).slice(0, 120)); }
await page.waitForTimeout(Number(a.wait || 12000));

const uniq = [];
const seen = new Set();
for (const f of found) {
  const key = [f.gear_name, f.width, f.height, f.kbps, f.is_h265, f.format].join('|');
  if (seen.has(key)) continue;
  seen.add(key);
  uniq.push(f);
}
uniq.sort((x, y) => (y.height || 0) - (x.height || 0) || (y.kbps || 0) - (x.kbps || 0));

log('---- 服务端给的档位 ----');
for (const f of uniq) {
  log(
    String(f.height || '?').padStart(5) + 'p',
    String(f.width + 'x' + f.height).padEnd(10),
    String(f.gear_name || '-').padEnd(22),
    'qt=' + f.quality_type,
    String(f.kbps || '?').padStart(6) + ' kbps',
    f.format || '',
    f.is_h265 ? 'h265' : (f.is_bytevc1 ? 'bytevc1/h265' : 'h264?'),
    f.urlHint || ''
  );
}
const max = uniq.reduce((m, f) => Math.max(m, f.height || 0), 0);
log('最高档 :', max + 'p', max >= 2160 ? '=> 有 4K 码流 ✅' : '=> 没有 4K 码流 ❌');
fs.writeFileSync(OUT, JSON.stringify({ url: URL_ARG, fetchedAt: new Date().toISOString(), gears: uniq }, null, 2), 'utf8');
log('saved  :', OUT);
console.log(JSON.stringify({ ok: true, maxHeight: max, count: uniq.length }));
await ctx.close();
