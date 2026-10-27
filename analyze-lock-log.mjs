/**
 * 分析 dypc4k-lock.log：统计"档位表里有没有 4K/2K"以及 codec 强制改写次数。
 * 用法：node analyze-lock-log.mjs [日志路径]
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const P = process.argv[2] || path.join(process.env.APPDATA || '', 'douyin', 'dypc4k-lock.log');
if (!fs.existsSync(P)) { console.log('日志不存在：', P); process.exit(0); }

const lines = fs.readFileSync(P, 'utf8').split('\n').filter(Boolean);
const kindOf = (l) => { const m = l.match(/\t([a-z0-9]+)\t/i); return m ? m[1] : '?'; };

const counts = {};
for (const l of lines) counts[kindOf(l)] = (counts[kindOf(l)] || 0) + 1;

console.log('日志 :', P);
console.log('行数 :', lines.length);
console.log('事件 :', Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join('  '));

// codec 强制改写
const codecLines = lines.filter((l) => kindOf(l) === 'codec');
console.log('\n=== codec 强制改写 ===');
console.log('  次数:', codecLines.length, codecLines.length > 20 ? '（仍在和我们抢）' : '（基本没有了）');
if (codecLines.length) {
  const was = {};
  for (const l of codecLines) { const m = l.match(/was=(\S+)/); if (m) was[m[1]] = (was[m[1]] || 0) + 1; }
  console.log('  客户端原本的选择:', JSON.stringify(was));
  console.log('  样例:', codecLines[0].slice(0, 110));
}

// 档位表分析
const states = lines.filter((l) => kindOf(l) === 'state');
console.log('\n=== 播放器档位表里"最高档"的分布 ===');
const dist = {};
const samples = [];
for (const l of states) {
  let arr;
  try { arr = JSON.parse(l.split('\t')[2]); } catch { continue; }
  for (const x of arr || []) {
    const gears = Array.isArray(x.gears) ? x.gears : [];
    if (!gears.length) continue;
    const defs = gears.map((s) => Number(String(s).split('@')[1])).filter((n) => !Number.isNaN(n));
    if (!defs.length) continue;
    const best = Math.min(...defs);
    dist[best] = (dist[best] || 0) + 1;
    if (samples.length < 6) samples.push({ t: l.slice(0, 12), cur: x.cur, best, n: gears.length });
  }
}
const label = (d) => (d === -2 ? '4K(-2)' : d === -1 ? '2K(-1)' : d === 1 ? '1080(1)' : d === 2 ? '720(2)' : d === 3 ? '540(3)' : String(d));
const total = Object.values(dist).reduce((a, b) => a + b, 0);
console.log('  采样数:', total);
for (const k of Object.keys(dist).sort((a, b) => Number(a) - Number(b))) {
  const pct = ((dist[k] / total) * 100).toFixed(1);
  console.log(`    ${label(Number(k)).padEnd(9)} ${String(dist[k]).padStart(4)} 次  ${pct}%`);
}
const has4k = (dist[-2] || 0) + (dist[-1] || 0);
console.log(`  含 4K/2K 档的占比: ${((has4k / total) * 100).toFixed(1)}%`);

console.log('\n=== 档位表样例 ===');
for (const s of samples) console.log(`  ${s.t}  cur=${s.cur}  档位${s.n}个  最高=${label(s.best)}`);
