// 深挖客户端 abconfig / SettingsCache：找出与编码/码率/清晰度相关的配置项
import { DatabaseSync } from 'node:sqlite';

const file = (process.env.APPDATA || '') + '\\douyin\\douyin_app_config';
const db = new DatabaseSync(file, { readOnly: true });
const get = k => {
  const r = db.prepare('SELECT value FROM app_config WHERE key = ?').get(k);
  return r ? String(r.value || '') : '';
};

const KEYS = ['abconfig', 'SettingsCache'];
// 关心的名字片段
const NAME_RE = /codec|h26[0-9]|hevc|vvc|av1|abr|bitrate|clarity|quality|gear|definition|degrade|downgrade|switch|dash|preload|player/i;

function walk(node, path, out, depth) {
  if (depth > 9 || out.length > 400) return;
  if (node && typeof node === 'object') {
    for (const k of Object.keys(node)) {
      const v = node[k];
      const p = path ? path + '.' + k : k;
      if (NAME_RE.test(k)) {
        const brief = (v && typeof v === 'object') ? JSON.stringify(v).slice(0, 300) : String(v).slice(0, 300);
        out.push(`[${p}] = ${brief}`);
      }
      walk(v, p, out, depth + 1);
    }
  }
}

for (const key of KEYS) {
  let raw = get(key);
  console.log(`\n############ ${key} (${raw.length} chars)`);
  if (!raw) continue;
  let data;
  try { data = JSON.parse(raw); } catch (e) { console.log('  not pure JSON:', e.message); continue; }

  // 顶层键
  const tops = Object.keys(data);
  console.log('  top-level keys:', tops.slice(0, 60).join(', '));

  const out = [];
  walk(data, '', out, 0);
  console.log(`  matched config entries: ${out.length}`);
  for (const line of out.slice(0, 120)) console.log('   ' + line);
}
