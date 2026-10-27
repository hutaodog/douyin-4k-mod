// 把 dypc4k-diag.log 解析成紧凑时间线（按窗口 ID 分组）
import fs from 'node:fs';

const LOG = process.env.APPDATA + '\\douyin\\dypc4k-diag.log';
const lines = fs.readFileSync(LOG, 'utf8').split(/\r?\n/).filter(Boolean);

const byWid = new Map();
for (const ln of lines) {
  const p = ln.split('\t');
  if (p.length < 5) continue;
  const [ts, wid, rel, kind, data] = p;
  if (!byWid.has(wid)) byWid.set(wid, []);
  byWid.get(wid).push({ ts, rel, kind, data });
}

function short(kind, data) {
  if (kind === 'storage.set') {
    try {
      const o = JSON.parse(data);
      const v = JSON.parse(o.v || '{}');
      return `set gearType=${v.gearType} clarity=${v.gearClarity} name=${v.gearName} clarityReal=${v.clarityReal ? v.clarityReal.length + '项' : '-'}`;
    } catch { return 'set ' + data.slice(0, 80); }
  }
  if (kind === 'storage.remove') return 'REMOVE (clarity plugin pC)';
  if (kind === 'storage.get') {
    try { const o = JSON.parse(data); return 'get -> ' + String(o.got).slice(0, 70); } catch { return 'get'; }
  }
  if (kind === 'video.res') return data;
  if (kind === 'video.src') {
    try {
      const arr = JSON.parse(data);
      return arr.map(s => {
        if (!s) return '(empty)';
        if (s.startsWith('blob:')) return 'blob:mse';
        try { const u = new URL(s); return u.host + u.pathname.slice(-26); } catch { return s.slice(0, 40); }
      }).join('  |  ');
    } catch { return data.slice(0, 80); }
  }
  if (kind === 'menu') {
    try { const a = JSON.parse(data); return a.length ? a.map(x => x.slice(0, 60)).join(' ‖ ') : '[]'; } catch { return data.slice(0, 80); }
  }
  return data.slice(0, 100);
}

for (const [wid, rows] of byWid) {
  if (rows.length < 3) continue;
  console.log(`\n================ 窗口 ${wid}  (${rows[0].ts} 起, ${rows.length} 条) ================`);
  let lastLine = '';
  for (const r of rows) {
    if (r.kind === 'video.res' || r.kind === 'storage.set' || r.kind === 'storage.remove' || r.kind === 'menu') {
      const s = short(r.kind, r.data);
      if (s === lastLine) continue;
      lastLine = s;
    }
    console.log(`${r.ts} ${r.rel.padStart(9)} ${r.kind.padEnd(14)} ${short(r.kind, r.data)}`);
  }
}
