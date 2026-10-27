#!/usr/bin/env node
/*
 * payload.js 的本地逻辑测试（不需要抖音、不需要浏览器）
 * 用最小 DOM 假环境跑 payload，验证：
 *   1. 启动时把 MANUAL_SWITCH 写成 4K
 *   2. 客户端把它改成 1080P / 删掉时，会被重新拉回 4K（含 removeItem 钩子同步补写）
 *   3. 客户端自己写入的结构会被当成模板复用（字段不丢）
 *   4. remember 模式下不强制，只还原
 *   5. setTarget / reset 生效
 *   6. 非抖音域不碰
 */
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = fs.readFileSync(path.join(HERE, 'payload.js'), 'utf8');

// 每个环境一套独立的 Storage 构造器（模拟真实页面：每个 realm 自己的 Storage.prototype，
// 否则 payload 打的补丁会跨环境串味，测出来的行为就不是浏览器里的行为）
function makeStorageClass() {
  return class FakeStorage {
    constructor() { this._m = new Map(); }
    getItem(k) { const s = String(k); return this._m.has(s) ? this._m.get(s) : null; }
    setItem(k, v) { this._m.set(String(k), String(v)); }
    removeItem(k) { this._m.delete(String(k)); }
    clear() { this._m.clear(); }
    key(i) { return [...this._m.keys()][i] ?? null; }
    get length() { return this._m.size; }
  };
}

function makeEnv(hostname = 'www.douyin.com') {
  const FakeStorage = makeStorageClass();
  const sessionStorage = new FakeStorage();
  const localStorage = new FakeStorage();
  const listeners = {};
  const timers = [];
  const timeouts = [];
  const win = {
    location: { hostname, href: `https://${hostname}/` },
    sessionStorage, localStorage,
    addEventListener: (t, f) => { (listeners[t] ||= []).push(f); },
    removeEventListener: () => {},
    Storage: FakeStorage,
    setInterval: (f) => { timers.push(f); return timers.length; },
    setTimeout: (f) => { timeouts.push(f); return timeouts.length; },
    clearTimeout: () => {},
    clearInterval: () => {},
    console: { log: () => {}, warn: () => {}, error: () => {} }
  };
  const document = { addEventListener: (t, f) => { (listeners[t] ||= []).push(f); } };
  const ctx = vm.createContext({ ...win, window: win, document, JSON, Date, String, Object, Array, Math, RegExp });
  ctx.globalThis = ctx;
  vm.runInContext(SRC, ctx, { filename: 'payload.js' });
  return {
    win, sessionStorage, localStorage, ctx, timers, timeouts,
    tickNow: () => timers.forEach(f => f()),
    runStartup: () => timeouts.forEach(f => f()),
    fire: t => (listeners[t] || []).forEach(f => f()),
    raw: () => sessionStorage.getItem('MANUAL_SWITCH')
  };
}
const parse = s => { try { return JSON.parse(s); } catch { return null; } };

let failed = 0;
function check(name, cond, extra) {
  if (cond) console.log('  ok   ' + name);
  else { failed++; console.log('  FAIL ' + name + (extra !== undefined ? '  -> ' + JSON.stringify(extra) : '')); }
}

console.log('\n[1] 启动即写 4K');
{
  const e = makeEnv();
  const v = parse(e.raw());
  check('MANUAL_SWITCH 存在', !!v, v);
  check('gearType = -2 (超清 4K)', v && v.gearType === -2, v);
  check('gearClarity = "20"', v && String(v.gearClarity) === '20', v);
  check('done = 1', v && v.done === 1, v);
  check('window.__DYPC4K__ 暴露', !!e.win.__DYPC4K__);
}

console.log('\n[2] 被改回 1080P / 被删除后自动拉回');
{
  const e = makeEnv();
  e.sessionStorage.setItem('MANUAL_SWITCH', JSON.stringify({ done: 1, gearType: 1, gearClarity: '5', gearName: '高清 1080P', qualityType: 1 }));
  e.tickNow();
  let v = parse(e.raw());
  check('1080P -> 4K', v && v.gearType === -2, v);

  // 模拟客户端根布局的 pC(MANUAL_SWITCH)：removeItem 后应被钩子当场补回
  e.sessionStorage.removeItem('MANUAL_SWITCH');
  v = parse(e.raw());
  check('removeItem 后同步补回 4K', v && v.gearType === -2, v);

  e.sessionStorage.removeItem('MANUAL_SWITCH');
  e.sessionStorage.removeItem('MANUAL_SWITCH');
  e.tickNow();
  v = parse(e.raw());
  check('反复删除仍为 4K', v && v.gearType === -2, v);
}

console.log('\n[3] 复用客户端写过的结构（额外字段不丢）');
{
  const e = makeEnv();
  const real = { done: 1, gearType: 1, gearClarity: '5', gearName: '高清 1080P', qualityType: 1, clarityReal: ['720', '1080'] };
  e.sessionStorage.setItem('MANUAL_SWITCH', JSON.stringify(real));   // 钩子会记录模板
  check('模板已记录', !!parse(e.localStorage.getItem('__DYPC4K_SHAPE__')));
  e.sessionStorage.removeItem('MANUAL_SWITCH');
  const v = parse(e.raw());
  check('clarityReal 保留', v && Array.isArray(v.clarityReal) && v.clarityReal.length === 2, v);
  check('gearType 覆盖为 4K', v && v.gearType === -2, v);
}

console.log('\n[4] remember 模式：不强制，只还原');
{
  const e = makeEnv();
  e.win.__DYPC4K__.setMode('remember');
  e.sessionStorage.setItem('MANUAL_SWITCH', JSON.stringify({ done: 1, gearType: 2, gearClarity: '4', gearName: '高清 720P', qualityType: 10 }));
  e.tickNow();
  const keep = parse(e.raw());
  check('用户选的 720P 不被覆盖', keep && keep.gearType === 2, keep);

  const e2 = makeEnv();
  e2.win.__DYPC4K__.setMode('remember');
  e2.localStorage.setItem('__DYPC4K_RAW__', JSON.stringify(keep));
  e2.sessionStorage.removeItem('MANUAL_SWITCH');
  e2.tickNow();
  const restored = parse(e2.raw());
  check('remember 模式跨启动还原', restored && restored.gearType === 2, restored);
}

console.log('\n[5] setTarget / reset');
{
  const e = makeEnv();
  e.win.__DYPC4K__.setTarget('4khdr');
  let v = parse(e.raw());
  check('切到 4K HDR (-3 / "30")', v && v.gearType === -3 && String(v.gearClarity) === '30', v);
  e.win.__DYPC4K__.setTarget('1080p');
  v = parse(e.raw());
  check('切到 1080P (1 / "5")', v && v.gearType === 1 && String(v.gearClarity) === '5', v);
  e.win.__DYPC4K__.reset();
  v = parse(e.raw());
  check('reset 回到默认 4K', v && v.gearType === -2, v);
  check('非法 target 被拒绝', typeof e.win.__DYPC4K__.setTarget('8k') === 'string');
}

console.log('\n[6] 非抖音域不碰');
{
  const e2 = makeEnv('example.com');
  check('example.com 不写 MANUAL_SWITCH', e2.raw() === null);
  check('example.com 不暴露 API', !e2.win.__DYPC4K__);
  const e3 = makeEnv('live.douyin.com');
  const v = parse(e3.raw());
  check('子域 live.douyin.com 生效', v && v.gearType === -2, v);
}

console.log(failed ? `\n${failed} 项失败` : '\n全部通过');
process.exit(failed ? 1 : 0);
