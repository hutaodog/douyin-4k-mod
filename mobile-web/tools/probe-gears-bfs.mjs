/**
 * 用 related 接口扩展采样：从一条种子视频出发，逐层收集几十条视频的档位表。
 * 用法：node probe-gears-bfs.mjs [种子id] [轮数=3]
 * 产物：mobile-web/probe-output/gears-collection.json
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { loadPW, UAS, stamp, baseLaunchOptions } from './lib/browser.mjs';

const SEED = process.argv[2] || '7701294669032614565';
const ROUNDS = Number(process.argv[3] || 3);
const OUT = path.resolve('mobile-web/probe-output');
const log = (...m) => console.log(stamp(), ...m);

const { chromium } = loadPW();
const ctx = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(OUT, '_bfs-')),
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

const page = await ctx.newPage();
log('打开视频页…');
await page.goto(`https://www.douyin.com/video/${SEED}`, { waitUntil: 'domcontentloaded', timeout: 45000 });
await page.waitForTimeout(7000);
log('页面就绪');

const collected = await page.evaluate(async ({ seed, rounds }) => {
  const B = 'device_platform=webapp&aid=6383&channel=channel_pc_web';
  const out = {};
  const seen = new Set();

  function take(aw) {
    if (!aw || !aw.aweme_id) return null;
    const id = String(aw.aweme_id);
    if (seen.has(id)) return null;
    const br = aw.video && aw.video.bit_rate;
    if (!Array.isArray(br) || !br.length) return null;
    seen.add(id);
    out[id] = {
      id,
      desc: String(aw.desc || '').slice(0, 36),
      author: String((aw.author && aw.author.nickname) || '').slice(0, 16),
      dur: (aw.video && aw.video.duration) || 0,
      vw: (aw.video && aw.video.width) || 0,
      vh: (aw.video && aw.video.height) || 0,
      gears: br.map((b) => {
        const pa = (b && b.play_addr) || {};
        return {
          g: b.gear_name, h: pa.height || 0, w: pa.width || 0,
          k: Math.round((b.bit_rate || 0) / 1000),
          c: (b.is_h265 || b.is_bytevc1) ? 'h265' : 'h264',
          f: b.format, qt: b.quality_type, fps: b.FPS
        };
      })
    };
    return id;
  }

  // 种子：detail
  try {
    const r = await fetch(`/aweme/v1/web/aweme/detail/?aweme_id=${seed}&${B}`, { credentials: 'include' });
    const j = await r.json();
    take(j.aweme_detail);
  } catch (e) {}

  // 逐层扩展
  let frontier = Object.keys(out);
  for (let round = 0; round < rounds && frontier.length; round++) {
    const next = [];
    for (const id of frontier.slice(0, 6)) {
      try {
        const r = await fetch(`/aweme/v1/web/aweme/related/?aweme_id=${id}&count=20&filterGids=0&${B}`, { credentials: 'include' });
        const j = await r.json();
        for (const aw of (j.aweme_list || [])) {
          const nid = take(aw);
          if (nid) next.push(nid);
        }
      } catch (e) {}
    }
    frontier = next;
  }
  return out;
}, { seed: SEED, rounds: ROUNDS });

const list = Object.values(collected);
log('采集到视频数:', list.length);
fs.writeFileSync(path.join(OUT, 'gears-collection.json'), JSON.stringify(list, null, 1), 'utf8');

// ---------- 归纳 ----------
const tierOf = (h) => h >= 2160 ? '4K' : h >= 1440 ? '2K' : h >= 1080 ? '1080P' : h >= 720 ? '720P' : h >= 540 ? '540P' : '更低';

const gearStat = new Map();
for (const v of list) for (const g of v.gears) {
  if (!gearStat.has(g.g)) gearStat.set(g.g, []);
  gearStat.get(g.g).push({ ...g, tier: tierOf(g.h) });
}

console.log('\n================ 档位名 → 画质 对照表 ================');
const rows = [...gearStat.entries()].map(([name, arr]) => {
  const hs = arr.map((x) => x.h).filter(Boolean);
  const ks = arr.map((x) => x.k).filter(Boolean);
  const codecs = [...new Set(arr.map((x) => x.c))];
  return {
    name,
    tier: tierOf(Math.max(...hs)),
    res: Math.max(...hs) + 'p',
    kmin: Math.min(...ks), kmax: Math.max(...ks),
    codec: codecs.join('/'),
    qt: [...new Set(arr.map((x) => x.qt))].join('/'),
    n: arr.length
  };
}).sort((a, b) => parseInt(b.res) - parseInt(a.res) || b.kmax - a.kmax);

console.log('档位名'.padEnd(30) + '画质'.padEnd(8) + '分辨率'.padEnd(9) + '码率'.padEnd(14) + '编码'.padEnd(7) + 'qt'.padEnd(8) + '出现');
for (const r of rows) {
  console.log(r.name.padEnd(28) + r.tier.padEnd(8) + r.res.padEnd(9) +
    (r.kmin + '~' + r.kmax + 'k').padEnd(14) + r.codec.padEnd(7) + String(r.qt).padEnd(8) + r.n);
}

console.log('\n================ 每条视频的最高档 ================');
const tiers = {};
for (const v of list) {
  const maxH = v.gears.reduce((m, g) => Math.max(m, g.h || 0), 0);
  const t = tierOf(maxH);
  tiers[t] = (tiers[t] || 0) + 1;
}
const total = list.length;
for (const t of ['4K', '2K', '1080P', '720P', '540P', '更低']) {
  if (!tiers[t]) continue;
  console.log(`  ${t.padEnd(6)} ${String(tiers[t]).padStart(3)} 条  ${((tiers[t] / total) * 100).toFixed(1)}%`);
}
log('saved', path.join(OUT, 'gears-collection.json'));
try { await ctx.close(); } catch (e) {}
