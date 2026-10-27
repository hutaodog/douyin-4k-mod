/**
 * 离线回归测试：用一个假的抖音网页（本地 route 拦截，不走网络）验证 userscript 的各条逻辑。
 *
 * 覆盖：
 *   1) fetch 拦截的 AB 改写：has_2k 被置 1、auto_clarity_reselect 等被清零、vid 字段保留
 *   2) XHR 拦截的 AB 改写（responseText / response 两条 getter）
 *   3) MANUAL_SWITCH 心跳：缺失/被删/被改回低档时自动补回 超清 4K
 *   4) window.abTestData 兜底：has2K 被补成 1
 *   5) 界面注入：style、viewport 改写、左侧导航隐藏、底部标签栏、沉浸模式
 *   6) HUD 文本
 *   7) 移动版引流页：弹提示、不做沉浸模式
 *
 * 用法：node mobile-web/tools/test-userscript.mjs
 * 退出码 0 = 全过；1 = 有失败
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { loadPW, baseLaunchOptions, stamp } from './lib/browser.mjs';

const SCRIPT_PATH = path.resolve('mobile-web/douyin-4k.user.js');
const CODE = fs.readFileSync(SCRIPT_PATH, 'utf8');
const log = (...m) => console.log(stamp(), ...m);

const AB_PAYLOAD = {
  status_code: 0,
  data: {
    abr_config: {
      val: {
        algoArg: {
          maxDownSwitchLevel: 1, rebufferDegrade: 1, safeRebufferDegrade: 0,
          limitFirstDownSwitch: 3, dangerBuffer: 15
        },
        isOpenAutoDefi: true, isPlayAutoDefi: true, abrDriveMode: 1
      },
      vid: '17081649'
    },
    auto_clarity_reselect: { val: 1, vid: '12922345' },
    switch_clarity_timing: { val: 1, vid: '11111111' },
    smooth_switch_clarity: { val: 1, vid: '22222222' },
    has_2k: { val: 0, vid: '33333333' },
    use_h266_client: { val: 1, vid: '44444444' },
    degradeBitrateFactors: { val: [0.5, 0.8], vid: '55555555' }
  }
};

const DESKTOP_HTML = `<!doctype html><html><head>
<meta name="viewport" content="width=device-width,initial-scale=0.5,user-scalable=no,viewport-fit=cover">
<style>
  body{margin:0;background:#111;color:#eee}
  #root,#dark{width:100%}
  #douyin-navigation{width:60px;height:800px;float:left;background:#1a1a1a}
  #douyin-right-container{overflow:hidden}
  .player-wrap{width:393px;height:400px;background:#000}
  .douyin-player{width:100%;height:100%}
  video{width:100%;height:100%;background:#000}
</style></head><body>
<div id="root"><div id="dark" class="windows-os header-ui is-mobile-pc">
  <div id="douyin-navigation">
    <a href="/jingxuan">精选</a><a href="/">推荐</a><a href="/follow">关注</a>
    <a href="/search">搜索</a><a href="/user/self">我的</a>
  </div>
  <div id="douyin-right-container">
    <header class="top-search">搜索 更多 通知 消息 投稿 登录</header>
    <div class="player-wrap"><div class="douyin-player"><video id="v1"></video></div></div>
    <div class="comment-list">评论</div>
  </div>
</div></div>
<script>
  // 模拟客户端：进页面就删 MANUAL_SWITCH
  try { sessionStorage.removeItem('MANUAL_SWITCH'); } catch (e) {}
  window.__mock = {};
  window.__mock.fetchAB = async function () {
    const r = await fetch('/service/2/abtest_config/?aid=6383');
    return await r.json();
  };
  window.__mock.xhrAB = function () {
    return new Promise(function (res, rej) {
      const x = new XMLHttpRequest();
      x.open('GET', '/service/2/abtest_config/?aid=6383&xhr=1');
      x.onreadystatechange = function () {
        if (x.readyState === 4) {
          try { res({ viaText: JSON.parse(x.responseText), viaResponse: x.response }); } catch (e) { rej(e); }
        }
      };
      x.send();
    });
  };
</script>
</body></html>`;

const MOBILE_HTML = `<!doctype html><html><head>
<meta name="viewport" content="width=device-width,initial-scale=1,user-scalable=0">
</head><body>
<div id="root"><div class="container">
  <div class="adapt-login-header"><div class="login-header-left">抖音精选 App</div><div class="btn-wrap">打开看看</div></div>
  <div class="video-container horizontal-video"><video id="video-player"></video>
    <div class="footer"><div class="bottom-btn-con-new-dyselect">打开抖音精选App看精彩视频</div></div>
    <div class="right-con"><img class="d-icon"></div>
  </div>
</div></div>
</body></html>`;

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail });
  log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? '  ' + String(detail).slice(0, 220) : ''));
}

const { chromium } = loadPW();
const browser = await chromium.launch({ ...baseLaunchOptions({ ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36' }), headless: true });

async function newPage(html) {
  const ctx = await browser.newContext({
    viewport: { width: 393, height: 852 }, isMobile: true, hasTouch: true,
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
  });
  await ctx.addInitScript({ content: CODE });
  await ctx.route('**/*', async (route) => {
    const u = route.request().url();
    if (/abtest_config/.test(u)) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(AB_PAYLOAD) });
    }
    if (/\.js|\.css|\.png|\.jpg|\.svg|\.woff/.test(u)) return route.fulfill({ status: 404, body: '' });
    return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: html });
  });
  const page = await ctx.newPage();
  await page.goto('https://www.douyin.com/video/7697934740980125171', { waitUntil: 'domcontentloaded' });
  return { ctx, page };
}

// ---------- 桌面版场景 ----------
log('--- desktop shell ---');
{
  const { ctx, page } = await newPage(DESKTOP_HTML);
  await page.waitForTimeout(1500);

  // 1) fetch AB
  const f = await page.evaluate(() => window.__mock.fetchAB());
  const d = f.data || {};
  check('fetch: has_2k.val = 1', d.has_2k && Number(d.has_2k.val) === 1, JSON.stringify(d.has_2k));
  check('fetch: has_2k.vid 保留', d.has_2k && d.has_2k.vid === '33333333', JSON.stringify(d.has_2k));
  check('fetch: auto_clarity_reselect.val = 0', d.auto_clarity_reselect && Number(d.auto_clarity_reselect.val) === 0, JSON.stringify(d.auto_clarity_reselect));
  check('fetch: switch_clarity_timing.val = 0', d.switch_clarity_timing && Number(d.switch_clarity_timing.val) === 0);
  check('fetch: smooth_switch_clarity.val = 0', d.smooth_switch_clarity && Number(d.smooth_switch_clarity.val) === 0);
  check('fetch: maxDownSwitchLevel = 0', Number(d.abr_config.val.algoArg.maxDownSwitchLevel) === 0, d.abr_config.val.algoArg.maxDownSwitchLevel);
  check('fetch: rebufferDegrade = 0', Number(d.abr_config.val.algoArg.rebufferDegrade) === 0);
  check('fetch: use_h266_client 不动（避坑第 10 条）', Number(d.use_h266_client.val) === 1, JSON.stringify(d.use_h266_client));
  check('fetch: degradeBitrateFactors 不动', JSON.stringify(d.degradeBitrateFactors.val) === '[0.5,0.8]');

  // 2) XHR AB
  const x = await page.evaluate(() => window.__mock.xhrAB());
  check('xhr: responseText 被改写', x.viaText.data && Number(x.viaText.data.has_2k.val) === 1, JSON.stringify(x.viaText.data && x.viaText.data.has_2k));
  check('xhr: response 被改写', (function () {
    var rr = x.viaResponse;
    var obj = rr && typeof rr === 'string' ? JSON.parse(rr) : rr;
    return !!(obj && obj.data && Number(obj.data.has_2k.val) === 1);
  })(), typeof x.viaResponse === 'string' ? x.viaResponse.slice(0, 100) : JSON.stringify(x.viaResponse).slice(0, 100));
  check('xhr: 结构未被破坏（data.abr_config.val 存在）', !!(x.viaText.data && x.viaText.data.abr_config && x.viaText.data.abr_config.val));

  // 3) MANUAL_SWITCH 心跳
  const ms1 = await page.evaluate(() => sessionStorage.getItem('MANUAL_SWITCH'));
  check('storage: MANUAL_SWITCH 被补回', !!ms1 && /"gearType":-2/.test(ms1), ms1);

  await page.evaluate(() => sessionStorage.removeItem('MANUAL_SWITCH'));
  await page.waitForTimeout(1200);
  const ms2 = await page.evaluate(() => sessionStorage.getItem('MANUAL_SWITCH'));
  check('storage: 被删后 1.2s 内自动补回', !!ms2 && /"gearType":-2/.test(ms2), ms2);

  // 手动切到 1080P 之后会被抢回去吗？（期望：会被抢，因为不是 auto；这是文档里说的取舍）
  await page.evaluate(() => sessionStorage.setItem('MANUAL_SWITCH', JSON.stringify({ done: 1, gearType: 0, gearClarity: '0', gearName: '智能', qualityType: 1 })));
  await page.waitForTimeout(900);
  const ms3 = await page.evaluate(() => sessionStorage.getItem('MANUAL_SWITCH'));
  check('storage: 被改成"智能"后补回 4K', !!ms3 && /"gearType":-2/.test(ms3), ms3);

  // 4) window.abTestData 兜底
  await page.evaluate(() => { window.abTestData = { has2K: 0, autoClarityReselect: 1 }; });
  await page.waitForTimeout(1400);
  const ab2 = await page.evaluate(() => ({ has2K: window.abTestData.has2K, acr: window.abTestData.autoClarityReselect }));
  check('abTestData: has2K 被补成 1', Number(ab2.has2K) === 1, JSON.stringify(ab2));

  // 5) 界面（mock 里的 <video> 没有真实媒体，先伪造解码尺寸再触发沉浸）
  await page.evaluate(() => {
    const v = document.querySelector('video');
    if (v) {
      Object.defineProperty(v, 'videoWidth', { get: () => 1080, configurable: true });
      Object.defineProperty(v, 'videoHeight', { get: () => 1920, configurable: true });
    }
    try { window.dy4k.immersive(true); } catch (e) {}
  });
  await page.waitForTimeout(300);
  const ui = await page.evaluate(() => {
    const st = document.getElementById('dy4k-style');
    const nav = document.getElementById('douyin-navigation');
    const tab = document.getElementById('dy4k-tabbar');
    const hud = document.getElementById('dy4k-hud');
    const vp = document.querySelector('meta[name="viewport"]').getAttribute('content');
    return {
      style: !!st, styleLen: st ? st.textContent.length : 0,
      navHidden: nav ? getComputedStyle(nav).display : 'missing',
      tabLinks: tab ? tab.querySelectorAll('.dy4k-tab').length : 0,
      tabText: tab ? tab.innerText.replace(/\s+/g, '|') : '',
      hud: hud ? hud.textContent : null,
      vp,
      stage: !!document.querySelector('.dy4k-stage'),
      immersive: document.documentElement.classList.contains('dy4k-immersive'),
      stageCls: (document.querySelector('.dy4k-stage') || {}).className || ''
    };
  });
  check('ui: style 注入', ui.style && ui.styleLen > 500, ui.styleLen);
  check('ui: 左侧导航被隐藏', ui.navHidden === 'none', ui.navHidden);
  check('ui: 底部标签栏有 4 项', ui.tabLinks === 4, ui.tabText);
  check('ui: 标签栏是 推荐/关注/朋友/我的，且没有精选和AI抖音',
    /推荐/.test(ui.tabText) && /关注/.test(ui.tabText) && /朋友/.test(ui.tabText) && /我的/.test(ui.tabText) &&
    !/精选/.test(ui.tabText) && !/AI/.test(ui.tabText), ui.tabText);
  check('ui: 沉浸模式已开', ui.immersive, ui.stageCls);
  check('ui: 舞台标在播放器容器上', /douyin-player/.test(ui.stageCls), ui.stageCls);
  // 策略变了：不再改站点 viewport（改了会把视频页播放器搞坏），改成同步 --dy4k-k 缩放补偿
  check('ui: 不改站点的 viewport', /initial-scale=0\.5/.test(ui.vp), ui.vp);
  const hudOn = await page.evaluate(() => {
    try { window.dy4k.hud(true); } catch (e) {}
    return new Promise((r) => setTimeout(() => {
      const h = document.getElementById('dy4k-hud');
      r(h ? h.textContent : null);
    }, 400));
  });
  check('hud: dy4k.hud(true) 后能显示档位', !!hudOn && /超清 4K/.test(hudOn), JSON.stringify(hudOn));

  // 6) dy4k API
  const api = await page.evaluate(() => {
    const before = window.dy4k.state();
    window.dy4k.target('2k');
    const after = sessionStorage.getItem('MANUAL_SWITCH');
    window.dy4k.target('4k');
    return { before, after };
  });
  check('api: dy4k.state() 可用', !!api.before && !!api.before.cfg, JSON.stringify(api.before && api.before.cfg).slice(0, 120));
  check('api: dy4k.target("2k") 改档位', /"gearType":-1/.test(api.after), api.after);

  await ctx.close();
}

// ---------- 移动版引流页场景 ----------
log('--- mobile shell ---');
{
  const { ctx, page } = await newPage(MOBILE_HTML);
  await page.waitForTimeout(1800);
  const m = await page.evaluate(() => ({
    toast: (document.getElementById('dy4k-toast') || {}).textContent || '',
    toastShown: (document.getElementById('dy4k-toast') || {}).style ? document.getElementById('dy4k-toast').style.display : '',
    tabbar: !!document.getElementById('dy4k-tabbar'),
    immersive: document.documentElement.classList.contains('dy4k-immersive'),
    bannerHidden: getComputedStyle(document.querySelector('.adapt-login-header')).display,
    appBtnHidden: getComputedStyle(document.querySelector('.bottom-btn-con-new-dyselect')).display,
    hud: (document.getElementById('dy4k-hud') || {}).textContent || ''
  }));
  check('mobile: 弹出"请切桌面版"提示', /桌面版网站/.test(m.toast), m.toast.slice(0, 80));
  check('mobile: 不建底部标签栏', !m.tabbar);
  check('mobile: 不做沉浸模式', !m.immersive);
  check('mobile: 隐藏"打开App"顶条', m.bannerHidden === 'none', m.bannerHidden);
  check('mobile: 隐藏"打开抖音精选App"按钮', m.appBtnHidden === 'none', m.appBtnHidden);
  await ctx.close();
}

await browser.close();

const fail = results.filter((r) => !r.ok);
log('');
log('==== ' + (results.length - fail.length) + '/' + results.length + ' passed ====');
if (fail.length) {
  for (const f of fail) log('  FAILED:', f.name, f.detail ? String(f.detail).slice(0, 200) : '');
  process.exit(1);
}
process.exit(0);
