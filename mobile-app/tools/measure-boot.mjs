/**
 * 冷启动计时：从 am start 到「切到推荐页」再到「首个视频出画」各要多久。
 * 用法：node mobile-app/tools/measure-boot.mjs
 */
import { execFileSync } from 'node:child_process';
import process from 'node:process';

const SERIAL = process.env.ADB_SERIAL || '7b0137b5';
const PKG = 'com.dypc4k.douyink4';
const PORT = Number(process.env.CDP_PORT || 9224);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const adb = (a) => execFileSync('adb', ['-s', SERIAL, ...a], { encoding: 'utf8', maxBuffer: 1 << 24 });
const log = (...m) => console.log(...m);

async function tryConnect() {
  let pid = '';
  try { pid = String(adb(['shell', 'pidof', PKG])).trim(); } catch (e) { return null; }
  if (!pid) return null;
  try {
    adb(['forward', '--remove', 'tcp:' + PORT]);
  } catch (e) {}
  adb(['forward', 'tcp:' + PORT, 'localabstract:webview_devtools_remote_' + pid]);
  let list;
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
    list = await r.json();
  } catch (e) { return null; }
  const page = list.find((t) => t.type === 'page' && /douyin/.test(t.url || '')) || list.find((t) => t.type === 'page');
  if (!page) return null;
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', () => rej(new Error('ws')), { once: true });
  });
  let id = 0;
  const waiters = new Map();
  ws.addEventListener('message', (ev) => {
    let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
    if (m.id && waiters.has(m.id)) { waiters.get(m.id)(m); waiters.delete(m.id); }
  });
  const send = (method, params = {}) => new Promise((res) => {
    const myId = ++id;
    waiters.set(myId, res);
    ws.send(JSON.stringify({ id: myId, method, params }));
  });
  return { ws, send };
}

const expr = `JSON.stringify({
  url: location.href,
  recommend: /recommend/.test(location.search),
  playing: [].slice.call(document.querySelectorAll('video')).some(function(v){return v.videoWidth>0;}),
  vids: [].slice.call(document.querySelectorAll('video')).map(function(v){return v.videoWidth+'x'+v.videoHeight;})
})`;

// 清 logcat 后启动，t0 记在启动前
try { adb(['logcat', '-c']); } catch (e) {}
const t0 = Date.now();
adb(['shell', 'am', 'force-stop', PKG]);
adb(['shell', 'am', 'start', '-n', `${PKG}/.MainActivity`]);
log('app start issued, measuring…');

let conn = null;
let tFeed = 0, tPlay = 0, last = '';
for (let i = 0; i < 400; i++) {
  if (!conn) {
    conn = await tryConnect();
    if (!conn) { await sleep(250); continue; }
  }
  let r = null;
  try {
    const m = await conn.send('Runtime.evaluate', { expression: expr, returnByValue: true });
    r = JSON.parse(m.result.result.value);
  } catch (e) {
    conn = null;
    await sleep(250);
    continue;
  }
  const ms = Date.now() - t0;
  if (r.recommend && !tFeed) { tFeed = ms; log(`  +${ms}ms  已到推荐页`); }
  if (r.playing && !tPlay) {
    tPlay = ms;
    log(`  +${ms}ms  首个视频出画  ${r.vids.join(' , ')}`);
    break;
  }
  if (r.url !== last) { last = r.url; log(`  +${ms}ms  url=${r.url.slice(0, 80)}`); }
  await sleep(150);
}

log('');
log('结果：');
log('  切到推荐页 :', tFeed ? tFeed + ' ms' : '未测到');
log('  首个视频出画:', tPlay ? tPlay + ' ms' : '未测到（超时）');
try { conn && conn.ws.close(); } catch (e) {}
