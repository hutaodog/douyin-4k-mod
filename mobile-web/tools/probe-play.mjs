/**
 * 播放探针：确认「这条视频到底给不给 4K 码流」以及点一下能不能真的播起来。
 *
 * 做四件事：
 *   1) 打开视频页，模拟点击（移动端 web 需要用户手势才播）
 *   2) 连续采样 video.videoWidth/Height + 播放状态，画出"分辨率随时间"的曲线
 *   3) 抓所有含 gear_name / bit_rate / play_addr 的响应，汇总这条视频**服务端给了哪些档位**
 *      —— 这一步能区分「没给 4K 码流」和「给了但没选」
 *   4) 尝试点开清晰度菜单，把菜单里的档位文字抓出来
 *
 * 用法：
 *   node mobile-web/tools/probe-play.mjs --url <视频页> --ua-android
 *   node mobile-web/tools/probe-play.mjs --url <视频页>            # 默认桌面 UA
 *   node mobile-web/tools/probe-play.mjs --url <视频页> --script mobile-web/douyin-4k.user.js
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { loadPW, UAS, parseArgs, stamp, baseLaunchOptions } from './lib/browser.mjs';

const a = parseArgs(process.argv.slice(2));
const URL_ARG = String(a.url || 'https://www.douyin.com/');
const OUT = path.resolve(String(a.out || 'mobile-web/probe-output/play'));
const UA = a['ua-android'] ? UAS.android : a['ua-iphone'] ? UAS.iphone : (a.ua && a.ua !== true ? String(a.ua) : UAS.desktop);
const SCRIPT = a.script && a.script !== true ? String(a.script) : null;
const SECONDS = Number(a.seconds || 25);

fs.mkdirSync(OUT, { recursive: true });
const log = (...m) => console.log(stamp(), ...m);

const { chromium } = loadPW();
const ctx = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(OUT, '_profile-')),
  baseLaunchOptions({ headed: !!a.headed, ua: UA }));

const result = { url: URL_ARG, ua: UA.slice(0, 70), gears: {}, samples: [], menus: [], ab: [], mediaHosts: {}, errors: [] };

ctx.on('request', (req) => {
  try {
    const u = req.url();
    if (req.resourceType() === 'media' || /douyinvod|bytecdn|zjcdn|\.m4s|\.ts\b|mime_type=video/i.test(u)) {
      let h = '';
      try { h = new URL(u).host; } catch (e) { h = '?'; }
      result.mediaHosts[h] = (result.mediaHosts[h] || 0) + 1;
    }
  } catch (e) {}
});

ctx.on('response', async (res) => {
  const u = res.url();
  if (!/aweme|abtest|play|video/i.test(u)) return;
  let txt;
  try { txt = await res.text(); } catch (e) { return; }
  if (!txt || txt.length < 40 || txt[0] !== '{') return;
  if (!/gear_name|bit_rate|play_addr|quality_type|2160/.test(txt)) return;

  // 抓档位：gear_name + quality_type + 尺寸 + 码率
  const rec = { url: u.slice(0, 160), len: txt.length, gears: [], sizes: [], bitrates: [] };
  const gm = txt.match(/"gear_name"\s*:\s*"([^"]+)"/g) || [];
  gm.forEach((s) => rec.gears.push(s.split('"')[3]));
  const qt = txt.match(/"quality_type"\s*:\s*(\d+)/g) || [];
  qt.forEach((s) => rec.bitrates.push('qt=' + s.split(':')[1].trim()));
  const br = txt.match(/"bit_rate"\s*:\s*(\d+)/g) || [];
  br.slice(0, 20).forEach((s) => rec.bitrates.push('br=' + Math.round(Number(s.split(':')[1]) / 1000) + 'k'));
  const wh = txt.match(/"width"\s*:\s*(\d+)[^}]{0,80}?"height"\s*:\s*(\d+)/g) || [];
  wh.slice(0, 20).forEach((s) => {
    const m = s.match(/"width"\s*:\s*(\d+)[^}]{0,80}?"height"\s*:\s*(\d+)/);
    if (m) rec.sizes.push(m[1] + 'x' + m[2]);
  });
  rec.gears = [...new Set(rec.gears)];
  rec.sizes = [...new Set(rec.sizes)];
  rec.bitrates = [...new Set(rec.bitrates)];
  if (/abtest/i.test(u)) { result.ab.push(u.slice(0, 160)); return; }
  result.gears[u.slice(0, 120)] = rec;
  log('gears', rec.gears.join(',') || '-', '|', rec.sizes.slice(0, 6).join(','), '|', u.slice(0, 80));
});

const page = ctx.pages()[0] || await ctx.newPage();
page.on('pageerror', (e) => result.errors.push(String(e && e.message || e).slice(0, 300)));
page.on('console', (m) => {
  const t = m.type();
  const txt = m.text();
  if (t === 'error' || t === 'warning' || /clarity|definition|decode|hevc|h265|abr|bitrate/i.test(txt)) {
    if (result.errors.length < 120) result.errors.push('[' + t + '] ' + txt.slice(0, 220));
  }
});
if (SCRIPT) {
  const code = fs.readFileSync(path.resolve(SCRIPT), 'utf8');
  await ctx.addInitScript({ content: code });
  log('injected', SCRIPT, code.length, 'bytes');
}

try { await page.goto(URL_ARG, { waitUntil: 'domcontentloaded', timeout: 45000 }); }
catch (e) { result.errors.push('goto ' + String(e).slice(0, 160)); }
await page.waitForTimeout(6000);

// 1) 用户手势：点视频中心
const tapInfo = await page.evaluate(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const out = [];
  const v = document.querySelector('video');
  if (!v) return { tapped: false, reason: 'no video element' };
  const r = v.getBoundingClientRect();
  const target = document.elementFromPoint(Math.round(r.x + r.width / 2), Math.round(r.y + r.height / 2)) || v;
  out.push({ tag: target.tagName, cls: String(target.className || '').slice(0, 60) });
  try { target.click(); } catch (e) {}
  await sleep(400);
  try { v.click(); } catch (e) {}
  await sleep(400);
  try { v.play(); } catch (e) {}
  return { tapped: true, out, paused: v.paused, w: v.videoWidth, h: v.videoHeight };
});
log('tap', JSON.stringify(tapInfo).slice(0, 300));

// 2) 采样分辨率曲线
for (let i = 0; i < SECONDS; i++) {
  const s = await page.evaluate(() => {
    const vs = [].slice.call(document.querySelectorAll('video'));
    const v = vs.find((x) => !x.paused && x.videoWidth) || vs.find((x) => x.videoWidth) || vs[0] || null;
    if (!v) return null;
    let buf = 0;
    try { if (v.buffered.length) buf = +(v.buffered.end(v.buffered.length - 1) - v.currentTime).toFixed(1); } catch (e) {}
    const ms = (() => { try { return sessionStorage.getItem('MANUAL_SWITCH'); } catch (e) { return null; } })();
    const hud = (() => {
      const el = document.querySelector('#dy4k-hud');
      return el ? el.textContent.replace(/\n/g, ' / ') : null;
    })();
    return {
      w: v.videoWidth, h: v.videoHeight, paused: v.paused, rs: v.readyState, t: +v.currentTime.toFixed(1),
      buf, ms: ms ? ms.slice(0, 120) : null, hud, src: (v.currentSrc || '').slice(0, 130)
    };
  });
  result.samples.push({ i, s });
  if (s) log(`+${i}s`, `${s.w}x${s.h}`, s.paused ? 'paused' : 'playing', 't=' + s.t, 'buf=' + s.buf, s.ms ? 'MS=' + s.ms.slice(0, 40) : 'MS=null', s.hud ? 'HUD[' + s.hud.slice(0, 60) + ']' : '');
  else log(`+${i}s`, 'no video');
  await page.waitForTimeout(1000);
}

// 3) 清晰度菜单：把可疑按钮都点一遍，收集"档位文字"
result.menus = await page.evaluate(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const GEAR = /4K|2K|1080|720|540|极速|智能|超清|高清|标清|清晰度/;
  const snap = () => [...new Set([].slice.call(document.querySelectorAll('div,span,li,p,a,button'))
    .filter((el) => el.children.length === 0)
    .map((el) => (el.innerText || '').trim())
    .filter((t) => t && t.length <= 14 && GEAR.test(t)))];
  const before = snap();
  const clicked = [];
  const cands = [].slice.call(document.querySelectorAll(
    '[class*="more"],[class*="More"],[class*="setting"],[class*="Setting"],[class*="gear"],[class*="quality"],[class*="Quality"],[class*="clarity"],[class*="right"] button,[aria-label*="更多"],[aria-label*="设置"]'
  )).slice(0, 25);
  for (const el of cands) {
    const r = el.getBoundingClientRect();
    if (r.width < 6 || r.height < 6) continue;
    try { el.click(); } catch (e) { continue; }
    clicked.push({ cls: String(el.className || '').slice(0, 50), rect: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)] });
    await sleep(500);
    const now = snap();
    if (now.length > before.length) break;
  }
  await sleep(500);
  return { before, after: snap(), clicked };
});

const ts = new Date().toISOString().replace(/[:.]/g, '-');

// 收尾诊断：脚本自己的视角（dy4k.state）+ AB 数据里跟清晰度有关的那几个键
result.diag = await page.evaluate(() => {
  const out = { dy4k: null, abTest: null, has2K: null, openAutoDefi: null, manual: null };
  try { out.dy4k = window.dy4k && window.dy4k.state(); } catch (e) { out.dy4k = 'err ' + String(e).slice(0, 120); }
  try {
    const ab = window.abTestData || {};
    out.abTest = {
      has2K: ab.has2K, abrConfigKeys: ab.abrConfig ? Object.keys(ab.abrConfig).slice(0, 12) : null,
      isOpenAutoDefi: ab.abrConfig && ab.abrConfig.isOpenAutoDefi,
      isPlayAutoDefi: ab.abrConfig && ab.abrConfig.isPlayAutoDefi,
      autoClarityReselect: ab.autoClarityReselect
    };
  } catch (e) { out.abTest = 'err'; }
  try {
    const v = [...document.querySelectorAll('video')].find((x) => !x.paused && x.videoWidth) || document.querySelector('video');
    out.video = v ? { w: v.videoWidth, h: v.videoHeight, src: (v.currentSrc || '').slice(0, 120) } : null;
  } catch (e) {}
  return out;
});

fs.writeFileSync(path.join(OUT, `play-${ts}.json`), JSON.stringify(result, null, 2), 'utf8');
await page.screenshot({ path: path.join(OUT, `play-${ts}.png`) });

log('==== summary ====');
const uniq = new Set(result.samples.map((x) => x.s && x.s.w + 'x' + x.s.h).filter(Boolean));
log('resolutions seen :', [...uniq].join(' , '));
const allGears = [...new Set(Object.values(result.gears).flatMap((g) => g.gears))];
log('gear_names server:', allGears.join(' , ') || '(none captured)');
const allSizes = [...new Set(Object.values(result.gears).flatMap((g) => g.sizes))];
log('sizes in payloads:', allSizes.slice(0, 25).join(' , ') || '(none)');
log('menu words       :', (result.menus.after || []).join(' | ') || '(none)');
log('media hosts      :', JSON.stringify(result.mediaHosts));
log('ab urls          :', result.ab.join(' , ') || '(none)');
log('saved            :', path.join(OUT, `play-${ts}.json`));
console.log(JSON.stringify({ ok: true, json: path.join(OUT, `play-${ts}.json`) }));
await ctx.close();
