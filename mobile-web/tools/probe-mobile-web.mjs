/**
 * 手机网页版抖音探针（无需 root / 无需登录）
 *
 * 用途：用 Chromium 的手机模拟打开 www.douyin.com，把"脚本要用到的真实现场"抓下来：
 *   1) AB 接口的真实 URL + 响应键名（验证 /ab\/params|abtest|abtest_config/i 是否够用）
 *   2) MANUAL_SWITCH 的真实写入结构（qualityType/clarityReal 等字段）
 *   3) 真实 DOM 类名（顶栏 / 下载条 / 打开App浮层 / 底部标签栏 / 播放器容器）
 *   4) 视频元素真实解码分辨率 + 清晰度菜单里有没有「超清 4K」
 *
 * 用法（cwd 必须是 F:\ddddddd\douyin-4k-mod，上级目录的 0 字节 package.json 会让 node 崩）：
 *   node mobile-web/tools/probe-mobile-web.mjs --out mobile-web/probe-output
 *   node mobile-web/tools/probe-mobile-web.mjs --url https://www.douyin.com/discover --headed
 *   node mobile-web/tools/probe-mobile-web.mjs --script mobile-web/douyin-4k.user.js   # 先注入脚本再抓
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

// playwright-core 不在本仓库依赖里，从 rea-agents 全局安装借一个
const PW_CANDIDATES = [
  'C:/Users/Ayanami/AppData/Roaming/npm/node_modules/rea-agents/node_modules/playwright-core',
  'playwright-core'
];
function loadPW() {
  for (const c of PW_CANDIDATES) {
    try { return require(c); } catch (e) { /* next */ }
  }
  throw new Error('找不到 playwright-core（可选：npm i -D playwright-core）');
}

const argv = process.argv.slice(2);
function arg(name, def) {
  const i = argv.indexOf('--' + name);
  if (i < 0) return def;
  const v = argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
}
const UA_ARG = arg('ua',
  'Mozilla/5.0 (Linux; Android 13; ONEPLUS A5000) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36');
const URL_ARG = String(arg('url', 'https://www.douyin.com/'));
const OUT = path.resolve(String(arg('out', 'mobile-web/probe-output')));
const HEADED = !!arg('headed', false);
const SCRIPT = arg('script', null);
const WAIT = Number(arg('wait', 15000));
const PROFILE = arg('profile', null); // 复用已登录 profile 时传入

const AB_RE = /ab\/params|mobile\/ab|abtest|abtest_config/i;
const MEDIA_RE = /douyinvod|bytecdn|tos-cn|zjcdn|mime_type=video|mime_type=audio/i;

const out = {
  startedAt: new Date().toISOString(),
  args: { url: URL_ARG, headed: HEADED, script: SCRIPT || null, wait: WAIT, profile: PROFILE || null },
  ab: [],            // { url, method, status, keys, sample }
  manualSwitches: [], // 每次客户端写入 MANUAL_SWITCH 的原样值
  media: [],         // 媒体请求摘要
  console: [],
  errors: [],
  dom: null,
  video: null,
  menu: null,
  misc: {}
};

function stamp() { return new Date().toISOString().slice(11, 23); }

const { chromium } = loadPW();

// 本机没有 playwright 对应版本的浏览器时，直接用已装的 chromium / 系统 Chrome
function findChrome() {
  const envP = process.env.PW_CHROME;
  if (envP && fs.existsSync(envP)) return envP;
  const base = path.join(process.env.LOCALAPPDATA || '', 'ms-playwright');
  try {
    const dirs = fs.readdirSync(base).filter((d) => /^chromium-\d+$/.test(d)).sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]));
    for (const d of dirs) {
      const p = path.join(base, d, 'chrome-win64', 'chrome.exe');
      if (fs.existsSync(p)) return p;
      const p2 = path.join(base, d, 'chrome-win', 'chrome.exe');
      if (fs.existsSync(p2)) return p2;
    }
  } catch (e) {}
  for (const p of ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe']) {
    if (fs.existsSync(p)) return p;
  }
  return undefined;
}
const CHROME = findChrome();
log('chrome binary  :', CHROME || '(playwright 自带)');

fs.mkdirSync(OUT, { recursive: true });
const userDataDir = PROFILE ? path.resolve(String(PROFILE)) : undefined;
const ctx = await chromium.launchPersistentContext(userDataDir || fs.mkdtempSync(path.join(OUT, '_profile-')), {
  headless: !HEADED,
  executablePath: CHROME,
  viewport: { width: 393, height: 852 },
  deviceScaleFactor: 3,
  isMobile: true,
  hasTouch: true,
  userAgent: UA_ARG,
  locale: 'zh-CN',
  timezoneId: 'Asia/Shanghai',
  args: [
    '--disable-blink-features=AutomationControlled',
    '--disable-features=IsolateOrigins,site-per-process'
  ]
});
ctx.setDefaultTimeout(20000);
const page = ctx.pages()[0] || await ctx.newPage();

function log(...a) { console.log(stamp(), ...a); }

// ---------- 初始化脚本：抓 Storage 写入 + 记录 hook ----------
const INIT = `
(function(){
  window.__probe = { writes: [], msgs: [] };
  try {
    var proto = window.Storage && window.Storage.prototype;
    if (proto && proto.setItem) {
      var orig = proto.setItem;
      proto.setItem = function (k, v) {
        try {
          if (String(k) === 'MANUAL_SWITCH') window.__probe.writes.push({ t: Date.now(), s: this === sessionStorage ? 'session' : 'local', k: String(k), v: String(v) });
        } catch (e) {}
        return orig.apply(this, arguments);
      };
    }
    var origRemove = proto && proto.removeItem;
    if (origRemove) {
      proto.removeItem = function (k) {
        try { if (String(k) === 'MANUAL_SWITCH') window.__probe.writes.push({ t: Date.now(), s: this === sessionStorage ? 'session' : 'local', k: String(k), v: '<removed>' }); } catch (e) {}
        return origRemove.apply(this, arguments);
      };
    }
  } catch (e) {}
  try {
    if (!window.TTE_ENV) window.TTE_ENV = {};
    if (!window.TTE_ENV.layoutInitialProps) window.TTE_ENV.layoutInitialProps = {};
  } catch (e) {}
})();
`;
await ctx.addInitScript(INIT);

page.on('console', (m) => {
  const t = m.type();
  if (t === 'error' || t === 'warning' || /dy4k|ab|clarity/i.test(m.text())) {
    out.console.push({ t, text: m.text().slice(0, 400) });
    if (out.console.length < 200) log('console', t, m.text().slice(0, 200));
  }
});
page.on('pageerror', (e) => { out.errors.push(String(e && e.message || e).slice(0, 500)); });
page.on('requestfailed', (r) => {
  const u = r.url();
  if (AB_RE.test(u) || MEDIA_RE.test(u)) out.errors.push('reqfail ' + u.slice(0, 160) + ' ' + (r.failure() && r.failure().errorText));
});

// ---------- AB 响应体抓取 ----------
page.on('response', async (res) => {
  let u;
  try { u = res.url(); } catch (e) { return; }
  if (MEDIA_RE.test(u)) {
    if (out.media.length < 200) {
      out.media.push({ url: u.slice(0, 200), status: res.status(), type: res.request().resourceType() });
    }
    return;
  }
  if (!AB_RE.test(u)) return;
  const entry = { t: stamp(), url: u.slice(0, 300), method: res.request().method(), status: res.status() };
  try {
    const txt = await res.text();
    entry.len = txt.length;
    entry.head = txt.slice(0, 300);
    let j = null;
    try { j = JSON.parse(txt); } catch (e) {}
    if (j) {
      const keys = [];
      (function walk(o, d, p) {
        if (!o || typeof o !== 'object' || d > 4) return;
        for (const k in o) {
          const v = o[k];
          if (typeof v !== 'object') { if (keys.length < 400) keys.push(p + k + '=' + String(v).slice(0, 40)); }
          else walk(v, d + 1, p + k + '.');
        }
      })(j, 0, '');
      entry.keyCount = keys.length;
      entry.keys = keys;
      entry.matchedGears = keys.filter((x) =>
        /auto_clarity_reselect|switch_clarity_timing|smooth_switch_clarity|maxDownSwitchLevel|rebufferDegrade|safeRebufferDegrade|degradeBitrateFactors|use_h266/i.test(x));
    }
  } catch (e) { entry.err = String(e && e.message || e).slice(0, 200); }
  out.ab.push(entry);
  log('AB', entry.status, entry.url.slice(0, 90), 'keys=' + entry.keyCount, (entry.matchedGears || []).join('|'));
});

// ---------- 注入目标脚本（模拟油猴：document-start 前执行） ----------
if (SCRIPT) {
  const code = fs.readFileSync(path.resolve(String(SCRIPT)), 'utf8');
  await ctx.addInitScript({ content: code });
  log('injected script', SCRIPT, code.length, 'bytes');
}

// ---------- 打开页面 ----------
try {
  await page.goto(URL_ARG, { waitUntil: 'domcontentloaded', timeout: 45000 });
} catch (e) {
  out.errors.push('goto: ' + String(e && e.message || e).slice(0, 300));
  log('goto failed', String(e && e.message || e).slice(0, 200));
}
await page.waitForTimeout(WAIT);

// ---------- DOM 采样 ----------
out.dom = await page.evaluate(() => {
  const MAX = 400;
  const attrsOf = (el) => {
    const o = { tag: el.tagName.toLowerCase() };
    if (el.id) o.id = el.id;
    if (el.className && typeof el.className === 'string') o.cls = el.className.slice(0, 200);
    const r = el.getBoundingClientRect();
    o.rect = [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)];
    const cs = getComputedStyle(el);
    o.pos = cs.position; o.z = cs.zIndex; o.disp = cs.display;
    return o;
  };
  const list = (sel) => [].slice.call(document.querySelectorAll(sel)).slice(0, MAX).map(attrsOf);
  // 顶部/底部固定层：最容易是"web 痕迹"的东西
  const fixedish = [].slice.call(document.querySelectorAll('body *')).filter((el) => {
    const cs = getComputedStyle(el);
    if (cs.position !== 'fixed' && cs.position !== 'sticky') return false;
    const r = el.getBoundingClientRect();
    return r.width > 100 && r.height > 20 && r.height < 400;
  }).slice(0, 120).map((el) => {
    const o = attrsOf(el);
    o.text = (el.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 120);
    return o;
  });
  const classFreq = {};
  [].slice.call(document.querySelectorAll('body *')).slice(0, 6000).forEach((el) => {
    if (typeof el.className !== 'string' || !el.className) return;
    el.className.split(/\s+/).forEach((c) => { if (c && c.length < 40) classFreq[c] = (classFreq[c] || 0) + 1; });
  });
  const top = Object.entries(classFreq).sort((a, b) => b[1] - a[1]).slice(0, 200);
  return {
    url: location.href,
    title: document.title,
    htmlLen: document.documentElement.outerHTML.length,
    bodyChildren: [].slice.call(document.body.children).map(attrsOf),
    videos: list('video'),
    fixedish,
    classFreqTop: top,
    textSample: (document.body.innerText || '').replace(/\s+/g, ' ').slice(0, 800),
    sessionStorageKeys: Object.keys(sessionStorage || {}),
    localStorageKeys: Object.keys(localStorage || {}),
    manualNow: sessionStorage.getItem('MANUAL_SWITCH'),
    hasTTE: !!(window.TTE_ENV),
    tteKeys: window.TTE_ENV ? Object.keys(window.TTE_ENV) : null,
    mediaSourceTypes: (function () {
      const out = {};
      try {
        const v = document.createElement('video');
        ['video/mp4; codecs="avc1.42E01E"', 'video/mp4; codecs="hvc1.1.6.L183.B0"', 'video/mp4; codecs="hev1.1.6.L183.B0"',
          'video/mp4; codecs="av01.0.12M.10"', 'video/mp4; codecs="vvc1.1.6.L183.B0"'].forEach((t) => {
          out[t] = !!(v.canPlayType && v.canPlayType(t));
        });
      } catch (e) {}
      return out;
    })()
  };
});

// 视频当前真实解码尺寸
out.video = await page.evaluate(async () => {
  const vs = [].slice.call(document.querySelectorAll('video'));
  const out = [];
  for (const v of vs) {
    let q = null;
    try { q = v.getVideoPlaybackQuality && v.getVideoPlaybackQuality(); } catch (e) {}
    out.push({
      w: v.videoWidth, h: v.videoHeight, paused: v.paused, readyState: v.readyState,
      currentTime: +(v.currentTime || 0).toFixed(2), duration: +(v.duration || 0).toFixed(2),
      src: (v.currentSrc || v.src || '').slice(0, 200),
      frames: q ? q.totalVideoFrames : null, dropped: q ? q.droppedVideoFrames : null,
      parentCls: v.parentElement && typeof v.parentElement.className === 'string' ? v.parentElement.className.slice(0, 100) : null
    });
  }
  return out;
});

// ---------- 尝试点开清晰度菜单，看有没有「超清 4K」 ----------
out.menu = await page.evaluate(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const GEAR_WORDS = /4K|2K|1080|720|540|极速|智能|超清|高清|标清|清晰/;
  const snapshot = () => [].slice.call(document.querySelectorAll('div,span,li,p'))
    .filter((el) => el.children.length === 0)
    .map((el) => (el.innerText || '').trim())
    .filter((t) => t && t.length <= 12 && GEAR_WORDS.test(t));
  const before = snapshot();
  // 找出所有可能是"齿轮/更多"的按钮：小尺寸、有 svg 或 icon、靠近右下
  const cands = [].slice.call(document.querySelectorAll('button,[role="button"],[class*="gear"],[class*="quality"],[class*="Gear"],[class*="Quality"],[class*="setting"],[class*="Setting"],[class*="more"],[class*="More"]')).slice(0, 40);
  const tried = [];
  for (const el of cands) {
    const r = el.getBoundingClientRect();
    if (r.width < 8 || r.height < 8) continue;
    tried.push({ cls: String(el.className || '').slice(0, 80), tag: el.tagName, rect: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)] });
  }
  // 直接按控件标签尝试（抖音网页播放器控件一般有 aria-label / title）
  const labels = ['设置', '清晰度', '更多', '选集', '倍速'];
  const clicked = [];
  for (const lab of labels) {
    const el = document.querySelector('[aria-label*="' + lab + '"],[title*="' + lab + '"]');
    if (el) { try { el.click(); clicked.push(lab); await sleep(600); } catch (e) {} }
  }
  const after = snapshot();
  return { before: before.slice(0, 50), after: after.slice(0, 80), clicked, candidatesTried: tried.slice(0, 40) };
});

// ---------- 把客户端自己写过的 MANUAL_SWITCH 全收回来 ----------
out.manualSwitches = await page.evaluate(() => (window.__probe && window.__probe.writes) || []);
out.misc.dy4k = await page.evaluate(() => {
  try {
    if (!window.dy4k) return null;
    return { state: window.dy4k.state && window.dy4k.state(), cfg: JSON.parse(JSON.stringify(window.dy4k.cfg || {})) };
  } catch (e) { return 'dy4k.state() error: ' + String(e).slice(0, 200); }
});
out.misc.hud = await page.evaluate(() => {
  const els = [].slice.call(document.querySelectorAll('div')).filter((d) => /gear=|no video/.test(d.textContent || '') && d.children.length === 0);
  return els.map((d) => ({ text: d.textContent, style: d.getAttribute('style') }));
});
out.misc.stylesInjected = await page.evaluate(() => {
  const st = document.getElementById('dy4k-style');
  return st ? st.textContent.length : null;
});

fs.mkdirSync(OUT, { recursive: true });
const ts = new Date().toISOString().replace(/[:.]/g, '-');
const jsonPath = path.join(OUT, `probe-${ts}.json`);
fs.writeFileSync(jsonPath, JSON.stringify(out, null, 2), 'utf8');
try {
  const html = await page.content();
  fs.writeFileSync(path.join(OUT, `page-${ts}.html`), html, 'utf8');
  await page.screenshot({ path: path.join(OUT, `shot-${ts}.png`), fullPage: false });
} catch (e) { out.errors.push('snapshot: ' + String(e).slice(0, 200)); }

log('---- summary ----');
log('final url      :', out.dom && out.dom.url);
log('ab responses   :', out.ab.length, out.ab.map((a) => a.url.replace(/^https?:\/\//, '').slice(0, 60)).join(' , '));
log('manual writes  :', out.manualSwitches.length);
log('videos         :', out.video.map((v) => v.w + 'x' + v.h + (v.paused ? '(paused)' : '(playing)')).join(' , ') || 'none');
log('gear words     :', (out.menu && out.menu.after || []).slice(0, 20).join(' | '));
log('saved          :', jsonPath);
console.log(JSON.stringify({ ok: true, json: jsonPath }));

await ctx.close();
