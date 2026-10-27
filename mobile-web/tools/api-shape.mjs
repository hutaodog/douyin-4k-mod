/**
 * 关键接口的「返回结构」实测：在页面内 fetch（自带签名），打印顶层键 + 主列表元素键。
 * 用法：node mobile-web/tools/api-shape.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { loadPW, UAS, stamp, baseLaunchOptions } from './lib/browser.mjs';

const OUT = path.resolve('mobile-web/probe-output/api');
const log = (...m) => console.log(stamp(), ...m);
const AWEME = '7686426147004976393';
const SEC = 'MS4wLjABAAAAAmSgIbQLcw0G88p5U2uAwOt-A9On9Bx2FKZJATLR5WM';
const B = 'device_platform=webapp&aid=6383&channel=channel_pc_web';

const TARGETS = [
  ['aweme/detail', `/aweme/v1/web/aweme/detail/?aweme_id=${AWEME}&${B}`],
  ['comment/list', `/aweme/v1/web/comment/list/?aweme_id=${AWEME}&cursor=0&count=20&${B}`],
  ['aweme/related', `/aweme/v1/web/aweme/related/?aweme_id=${AWEME}&count=20&filterGids=0&${B}`],
  ['aweme/post', `/aweme/v1/web/aweme/post/?sec_user_id=${SEC}&max_cursor=0&count=12&${B}`],
  ['user/profile/other', `/aweme/v1/web/user/profile/other/?sec_user_id=${SEC}&${B}`],
  ['hot/search/list', `/aweme/v1/web/hot/search/list/?detail_list=1&${B}`],
  ['danmaku/get_v2', `/aweme/v1/web/danmaku/get_v2/?group_id=${AWEME}&format=json&${B}`],
  ['music/aweme', `/aweme/v1/web/music/aweme/?music_id=7412345678901234567&cursor=0&count=10&${B}`],
  ['mix/aweme', `/aweme/v1/web/mix/aweme/?mix_id=7372484719360453395&cursor=0&count=10&${B}`],
  ['notice/count', `/aweme/v1/web/notice/count/?is_new_notice=1&need_social_count=1&${B}`],
  ['search/item', `/aweme/v1/web/search/item/?keyword=${encodeURIComponent('猫')}&offset=0&count=10&${B}`]
];

const { chromium } = loadPW();
const ctx = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(OUT, '_shape-')),
  baseLaunchOptions({ ua: UAS.desktop }));
try {
  const list = JSON.parse(fs.readFileSync(path.join(OUT, '..', 'cookies.json'), 'utf8'));
  await ctx.addCookies(list.filter((c) => c.name && c.name.trim()).map((c) => ({
    name: c.name, value: c.value,
    domain: c.domain && c.domain.startsWith('.') ? c.domain : '.' + String(c.domain || 'douyin.com').replace(/^\./, ''),
    path: c.path || '/', secure: c.secure !== false, httpOnly: !!c.httpOnly,
    sameSite: ['Lax', 'Strict', 'None'].includes(c.sameSite) ? c.sameSite : 'Lax'
  })));
} catch (e) { log('cookie:', String(e).slice(0, 80)); }

const page = await ctx.newPage();
try { await page.goto(`https://www.douyin.com/video/${AWEME}`, { waitUntil: 'domcontentloaded', timeout: 45000 }); } catch (e) {}
await page.waitForTimeout(8000);

const SHAPE = `
(async (u) => {
  const ctl = new AbortController();
  const t = setTimeout(()=>{try{ctl.abort()}catch(e){}}, 12000);
  try {
    const r = await fetch(u, { credentials:'include', signal: ctl.signal });
    const txt = await r.text();
    clearTimeout(t);
    let j=null; try { j = JSON.parse(txt); } catch(e) {}
    if (!j) return { status:r.status, len:txt.length, err:'not json' };
    const K = (o,n) => o && typeof o==='object' ? Object.keys(o).slice(0,n) : [];
    const out = { status:r.status, len:txt.length, top:K(j,26) };
    for (const k of Object.keys(j)) {
      const v=j[k];
      if (Array.isArray(v) && v.length && typeof v[0]==='object') {
        out['list '+k] = { n:v.length, keys:K(v[0],30) };
      }
    }
    const aw = (j.aweme_detail) || (Array.isArray(j.aweme_list)&&j.aweme_list[0]) || null;
    if (aw) {
      out['aweme'] = K(aw,40);
      if (aw.video) { out['video'] = K(aw.video,30);
        if (Array.isArray(aw.video.bit_rate)) out['bit_rate'] = { n: aw.video.bit_rate.length, keys: K(aw.video.bit_rate[0],14) };
        if (aw.video.play_addr) out['play_addr'] = K(aw.video.play_addr,10);
      }
      if (aw.author) out['author'] = K(aw.author,18);
      if (aw.statistics) out['statistics'] = K(aw.statistics,18);
      if (aw.music) out['music'] = K(aw.music,14);
      if (aw.text_extra) out['text_extra'] = K(aw.text_extra[0],8);
    }
    const cm = Array.isArray(j.comments) && j.comments[0];
    if (cm) { out['comment'] = K(cm,22); if (cm.user) out['comment.user'] = K(cm.user,14); if (cm.reply_comment) out['comment.reply_comment'] = { n: cm.reply_comment.length }; }
    if (j.cursor !== undefined) out.paging = { cursor: j.cursor, has_more: j.has_more, total: j.total };
    if (j.max_cursor !== undefined) out.paging = { max_cursor: j.max_cursor, has_more: j.has_more };
    return out;
  } catch(e) { clearTimeout(t); return { status:-1, err:String(e).slice(0,80) }; }
})(%U%)
`;

const all = {};
for (const [name, u] of TARGETS) {
  let r = null;
  try { r = await page.evaluate(SHAPE.replace('%U%', JSON.stringify(u))); }
  catch (e) { r = { status: -2, err: String(e).slice(0, 70) }; }
  all[name] = r;
  log('');
  log('■ ' + name + '   status=' + r.status + '  len=' + (r.len || 0));
  if (r.top) log('  top    : ' + r.top.join(', '));
  for (const k of Object.keys(r)) {
    if (k.startsWith('list ') || ['aweme', 'video', 'bit_rate', 'play_addr', 'author', 'statistics', 'music', 'comment', 'comment.user'].includes(k)) {
      const v = r[k];
      const keys = Array.isArray(v && v.keys) ? v.keys.join(',') : JSON.stringify(v);
      log('  ' + k.padEnd(16) + (v && v.n !== undefined ? 'n=' + v.n + ' ' : '') + keys);
    }
  }
  if (r.paging) log('  paging : ' + JSON.stringify(r.paging));
  if (r.err) log('  err    : ' + r.err);
}

fs.writeFileSync(path.join(OUT, 'shapes.json'), JSON.stringify(all, null, 2), 'utf8');
log('');
log('saved:', path.join(OUT, 'shapes.json'));
try { await ctx.close(); } catch (e) {}
