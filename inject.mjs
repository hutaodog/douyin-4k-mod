#!/usr/bin/env node
/*
 * dypc4k injector —— 通过 Chrome DevTools Protocol 给抖音 PC 客户端注入 payload.js
 *
 * 不需要改客户端任何文件。前提：抖音是用 --remote-debugging-port=<port> 启动的
 * （配套的「启动-4K抖音.cmd」已经这样做）。
 *
 * 用法：
 *   node inject.mjs --port 92258                 # 常驻：给所有新页面/新窗口注入
 *   node inject.mjs --port 92258 --verify        # 只连上去打印当前 sessionStorage
 *
 * 依赖：Node.js >= 22（自带全局 fetch / WebSocket），无第三方包。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PAYLOAD = fs.readFileSync(path.join(HERE, 'payload.js'), 'utf8');

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  if (i < 0) return def;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
}
const PORT = Number(arg('port', 92258));
const VERIFY = !!arg('verify', false);
const QUIET = !!arg('quiet', false);

const log = (...a) => { if (!QUIET) console.log(new Date().toLocaleTimeString(), ...a); };

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function endpoint() {
  const url = `http://127.0.0.1:${PORT}/json/version`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.handlers = new Map();
    ws.addEventListener('message', ev => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
        return;
      }
      if (msg.method) {
        const list = this.handlers.get(msg.method) || [];
        for (const h of list) { try { h(msg.params, msg.sessionId); } catch (e) { log('handler error', msg.method, e.message); } }
        const all = this.handlers.get('*') || [];
        for (const h of all) { try { h(msg); } catch {} }
      }
    });
  }
  static async connect(wsUrl) {
    const ws = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('WebSocket connect timeout')), 8000);
      ws.addEventListener('open', () => { clearTimeout(t); resolve(); }, { once: true });
      ws.addEventListener('error', e => { clearTimeout(t); reject(new Error('WebSocket error: ' + (e.message || 'unknown'))); }, { once: true });
    });
    return new CDP(ws);
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    const msg = { id, method, params };
    if (sessionId) msg.sessionId = sessionId;
    this.ws.send(JSON.stringify(msg));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); reject(new Error(`timeout: ${method}`)); }
      }, 15000);
    });
  }
  on(method, fn) {
    if (!this.handlers.has(method)) this.handlers.set(method, []);
    this.handlers.get(method).push(fn);
  }
  close() { try { this.ws.close(); } catch {} }
}

const injected = new Set();

async function install(cdp, sessionId, targetInfo) {
  const key = sessionId;
  if (injected.has(key)) return;
  injected.add(key);
  try {
    await cdp.send('Page.enable', {}, sessionId).catch(() => {});
    await cdp.send('Page.addScriptToEvaluateOnNewDocument',
      { source: PAYLOAD, runImmediately: true }, sessionId).catch(() => {});
    // 已经加载过的页面：立刻补一次
    await cdp.send('Runtime.evaluate',
      { expression: PAYLOAD, awaitPromise: false, includeCommandLineAPI: false }, sessionId).catch(() => {});
    log('inject ->', (targetInfo && (targetInfo.url || targetInfo.type)) || sessionId);
  } catch (e) {
    log('inject failed:', e.message);
  } finally {
    // 若目标停在 debugger 上，必须放行，否则页面不会继续加载
    await cdp.send('Runtime.runIfWaitingForDebugger', {}, sessionId).catch(() => {});
  }
}

async function verify(cdp) {
  const list = await fetch(`http://127.0.0.1:${PORT}/json/list`).then(r => r.json()).catch(() => []);
  for (const t of list) {
    if (t.type !== 'page') continue;
    log('page:', t.url);
  }
}

async function main() {
  if (VERIFY) {
    const info = await endpoint();
    log('browser:', info.Browser);
    const cdp = await CDP.connect(info.webSocketDebuggerUrl);
    const list = await fetch(`http://127.0.0.1:${PORT}/json/list`).then(r => r.json()).catch(() => []);
    for (const t of list) {
      if (t.type !== 'page' || !/douyin\.com/.test(t.url)) continue;
      const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: t.id, flatten: true });
      const r = await cdp.send('Runtime.evaluate', {
        expression: `JSON.stringify({url:location.href, manualSwitch: sessionStorage.getItem('MANUAL_SWITCH'), hasHook: !!window.__DYPC4K__})`,
        returnByValue: true
      }, sessionId).catch(e => ({ result: { value: 'eval failed: ' + e.message } }));
      console.log('\n=== ' + t.url);
      console.log(r.result && r.result.value);
      await cdp.send('Target.detachFromTarget', { sessionId }).catch(() => {});
    }
    cdp.close();
    return;
  }

  const info = await endpoint();
  log('connected to', info.Browser, 'at port', PORT);
  const cdp = await CDP.connect(info.webSocketDebuggerUrl);

  cdp.on('Target.attachedToTarget', async ({ sessionId, targetInfo }) => {
    if (!['page', 'iframe', 'webview'].includes(targetInfo.type)) {
      await cdp.send('Runtime.runIfWaitingForDebugger', {}, sessionId).catch(() => {});
      return;
    }
    await install(cdp, sessionId, targetInfo);
  });
  cdp.on('Target.detachedFromTarget', ({ sessionId }) => injected.delete(sessionId));

  // 已有的窗口先接上
  const list = await fetch(`http://127.0.0.1:${PORT}/json/list`).then(r => r.json()).catch(() => []);
  for (const t of list) {
    if (!['page', 'webview'].includes(t.type)) continue;
    try {
      const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: t.id, flatten: true });
      await install(cdp, sessionId, t);
    } catch (e) { log('attach failed:', t.url, e.message); }
  }

  // 之后所有新目标自动接管
  await cdp.send('Target.setDiscoverTargets', { discover: true }).catch(() => {});
  await cdp.send('Target.setAutoAttach', {
    autoAttach: true, waitForDebuggerOnStart: true, flatten: true,
    filter: [{ type: 'page' }, { type: 'iframe' }, { type: 'webview' }]
  }).catch(e => log('setAutoAttach failed:', e.message));

  log('watching for new windows… (Ctrl+C to stop)');
  await new Promise(resolve => {
    cdp.ws.addEventListener('close', resolve);
    process.on('SIGINT', () => { cdp.close(); resolve(); });
  });
  log('browser connection closed, injector exits');
}

main().catch(async e => {
  if (/ECONNREFUSED|fetch failed|HTTP 4|HTTP 5/.test(String(e.message))) {
    console.error(`\n[!] 连不上 127.0.0.1:${PORT}。`);
    console.error('    抖音必须带 --remote-debugging-port=' + PORT + ' 启动。请先用「启动-4K抖音.cmd」，');
    console.error('    或者确认 8.7.0 客户端没有在运行（单实例：旧进程会让新参数失效）。');
  } else {
    console.error('[!] ' + e.message);
  }
  process.exit(1);
});
