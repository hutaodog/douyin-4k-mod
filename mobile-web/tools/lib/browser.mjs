/**
 * 探针共用的小工具：找 playwright-core / 找 Chromium 可执行文件 / 命令行参数。
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const PW_CANDIDATES = [
  'C:/Users/Ayanami/AppData/Roaming/npm/node_modules/rea-agents/node_modules/playwright-core',
  'playwright-core'
];

export function loadPW() {
  for (const c of PW_CANDIDATES) {
    try { return require(c); } catch (e) { /* next */ }
  }
  throw new Error('找不到 playwright-core（npm i -D playwright-core 或设置 PW_CORE 环境变量）');
}

/** 本机 ms-playwright 里的 chromium，退化成系统 Chrome / Edge */
export function findChrome() {
  const envP = process.env.PW_CHROME;
  if (envP && fs.existsSync(envP)) return envP;
  const base = path.join(process.env.LOCALAPPDATA || '', 'ms-playwright');
  try {
    const dirs = fs.readdirSync(base)
      .filter((d) => /^chromium-\d+$/.test(d))
      .sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]));
    for (const d of dirs) {
      for (const sub of ['chrome-win64', 'chrome-win']) {
        const p = path.join(base, d, sub, 'chrome.exe');
        if (fs.existsSync(p)) return p;
      }
    }
  } catch (e) { /* ignore */ }
  for (const p of [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe'
  ]) {
    if (fs.existsSync(p)) return p;
  }
  return undefined;
}

export const UAS = {
  android: 'Mozilla/5.0 (Linux; Android 13; ONEPLUS A5000) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36',
  iphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  desktop: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
};

export function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const name = a.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) { out[name] = next; i++; }
    else out[name] = true;
  }
  return out;
}

export function stamp() {
  return new Date().toISOString().slice(11, 23);
}

export function baseLaunchOptions({ headed = false, ua = UAS.desktop, autoplay = true, extraArgs = [] } = {}) {
  const args = [
    '--disable-blink-features=AutomationControlled',
    '--disable-features=IsolateOrigins,site-per-process',
    ...extraArgs
  ];
  if (autoplay) args.push('--autoplay-policy=no-user-gesture-required');
  return {
    headless: !headed,
    executablePath: findChrome(),
    viewport: { width: 393, height: 852 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
    userAgent: ua,
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
    args
  };
}
