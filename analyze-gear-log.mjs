/**
 * 分析档位探针日志：看客户端每条视频实际拿到了哪些档、播的是哪一档。
 * 用法：node analyze-gear-log.mjs [日志路径]
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const LOG = process.argv[2] || path.join(process.env.APPDATA || '', 'douyin', 'dypc4k-gear.log');
if (!fs.existsSync(LOG)) {
  console.log('日志还不存在：', LOG);
  console.log('先在抖音里刷几条视频，再跑一次。');
  process.exit(0);
}

const lines = fs.readFileSync(LOG, 'utf8').split('\n').filter(Boolean);
const gearEvents = [];
const videoEvents = [];
const menuEvents = [];

for (const ln of lines) {
  const parts = ln.split('\t');
  if (parts.length < 3) continue;
  const kind = parts[1];
  let obj = null;
  try { obj = JSON.parse(parts[2]); } catch (e) { continue; }
  if (kind === 'G') gearEvents.push(obj);
  else if (kind === 'V') videoEvents.push(obj);
  else if (kind === 'M') menuEvents.push(obj);
}

console.log('日志 :', LOG);
console.log('记录 :', lines.length, '行 | 档位事件', gearEvents.length, '| 视频事件', videoEvents.length, '| 菜单事件', menuEvents.length);
console.log('');

// 按 aweme 聚合：客户端给的档位表
const byId = new Map();
for (const g of gearEvents) {
  if (!g.id) continue;
  if (!byId.has(g.id)) byId.set(g.id, []);
  byId.get(g.id).push(g);
}

function fmtGear(x) {
  return `${x.h}p/${x.c}/${x.k}k/${x.f}${x.g ? '(' + x.g + ')' : ''}`;
}

console.log('=== 客户端拿到的档位表（按视频）===');
let n = 0;
for (const [id, arr] of byId) {
  n++;
  const all = arr.flatMap((a) => a.gears || []);
  const uniq = [...new Map(all.map((x) => [fmtGear(x), x])).values()]
    .sort((a, b) => (b.h || 0) - (a.h || 0));
  const top = uniq.slice(0, 5);
  const req = arr[0] && arr[0].req || {};
  console.log(`\n[${n}] ${id}  档位 ${uniq.length} 个  最高 ${uniq[0] ? uniq[0].h + 'p' : '?'}`);
  console.log('    请求参数:', JSON.stringify(req).slice(0, 160));
  console.log('    档位:', top.map(fmtGear).join(' | '));
  if (n >= 25) { console.log('\n(只列前 25 条)'); break; }
}

console.log('\n=== 实际解码分辨率（video 元素）===');
const seenV = new Set();
for (const v of videoEvents) {
  const key = `${v.w}x${v.h}|${v.src}`;
  if (seenV.has(key)) continue;
  seenV.add(key);
  console.log(`  ${v.w}x${v.h}  ${v.page}  ${v.src}`);
}

if (menuEvents.length) {
  console.log('\n=== 清晰度菜单文案 ===');
  menuEvents.slice(0, 10).forEach((m) => console.log('  ' + m.text));
}

// 交叉对比：有 1080 档却播了 720 的
console.log('\n=== 可疑：档位表里有 ≥1080 但实际没播到 ===');
let suspect = 0;
for (const [id, arr] of byId) {
  const all = arr.flatMap((a) => a.gears || []);
  const maxH = Math.max(0, ...all.map((x) => x.h || 0));
  if (maxH < 1080) continue;
  const played = videoEvents.map((v) => v.h).filter((h) => h > 0);
  const playedMax = played.length ? Math.max(...played) : 0;
  if (playedMax && playedMax < maxH) {
    suspect++;
    console.log(`  ${id}: 档位最高 ${maxH}p，实际播 ${playedMax}p`);
  }
}
if (!suspect) console.log('  （没发现，或还没刷够视频）');
