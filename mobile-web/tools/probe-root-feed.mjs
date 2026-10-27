/**
 * 试验：首页 `/` 被客户端路由重定向到 /jingxuan，把重定向拦掉看它到底渲染什么。
 * 如果拦掉之后是"全屏竖向 feed"，那就找到了真正的推荐页。
 */
import fs from 'node:fs';
import path from 'node:path';
import { loadPW, UAS, baseLaunchOptions, stamp } from './lib/browser.mjs';

const OUT = path.resolve('mobile-web/probe-output/root-feed');
fs.mkdirSync(OUT, { recursive: true });
const log = (...m) => console.log(stamp(), ...m);

const { chromium } = loadPW();
const ctx = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(OUT, '_p-')),
  baseLaunchOptions({ ua: UAS.desktop }));

await ctx.addInitScript({ content: `
(function(){
  var block = function(url){
    try { return typeof url === 'string' && /jingxuan/.test(url); } catch(e){ return false; }
  };
  var rp = history.replaceState, pp = history.pushState;
  history.replaceState = function(s,t,u){ if(block(u)) { window.__dy4kBlocked=(window.__dy4kBlocked||0)+1; return; } return rp.apply(history, arguments); };
  history.pushState  = function(s,t,u){ if(block(u)) { window.__dy4kBlocked=(window.__dy4kBlocked||0)+1; return; } return pp.apply(history, arguments); };
})();
` });

const page = await ctx.newPage();
page.on('framenavigated', (f) => { if (f === page.mainFrame()) log('  nav ->', f.url().slice(0, 90)); });
await page.goto('https://www.douyin.com/', { waitUntil: 'domcontentloaded', timeout: 45000 }).catch((e) => log('goto err', String(e).slice(0, 100)));
await page.waitForTimeout(12000);

const info = await page.evaluate(() => {
  const vs = [...document.querySelectorAll('video')];
  return {
    url: location.href,
    blocked: window.__dy4kBlocked || 0,
    videos: vs.map((v) => ({ w: v.videoWidth, h: v.videoHeight, paused: v.paused })),
    text: (document.body.innerText || '').replace(/\s+/g, ' ').slice(0, 220),
    swipeHints: document.querySelectorAll('[class*="swiper"],[class*="Swiper"]').length,
    player: !!document.querySelector('.basePlayerContainer,.xgplayer,[class*="douyin-player"]')
  };
});
log(JSON.stringify(info, null, 1).slice(0, 1200));
await page.screenshot({ path: path.join(OUT, 'root.png') });
log('shot:', path.join(OUT, 'root.png'));

// 再试一下：拦掉重定向后手动往 feed 走
await page.waitForTimeout(1000);
await ctx.close();
