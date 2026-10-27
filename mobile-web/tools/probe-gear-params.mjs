/**
 * 对照实验：同一个视频，用不同请求参数拿 detail，看档位表差多少。
 * 目的：验证"客户端参数导致服务端裁掉高档位"的猜测。
 * 用法：node probe-gear-params.mjs <aweme_id>
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { loadPW, UAS, stamp, baseLaunchOptions } from './lib/browser.mjs';

const ID = process.argv[2] || '7701294669032614565';
const OUT = path.resolve('mobile-web/probe-output');

const { chromium } = loadPW();
const ctx = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(OUT, '_gp-')),
  { ...baseLaunchOptions({ ua: UAS.desktop }), viewport: { width: 1280, height: 900 } });

const ck = path.join(OUT, 'cookies.json');
if (fs.existsSync(ck)) {
  try {
    const list = JSON.parse(fs.readFileSync(ck, 'utf8'));
    await ctx.addCookies(list.filter((c) => c.name && c.name.trim()).map((c) => ({
      name: c.name, value: c.value,
      domain: c.domain && c.domain.startsWith('.') ? c.domain : '.' + String(c.domain || 'douyin.com').replace(/^\./, ''),
      path: c.path || '/', secure: c.secure !== false, httpOnly: !!c.httpOnly,
      sameSite: ['Lax', 'Strict', 'None'].includes(c.sameSite) ? c.sameSite : 'Lax'
    })));
  } catch (e) {}
}

const page = await ctx.newPage();
await page.goto(`https://www.douyin.com/video/${ID}`, { waitUntil: 'domcontentloaded', timeout: 45000 });
await page.waitForTimeout(6000);

const res = await page.evaluate(async (id) => {
  const base = 'device_platform=webapp&aid=6383&channel=channel_pc_web';
  const variants = {
    'web (我们的对照)': `/aweme/v1/web/aweme/detail/?aweme_id=${id}&${base}`,
    '客户端参数 pc_client_type=2': `/aweme/v1/web/aweme/detail/?aweme_id=${id}&pc_client_type=2&version_code=807000&pc_libra_divert=Windows&support_h265=1&${base}`,
    '去掉 channel/加 h265': `/aweme/v1/web/aweme/detail/?aweme_id=${id}&support_h265=1&support_bytevc1=1`,
    'feed 接口同款': `/aweme/v2/web/module/feed/?pc_client_type=2&version_code=807000&support_h265=1&${base}`
  };
  const out = {};
  for (const [name, url] of Object.entries(variants)) {
    try {
      const r = await fetch(url, { credentials: 'include' });
      const txt = await r.text();
      let j = null;
      try { j = JSON.parse(txt); } catch (e) {}
      if (!j) { out[name] = { status: r.status, note: 'not json', len: txt.length }; continue; }
      // 这个 id 的档位
      let aw = j.aweme_detail;
      if (!aw && Array.isArray(j.aweme_list)) aw = j.aweme_list.find((x) => String(x.aweme_id) === String(id)) || j.aweme_list[0];
      if (!aw || !aw.video) { out[name] = { status: r.status, note: 'no video', keys: Object.keys(j).slice(0, 6) }; continue; }
      const gears = (aw.video.bit_rate || []).map((b) => ({
        h: b.play_addr && b.play_addr.height,
        c: (b.is_h265 || b.is_bytevc1) ? 'h265' : 'h264',
        k: Math.round((b.bit_rate || 0) / 1000),
        g: b.gear_name
      })).sort((a, b) => (b.h || 0) - (a.h || 0));
      const uniq = [...new Map(gears.map((x) => [x.h + x.c + x.g, x])).values()];
      out[name] = { status: r.status, n: uniq.length, max: uniq[0] ? uniq[0].h : 0, top: uniq.slice(0, 4) };
    } catch (e) {
      out[name] = { err: String(e).slice(0, 80) };
    }
  }
  return out;
}, ID);

console.log(stamp(), '视频', ID);
for (const [name, v] of Object.entries(res)) {
  console.log('\n## ' + name);
  console.log('   status=' + v.status + '  档位=' + (v.n ?? '?') + '  最高=' + (v.max ?? '?'));
  if (v.top) v.top.forEach((g) => console.log(`     ${g.h}p ${g.c} ${g.k}k ${g.g}`));
  if (v.note) console.log('   note:', v.note, v.keys || '');
}
try { await ctx.close(); } catch (e) {}
