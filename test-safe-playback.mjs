#!/usr/bin/env node
/*
 * Safe-playback acceptance test for the actual serialized LOCK_FN in
 * preload-snippet.js.
 *
 * This file intentionally does not import or rewrite production code.  It
 * extracts only `var LOCK_FN = function (CFG) { ... }`, obtains the function's
 * own toString(), and executes that serialized function in a fresh browser-like
 * VM realm.  The mocks are deliberately hostile to playback mutation: every
 * media setter/action and player changeDefinition call is recorded.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath, URL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SOURCE_PATH = path.join(HERE, 'preload-snippet.js');
const SOURCE = fs.readFileSync(SOURCE_PATH, 'utf8');

const failures = [];
const ok = (name) => console.log(`  ok   ${name}`);
function show(value) {
  try {
    if (typeof value === 'string') return value;
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
function check(name, condition, details) {
  if (condition) ok(name);
  else {
    const suffix = details === undefined ? '' : ` -> ${show(details)}`;
    failures.push(`${name}${suffix}`);
    console.log(`  FAIL ${name}${suffix}`);
  }
}
function checkEqual(name, actual, expected) {
  try {
    assert.deepStrictEqual(actual, expected);
    ok(name);
  } catch (error) {
    failures.push(`${name} -> expected ${show(expected)}, got ${show(actual)}`);
    console.log(`  FAIL ${name} -> expected ${show(expected)}, got ${show(actual)}`);
  }
}
function expectNoThrow(name, fn) {
  try {
    const result = fn();
    ok(name);
    return result;
  } catch (error) {
    failures.push(`${name} -> ${error && error.stack ? error.stack : error}`);
    console.log(`  FAIL ${name} -> ${error && error.message ? error.message : error}`);
    return undefined;
  }
}
async function expectNoReject(name, fn) {
  try {
    const result = await fn();
    ok(name);
    return result;
  } catch (error) {
    failures.push(`${name} -> ${error && error.stack ? error.stack : error}`);
    console.log(`  FAIL ${name} -> ${error && error.message ? error.message : error}`);
    return undefined;
  }
}
async function expectReject(name, fn, expectedError) {
  try {
    await fn();
    failures.push(`${name} -> expected rejection`);
    console.log(`  FAIL ${name} -> expected rejection`);
    return undefined;
  } catch (error) {
    check(name, expectedError === undefined || error === expectedError, error);
    return error;
  }
}

function scanFunctionEnd(source, functionStart) {
  // Use the actual serialization boundary; a hand-written JS lexer cannot
  // safely distinguish comments from regex literals such as /...\//i.
  const boundary = /^    \};\r?\n\r?\n    try \{\r?\n      var electron = require\('electron'\);/m;
  const match = boundary.exec(source.slice(functionStart));
  if (!match) throw new Error('LOCK_FN serialization boundary not found');
  return functionStart + match.index + match[0].indexOf('}');
}

function extractSerializedLock(source) {
  const marker = 'var LOCK_FN = function (CFG)';
  const declaration = source.indexOf(marker);
  if (declaration < 0) throw new Error(`missing ${marker}`);
  const functionStart = source.indexOf('function (CFG)', declaration);
  const end = scanFunctionEnd(source, functionStart);
  const expression = source.slice(functionStart, end + 1);
  const extracted = vm.runInNewContext(`(${expression})`, {}, { filename: 'extracted-LOCK_FN.js' });
  if (typeof extracted !== 'function') throw new Error('extracted LOCK_FN is not a function');
  const serialized = extracted.toString();
  // Parse the exact serialization again.  The test target is this second
  // function, matching preload's LOCK_FN.toString() injection path.
  vm.runInNewContext(`(${serialized})`, {}, { filename: 'serialized-LOCK_FN.js' });
  return { serialized, start: declaration, end };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function flushMicrotasks() {
  return new Promise((resolve) => queueMicrotask(resolve));
}
async function flushAsync() {
  await flushMicrotasks();
  await flushMicrotasks();
  await new Promise((resolve) => setImmediate(resolve));
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function makeMedia(name, { visible, width, height, paused, currentTime, srcObject } = {}) {
  const calls = [];
  const attrs = { src: `blob:${name}` };
  const listeners = new Map();
  let src = attrs.src;
  let sourceObject = srcObject === undefined ? { stream: `${name}-live` } : srcObject;
  let time = currentTime === undefined ? 17.25 : currentTime;
  const media = {
    name,
    calls,
    _listeners: listeners,
    videoWidth: width === undefined ? 720 : width,
    videoHeight: height === undefined ? 1280 : height,
    paused: paused === undefined ? false : paused,
    ended: false,
    readyState: 4,
    duration: 180,
    get currentSrc() { return src; },
    get src() { return src; },
    set src(value) { calls.push(['src', value]); src = String(value); },
    get srcObject() { return sourceObject; },
    set srcObject(value) { calls.push(['srcObject', value]); sourceObject = value; },
    get currentTime() { return time; },
    set currentTime(value) { calls.push(['seek', value]); time = Number(value); },
    getAttribute(key) {
      return key === 'src' ? (attrs.src || '') : (attrs[key] || '');
    },
    setAttribute(key, value) {
      calls.push([`setAttribute:${key}`, value]);
      attrs[key] = String(value);
      if (key === 'src') src = String(value);
    },
    removeAttribute(key) {
      calls.push([`removeAttribute:${key}`]);
      delete attrs[key];
      if (key === 'src') src = '';
    },
    querySelectorAll(selector) {
      if (selector === 'source') return [];
      return [];
    },
    appendChild(child) {
      calls.push(['appendChild', child]);
      return child;
    },
    removeChild(child) {
      calls.push(['removeChild', child]);
      return child;
    },
    get firstChild() { return null; },
    addEventListener(type, fn) {
      const list = listeners.get(type) || [];
      list.push(fn);
      listeners.set(type, list);
    },
    removeEventListener(type, fn) {
      const list = listeners.get(type) || [];
      listeners.set(type, list.filter((item) => item !== fn));
    },
    dispatchEvent(event) {
      const list = (listeners.get(event.type) || []).slice();
      for (const fn of list) fn.call(media, event);
      return true;
    },
    load() {
      calls.push(['load']);
    },
    pause() {
      calls.push(['pause']);
      media.paused = true;
    },
    play() {
      calls.push(['play']);
      media.paused = false;
      return Promise.resolve();
    },
    getVideoPlaybackQuality() {
      return { totalVideoFrames: 100, droppedVideoFrames: 0 };
    },
    getBoundingClientRect() {
      return visible
        ? { left: 80, top: 50, width: 800, height: 450, right: 880, bottom: 500 }
        : { left: -1600, top: -900, width: 320, height: 180, right: -1280, bottom: -720 };
    },
    buffered: { length: 1, start: () => 0, end: () => time + 12 },
    parentElement: null,
    tagName: 'VIDEO',
    className: visible ? 'main-video' : 'offscreen-video'
  };
  return media;
}

function makePlayer(id, media, { playing = true, uri = `${id}-720`, definition = 2 } = {}) {
  const entry = {
    definition,
    gearName: definition === 2 ? '高清 720P' : '超清 4K',
    uri,
    vid: uri,
    url: [{ src: `https://cdn.example/${uri}.mp4` }],
    width: definition === 2 ? 1280 : 3840,
    height: definition === 2 ? 720 : 2160,
    bitrate: definition === 2 ? 900000 : 9000000,
    mediaType: 'video',
    isH265: false
  };
  const list = [entry];
  let changeDefinitionCalls = 0;
  let emitCalls = 0;
  const player = {
    id,
    isPlaying: playing,
    video: media,
    media,
    config: {
      needAutoBitrate: true,
      autoBitrateOpts: { isPlayAutoDefi: true, isOpenAutoDefi: true },
      awemeInfo: { aweme_id: `${id}-aid` },
      uri,
      codecType: 'h264',
      initCodecType: 'h264',
      userSelectDefinition: definition,
      definition: { list }
    },
    curDefinition: entry,
    plugins: {},
    get changeDefinitionCalls() { return changeDefinitionCalls; },
    get emitCalls() { return emitCalls; },
    changeDefinition() { changeDefinitionCalls++; },
    emit() { emitCalls++; },
    getPlugin() { return null; },
    root: { contains(value) { return value === media; } }
  };
  return player;
}

class FakeXHR {
  constructor() {
    this._listeners = new Map();
    this._url = '';
    this._body = '';
    this._jsonValue = undefined;
    this._jsonSet = false;
    this._reads = { responseText: 0, response: 0 };
    this.readyState = 0;
    this.responseType = '';
    this.status = 200;
  }
  open(method, url) {
    this.method = method;
    this._url = String(url || '');
    this.readyState = 1;
    return 'native-open-result';
  }
  send() {
    this.readyState = 2;
    return 'native-send-result';
  }
  abort() {
    this.aborted = true;
    this.readyState = 0;
    this.dispatch('abort');
  }
  addEventListener(type, fn, options) {
    const list = this._listeners.get(type) || [];
    list.push({ fn, once: !!(options && options.once) });
    this._listeners.set(type, list);
  }
  removeEventListener(type, fn) {
    const list = this._listeners.get(type) || [];
    this._listeners.set(type, list.filter((item) => item.fn !== fn));
  }
  dispatch(type) {
    const list = (this._listeners.get(type) || []).slice();
    for (const item of list) {
      if (item.once) this.removeEventListener(type, item.fn);
      item.fn.call(this, { type, target: this });
    }
  }
}
Object.defineProperty(FakeXHR.prototype, 'responseText', {
  configurable: true,
  enumerable: true,
  get() {
    this._reads.responseText++;
    if (this.responseType && this.responseType !== 'text') return '';
    return this._body;
  }
});
Object.defineProperty(FakeXHR.prototype, 'response', {
  configurable: true,
  enumerable: true,
  get() {
    this._reads.response++;
    return this._jsonSet ? this._jsonValue : this._body;
  }
});

function makeResponse(body, mode = 'pending') {
  const cloneDeferred = deferred();
  const response = {
    status: 200,
    statusText: 'OK',
    url: '/aweme/v1/web/feed/',
    headers: { get: () => 'application/json' },
    clone() {
      response.cloneCalls++;
      if (mode === 'throw-clone') throw new Error('clone failed by test');
      if (mode === 'reject-clone-text') {
        return { text: () => Promise.reject(new Error('clone text failed by test')) };
      }
      return {
        text: () => {
          response.cloneTextStarted = true;
          if (mode === 'resolved') return Promise.resolve(body);
          return cloneDeferred.promise;
        }
      };
    },
    text: () => {
      response.originalTextReads = (response.originalTextReads || 0) + 1;
      return Promise.resolve(body);
    },
    cloneTextStarted: false,
    cloneCalls: 0,
    cloneDeferred
  };
  return response;
}

function makeQualityResponse(body, { readError, cloneError } = {}) {
  // Only model caller-owned body reads and clone state; no Response dependency.
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  const response = {
    status: 200,
    statusText: 'OK',
    url: 'https://www.douyin.com/service/2/abtest_config/',
    headers: { get: () => 'application/json' },
    bodyUsed: false,
    reads: { text: 0, json: 0, clone: 0 },
    clones: [],
    text() {
      response.reads.text++;
      response.bodyUsed = true;
      return readError ? Promise.reject(readError) : Promise.resolve(text);
    },
    json() {
      response.reads.json++;
      response.bodyUsed = true;
      return readError ? Promise.reject(readError) : Promise.resolve().then(() => JSON.parse(text));
    },
    clone() {
      response.reads.clone++;
      if (cloneError) throw cloneError;
      const copy = makeQualityResponse(text, { readError, cloneError });
      response.clones.push(copy);
      return copy;
    }
  };
  return response;
}

function makeQualityPayload() {
  return {
    status_code: 0,
    data: {
      auto_clarity_reselect: { val: 1, vid: 'experiment-auto', extra: { keep: true } },
      switch_clarity_timing: { val: '2', vid: 17 },
      smooth_switch_clarity: { val: true, vid: 'experiment-smooth' },
      scalar: { auto_clarity_reselect: 1, switch_clarity_timing: '3', smooth_switch_clarity: true },
      unchanged: { auto_clarity_reselect: 0, switch_clarity_timing: '0', smooth_switch_clarity: false },
      unknown: {
        auto_clarity_reselect: { value: 1, vid: 'unknown-schema' },
        switch_clarity_timing: { val: { enabled: true }, vid: 'nested-val' },
        smooth_switch_clarity: { val: 'server-choice', vid: 'text-val' }
      },
      nulls: { auto_clarity_reselect: null, switch_clarity_timing: [], smooth_switch_clarity: { val: null, vid: 9 } },
      use_h266_client: { val: 1, vid: 'vvc-experiment' },
      fix_h266_list: 1,
      codecType: 'h265',
      initCodecType: 'h266',
      degradeBitrateFactors: [0.9, 0.75],
      abr_config: {
        maxDownSwitchLevel: 3,
        rebufferDegrade: true,
        safeRebufferDegrade: { val: 2, vid: 'rebuffer' },
        unknown: { keep: 'native' }
      },
      needAutoBitrate: true,
      autoBitrateOpts: { isPlayAutoDefi: true, isOpenAutoDefi: true },
      unknown_field: { enabled: true, sequence: [1, 2, 3] }
    }
  };
}

function expectedQualityPayload() {
  const expected = makeQualityPayload();
  for (const key of ['auto_clarity_reselect', 'switch_clarity_timing', 'smooth_switch_clarity']) {
    expected.data[key].val = 0;
    expected.data.scalar[key] = 0;
  }
  return expected;
}

function makeHevcAweme(aid = '7491234567890123456') {
  const uri = `same-video-${aid}`;
  const row = (codec, short, label) => ({
    is_h265: codec,
    bit_rate: short * 4000,
    gear_name: label,
    quality_type: 1,
    format: 'mp4',
    FPS: 30,
    HDR_type: 0,
    HDR_bit: 0,
    extra: { preserve: label },
    play_addr: {
      uri, width: short * 16 / 9, height: short, data_size: short * 1000,
      url_list: [`https://cdn.example/${aid}/${label}.mp4`, `https://backup.example/${aid}/${label}.mp4`],
      url_key: `${label}-key`
    }
  });
  return {
    aweme_id: aid,
    aweme_type: 0,
    author: { uid: 'native-author' },
    video: {
      play_addr: { uri, url_list: [`https://cdn.example/${aid}/default.mp4`] },
      bit_rate: [row(1, 720, 'hevc720'), row(2, 1080, 'vvc1080'), row(1, 2160, 'hevc4k'),
        row(0, 720, 'avc720'), row(1, 1440, 'hevc2k'), row(2, 720, 'vvc720')],
      abr_config: { maxDownSwitchLevel: 3, rebufferDegrade: true, safeRebufferDegrade: 2 },
      needAutoBitrate: true,
      autoBitrateOpts: { isPlayAutoDefi: true, isOpenAutoDefi: true },
      extra: { preserve: ['all', 'metadata'] }
    }
  };
}

function expectedHevcAweme(aweme) {
  const expected = cloneJson(aweme);
  expected.video.bit_rate = expected.video.bit_rate.filter((row) => row.is_h265 !== 2);
  return expected;
}

function makeGearPayload(aid, suffix, width = 3840, height = 2160) {
  return {
    aweme_id: aid,
    video: {
      bit_rate: [
        {
          bit_rate: 9000000,
          gear_name: '超清 4K',
          quality_type: 1,
          is_h265: true,
          play_addr: {
            uri: `${suffix}-4k`,
            width,
            height,
            url_list: [`https://cdn.example/${suffix}-4k.mp4`]
          }
        },
        {
          bit_rate: 900000,
          gear_name: '高清 720P',
          quality_type: 1,
          is_h265: false,
          play_addr: {
            uri: `${suffix}-720`,
            width: 1280,
            height: 720,
            url_list: [`https://cdn.example/${suffix}-720.mp4`]
          }
        }
      ]
    }
  };
}

function makeEnvironment() {
  // Browser realms own their XHR prototypes.  Copy native methods/descriptors
  // so one LOCK_FN installation cannot leak wrappers into a second VM.
  class RealmXHR extends FakeXHR {}
  for (const key of Object.getOwnPropertyNames(FakeXHR.prototype)) {
    if (key !== 'constructor') Object.defineProperty(RealmXHR.prototype, key, Object.getOwnPropertyDescriptor(FakeXHR.prototype, key));
  }
  const listeners = new Map();
  const posts = [];
  const intervals = [];
  const timeouts = [];
  const videos = [
    makeMedia('main', { visible: true, width: 720, height: 1280, paused: false }),
    makeMedia('offscreen', { visible: false, width: 360, height: 640, paused: true })
  ];
  const playerA = makePlayer('player-a', videos[0], { playing: true, uri: 'owner-a-720' });
  const playerB = makePlayer('player-b', videos[1], { playing: false, uri: 'owner-b-720' });
  const players = [playerA, playerB];
  const registry = { getAllPlayer: () => players.slice() };
  const req = { c: { registry: { exports: registry } } };
  const chunk = {
    push(value) {
      if (Array.isArray(value) && typeof value[2] === 'function') value[2](req);
      return chunk.length || 0;
    },
    length: 0
  };

  const pendingFetches = [];
  function nativeFetch(input) {
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    const d = deferred();
    pendingFetches.push({ url: String(url), deferred: d });
    return d.promise;
  }

  function addListener(target, type, fn) {
    const map = target === 'window' ? listeners : listeners;
    const list = map.get(type) || [];
    list.push(fn);
    map.set(type, list);
  }
  function removeListener(type, fn) {
    const list = listeners.get(type) || [];
    listeners.set(type, list.filter((item) => item !== fn));
  }
  function dispatchWindow(event) {
    const list = (listeners.get(event.type) || []).slice();
    for (const fn of list) fn.call(win, event);
    return true;
  }

  const document = {
    readyState: 'complete',
    body: { tagName: 'BODY', dispatchEvent() { return true; }, parentElement: null },
    documentElement: { tagName: 'HTML', clientWidth: 1280, clientHeight: 720, dispatchEvent() { return true; } },
    addEventListener(type, fn) { addListener('document', type, fn); },
    removeEventListener(type, fn) { removeListener(type, fn); },
    dispatchEvent(event) { const list = (listeners.get(event.type) || []).slice(); for (const fn of list) fn.call(document, event); return true; },
    querySelectorAll(selector) {
      if (selector === 'video') return videos.slice();
      if (selector === 'div,video,*') return videos.slice();
      return [];
    },
    querySelector() { return null; },
    elementFromPoint() { return null; },
    createElement(tagName) {
      const attrs = {};
      const childNodes = [];
      return {
        tagName: String(tagName).toUpperCase(),
        style: {},
        childNodes,
        parentNode: null,
        textContent: '',
        className: '',
        setAttribute(k, v) { attrs[k] = String(v); },
        getAttribute(k) { return attrs[k] || ''; },
        appendChild(child) { child.parentNode = this; childNodes.push(child); return child; },
        removeChild(child) { const i = childNodes.indexOf(child); if (i >= 0) childNodes.splice(i, 1); child.parentNode = null; return child; },
        addEventListener() {},
        querySelector() { return null; },
        querySelectorAll() { return []; },
        getBoundingClientRect() { return { left: 0, top: 0, width: 100, height: 20 }; }
      };
    }
  };

  const win = {
    location: { hostname: 'www.douyin.com', href: 'https://www.douyin.com/' },
    document,
    innerWidth: 1280,
    innerHeight: 720,
    visualViewport: { width: 1280, height: 720 },
    navigator: {},
    performance: { now: () => Date.now(), getEntriesByType: () => [] },
    webpackChunkdouyin_web: chunk,
    fetch: nativeFetch,
    XMLHttpRequest: RealmXHR,
    addEventListener(type, fn) { addListener('window', type, fn); },
    removeEventListener(type, fn) { removeListener(type, fn); },
    dispatchEvent: dispatchWindow,
    postMessage(data) { posts.push(data); },
    setTimeout(fn, delay = 0) { const item = { fn, delay, cancelled: false }; timeouts.push(item); return timeouts.length; },
    clearTimeout(id) { if (timeouts[id - 1]) timeouts[id - 1].cancelled = true; },
    setInterval(fn, delay = 0) { intervals.push({ fn, delay, cancelled: false }); return intervals.length; },
    clearInterval(id) { if (intervals[id - 1]) intervals[id - 1].cancelled = true; },
    scrollBy() {},
    getComputedStyle() { return { overflowY: 'visible' }; },
    console: { log() {}, warn() {}, error() {} }
  };
  win.window = win;

  class FakeCustomEvent {
    constructor(type, init = {}) { this.type = type; this.detail = init.detail; }
  }
  class FakeEvent {
    constructor(type, init = {}) { this.type = type; Object.assign(this, init); }
  }
  class FakeWheelEvent extends FakeEvent {}
  class FakeKeyboardEvent extends FakeEvent {}
  class FakeMouseEvent extends FakeEvent {}

  const context = vm.createContext({
    window: win,
    document,
    location: win.location,
    navigator: win.navigator,
    performance: win.performance,
    fetch: nativeFetch,
    XMLHttpRequest: RealmXHR,
    setTimeout: win.setTimeout,
    clearTimeout: win.clearTimeout,
    setInterval: win.setInterval,
    clearInterval: win.clearInterval,
    CustomEvent: FakeCustomEvent,
    Event: FakeEvent,
    WheelEvent: FakeWheelEvent,
    KeyboardEvent: FakeKeyboardEvent,
    MouseEvent: FakeMouseEvent,
    Promise,
    URL,
    queueMicrotask,
    console: win.console,
    Date,
    JSON,
    String,
    Number,
    Boolean,
    Object,
    Array,
    Math,
    RegExp,
    isFinite
  });
  context.globalThis = context;

  return {
    context,
    win,
    document,
    videos,
    players,
    registry,
    posts,
    intervals,
    timeouts,
    pendingFetches,
    nativeFetch,
    FakeXHR: RealmXHR,
    runIntervals(count) {
      for (let i = 0; i < count; i++) {
        for (const timer of intervals.slice()) {
          if (!timer.cancelled) timer.fn();
        }
      }
    },
    runTimeoutsWhere(predicate) {
      for (const item of timeouts.slice()) {
        if (!item.cancelled && predicate(item)) {
          item.cancelled = true;
          item.fn();
        }
      }
    }
  };
}

function playerSnapshot(player) {
  return {
    config: cloneJson(player.config),
    listRef: player.config.definition.list,
    listEntries: cloneJson(player.config.definition.list),
    curDefinition: cloneJson(player.curDefinition),
    codecType: player.config.codecType,
    initCodecType: player.config.initCodecType,
    needAutoBitrate: player.config.needAutoBitrate,
    autoBitrateOpts: cloneJson(player.config.autoBitrateOpts),
    changeDefinitionCalls: player.changeDefinitionCalls,
    emitCalls: player.emitCalls
  };
}

function mediaCalls(media) {
  return media.calls.map((entry) => entry[0]);
}

async function testQualityAbPolicy(serialized) {
  console.log('\n[11] Quality-only AB policy preserves wrappers, playback and native network behavior');
  const env = makeEnvironment();
  const original = makeQualityPayload();
  const expected = expectedQualityPayload();
  const originalText = JSON.stringify(original, null, 2);
  const layout = { allAbParams: makeQualityPayload(), unrelated: { keep: true } };
  env.win.TTE_ENV = { layoutInitialProps: layout };
  const layoutRef = env.win.TTE_ENV.layoutInitialProps;
  const layoutWrapper = layout.allAbParams.data.auto_clarity_reselect;
  const before = env.players.map(playerSnapshot);
  const lock = vm.runInContext(`(${serialized})`, env.context, { filename: 'quality-serialized-LOCK_FN.js' });
  lock({ gear: -2, clarity: '20', fight: false, codec: '', refuse: 'none', abPatch: false,
    qualityAbPatch: true, safePlayback: true, captureGears: false });
  check('outer injection serializes qualityAbPatch', /qualityAbPatch:\s*!!QUALITY_AB_PATCH/.test(SOURCE));
  check('quality-only policy installs in a fresh VM', !!env.win.__dypc4kQualityAB);
  check('layout initial props retain identity', env.win.TTE_ENV.layoutInitialProps === layoutRef);
  check('layout quality wrapper retains identity', layout.allAbParams.data.auto_clarity_reselect === layoutWrapper);
  checkEqual('layout changes only three clarity scalar/wrapper values', layout, { allAbParams: expected, unrelated: { keep: true } });
  let observed;
  try { observed = JSON.parse(env.win.__DYPc4kActions.observe()); } catch {}
  checkEqual('observe reports quality-only AB policy', observed && observed.qualityAbPatch, true);

  async function fetchResponse(url, response, name) {
    const request = env.win.fetch(url);
    const pending = env.pendingFetches.at(-1);
    check(`${name} returns exact native fetch promise`, request === pending.deferred.promise);
    pending.deferred.resolve(response);
    const returned = await request;
    await flushAsync();
    check(`${name} returns exact original response`, returned === response);
    checkEqual(`${name} performs no eager reads or clones`, response.reads, { text: 0, json: 0, clone: 0 });
    checkEqual(`${name} leaves body unused before caller`, response.bodyUsed, false);
    return returned;
  }
  for (const [name, url, method] of [
    ['AB service text', '/service/2/abtest_config/?app_id=1', 'text'],
    ['AB mobile JSON', new URL('https://www.douyin.com/aweme/v12/web/mobile/ab/params/'), 'json']
  ]) {
    const response = makeQualityResponse(originalText);
    const result = await fetchResponse(url, response, name);
    const textClone = result.clone();
    const jsonClone = result.clone();
    check('caller clone retains native clone identity', textClone === response.clones[0] && jsonClone === response.clones[1]);
    checkEqual(`${name} clones remain unread until caller`, [textClone.reads, jsonClone.reads], [{ text: 0, json: 0, clone: 0 }, { text: 0, json: 0, clone: 0 }]);
    const body = await result[method]();
    checkEqual(`${name} preserves all fields except clarity values`, method === 'text' ? JSON.parse(body) : body, expected);
    checkEqual(`${name} clone.text applies quality policy`, JSON.parse(await textClone.text()), expected);
    checkEqual(`${name} clone.json applies quality policy`, await jsonClone.json(), expected);
  }

  for (const [name, url] of [
    ['non-AB media', 'https://www.douyin.com/aweme/v1/play/video.mp4'],
    ['non-AB search', '/aweme/v1/web/search/item/?keyword=abtest_config'],
    ['foreign-domain AB path', 'https://example.com/service/2/abtest_config/'],
    ['lookalike-domain AB path', 'https://douyin.com.example.com/aweme/v1/web/mobile/ab/params/'],
    ['AB path suffix', '/service/2/abtest_config/extra'],
    ['AB path prefix', '/prefix/aweme/v1/web/mobile/ab/params/']
  ]) {
    const response = makeQualityResponse(originalText);
    const methods = [response.text, response.json, response.clone];
    await fetchResponse(url, response, name);
    check(`${name} reader identities untouched`, methods[0] === response.text && methods[1] === response.json && methods[2] === response.clone);
    checkEqual(`${name} text remains byte-for-byte unchanged`, await response.text(), originalText);
    checkEqual(`${name} JSON remains unchanged`, await response.json(), original);
  }

  const fetchError = new Error('native AB fetch failed');
  const rejectedFetch = env.win.fetch('/service/2/abtest_config/');
  const rejectedPending = env.pendingFetches.at(-1);
  check('rejected AB fetch preserves native promise identity', rejectedFetch === rejectedPending.deferred.promise);
  rejectedPending.deferred.reject(fetchError);
  await expectReject('native AB fetch rejection identity preserved', () => rejectedFetch, fetchError);
  for (const method of ['text', 'json']) {
    const readError = new Error(`native AB ${method} failed`);
    const response = makeQualityResponse(originalText, { readError });
    await fetchResponse('/service/2/abtest_config/', response, `AB ${method} failure`);
    await expectReject(`native AB ${method} rejection identity preserved`, () => response[method](), readError);
    const copy = response.clone();
    await expectReject(`AB clone.${method} rejection identity preserved`, () => copy[method](), readError);
  }
  const cloneError = new Error('native AB clone failed');
  const cloneFailure = makeQualityResponse(originalText, { cloneError });
  await fetchResponse('/service/2/abtest_config/', cloneFailure, 'AB clone failure');
  let caughtCloneError;
  try { cloneFailure.clone(); } catch (error) { caughtCloneError = error; }
  check('native AB clone exception identity preserved', caughtCloneError === cloneError);
  const invalid = makeQualityResponse('{invalid JSON');
  await fetchResponse('/service/2/abtest_config/', invalid, 'AB malformed body');
  checkEqual('invalid AB text remains exact native text', await invalid.text(), '{invalid JSON');
  const parseError = await expectReject('invalid AB json remains rejected', () => invalid.json());
  check('invalid AB json retains native SyntaxError', parseError instanceof SyntaxError);

  console.log('\n[12] Quality-only XHR getters cache by request and leave other endpoints unchanged');
  const xhr = new env.win.XMLHttpRequest();
  checkEqual('quality XHR open preserves native return', xhr.open('GET', '/service/2/abtest_config/'), 'native-open-result');
  checkEqual('quality XHR send preserves native return', xhr.send(), 'native-send-result');
  xhr._body = originalText;
  checkEqual('incomplete AB XHR text stays unchanged', xhr.responseText, originalText);
  xhr.readyState = 4;
  const readsBeforeText = env.win.__dypc4kQualityAB.reads;
  const patchedText = xhr.responseText;
  checkEqual('AB XHR text patches only clarity values', JSON.parse(patchedText), expected);
  checkEqual('AB XHR repeated responseText returns cached text', xhr.responseText, patchedText);
  checkEqual('AB XHR response shares text cache', xhr.response, patchedText);
  checkEqual('AB XHR cached getters transform once', env.win.__dypc4kQualityAB.reads - readsBeforeText, 1);
  xhr.open('GET', '/aweme/v2/web/mobile/ab/params/');
  xhr.readyState = 4;
  const readsBeforeReuse = env.win.__dypc4kQualityAB.reads;
  checkEqual('reopened AB XHR same body still patches', JSON.parse(xhr.responseText), expected);
  checkEqual('reopened AB XHR resets transform memo', env.win.__dypc4kQualityAB.reads - readsBeforeReuse, 1);

  const jsonXhr = new env.win.XMLHttpRequest();
  jsonXhr.responseType = 'json';
  jsonXhr.open('GET', 'https://www.douyin.com/aweme/v1/web/mobile/ab/params/?x=1');
  jsonXhr.send();
  jsonXhr._jsonValue = makeQualityPayload();
  jsonXhr._jsonSet = true;
  jsonXhr.readyState = 4;
  const nativeObject = jsonXhr._jsonValue;
  const readsBeforeJson = env.win.__dypc4kQualityAB.reads;
  check('AB JSON XHR retains native object identity', jsonXhr.response === nativeObject);
  checkEqual('AB JSON XHR patches only clarity values', jsonXhr.response, expected);
  checkEqual('AB JSON XHR repeated reads transform once', env.win.__dypc4kQualityAB.reads - readsBeforeJson, 1);

  for (const url of ['/aweme/v1/web/search/item/', 'https://cdn.example/video.mp4',
    'https://foreign.example/service/2/abtest_config/', '/service/2/abtest_config/extra']) {
    xhr.open('GET', url);
    xhr._body = originalText;
    xhr.readyState = 4;
    checkEqual(`XHR reuse ${url} text untouched`, xhr.responseText, originalText);
    checkEqual(`XHR reuse ${url} response untouched`, xhr.response, originalText);
  }
  jsonXhr.open('GET', '/aweme/v1/web/search/item/');
  jsonXhr._jsonValue = makeQualityPayload();
  jsonXhr.readyState = 4;
  check('non-AB JSON XHR keeps native object identity', jsonXhr.response === jsonXhr._jsonValue);
  checkEqual('non-AB JSON XHR leaves all quality fields unchanged', jsonXhr.response, original);

  xhr.open('GET', '/service/2/abtest_config/');
  xhr.send();
  xhr._body = originalText;
  let abortEvents = 0;
  xhr.addEventListener('abort', () => abortEvents++);
  const readsBeforeAbort = { ...xhr._reads };
  checkEqual('AB XHR abort preserves native return', xhr.abort(), undefined);
  checkEqual('AB XHR abort preserves readyState', xhr.readyState, 0);
  checkEqual('AB XHR abort dispatches exactly once', abortEvents, 1);
  checkEqual('AB XHR abort performs no getter reads', xhr._reads, readsBeforeAbort);
  checkEqual('aborted AB XHR text stays native', xhr.responseText, originalText);
  xhr.open('GET', '/aweme/v1/web/search/item/');
  xhr._body = originalText;
  xhr.readyState = 4;
  checkEqual('aborted/reopened non-AB XHR has no stale patch', xhr.responseText, originalText);
  xhr.open('GET', '/service/2/abtest_config/');
  xhr._body = originalText;
  xhr.readyState = 4;
  checkEqual('AB XHR after abort/reuse patches current response', JSON.parse(xhr.responseText), expected);

  env.runIntervals(12);
  env.players.forEach((player, index) => {
    checkEqual(`quality policy player ${index} config and ABR unchanged`, playerSnapshot(player).config, before[index].config);
    check(`quality policy player ${index} list identity unchanged`, player.config.definition.list === before[index].listRef);
    checkEqual(`quality policy player ${index} list contents unchanged`, player.config.definition.list, before[index].listEntries);
    checkEqual(`quality policy player ${index} curDefinition unchanged`, player.curDefinition, before[index].curDefinition);
    checkEqual(`quality policy player ${index} never changes definition`, player.changeDefinitionCalls, 0);
    checkEqual(`quality policy player ${index} emits no playback changes`, player.emitCalls, 0);
  });
  env.videos.forEach((video, index) => checkEqual(`quality policy media ${index} has no mutations`, mediaCalls(video), []));
  check('quality-only policy produced no install errors', !env.posts.some((item) => item.kind === 'err' && /qualityab/i.test(String(item.data))));
}

async function testHevcInitializer(serialized) {
  console.log('\n[13] HEVC initializer filters only a lower VVC family before player normalization');
  const env = makeEnvironment();
  const supportCalls = [];
  env.win.navigator.hardwareConcurrency = 32;
  env.win.MediaSource = { isTypeSupported(type) {
    supportCalls.push(type);
    return type === 'video/mp4;codecs=hev1.1.6.L93.B0';
  } };
  env.context.MediaSource = env.win.MediaSource;
  const nativeSupport = env.win.MediaSource.isTypeSupported;
  const initial = makeHevcAweme();
  const initialExpected = expectedHevcAweme(initial);
  const initialRows = initial.video.bit_rate.slice();
  const initialLayout = { aweme_detail: initial, untouched: { keep: true } };
  const initialTte = { layoutInitialProps: initialLayout, untouched: 'native' };
  env.win.TTE_ENV = initialTte;
  const before = env.players.map(playerSnapshot);
  const lock = vm.runInContext(`(${serialized})`, env.context, { filename: 'hevc-serialized-LOCK_FN.js' });
  lock({ gear: -2, clarity: '20', fight: false, codec: '', refuse: 'none', abPatch: false,
    qualityAbPatch: false, preferHighHevc: true, safePlayback: true, captureGears: false });
  check('outer injection serializes preferHighHevc', /preferHighHevc:\s*!!PREFER_HIGH_HEVC/.test(SOURCE));
  check('HEVC initializer installs in fresh VM', !!env.win.__dypc4kHevcInit);
  check('initializer leaves capability function identity unchanged', env.win.MediaSource.isTypeSupported === nativeSupport);
  check('initializer checks exact HEVC capability', supportCalls.length > 0 && supportCalls.every((type) => type === 'video/mp4;codecs=hev1.1.6.L93.B0'));
  check('initial TTE_ENV/layout identities preserved', env.win.TTE_ENV === initialTte && initialTte.layoutInitialProps === initialLayout);
  checkEqual('initial layout filters VVC and preserves all other fields', initial, initialExpected);
  const keptInitial = initialRows.filter((row) => row.is_h265 !== 2);
  check('initial layout preserves surviving row identity and order', initial.video.bit_rate.length === keptInitial.length && initial.video.bit_rate.every((row, index) => row === keptInitial[index]));
  const initialCache = env.win.__dypc4kGearMap[initialRows[0].play_addr.uri] || [];
  check('original API cache retains both removed VVC row objects', initialRows.filter((row) => row.is_h265 === 2).every((row) => initialCache.some((record) => record.g === row)));
  checkEqual('original API cache retains entire original ladder', initialCache.length, initialRows.length);
  let observed;
  try { observed = JSON.parse(env.win.__DYPc4kActions.observe()); } catch {}
  checkEqual('observe reports HEVC initialization preference', observed && observed.preferHighHevc, true);

  let nextAid = 7491234567890123500n;
  const freshAweme = () => makeHevcAweme(String(nextAid++));
  function assignLayout(aweme) {
    const layout = { aweme_detail: aweme, unknown: { keep: 'layout' } };
    env.win.TTE_ENV.layoutInitialProps = layout;
    check('later layout assignment keeps exact assigned object', env.win.TTE_ENV.layoutInitialProps === layout);
  }
  const later = freshAweme();
  const laterExpected = expectedHevcAweme(later);
  assignLayout(later);
  checkEqual('later layout assignment applies initializer', later, laterExpected);
  const replacementAweme = freshAweme();
  const replacementExpected = expectedHevcAweme(replacementAweme);
  const replacement = { layoutInitialProps: { aweme_list: [replacementAweme] }, keep: 'TTE_ENV' };
  env.win.TTE_ENV = replacement;
  check('later TTE_ENV assignment keeps exact assigned object', env.win.TTE_ENV === replacement);
  checkEqual('later TTE_ENV assignment applies initializer', replacementAweme, replacementExpected);
  const replacementLater = freshAweme();
  const replacementLaterExpected = expectedHevcAweme(replacementLater);
  assignLayout(replacementLater);
  checkEqual('replacement TTE_ENV intercepts later layout assignment', replacementLater, replacementLaterExpected);

  for (const [name, mutate] of [
    ['live type 101', (a) => { a.aweme_type = 101; }],
    ['room metadata', (a) => { a.room = { id: 'room' }; }],
    ['live_room metadata', (a) => { a.live_room = { id: 'room' }; }],
    ['room_id metadata', (a) => { a.room_id = 'room'; }],
    ['aweme is_live', (a) => { a.is_live = true; }],
    ['video is_live', (a) => { a.video.is_live = true; }],
    ['missing aweme id', (a) => { delete a.aweme_id; }],
    ['numeric aweme id', (a) => { a.aweme_id = 7491234567890123; }],
    ['invalid aweme id', (a) => { a.aweme_id = 'owner-a'; }],
    ['missing video', (a) => { delete a.video; }],
    ['missing bitrate rows', (a) => { delete a.video.bit_rate; }],
    ['string codec metadata', (a) => { a.video.bit_rate.forEach((row) => { row.is_h265 = String(row.is_h265); }); }],
    ['missing codec metadata', (a) => { a.video.bit_rate.forEach((row) => { delete row.is_h265; }); }],
    ['ambiguous HEVC URI', (a) => { a.video.bit_rate[0].play_addr.uri = 'other-video'; }],
    ['ambiguous VVC URI', (a) => { a.video.bit_rate[1].play_addr.uri = 'other-video'; }],
    ['ambiguous primary URI', (a) => { a.video.play_addr.uri = 'other-video'; }],
    ['missing HEVC URI', (a) => { delete a.video.bit_rate[2].play_addr.uri; }],
    ['missing valid HEVC URLs', (a) => { a.video.bit_rate[2].play_addr.url_list = ['blob:unsupported', null]; }],
    ['missing valid VVC URLs', (a) => { a.video.bit_rate[1].play_addr.url_list = []; }],
    ['API-only high HEVC', (a) => { a.video.bit_rate.filter((row) => row.is_h265 === 1 && row.play_addr.height > 1080).forEach((row) => { row.play_addr.url_list = ['https://www.douyin.com/aweme/v1/play/?video_id=same-video']; }); }],
    ['equal resolution VVC', (a) => { Object.assign(a.video.bit_rate[1].play_addr, { width: 3840, height: 2160 }); }],
    ['higher resolution VVC', (a) => { Object.assign(a.video.bit_rate[1].play_addr, { width: 5120, height: 2880 }); }],
    ['no high HEVC', (a) => { a.video.bit_rate.filter((row) => row.is_h265 === 1).forEach((row) => { Object.assign(row.play_addr, { width: 1920, height: 1080 }); }); }],
    ['no HEVC family', (a) => { a.video.bit_rate = a.video.bit_rate.filter((row) => row.is_h265 !== 1); }],
    ['no VVC family', (a) => { a.video.bit_rate = a.video.bit_rate.filter((row) => row.is_h265 !== 2); }],
    ['HDR-only high HEVC', (a) => { a.video.bit_rate.filter((row) => row.is_h265 === 1 && row.play_addr.height > 1080).forEach((row) => { row.HDR_type = 1; }); }],
    ['HDR bit 1 high HEVC', (a) => { a.video.bit_rate.filter((row) => row.is_h265 === 1 && row.play_addr.height > 1080).forEach((row) => { row.HDR_bit = 1; }); }],
    ['HDR bit 8 high HEVC', (a) => { a.video.bit_rate.filter((row) => row.is_h265 === 1 && row.play_addr.height > 1080).forEach((row) => { row.HDR_bit = 8; }); }],
    ['DASH-only high HEVC', (a) => { a.video.bit_rate.filter((row) => row.is_h265 === 1 && row.play_addr.height > 1080).forEach((row) => { row.format = 'dash'; }); }]
  ]) {
    const aweme = freshAweme();
    mutate(aweme);
    const unchanged = cloneJson(aweme);
    const rows = aweme.video && aweme.video.bit_rate;
    assignLayout(aweme);
    checkEqual(`initializer guard ${name} leaves full input unchanged`, aweme, unchanged);
    if (rows) check(`initializer guard ${name} keeps original row list`, aweme.video.bit_rate === rows);
  }
  for (const [name, setup, restore] of [
    ['unsupported HEVC', () => { env.win.MediaSource.isTypeSupported = () => false; }, () => { env.win.MediaSource.isTypeSupported = nativeSupport; }],
    ['low hardware concurrency', () => { env.win.navigator.hardwareConcurrency = 4; }, () => { env.win.navigator.hardwareConcurrency = 32; }]
  ]) {
    setup();
    const aweme = freshAweme();
    const unchanged = cloneJson(aweme);
    assignLayout(aweme);
    checkEqual(`initializer guard ${name} leaves input unchanged`, aweme, unchanged);
    restore();
  }

  console.log('\n[14] HEVC response readers remain lazy, scoped and preserve native identities');
  async function fetchResponse(url, response, name) {
    const request = env.win.fetch(url);
    const pending = env.pendingFetches.at(-1);
    check(`${name} keeps native fetch promise`, request === pending.deferred.promise);
    pending.deferred.resolve(response);
    const result = await request;
    await flushAsync();
    check(`${name} keeps native response`, result === response);
    checkEqual(`${name} performs no eager reads/clones`, response.reads, { text: 0, json: 0, clone: 0 });
    checkEqual(`${name} leaves original body unused`, response.bodyUsed, false);
    return result;
  }
  for (const [name, url, method] of [
    ['HEVC feed text', '/aweme/v1/web/feed/?count=1', 'text'],
    ['HEVC detail JSON', '/aweme/v1/web/aweme/detail/?aweme_id=1', 'json']
  ]) {
    const aweme = freshAweme();
    const payload = { aweme_list: [aweme], extra: { keep: true } };
    const expected = { aweme_list: [expectedHevcAweme(aweme)], extra: { keep: true } };
    const response = makeQualityResponse(payload);
    await fetchResponse(url, response, name);
    const textCopy = response.clone();
    const jsonCopy = response.clone();
    check(`${name} caller clones preserve native identity`, textCopy === response.clones[0] && jsonCopy === response.clones[1]);
    checkEqual(`${name} clones remain unread`, [textCopy.reads, jsonCopy.reads], [{ text: 0, json: 0, clone: 0 }, { text: 0, json: 0, clone: 0 }]);
    const output = await response[method]();
    checkEqual(`${name} filters only VVC`, method === 'text' ? JSON.parse(output) : output, expected);
    checkEqual(`${name} clone.text filters VVC`, JSON.parse(await textCopy.text()), expected);
    checkEqual(`${name} clone.json filters VVC`, await jsonCopy.json(), expected);
    const rawCopy = response.__dypc4kRawClone.call(response);
    checkEqual(`${name} raw clone retains original VVC rows`, await rawCopy.json(), payload);
  }
  const identityAweme = freshAweme();
  const identityExpected = expectedHevcAweme(identityAweme);
  const identityRows = identityAweme.video.bit_rate.slice();
  const identityPayload = { aweme_detail: identityAweme };
  const identityResponse = makeQualityResponse(identityPayload);
  identityResponse.json = function () {
    identityResponse.reads.json++; identityResponse.bodyUsed = true;
    return Promise.resolve(identityPayload);
  };
  await fetchResponse('/aweme/v1/web/aweme/detail/', identityResponse, 'HEVC object JSON');
  check('HEVC JSON retains original payload object', await identityResponse.json() === identityPayload);
  checkEqual('HEVC JSON preserves all retained metadata/URLs', identityAweme, identityExpected);
  const keptRows = identityRows.filter((row) => row.is_h265 !== 2);
  check('HEVC JSON preserves retained row objects/order including AVC and low HEVC', identityAweme.video.bit_rate.every((row, index) => row === keptRows[index]) && identityAweme.video.bit_rate.length === keptRows.length);
  const cache = env.win.__dypc4kGearMap[identityRows[0].play_addr.uri] || [];
  check('HEVC JSON preserves original VVC in API cache', identityRows.filter((row) => row.is_h265 === 2).every((row) => cache.some((record) => record.g === row)));

  for (const [name, url] of [
    ['search', '/aweme/v1/web/search/item/'], ['media', '/aweme/v1/play/video.mp4'],
    ['foreign feed', 'https://foreign.example/aweme/v1/web/feed/'], ['feed suffix', '/aweme/v1/web/feed/extra'],
    ['AB params', '/aweme/v1/web/mobile/ab/params/']
  ]) {
    const payload = { aweme_detail: freshAweme() };
    const text = JSON.stringify(payload, null, 2);
    const response = makeQualityResponse(text);
    const methods = [response.text, response.json, response.clone];
    await fetchResponse(url, response, `initializer non-target ${name}`);
    check(`initializer non-target ${name} keeps reader identities`, response.text === methods[0] && response.json === methods[1] && response.clone === methods[2]);
    checkEqual(`initializer non-target ${name} leaves bytes unchanged`, await response.text(), text);
  }

  console.log('\n[15] HEVC XHR memoization and reuse preserve native response semantics');
  const xhr = new env.win.XMLHttpRequest();
  const xhrAweme = freshAweme();
  const xhrPayload = { aweme_detail: xhrAweme };
  const xhrExpected = { aweme_detail: expectedHevcAweme(xhrAweme) };
  const xhrText = JSON.stringify(xhrPayload, null, 2);
  checkEqual('HEVC XHR open keeps native return', xhr.open('GET', '/aweme/v1/web/aweme/detail/'), 'native-open-result');
  checkEqual('HEVC XHR send keeps native return', xhr.send(), 'native-send-result');
  xhr._body = xhrText;
  checkEqual('incomplete HEVC XHR remains unchanged', xhr.responseText, xhrText);
  xhr.readyState = 4;
  const readsBefore = env.win.__dypc4kHevcInit.reads;
  const patchedText = xhr.responseText;
  checkEqual('HEVC XHR text filters only VVC', JSON.parse(patchedText), xhrExpected);
  checkEqual('HEVC XHR repeated getter memoized', xhr.responseText, patchedText);
  checkEqual('HEVC XHR response shares text memo', xhr.response, patchedText);
  checkEqual('HEVC XHR memo transforms once', env.win.__dypc4kHevcInit.reads - readsBefore, 1);
  xhr.open('GET', '/aweme/v1/web/feed/');
  xhr.readyState = 4;
  const readsBeforeReuse = env.win.__dypc4kHevcInit.reads;
  checkEqual('reopened HEVC XHR identical body filters current request', JSON.parse(xhr.responseText), xhrExpected);
  checkEqual('reopened HEVC XHR resets memo', env.win.__dypc4kHevcInit.reads - readsBeforeReuse, 1);
  xhr.open('GET', '/aweme/v1/web/search/item/');
  xhr.readyState = 4;
  checkEqual('HEVC XHR reuse to search has no stale text', xhr.responseText, xhrText);
  checkEqual('HEVC XHR reuse to search has no stale response', xhr.response, xhrText);
  xhr.responseType = 'json';
  const jsonAweme = freshAweme();
  const jsonExpected = expectedHevcAweme(jsonAweme);
  const jsonRows = jsonAweme.video.bit_rate.slice();
  const jsonBody = { aweme_detail: jsonAweme };
  xhr.open('GET', '/aweme/v1/web/aweme/detail/');
  xhr._jsonSet = true; xhr._jsonValue = jsonBody; xhr.readyState = 4;
  const readsBeforeJson = env.win.__dypc4kHevcInit.reads;
  check('HEVC XHR JSON keeps native object identity', xhr.response === jsonBody);
  checkEqual('HEVC XHR JSON filters only VVC', xhr.response, { aweme_detail: jsonExpected });
  checkEqual('HEVC XHR JSON repeated getter transforms once', env.win.__dypc4kHevcInit.reads - readsBeforeJson, 1);
  check('HEVC XHR JSON retained rows keep identity/order', jsonAweme.video.bit_rate.every((row, index) => row === jsonRows.filter((item) => item.is_h265 !== 2)[index]));
  const nonTargetJson = { aweme_detail: freshAweme() };
  const unchangedJson = cloneJson(nonTargetJson);
  xhr.open('GET', '/aweme/v1/web/search/item/');
  xhr._jsonValue = nonTargetJson; xhr.readyState = 4;
  check('HEVC XHR reused JSON retains native identity', xhr.response === nonTargetJson);
  checkEqual('HEVC XHR reused JSON remains unchanged', xhr.response, unchangedJson);

  env.runIntervals(12);
  env.players.forEach((player, index) => {
    checkEqual(`initializer player ${index} config/codec/ABR unchanged`, playerSnapshot(player).config, before[index].config);
    check(`initializer player ${index} list identity unchanged`, player.config.definition.list === before[index].listRef);
    checkEqual(`initializer player ${index} list contents unchanged`, player.config.definition.list, before[index].listEntries);
    checkEqual(`initializer player ${index} current definition unchanged`, player.curDefinition, before[index].curDefinition);
    checkEqual(`initializer player ${index} never changes definition or emits`, [player.changeDefinitionCalls, player.emitCalls], [0, 0]);
  });
  env.videos.forEach((video, index) => checkEqual(`initializer media ${index} has no mutations`, mediaCalls(video), []));
  check('initializer produced no install errors', !env.posts.some((item) => item.kind === 'err' && /hevcinit/i.test(String(item.data))));
}

async function main() {
  console.log(`\n[1] Extract and serialize actual LOCK_FN from ${SOURCE_PATH}`);
  let extracted;
  try {
    extracted = extractSerializedLock(SOURCE);
    check('LOCK_FN extraction found a balanced function', extracted.end > extracted.start);
    check('LOCK_FN serialization parses independently', extracted.serialized.includes('function (CFG)'));
    console.log(`  info LOCK_FN source span ${extracted.start}-${extracted.end}, serialized ${extracted.serialized.length} bytes`);
  } catch (error) {
    failures.push(`LOCK_FN extraction -> ${error && error.stack ? error.stack : error}`);
    console.log(`  FAIL LOCK_FN extraction -> ${error && error.stack ? error.stack : error}`);
    return finish();
  }

  const env = makeEnvironment();
  const textDescriptorBefore = Object.getOwnPropertyDescriptor(env.FakeXHR.prototype, 'responseText');
  const responseDescriptorBefore = Object.getOwnPropertyDescriptor(env.FakeXHR.prototype, 'response');
  const outerSafeConfig = /JSON\.stringify\(\{[^}]*safePlayback:\s*!!SAFE_PLAYBACK[^}]*captureGears:\s*!!CAPTURE_GEARS[^}]*\}\)/s.test(SOURCE);
  check('outer injection config serializes safePlayback and captureGears', outerSafeConfig);
  check('original INFO_FN remains present for serialization', /var INFO_FN = function \(\)/.test(SOURCE) && /INFO_FN\.toString\(\)/.test(SOURCE));
  let lockFn;
  try {
    lockFn = vm.runInContext(`(${extracted.serialized})`, env.context, { filename: 'serialized-LOCK_FN.js' });
    lockFn({
      gear: -2,
      clarity: '20',
      fight: false,
      codec: '',
      refuse: 'none',
      abPatch: false,
      safePlayback: true,
      captureGears: true
    });
    ok('serialized LOCK_FN executes in browser-like VM');
  } catch (error) {
    failures.push(`serialized LOCK_FN execution -> ${error && error.stack ? error.stack : error}`);
    console.log(`  FAIL serialized LOCK_FN execution -> ${error && error.stack ? error.stack : error}`);
    return finish();
  }

  console.log('\n[2] Safe polling is observational across multiple visible/offscreen videos');
  const [mainVideo, offscreenVideo] = env.videos;
  const [playerA, playerB] = env.players;
  env.win.__dypc4kCapture(makeGearPayload('owner-a', 'owner-a'));
  env.win.__dypc4kCapture(makeGearPayload('owner-b', 'owner-b'));
  const playerBefore = env.players.map(playerSnapshot);
  const listRefsBefore = env.players.map((player) => player.config.definition.list);
  mainVideo.calls.length = 0;
  offscreenVideo.calls.length = 0;
  env.runIntervals(12);
  checkEqual('visible video has no playback mutator calls', mediaCalls(mainVideo), []);
  checkEqual('offscreen video has no playback mutator calls', mediaCalls(offscreenVideo), []);
  checkEqual('player A changeDefinition is untouched', playerA.changeDefinitionCalls, 0);
  checkEqual('player B changeDefinition is untouched', playerB.changeDefinitionCalls, 0);
  env.players.forEach((player, index) => {
    const before = playerBefore[index];
    checkEqual(`player ${index} config/ABR state unchanged`, playerSnapshot(player).config, before.config);
    checkEqual(`player ${index} definition list identity unchanged`, player.config.definition.list, listRefsBefore[index]);
    checkEqual(`player ${index} definition list contents unchanged`, player.config.definition.list, before.listEntries);
    checkEqual(`player ${index} curDefinition unchanged`, player.curDefinition, before.curDefinition);
  });
  check('both visible and offscreen mocks were present', mainVideo.getBoundingClientRect().width > 0 && offscreenVideo.getBoundingClientRect().left < 0);

  console.log('\n[3] Reused video/srcObject and changed player owner remain untouched');
  // Simulate feed reuse: the old main <video> is handed to the second player,
  // while the first player receives the offscreen element.  srcObject also
  // changes as a live MediaStream would when the page reuses the element.
  playerA.isPlaying = false;
  playerA.video = offscreenVideo;
  playerA.media = offscreenVideo;
  playerB.isPlaying = true;
  playerB.video = mainVideo;
  playerB.media = mainVideo;
  mainVideo.srcObject = { stream: 'owner-b-live-reused' };
  mainVideo.calls.length = 0;
  offscreenVideo.calls.length = 0;
  const ownerBefore = env.players.map(playerSnapshot);
  env.runIntervals(12);
  checkEqual('reused live video has no src/srcObject/load/pause/play/seek calls', mediaCalls(mainVideo), []);
  checkEqual('changed offscreen owner has no media mutator calls', mediaCalls(offscreenVideo), []);
  checkEqual('reused owner changeDefinition remains untouched', playerB.changeDefinitionCalls, 0);
  env.players.forEach((player, index) => {
    checkEqual(`reused owner ${index} config remains unchanged`, playerSnapshot(player).config, ownerBefore[index].config);
    checkEqual(`reused owner ${index} list identity remains unchanged`, player.config.definition.list, listRefsBefore[index]);
  });
  checkEqual('direct safe force helper does not mutate media', expectNoThrow('safe force helper returns without throw', () => env.win.__dypc4kForce(playerB, playerB.config.definition.list[0], -2)), false);
  checkEqual('direct safe force helper still made no calls', mediaCalls(mainVideo), []);

  console.log('\n[4] Safe exposed fill helper cannot mutate the native ladder');
  const fillList = playerA.config.definition.list;
  const fillBefore = cloneJson(fillList);
  if (typeof env.win.__dypc4kFill === 'function') {
    expectNoThrow('safe fill helper returns without throw', () => env.win.__dypc4kFill(fillList));
    checkEqual('safe fill helper leaves definition list unchanged', fillList, fillBefore);
  } else {
    ok('safe fill helper is not exposed');
  }

  console.log('\n[5] Diagnostic actions remain available while playback mutators disable');
  const actions = env.win.__DYPc4kActions;
  check('remote action table remains exposed', !!actions && typeof actions === 'object');
  const diagnosticNames = ['state', 'diag', 'gears', 'click', 'els', 'pn', 'scroll', 'plugins', 'pick', 'key', 'aids', 'goto', 'hover', 'wake', 'sp', 'q', 'ql', 'runs', 'pnx', 'next'];
  diagnosticNames.forEach((name) => check(`diagnostic action ${name} remains present`, !!actions && typeof actions[name] === 'function'));
  check('diagnostic dump remains exposed', typeof env.win.__dypc4kDiag2 === 'function');
  check('label diagnostic helper remains exposed', typeof env.win.__dypc4kLabel === 'function');
  check('DOM label diagnostic helper remains exposed', typeof env.win.__dypc4kLabelDom === 'function');
  if (actions) {
    for (const name of ['state', 'diag', 'gears', 'q', 'runs']) {
      if (typeof actions[name] === 'function') expectNoThrow(`read-only diagnostic ${name} executes`, () => actions[name]());
    }
    if (typeof actions.observe === 'function') {
      const observedText = expectNoThrow('read-only observe diagnostic executes', () => actions.observe());
      let observed;
      try { observed = JSON.parse(observedText); } catch {}
      checkEqual('observe diagnostic reports safe playback mode', observed && observed.safePlayback, true);
      checkEqual('observe diagnostic selects largest visible video', observed && observed.active, 0);
      checkEqual('observe diagnostic associates exact active player aid', observed && observed.videos[0] && observed.videos[0].aid, 'player-b-aid');
      checkEqual('observe diagnostic reports offscreen video hidden', observed && observed.videos[1] && observed.videos[1].visible, false);
      checkEqual('observe diagnostic reports active stream as live', observed && observed.videos[0] && observed.videos[0].live, true);
      checkEqual('observe diagnostic reports buffer ahead without mutation', observed && observed.videos[0] && observed.videos[0].ahead, 12);
    } else {
      check('viewport/media/player observe diagnostic remains present', false, 'ACT.observe missing');
    }
    const playbackMutators = [
      ['eval', 'window.__safePlaybackEvalShouldNotRun = 1'],
      ['spsw', '-2'],
      ['hard', '-2'],
      ['hard4k', '-2'],
      ['force', '-2']
    ];
    for (const [name, arg] of playbackMutators) {
      if (typeof actions[name] !== 'function') {
        check(`playback mutator ${name} is exposed for safe disable`, false, 'missing action');
        continue;
      }
      const result = expectNoThrow(`playback mutator ${name} returns safely`, () => actions[name](arg));
      checkEqual(`playback mutator ${name} is disabled`, result, 'disabled: safe playback mode');
    }
    check('disabled eval did not run code', env.win.__safePlaybackEvalShouldNotRun === undefined);
  }
  const postCountBeforeCommand = env.posts.length;
  expectNoThrow('remote state command dispatch does not throw', () => env.win.dispatchEvent(new env.context.CustomEvent('dypc4kCmd', { detail: 'state' })));
  const ctlResults = env.posts.slice(postCountBeforeCommand).filter((item) => item && item.kind === 'ctlres');
  check('remote state command still reports a result', ctlResults.length > 0, env.posts.slice(postCountBeforeCommand));
  if (ctlResults.length) {
    const parsed = JSON.parse(ctlResults.at(-1).data);
    checkEqual('remote state result names requested operation', parsed.op, 'state');
  }

  console.log('\n[6] Passive fetch returns the original promise/response before clone capture completes');
  const fetchBody = JSON.stringify(makeGearPayload('fetch-aid', 'fetch-aid'));
  const fetchRequest = env.win.fetch('/aweme/v1/web/feed/?count=1');
  const pendingFetch = env.pendingFetches.at(-1);
  check('passive fetch wrapper returns exact native promise', fetchRequest === pendingFetch.deferred.promise);
  const fetchResponse = makeResponse(fetchBody, 'pending');
  pendingFetch.deferred.resolve(fetchResponse);
  const returnedResponse = await expectNoReject('native fetch response resolves without waiting for clone.text', () => fetchRequest);
  check('passive fetch returns exact original response object', returnedResponse === fetchResponse);
  await flushAsync();
  check('passive fetch started asynchronous clone read', fetchResponse.cloneTextStarted === true);
  check('passive fetch has not consumed original response body', fetchResponse.originalTextReads === undefined);
  check('gear cache is still empty before clone.text resolves', !env.win.__dypc4kGearMap['fetch-aid-4k']);
  const mediaFetch = env.win.fetch('https://cdn.example/aweme/v1/play/dash/owner-a-4k.mp4');
  const pendingMediaFetch = env.pendingFetches.at(-1);
  const mediaResponse = makeResponse(fetchBody, 'resolved');
  pendingMediaFetch.deferred.resolve(mediaResponse);
  const mediaReturned = await mediaFetch;
  await flushAsync();
  check('playback media fetch still returns original response', mediaReturned === mediaResponse);
  checkEqual('playback media fetch is not cloned or read as text', mediaResponse.cloneCalls, 0);
  check('playback media fetch did not change captured gear cache', !env.win.__dypc4kGearMap['fetch-aid-4k']);
  fetchResponse.cloneDeferred.resolve(fetchBody);
  await flushAsync();
  check('passive fetch captures after clone.text resolves', Array.isArray(env.win.__dypc4kGearMap['fetch-aid-4k']));
  const fetchGearLength = env.win.__dypc4kGearMap['fetch-aid-4k'] && env.win.__dypc4kGearMap['fetch-aid-4k'].length;
  checkEqual('first passive fetch captures one 4K gear record', fetchGearLength, 1);

  console.log('\n[7] Passive fetch errors do not propagate to callers');
  for (const mode of ['throw-clone', 'reject-clone-text']) {
    const p = env.win.fetch('/aweme/v1/web/error-case');
    const pending = env.pendingFetches.at(-1);
    const response = makeResponse(fetchBody, mode);
    pending.deferred.resolve(response);
    const result = await expectNoReject(`fetch ${mode} leaves original promise resolved`, () => p);
    check(`fetch ${mode} returns original response`, result === response);
    await flushAsync();
  }
  check('error paths did not generate an uncaught VM post error', !env.posts.some((item) => item && item.kind === 'err' && /gear capture|fetch/i.test(String(item.data))));

  console.log('\n[8] Repeated passive gear responses are deduplicated and bounded');
  for (let i = 0; i < 120; i++) {
    const p = env.win.fetch('/aweme/v1/web/repeated-gear');
    const pending = env.pendingFetches.at(-1);
    const response = makeResponse(fetchBody, 'resolved');
    pending.deferred.resolve(response);
    await p;
    await flushAsync();
  }
  const repeatedEntries = env.win.__dypc4kGearMap['fetch-aid-4k'] || [];
  checkEqual('120 identical passive responses retain one 4K record', repeatedEntries.length, 1);
  checkEqual('120 identical passive responses retain one 720 record', (env.win.__dypc4kGearMap['fetch-aid-720'] || []).length, 1);
  check('repeated passive response cache remains bounded by distinct gears', Object.keys(env.win.__dypc4kGearMap).filter((key) => key.startsWith('fetch-aid-')).length <= 2);

  console.log('\n[9] XHR capture preserves native getters/response and captures once per request');
  const textDescriptorAfter = Object.getOwnPropertyDescriptor(env.FakeXHR.prototype, 'responseText');
  const responseDescriptorAfter = Object.getOwnPropertyDescriptor(env.FakeXHR.prototype, 'response');
  check('XHR responseText getter identity is unchanged', textDescriptorAfter && textDescriptorBefore && textDescriptorAfter.get === textDescriptorBefore.get);
  check('XHR response getter identity is unchanged', responseDescriptorAfter && responseDescriptorBefore && responseDescriptorAfter.get === responseDescriptorBefore.get);

  const xhrReuse = new env.win.XMLHttpRequest();
  expectNoThrow('XHR open returns native result', () => checkEqual('XHR open return value', xhrReuse.open('GET', '/aweme/v1/web/aborted-before-load'), 'native-open-result'));
  xhrReuse.send();
  // Reopen before the first request has delivered load.  A stale listener
  // would run alongside the second request's listener and read response twice.
  xhrReuse.open('GET', '/aweme/v1/web/reused-request');
  xhrReuse.send();
  const reusedBody = JSON.stringify(makeGearPayload('xhr-reuse-aid', 'xhr-reuse'));
  xhrReuse._body = reusedBody;
  xhrReuse.readyState = 4;
  xhrReuse.dispatch('load');
  env.runTimeoutsWhere((timer) => timer.delay === 0);
  const reuseGetterReads = xhrReuse._reads.responseText + xhrReuse._reads.response;
  checkEqual('reused XHR request reads response exactly once', reuseGetterReads, 1);
  check('reused XHR request captured gear data', Array.isArray(env.win.__dypc4kGearMap['xhr-reuse-4k']));
  xhrReuse.dispatch('load');
  checkEqual('second load event does not capture reused XHR again', xhrReuse._reads.responseText + xhrReuse._reads.response, 1);
  checkEqual('reused XHR native responseText remains unchanged', xhrReuse.responseText, reusedBody);

  const xhrAbort = new env.win.XMLHttpRequest();
  xhrAbort.open('GET', '/aweme/v1/web/abort-me');
  xhrAbort.send();
  xhrAbort.abort();
  xhrAbort.open('GET', '/aweme/v1/web/after-abort');
  xhrAbort.send();
  xhrAbort._body = JSON.stringify(makeGearPayload('xhr-abort-aid', 'xhr-abort'));
  xhrAbort.readyState = 4;
  xhrAbort.dispatch('load');
  env.runTimeoutsWhere((timer) => timer.delay === 0);
  checkEqual('aborted/reused XHR reads response exactly once', xhrAbort._reads.responseText + xhrAbort._reads.response, 1);
  check('aborted/reused XHR captured only current request', Array.isArray(env.win.__dypc4kGearMap['xhr-abort-4k']));

  const xhrText = new env.win.XMLHttpRequest();
  xhrText.open('GET', '/aweme/v1/web/text-response');
  xhrText.send();
  const textBody = JSON.stringify(makeGearPayload('xhr-text-aid', 'xhr-text'));
  xhrText._body = textBody;
  xhrText.readyState = 4;
  xhrText.dispatch('readystatechange');
  xhrText.dispatch('load');
  env.runTimeoutsWhere((timer) => timer.delay === 0);
  check('XHR text response getter still returns exact body', xhrText.responseText === textBody);
  check('XHR text response captured gear data', Array.isArray(env.win.__dypc4kGearMap['xhr-text-4k']));

  const xhrJson = new env.win.XMLHttpRequest();
  xhrJson.responseType = 'json';
  xhrJson.open('GET', '/aweme/v1/web/json-response');
  xhrJson.send();
  const jsonBody = makeGearPayload('xhr-json-aid', 'xhr-json');
  xhrJson._jsonValue = jsonBody;
  xhrJson._jsonSet = true;
  xhrJson.readyState = 4;
  xhrJson.dispatch('readystatechange');
  xhrJson.dispatch('load');
  env.runTimeoutsWhere((timer) => timer.delay === 0);
  checkEqual('JSON XHR capture reads one native response getter', xhrJson._reads.response, 1);
  check('XHR JSON response getter returns exact original object', xhrJson.response === jsonBody);
  check('XHR JSON response captured gear data', Array.isArray(env.win.__dypc4kGearMap['xhr-json-4k']));

  console.log('\n[10] Final safety invariant after network and owner churn');
  const finalMediaCalls = [...mainVideo.calls, ...offscreenVideo.calls];
  checkEqual('no media source/stream/load/pause/play/seek mutations occurred', finalMediaCalls, []);
  checkEqual('player A changeDefinition remained untouched', playerA.changeDefinitionCalls, 0);
  checkEqual('player B changeDefinition remained untouched', playerB.changeDefinitionCalls, 0);
  checkEqual('native ABR config remains unchanged after all tests', playerA.config.needAutoBitrate, true);
  checkEqual('native ABR options remain unchanged after all tests', playerA.config.autoBitrateOpts, { isPlayAutoDefi: true, isOpenAutoDefi: true });
  checkEqual('native definition list remains one native entry', playerA.config.definition.list.length, 1);
  check('native definition list has no synthetic entry', playerA.config.definition.list.every((entry) => !entry.__dypc4kSynth));

  await testQualityAbPolicy(extracted.serialized);
  await testHevcInitializer(extracted.serialized);
  return finish();
}

function finish() {
  if (failures.length) {
    console.log(`\n${failures.length} assertion(s) failed`);
    for (const failure of failures) console.log(`  evidence: ${failure}`);
    process.exitCode = 1;
  } else {
    console.log('\nAll safe-playback assertions passed');
  }
}

await main();
