/**
 * 把 probe-play.mjs 的输出 JSON 变成一张"分辨率随时间"的曲线表（写文档/贴证据用）。
 *
 * 用法：
 *   node mobile-web/tools/summarize-play.mjs                     # 自动挑最新的一份
 *   node mobile-web/tools/summarize-play.mjs --file <play.json>
 *   node mobile-web/tools/summarize-play.mjs --dir mobile-web/probe-output/play-v2-portrait
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { parseArgs } from './lib/browser.mjs';

const a = parseArgs(process.argv.slice(2));
let file = a.file && a.file !== true ? path.resolve(String(a.file)) : null;
if (!file) {
  const dir = path.resolve(String(a.dir || 'mobile-web/probe-output'));
  const cands = [];
  (function walk(d, depth) {
    if (depth > 3) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (!/^_/.test(e.name)) walk(p, depth + 1); }
      else if (/^play-.*\.json$/.test(e.name)) cands.push({ p, m: fs.statSync(p).mtimeMs });
    }
  })(dir, 0);
  cands.sort((x, y) => y.m - x.m);
  if (!cands.length) { console.log('没找到 play-*.json'); process.exit(1); }
  file = cands[0].p;
}
const j = JSON.parse(fs.readFileSync(file, 'utf8'));
console.log('file :', file);
console.log('url  :', j.url);
console.log('ua   :', j.ua);
console.log('');
console.log('  t   resolution   state   pos    buf   hud');
console.log('  ---- ----------- ------- ------ ----- ------------------------------');
for (const s of j.samples || []) {
  const x = s.s;
  if (!x) { console.log(String(s.i).padStart(4) + '  (no video)'); continue; }
  console.log(
    String(s.i).padStart(4) + 's ' +
    (x.w + 'x' + x.h).padEnd(11) + ' ' +
    (x.paused ? 'paused' : 'play').padEnd(7) + ' ' +
    String(x.t).padEnd(6) + ' ' +
    String(x.buf).padEnd(5) + ' ' +
    String(x.hud || '').replace(/\n/g, ' / ').slice(0, 46)
  );
}
const res = [...new Set((j.samples || []).map((s) => s.s && s.s.w + 'x' + s.s.h).filter(Boolean))];
console.log('');
console.log('resolutions seen :', res.join(' , '));
const maxH = Math.max(...res.map((r) => Number(r.split('x')[1]) || 0), 0);
console.log('max height       :', maxH, maxH >= 2160 ? '(4K ✅)' : maxH >= 1440 ? '(2K)' : '');
console.log('gear_names       :', [...new Set(Object.values(j.gears || {}).flatMap((g) => g.gears || []))].join(' , '));
console.log('menu words       :', (j.menus && j.menus.after || []).join(' | '));
console.log('media hosts      :', JSON.stringify(j.mediaHosts || {}));
console.log('ab urls          :', (j.ab || []).join(' , '));
