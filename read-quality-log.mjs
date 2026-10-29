/**
 * 读画质日志：%APPDATA%\douyin\dypc4k-quality.log
 * 用法：node read-quality-log.mjs [行数=40] [--all]
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const N = Number(process.argv[2] || 40);
const P = path.join(process.env.APPDATA || '', 'douyin', 'dypc4k-quality.log');

if (!fs.existsSync(P)) {
  console.log('还没有画质日志：', P);
  console.log('在抖音里刷几条视频就会生成。');
  process.exit(0);
}

const lines = fs.readFileSync(P, 'utf8').split('\n').filter(Boolean);
console.log('日志 :', P);
console.log('条数 :', lines.length, '（显示最近', N, '条）\n');

const rows = lines.slice(-N).map((l) => {
  const p = l.split('\t');
  const o = {};
  for (const seg of p.slice(1)) {
    const i = seg.indexOf('=');
    if (i > 0) o[seg.slice(0, i)] = seg.slice(i + 1);
  }
  return { time: p[0], phase: (p[1] || '').replace(/[[\]]/g, ''), raw: l, ...o };
});

const tierOf = (s) => {
  if (!s) return '-';
  const m = /(\d+)x(\d+)/.exec(s);
  if (!m) return s;
  const h = Math.min(+m[1], +m[2]);
  return h >= 2160 ? '4K' : h >= 1400 ? '2K' : h >= 1080 ? '1080P' : h >= 720 ? '720P' : h >= 540 ? '540P' : '更低';
};

console.log('时间'.padEnd(21) + '阶段'.padEnd(7) + '实际'.padEnd(12) + '画质'.padEnd(7) + '表内最高'.padEnd(11) + '清晰度档'.padEnd(9) + '选中');
console.log('-'.repeat(92));
for (const r of rows) {
  console.log(
    String(r.time).padEnd(21) +
    String(r.phase).padEnd(7) +
    String(r['实际'] || '-').padEnd(12) +
    tierOf(r['实际']).padEnd(7) +
    String(r['表内最高'] || '-').padEnd(11) +
    String(r['清晰度档'] || '-').padEnd(9) +
    String(r['选中'] || '-')
  );
}

// 诊断：分两类
const finals = rows.filter((r) => r.phase === 'final');
if (finals.length) {
  console.log('\n=== 诊断 ===');
  let trim = 0, abr = 0, ok = 0;
  for (const r of finals) {
    const best = String(r['表内最高'] || '');
    const tier = tierOf(r['实际']);
    const bestIsHigh = /4K|2K|1080/.test(best);
    const gotHigh = /4K|2K|1080/.test(tier);
    if (bestIsHigh && gotHigh) ok++;
    else if (bestIsHigh && !gotHigh) abr++;     // 表里有高档，但没上
    else trim++;                                 // 表里最高就是低档
  }
  console.log(`  表里有高档且成功   : ${ok} 条`);
  console.log(`  表里有高档但没上   : ${abr} 条   ← 这类是"选择/带宽"问题`);
  console.log(`  表里最高就是低档   : ${trim} 条   ← 这类是"档位表被裁/源本身低"`);
  const last = finals[finals.length - 1];
  if (last) {
    console.log('\n最近一条：');
    console.log('  ' + last.raw.replace(/\t/g, '\n  '));
  }
}
