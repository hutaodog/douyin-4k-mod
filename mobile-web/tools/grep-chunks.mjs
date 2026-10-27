/**
 * 本地 chunk 检索：在 find-code.mjs 缓存的 JS 包上按正则找上下文（压缩代码一行到底，必须切片打印）。
 *
 * 用法：
 *   node mobile-web/tools/grep-chunks.mjs --dir mobile-web/probe-output/code/_chunks --pattern "fR:"
 *   node mobile-web/tools/grep-chunks.mjs --pattern "isHas2K" --file player-14.462e8c48.js --ctx 400
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { parseArgs } from './lib/browser.mjs';

const a = parseArgs(process.argv.slice(2));
const DIR = path.resolve(String(a.dir || 'mobile-web/probe-output/code/_chunks'));
const FILE = a.file && a.file !== true ? String(a.file) : null;
const PAT = String(a.pattern || 'isHas2K');
const CTX = Number(a.ctx || 260);
const MAX = Number(a.max || 6);

const files = FILE
  ? [path.join(DIR, FILE)]
  : fs.readdirSync(DIR).filter((f) => /\.js$/.test(f)).map((f) => path.join(DIR, f));

const re = new RegExp(PAT, 'g');
let total = 0;
for (const f of files) {
  let txt;
  try { txt = fs.readFileSync(f, 'utf8'); } catch (e) { continue; }
  let m; let n = 0;
  re.lastIndex = 0;
  const hits = [];
  while ((m = re.exec(txt)) && n < MAX) {
    hits.push({ at: m.index, ctx: txt.slice(Math.max(0, m.index - CTX), m.index + CTX) });
    n++;
    if (m.index === re.lastIndex) re.lastIndex++;
  }
  if (!hits.length) continue;
  total += hits.length;
  console.log('\n■ ' + path.basename(f) + '  (' + txt.length + ' bytes, ' + hits.length + ' hit)');
  for (const h of hits) console.log('  @' + h.at + ' … ' + h.ctx.replace(/\s+/g, ' '));
}
console.log('\n== total hits: ' + total + ' in ' + files.length + ' files ==');
