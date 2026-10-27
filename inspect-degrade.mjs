// 深挖 abconfig 的 backendAbTest / allAbParams：列出所有与降档、码率、编码、清晰度相关的配置
import { DatabaseSync } from 'node:sqlite';

const file = (process.env.APPDATA || '') + '\\douyin\\douyin_app_config';
const db = new DatabaseSync(file, { readOnly: true });
const raw = String((db.prepare("SELECT value FROM app_config WHERE key='abconfig'").get() || {}).value || '');
const data = JSON.parse(raw);

const RE = /degrade|bitrate|abr|codec|dash|quality|clarity|gear|defin|switch|h265|h266|hevc|vvc|player/i;

function dump(obj, path, out, depth) {
  if (depth > 4 || !obj || typeof obj !== 'object') return;
  for (const k of Object.keys(obj)) {
    const v = obj[k];
    const p = path + '.' + k;
    if (RE.test(k)) {
      const brief = (v && typeof v === 'object') ? JSON.stringify(v).slice(0, 400) : String(v).slice(0, 200);
      out.push(`${p} = ${brief}`);
    }
    if (v && typeof v === 'object') dump(v, p, out, depth + 1);
  }
}

for (const top of ['csrInitData', 'tccConfigData', 'setting', 'userSetting']) {
  const node = data[top];
  if (!node) continue;
  console.log(`\n############ ${top}  top-level keys:`);
  console.log('  ' + Object.keys(node).join(', ').slice(0, 1500));
  const out = [];
  dump(node, top, out, 0);
  const seen = new Set();
  console.log(`  --- matched (${out.length}) ---`);
  for (const line of out) {
    if (seen.has(line)) continue;
    seen.add(line);
    console.log('   ' + line);
    if (seen.size > 100) break;
  }
}
