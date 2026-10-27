// 从 web 包里抽出播放器设置注册表（solidKey / alias / defaultVal）
import fs from 'node:fs';

const file = process.argv[2];
const s = fs.readFileSync(file, 'utf8');

const re = /\{key:"([^"]+)"(?:,[^{}]*?)?alias:"([^"]+)"(?:,[^{}]*?)?defaultVal:([^,}]+)/g;
const rows = [];
let m;
while ((m = re.exec(s))) rows.push({ key: m[1], alias: m[2], def: m[3] });

console.log(`entries: ${rows.length}`);
const interest = /clarity|quality|bitrate|codec|h26|degrade|abr|switch|defin|player|video|dash|sr|over_rect/i;
console.log('\n--- 与清晰度/编码/降码率相关的 ---');
for (const r of rows) {
  if (interest.test(r.key) || interest.test(r.alias)) {
    console.log(`  key=${r.key}  alias=${r.alias}  default=${String(r.def).slice(0, 60)}`);
  }
}
console.log('\n--- 全部 key 一览 ---');
console.log(rows.map(r => r.key).join(', '));
