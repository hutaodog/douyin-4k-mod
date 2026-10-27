/**
 * K40 device console: drive the App's WebView over adb + CDP (Chrome DevTools Protocol).
 *
 * Requires: adb on PATH, App installed, and WebView.setWebContentsDebuggingEnabled(true) already on.
 *
 * Usage:
 *   node mobile-app/tools/device.mjs info
 *   node mobile-app/tools/device.mjs eval "dy4k.state()"
 *   node mobile-app/tools/device.mjs eval "document.title"
 *   node mobile-app/tools/device.mjs nav https://www.douyin.com/?recommend=1
 *   node mobile-app/tools/device.mjs shot mobile-app/shots/x.png
 *   node mobile-app/tools/device.mjs log dy4k
 *   node mobile-app/tools/device.mjs start
 *   node mobile-app/tools/device.mjs stop
 *
 * Env: ADB_SERIAL (default 7b0137b5), CDP_PORT (default 9222)
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const SERIAL = process.env.ADB_SERIAL || '7b0137b5';
const PKG = 'com.dypc4k.douyink4';
const PORT = Number(process.env.CDP_PORT || 9222);
const log = (...a) => console.log(...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function adb(args, opts = {}) {
  return execFileSync('adb', ['-s', SERIAL, ...args], {
    encoding: opts.binary ? 'buffer' : 'utf8',
    maxBuffer: 64 << 20
  });
}

function pidof() {
  try {
    return String(execFileSync('adb', ['-s', SERIAL, 'shell', 'pidof', PKG], { encoding: 'utf8' })).trim();
  } catch (e) {
    return ''; // pidof exits 1 when no such process
  }
}

async function startApp() {
  adb(['shell', 'am', 'start', '-n', `${PKG}/.MainActivity`]);
  for (let i = 0; i < 30; i++) {
    await sleep(500);
    const p = pidof();
    if (p) return p;
  }
  throw new Error('App did not start (check: adb logcat -s dy4k)');
}

async function ensureForward() {
  let pid = pidof();
  if (!pid) {
    log('[device] app not running, starting...');
    pid = await startApp();
  }
  try { adb(['forward', '--remove', 'tcp:' + PORT]); } catch (e) {}
  adb(['forward', 'tcp:' + PORT, 'localabstract:webview_devtools_remote_' + pid]);
  return pid;
}

async function listTargets() {
  const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
  return await r.json();
}

function pickPage(targets) {
  const pages = targets.filter((t) => t.type === 'page' && t.webSocketDebuggerUrl);
  if (!pages.length) throw new Error('no page target');
  return pages.find((p) => /douyin\.com/.test(p.url || '')) || pages[0];
}

async function connect() {
  const pid = await ensureForward();
  const targets = await listTargets();
  const page = pickPage(targets);
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', () => rej(new Error('ws connect failed')), { once: true });
  });
  let id = 0;
  const waiters = new Map();
  ws.addEventListener('message', (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch (e) { return; }
    if (msg.id && waiters.has(msg.id)) {
      waiters.get(msg.id)(msg);
      waiters.delete(msg.id);
    }
  });
  const send = (method, params = {}) => new Promise((res) => {
    const myId = ++id;
    waiters.set(myId, res);
    ws.send(JSON.stringify({ id: myId, method, params }));
  });
  return { ws, send, page, pid, targets };
}

async function evaluate(expression) {
  const { ws, send } = await connect();
  await send('Runtime.enable');
  const r = await send('Runtime.evaluate', {
    expression, awaitPromise: true, returnByValue: true, userGesture: true,
    allowUnsafeEvalBlockedByCSP: true
  });
  ws.close();
  if (r.result && r.result.exceptionDetails) {
    const d = r.result.exceptionDetails;
    return { ok: false, error: (d.text || 'exception') + ' ' + JSON.stringify(d.exception || {}).slice(0, 300) };
  }
  const res = r.result && r.result.result;
  return { ok: true, value: res && Object.prototype.hasOwnProperty.call(res, 'value') ? res.value : res };
}

const [cmd, ...rest] = process.argv.slice(2);
try {
  if (cmd === 'start') {
    log('pid', await startApp());
  } else if (cmd === 'stop') {
    adb(['shell', 'am', 'force-stop', PKG]);
    log('stopped');
  } else if (cmd === 'info') {
    log('serial  :', SERIAL);
    log('model   :', String(adb(['shell', 'getprop', 'ro.product.model'])).trim(),
        '| android', String(adb(['shell', 'getprop', 'ro.build.version.release'])).trim(),
        '| sdk', String(adb(['shell', 'getprop', 'ro.build.version.sdk'])).trim());
    log('app pid :', pidof() || '(not running)');
    log('webview :', String(adb(['shell', 'dumpsys', 'webviewupdate'])).split('\n')
      .find((l) => /Current WebView package/.test(l))?.trim() || '?');
    await ensureForward();
    const t = await listTargets();
    log('targets :', t.length, t.map((x) => `${x.type}:${(x.url || '').slice(0, 70)}`).join(' | '));
  } else if (cmd === 'eval') {
    let expr = rest.join(' ');
    if (expr.startsWith('@')) {           // @file.js : read expression from file
      expr = fs.readFileSync(expr.slice(1), 'utf8');
    }
    const r = await evaluate(expr);
    if (!r.ok) { log('ERROR', r.error); process.exit(2); }
    log(typeof r.value === 'string' ? r.value : JSON.stringify(r.value, null, 0));
  } else if (cmd === 'nav') {
    const url = rest[0];
    const r = await evaluate(`location.href = ${JSON.stringify(url)}; location.href`);
    log('nav ->', url, r.ok ? '' : r.error);
  } else if (cmd === 'shot') {
    const out = rest[0] || path.join('mobile-app', 'shots', `dev-${Date.now()}.png`);
    fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
    const buf = adb(['exec-out', 'screencap', '-p'], { binary: true });
    fs.writeFileSync(path.resolve(out), buf);
    log('saved', out, buf.length, 'bytes');
  } else if (cmd === 'log') {
    const filter = rest[0] || 'dy4k';
    log(String(adb(['logcat', '-d', '-s', `${filter}:I`])).split('\n').slice(-60).join('\n'));
  } else if (cmd === 'cookies') {
    // 把 App 里（已登录）的 cookie 导出来，给 PC 侧的接口抓取复用登录态
    const { ws, send } = await connect();
    await send('Network.enable');
    const r = await send('Network.getAllCookies');
    ws.close();
    const cookies = (r.result && r.result.cookies) || [];
    const keep = cookies.filter((c) => /douyin\.com$/.test(String(c.domain).replace(/^\./, '')) || /douyin/.test(c.domain));
    const out = rest[0] || path.join('mobile-app', 'shots', 'cookies.json');
    fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
    fs.writeFileSync(path.resolve(out), JSON.stringify(keep.map((c) => ({
      name: c.name, value: c.value, domain: c.domain, path: c.path,
      expires: c.expires, httpOnly: c.httpOnly, secure: c.secure, sameSite: c.sameSite
    })), null, 1), 'utf8');
    log('cookies:', keep.length, '->', out);
    log('names  :', keep.map((c) => c.name).slice(0, 30).join(', '));
  } else {
    log('usage: device.mjs <info|eval|nav|shot|log|start|stop> [args]');
    process.exit(1);
  }
} catch (e) {
  log('FAILED:', String((e && e.message) || e).slice(0, 500));
  process.exit(1);
}
