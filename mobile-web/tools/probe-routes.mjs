/**
 * 路由探测：同一个域名在不同 UA / 不同路径下，到底给「手机版 App 界面」还是「引流页」还是「桌面版」。
 *
 * 用法：
 *   node mobile-web/tools/probe-routes.mjs                      # 默认一组路由 + 手机 UA
 *   node mobile-web/tools/probe-routes.mjs --ua desktop
 *   node mobile-web/tools/probe-routes.mjs --urls https://www.douyin.com/,https://www.douyin.com/?recommend=1
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { loadPW, UAS, parseArgs, stamp, baseLaunchOptions } from './lib/browser.mjs';

const a = parseArgs(process.argv.slice(2));
const UA = a.ua === 'desktop' ? UAS.desktop : a.ua === 'iphone' ? UAS.iphone : UAS.android;
const OUT = path.resolve(String(a.out || 'mobile-web/probe-output/routes'));
const WAIT = Number(a.wait || 8000);
const URLS = a.urls
  ? String(a.urls).split(',')
  : [
      'https://www.douyin.com/',
      'https://www.douyin.com/?recommend=1',
      'https://www.douyin.com/jingxuan',
      'https://www.douyin.com/hot',
      'https://www.douyin.com/user/self',
      'https://www.douyin.com/video/7686426147004976393'
    ];

fs.mkdirSync(OUT, { recursive: true });
const log = (...m) => console.log(stamp(), ...m);

const { chromium } = loadPW();
const ctx = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(OUT, '_p-')),
  baseLaunchOptions({ headed: !!a.headed, ua: UA }));
log('ua:', UA.slice(0, 60));

const rows = [];
for (const url of URLS) {
  const page = await ctx.newPage();
  let finalUrl = url, err = '';
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 40000 });
    await page.waitForTimeout(WAIT);
    finalUrl = page.url();
  } catch (e) { err = String(e).slice(0, 120); }
  let info = {};
  try {
    info = await page.evaluate(() => {
      const txt = (document.body.innerText || '').replace(/\s+/g, ' ');
      const fixed = [].slice.call(document.querySelectorAll('body *')).filter((el) => {
        const cs = getComputedStyle(el);
        if (cs.position !== 'fixed' && cs.position !== 'sticky') return false;
        const r = el.getBoundingClientRect();
        return r.width > 120 && r.height > 24 && r.height < 160 && r.top > innerHeight * 0.72;
      }).slice(0, 6).map((el) => ({
        cls: String(el.className || '').slice(0, 90),
        text: (el.innerText || '').replace(/\s+/g, ' ').slice(0, 60),
        rect: [Math.round(el.getBoundingClientRect().left), Math.round(el.getBoundingClientRect().top),
               Math.round(el.getBoundingClientRect().width), Math.round(el.getBoundingClientRect().height)]
      }));
      const cls = {};
      [].slice.call(document.querySelectorAll('body *')).slice(0, 6000).forEach((el) => {
        if (typeof el.className !== 'string' || !el.className) return;
        el.className.split(/\s+/).forEach((c) => { if (c && c.length < 44) cls[c] = (cls[c] || 0) + 1; });
      });
      return {
        title: document.title,
        textHead: txt.slice(0, 260),
        videos: document.querySelectorAll('video').length,
        videoSized: [].slice.call(document.querySelectorAll('video')).filter((v) => v.videoWidth).length,
        bottomFixed: fixed,
        markers: {
          openApp: /打开抖音|打开APP|下载抖音/.test(txt),
          appLike: /推荐|关注|朋友|我的/.test(txt),
          login: /登录/.test(txt),
          commentInput: /善语结善缘|留下你的精彩评论|说点什么/.test(txt)
        },
        topClasses: Object.entries(cls).sort((x, y) => y[1] - x[1]).slice(0, 14).map(([k, v]) => k + ':' + v),
        url: location.href
      };
    });
  } catch (e) { info = { err: String(e).slice(0, 160) }; }
  const row = { url, finalUrl, err, ...info };
  rows.push(row);
  log('---', url);
  log('   final :', finalUrl, err ? 'ERR ' + err : '');
  log('   videos:', row.videos, 'sized:', row.videoSized, '| title:', String(row.title || '').slice(0, 40));
  log('   text  :', String(row.textHead || '').slice(0, 120));
  log('   marker:', JSON.stringify(row.markers || {}));
  log('   bottom:', JSON.stringify(row.bottomFixed || []).slice(0, 260));
  log('   cls   :', (row.topClasses || []).join(' ').slice(0, 220));
  await page.screenshot({ path: path.join(OUT, url.replace(/[^\w]+/g, '_').slice(0, 60) + '.png') }).catch(() => {});
  await page.close();
}

const ts = new Date().toISOString().replace(/[:.]/g, '-');
fs.writeFileSync(path.join(OUT, `routes-${ts}.json`), JSON.stringify({ ua: UA, rows }, null, 2), 'utf8');
log('saved', path.join(OUT, `routes-${ts}.json`));
await ctx.close();
