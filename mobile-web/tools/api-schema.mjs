/**
 * 从抓到的样本里提取「接口 → 返回结构」摘要，给文档用。
 * 用法：node mobile-web/tools/api-schema.mjs
 */
import fs from 'node:fs';
import path from 'node:path';

const DIR = path.resolve('mobile-web/probe-output/api');
const cat = JSON.parse(fs.readFileSync(path.join(DIR, 'api-catalog.json'), 'utf8'));

const interesting = /aweme\/(detail|post|favorite|related)\/|comment\/list|user\/profile|hot\/search|general\/search|search\/item|danmaku|music\/aweme|mix\/aweme|notice\/count|im\/user\/info|abtest_config|module\/feed|series\/aweme|mix\/listcollection/;

function typeName(v, depth = 0) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return v.length ? 'array<' + typeName(v[0], depth + 1) + '>' : 'array[]';
  const t = typeof v;
  if (t === 'object') return depth > 0 ? 'object' : 'object';
  return t;
}

function keysOf(obj, limit = 40) {
  if (!obj || typeof obj !== 'object') return [];
  return Object.keys(obj).slice(0, limit);
}

const out = [];
for (const e of cat.endpoints) {
  if (!interesting.test(e.path)) continue;
  const rec = { path: e.path, method: e.methods.join(','), scenes: e.scenes, maxLen: e.maxLen, sample: e.sampleFile };
  const f = e.sampleFile ? path.join(DIR, 'samples', e.sampleFile) : null;
  if (f && fs.existsSync(f)) {
    try {
      const j = JSON.parse(fs.readFileSync(f, 'utf8').replace(/…\(truncated\)$/, ''));
      rec.top = keysOf(j);
      // 找主要列表
      for (const k of Object.keys(j)) {
        const v = j[k];
        if (Array.isArray(v) && v.length && typeof v[0] === 'object') {
          rec['list_' + k] = { count: v.length, keys: keysOf(v[0], 30) };
        }
      }
      // aweme 里的关键嵌套
      const pick = (arr) => (Array.isArray(arr) && arr[0]) || null;
      const aw = pick(j.aweme_list) || j.aweme_detail || pick(j.data);
      if (aw) {
        rec.awemeKeys = keysOf(aw, 40);
        if (aw.video) {
          rec.videoKeys = keysOf(aw.video, 30);
          const br = aw.video.bit_rate;
          rec.bitRate = Array.isArray(br) ? { count: br.length, keys: br[0] ? keysOf(br[0], 20) : [] } : null;
        }
        if (aw.author) rec.authorKeys = keysOf(aw.author, 20);
        if (aw.statistics) rec.statKeys = keysOf(aw.statistics, 20);
      }
      const cm = pick(j.comments);
      if (cm) {
        rec.commentKeys = keysOf(cm, 24);
        if (cm.user) rec.commentUserKeys = keysOf(cm.user, 16);
      }
      if (j.cursor !== undefined) rec.paging = { cursor: j.cursor, has_more: j.has_more, total: j.total };
      if (j.max_cursor !== undefined) rec.paging = { max_cursor: j.max_cursor, has_more: j.has_more };
    } catch (err) { rec.err = String(err).slice(0, 80); }
  }
  out.push(rec);
}

fs.writeFileSync(path.join(DIR, 'schema-summary.json'), JSON.stringify(out, null, 2), 'utf8');
for (const r of out) {
  console.log('■ ' + r.method + ' ' + r.path + '  (' + r.maxLen + 'B)  scenes=' + r.scenes.join(','));
  if (r.top) console.log('   top     : ' + r.top.slice(0, 14).join(', '));
  for (const k of Object.keys(r)) {
    if (k.startsWith('list_')) console.log('   ' + k.padEnd(9) + ': n=' + r[k].count + ' keys=' + r[k].keys.slice(0, 16).join(','));
  }
  if (r.awemeKeys) console.log('   aweme   : ' + r.awemeKeys.slice(0, 22).join(','));
  if (r.bitRate) console.log('   bit_rate: n=' + r.bitRate.count + ' keys=' + r.bitRate.keys.join(','));
  if (r.commentKeys) console.log('   comment : ' + r.commentKeys.slice(0, 16).join(','));
  if (r.paging) console.log('   paging  : ' + JSON.stringify(r.paging));
  console.log('');
}
