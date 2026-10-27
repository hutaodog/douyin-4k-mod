// 列出客户端 app 配置库的所有 key（以及命中的清晰度相关片段）
import { DatabaseSync } from 'node:sqlite';

const file = (process.env.APPDATA || '') + '\\douyin\\douyin_app_config';
const db = new DatabaseSync(file, { readOnly: true });
const rows = db.prepare('SELECT key, value FROM app_config').all();

console.log('keys (' + rows.length + '):');
for (const r of rows) {
  const v = String(r.value || '');
  console.log(`  ${r.key}  [${v.length}]`);
}

console.log('\n=== 含 clarity / gear / quality / player 的片段 ===');
const RE = /clarity|gear|quality|player|清晰|画质/i;
for (const r of rows) {
  const v = String(r.value || '');
  let m, from = 0, n = 0;
  while ((m = RE.exec(v)) && n < 6) {
    const s = Math.max(0, m.index - 120), e = Math.min(v.length, m.index + 200);
    console.log(`\n[${r.key}] …${v.slice(s, e).replace(/\s+/g, ' ')}…`);
    from = m.index + 1; RE.lastIndex = from; n++;
  }
}
