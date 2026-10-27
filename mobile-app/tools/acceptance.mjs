/**
 * K40 真机验收：一条命令跑完「打开视频 → 抓 4K 直链 → 拉起原生播放器 → 读实际解码分辨率」。
 *
 * 依赖：adb（设备已连、App 已装）、App 里 WebView 调试已开启。
 * 用法：
 *   node mobile-app/tools/acceptance.mjs
 *   node mobile-app/tools/acceptance.mjs --videos 7689731341721564658,7697934740980125171
 *   node mobile-app/tools/acceptance.mjs --seconds 12
 *
 * 输出：每个视频一行，含 网页分辨率 / 是否抓到 4K 直链 / 原生播放器实际解码分辨率。
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const SERIAL = process.env.ADB_SERIAL || '7b0137b5';
const PKG = 'com.dypc4k.douyink4';
const PORT = Number(process.env.CDP_PORT || 9223);

const DEFAULT_VIDEOS = [
  '7689731341721564658', // 竖屏 4K 2160x3840
  '7697934740980125171', // 横屏 4K 3840x2160
  '7686426147004976393', // 横屏 4K 3840x2160
  '7697812200731266358', // 片源最高 1440p，用来看降级是否正常
  '7698098558267919667', // 页面只给到 1080p
  '7697180425155808527'  // 1080p
];

const args = process.argv.slice(2);
function arg(name, def) {
  const i = args.indexOf('--' + name);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
}
const VIDEOS = String(arg('videos', DEFAULT_VIDEOS.join(','))).split(',').map((s) => s.trim()).filter(Boolean);
const WAIT_SEC = Number(arg('seconds', 9));
const SHOT = !!args.includes('--shot');

const adb = (a, opts = {}) => execFileSync('adb', ['-s', SERIAL, ...a], { encoding: opts.binary ? 'buffer' : 'utf8', maxBuffer: 64 << 20 });
const log = (...m) => console.log(...m);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------- CDP ----------------
let ws, msgId = 0;
const waiters = new Map();

async function cdpConnect() {
  const pid = String(adb(['shell', 'pidof', PKG])).trim();
  if (!pid) throw new Error('App 没在跑');
  try { adb(['forward', '--remove', 'tcp:' + PORT]); } catch (e) {}
  adb(['forward', 'tcp:' + PORT, 'localabstract:webview_devtools_remote_' + pid]);
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const page = list.find((t) => t.type === 'page' && /douyin\.com/.test(t.url || '')) || list.find((t) => t.type === 'page');
  if (!page) throw new Error('没有 page target');
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', () => rej(new Error('ws error')), { once: true });
  });
  ws.addEventListener('message', (ev) => {
    let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
    if (m.id && waiters.has(m.id)) { waiters.get(m.id)(m); waiters.delete(m.id); }
  });
  await send('Runtime.enable');
  return page.url;
}

function send(method, params = {}) {
  return new Promise((res) => {
    const id = ++msgId;
    waiters.set(id, res);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function evaluate(expression) {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
  if (r.result && r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.text || 'eval error');
  const v = r.result && r.result.result;
  return v && Object.prototype.hasOwnProperty.call(v, 'value') ? v.value : v;
}

// ---------------- 步骤 ----------------
function logcatTail(n = 200) {
  try { return String(adb(['logcat', '-d', '-s', 'dy4k:I', '-t', String(n)])); } catch (e) { return ''; }
}

function clearLogcat() { try { adb(['logcat', '-c']); } catch (e) {} }

async function gotoVideo(id) {
  await evaluate(`location.href = ${JSON.stringify('https://www.douyin.com/video/' + id)}; 1`);
  // 等页面把 aweme detail 拉回来（我们的 sniff 会存进 GEARS）
  for (let i = 0; i < WAIT_SEC * 2; i++) {
    await sleep(500);
    try {
      const g = await evaluate('JSON.stringify(dy4k.gears())');
      const o = JSON.parse(g);
      if (o && o.best) return o;
    } catch (e) { /* 页面可能正在跳转 */ }
  }
  try { return JSON.parse(await evaluate('JSON.stringify(dy4k.gears())')); } catch (e) { return null; }
}

async function runOne(id) {
  const row = { id, web: '', best: '', native: '', note: '' };
  clearLogcat();
  const g = await gotoVideo(id);
  if (!g || !g.best) { row.note = '没抓到码流'; return row; }

  row.best = `${g.best.w}x${g.best.h} ${g.best.kbps}kbps ${g.best.h265 ? 'HEVC' : 'H264'} ${g.best.gear}`;
  try {
    // 网页侧：HUD 第一行（分辨率 + 档位）+ hevc 能力，用来对比"网页只能 1080P"
    row.web = await evaluate(`(function(){
      var h = document.getElementById('dy4k-hud');
      var t = h ? h.textContent.replace(/\\n/g, ' ') : 'no hud';
      var v = [].slice.call(document.querySelectorAll('video')).find(function(x){return x.videoWidth});
      return (v ? v.videoWidth + 'x' + v.videoHeight : 'no-video') + ' | ' + t;
    })()`);
  } catch (e) { row.web = '?'; }

  // 点页面上的「原生 xx」按钮
  let clicked = false;
  for (let i = 0; i < 8 && !clicked; i++) {
    try {
      clicked = !!(await evaluate(`(function(){var b=document.getElementById('dy4k-native-btn');if(!b||b.style.display==='none')return false;b.click();return true;})()`));
    } catch (e) {}
    if (!clicked) await sleep(500);
  }
  if (!clicked) { row.note = '按钮没出现'; return row; }

  // 等原生播放器报出真实解码尺寸
  let size = '';
  for (let i = 0; i < 16; i++) {
    await sleep(500);
    const lg = logcatTail(400);
    const m = [...lg.matchAll(/video size -> (\d+)x(\d+)/g)];
    if (m.length) size = m[m.length - 1][1] + 'x' + m[m.length - 1][2];
    const err = /media error what=(\d+)/.exec(lg);
    if (err) { row.note = 'ERROR what=' + err[1]; break; }
    if (size) break;
  }
  row.native = size || '(未起播)';

  if (SHOT) {
    const dir = path.resolve('mobile-app/shots');
    fs.mkdirSync(dir, { recursive: true });
    const buf = adb(['exec-out', 'screencap', '-p'], { binary: true });
    fs.writeFileSync(path.join(dir, `acc-${id}.png`), buf);
  }

  // 退回网页
  try { adb(['shell', 'input', 'keyevent', 'KEYCODE_BACK']); } catch (e) {}
  await sleep(1200);
  return row;
}

// ---------------- main ----------------
log('serial :', SERIAL);
log('app    :', String(adb(['shell', 'dumpsys', 'package', PKG])).split('\n').find((l) => /versionName/.test(l))?.trim() || '?');
log('webview:', String(adb(['shell', 'dumpsys', 'webviewupdate'])).split('\n').find((l) => /Current WebView package/.test(l))?.trim() || '?');

clearLogcat();
adb(['shell', 'am', 'force-stop', PKG]);
adb(['shell', 'am', 'start', '-n', `${PKG}/.MainActivity`]);
await sleep(8000);
await cdpConnect();

const rows = [];
for (const id of VIDEOS) {
  log('\n--- ' + id + ' ---');
  try {
    const r = await runOne(id);
    rows.push(r);
    log('  web   :', r.web);
    log('  best  :', r.best);
    log('  native:', r.native, r.note ? '(' + r.note + ')' : '');
  } catch (e) {
    rows.push({ id, web: '', best: '', native: '', note: 'FAILED ' + String(e).slice(0, 120) });
    log('  FAILED:', String(e).slice(0, 200));
  }
}

log('\n================ 汇总 ================');
log('视频ID'.padEnd(22) + '网页播放'.padEnd(12) + '最佳码流'.padEnd(40) + '原生解码');
for (const r of rows) {
  log(String(r.id).padEnd(22) + String(r.web).padEnd(12) + String(r.best).padEnd(40) + String(r.native) + (r.note ? '  ' + r.note : ''));
}
const ok4k = rows.filter((r) => {
  const m = /^(\d+)x(\d+)$/.exec(r.native);
  if (!m) return false;
  const [w, h] = [Number(m[1]), Number(m[2])];
  return Math.min(w, h) >= 2000;      // 真 4K：短边 >= 2000（2160x3840 / 3840x2160 都算）
});
log('');
log(`4K 成功：${ok4k.length}/${rows.length}`);
fs.writeFileSync(path.resolve('mobile-app/shots/acceptance.json'), JSON.stringify({ at: new Date().toISOString(), rows }, null, 2), 'utf8');
log('saved: mobile-app/shots/acceptance.json');
try { ws.close(); } catch (e) {}
process.exit(ok4k.length > 0 ? 0 : 1);
