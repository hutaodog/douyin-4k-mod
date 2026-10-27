/**
 * 分析 gears-collection.json：按 min(宽,高) 归类，输出档位对照表与统计。
 * 用法：node analyze-gear-tiers.mjs
 */
import fs from 'node:fs';
import path from 'node:path';

const P = path.resolve('mobile-web/probe-output/gears-collection.json');
const list = JSON.parse(fs.readFileSync(P, 'utf8'));

const shortSide = (g) => Math.min(g.w || 0, g.h || 0) || Math.max(g.w || 0, g.h || 0) || 0;
const tierOf = (s) => s >= 2160 ? '4K' : s >= 1400 ? '2K' : s >= 1080 ? '1080P' : s >= 720 ? '720P' : s >= 540 ? '540P' : '更低';

console.log('视频数:', list.length);

// 统计方向
let portrait = 0, landscape = 0, square = 0;
for (const v of list) {
  const w = v.vw || 0, h = v.vh || 0;
  if (!w || !h) continue;
  if (h > w) portrait++; else if (w > h) landscape++; else square++;
}
console.log(`画幅: 竖屏 ${portrait} / 横屏 ${landscape} / 方形 ${square}`);

// 档位名 → 画质
const stat = new Map();
for (const v of list) for (const g of v.gears) {
  const s = shortSide(g);
  if (!stat.has(g.g)) stat.set(g.g, []);
  stat.get(g.g).push({ ...g, short: s, tier: tierOf(s) });
}

const rows = [...stat.entries()].map(([name, arr]) => {
  const shorts = arr.map((x) => x.short).filter(Boolean);
  const ks = arr.map((x) => x.k).filter(Boolean);
  const maxShort = Math.max(...shorts);
  return {
    name,
    tier: tierOf(maxShort),
    res: `${maxShort}×${Math.max(...arr.map((x) => Math.max(x.w, x.h)))}`,
    short: maxShort,
    kmin: Math.min(...ks), kmax: Math.max(...ks),
    codec: [...new Set(arr.map((x) => x.c))].join('/'),
    qts: [...new Set(arr.map((x) => x.qt))].sort((a, b) => a - b).join('/'),
    n: arr.length
  };
}).sort((a, b) => b.short - a.short || b.kmax - a.kmax);

console.log('\n档位名'.padEnd(30) + '画质'.padEnd(8) + '短边×长边'.padEnd(14) + '码率范围'.padEnd(15) + '编码'.padEnd(7) + 'qt'.padEnd(8) + '出现次数');
console.log('-'.repeat(96));
for (const r of rows) {
  console.log(r.name.padEnd(28) + r.tier.padEnd(8) + r.res.padEnd(14) +
    (r.kmin + '~' + r.kmax + 'k').padEnd(15) + r.codec.padEnd(7) + r.qts.padEnd(8) + r.n);
}

// 每条视频的最高档分布
const tiers = {};
for (const v of list) {
  const best = Math.max(...v.gears.map(shortSide));
  const t = tierOf(best);
  tiers[t] = (tiers[t] || 0) + 1;
}
console.log('\n=== 每条视频"能给的最高画质"分布 ===');
for (const t of ['4K', '2K', '1080P', '720P', '540P', '更低']) {
  if (!tiers[t]) continue;
  console.log(`  ${t.padEnd(6)} ${String(tiers[t]).padStart(3)} 条   ${((tiers[t] / list.length) * 100).toFixed(1)}%`);
}

// 编码分布（高档位）
console.log('\n=== 高画质的编码 ===');
const codecByTier = {};
for (const v of list) for (const g of v.gears) {
  const t = tierOf(shortSide(g));
  if (!codecByTier[t]) codecByTier[t] = {};
  codecByTier[t][g.c] = (codecByTier[t][g.c] || 0) + 1;
}
for (const t of ['4K', '2K', '1080P', '720P', '540P']) {
  if (!codecByTier[t]) continue;
  console.log('  ' + t.padEnd(6) + JSON.stringify(codecByTier[t]));
}

// 码率中位数
const med = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
console.log('\n=== 各画质档的典型码率（中位数）===');
const byTier = {};
for (const v of list) for (const g of v.gears) {
  const t = tierOf(shortSide(g));
  (byTier[t] = byTier[t] || []).push(g.k);
}
for (const t of ['4K', '2K', '1080P', '720P', '540P']) {
  if (!byTier[t]) continue;
  console.log(`  ${t.padEnd(6)} 中位 ${String(med(byTier[t])).padStart(5)} kbps   范围 ${Math.min(...byTier[t])}~${Math.max(...byTier[t])}`);
}
