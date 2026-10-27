/**
 * 从推荐流批量采集视频档位表，归纳"每档画质对应什么"。
 * 用法：node probe-feed-gears.mjs [滚动次数=14]
 * 产物：mobile-web/probe-output/feed-gears.json
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { loadPW, UAS, stamp, baseLaunchOptions } from './lib/browser.mjs';

const SCROLLS = Number(process.argv[2] || 14);
const OUT = path.resolve('mobile-web/probe-output');
fs.mkdirSync(OUT, { recursive: true });

const { chromium } = loadPW();
const ctx = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(OUT, '_feed-')),
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
    log('cookies', list.length);
  } catch (e) {}
}

function log(...m) { console.log(stamp(), ...m); }

const page = await ctx.newPage();
const videos = new Map();   // aweme_id -> {id, desc, author, gears:[...]}

page.on('response', async (res) => {
  try {
    const url = res.url();
    if (!/\/aweme\/v\d\/web\//.test(url)) return;
    const ct = (res.headers()['content-type'] || '');
    if (!/json/.test(ct)) return;
    const txt = await res.text();
    if (txt.indexOf('bit_rate') < 0) return;
    let j = null; try { j = JSON.parse(txt); } catch (e) { return; }
    const stack = [j];
    let guard = 5000;
    while (stack.length && guard-- > 0) {
      const v = stack.pop();
      if (!v || typeof v !== 'object') continue;
      if (Array.isArray(v)) { for (const x of v) stack.push(x); continue; }
      if (v.video && Array.isArray(v.video.bit_rate) && v.video.bit_rate.length && v.aweme_id) {
        const id = String(v.aweme_id);
        const gears = v.video.bit_rate.map((b) => {
          const pa = (b && b.play_addr) || {};
          return {
            g: b.gear_name,
            h: pa.height || 0,
            w: pa.width || 0,
            k: Math.round((b.bit_rate || 0) / 1000),
            c: (b.is_h265 || b.is_bytevc1) ? 'h265' : 'h264',
            f: b.format,
            qt: b.quality_type,
            fps: b.FPS
          };
        });
        if (!videos.has(id)) {
          videos.set(id, {
            id,
            desc: String(v.desc || '').slice(0, 40),
            author: String((v.author && v.author.nickname) || '').slice(0, 20),
            dur: v.video.duration || 0,
            vw: v.video.width, vh: v.video.height,
            gears
          });
        }
      }
      for (const k in v) if (v[k] && typeof v[k] === 'object') stack.push(v[k]);
    }
  } catch (e) {}
});

await page.goto('https://www.douyin.com/?recommend=1', { waitUntil: 'domcontentloaded', timeout: 45000 });
await page.waitForTimeout(8000);

for (let i = 0; i < SCROLLS; i++) {
  await page.mouse.wheel(0, 1400);
  await page.waitForTimeout(1600);
  if (i % 4 === 3) log('已滚动', i + 1, '次，视频数', videos.size);
}
await page.waitForTimeout(2000);
log('采集完成，视频数', videos.size);

const arr = [...videos.values()];
fs.writeFileSync(path.join(OUT, 'feed-gears.json'), JSON.stringify(arr, null, 1), 'utf8');
log('saved', path.join(OUT, 'feed-gears.json'));

// ---- 输出归纳 ----
const uniqGears = new Map();
for (const v of arr) for (const g of v.gears) {
  const key = g.g;
  if (!uniqGears.has(key)) uniqGears.set(key, { name: key, samples: [] });
  uniqGears.get(key).samples.push(g);
}
console.log('\n=== 出现过的档位名（', uniqGears.size, '种）===');
const rows = [...uniqGears.values()].map((x) => {
  const hs = x.samples.map((s) => s.h).filter(Boolean);
  const ks = x.samples.map((s) => s.k).filter(Boolean);
  const codecs = [...new Set(x.samples.map((s) => s.c))];
  const qts = [...new Set(x.samples.map((s) => s.qt))];
  const fmts = [...new Set(x.samples.map((s) => s.f))];
  return {
    name: x.name, n: x.samples.length,
    h: Math.max(...hs), kmin: Math.min(...ks), kmax: Math.max(...ks),
    codec: codecs.join('/'), qt: qts.join('/'), fmt: fmts.join('/')
  };
}).sort((a, b) => b.h - a.h);
console.log('  档位名'.padEnd(34) + '分辨率'.padEnd(12) + '码率区间'.padEnd(16) + '编码'.padEnd(8) + 'quality_type  出现次数');
for (const r of rows) {
  console.log('  ' + r.name.padEnd(32) + (r.h + 'p').padEnd(12) +
    (r.kmin + '~' + r.kmax + 'k').padEnd(16) + r.codec.padEnd(8) + String(r.qt).padEnd(13) + r.n);
}
