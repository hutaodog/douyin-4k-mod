import fs from 'node:fs';

const P = 'preload-snippet.js';
let t = fs.readFileSync(P, 'utf8');

if (t.includes('__dypc4kFixUrl')) {
  console.log('already patched');
  process.exit(0);
}

// 1) 在 AB_URL 定义前插入 URL 修正器
const anchor1 = "          var AB_URL = /ab\\/params|mobile\\/ab|abtest/i;";
const inject1 = `          // 【v1.2 关键修复】给视频数据请求补上 channel=channel_pc_web。
          // 实测：同一视频，带这个参数返回 11~14 档（最高 1440/2160）；
          //       不带时服务端只给 5 档（最高 720，档位名变成 720_2_1 这种），
          //       正好就是播放器手里那份"只有 720/540"的表。
          var VID_URL = /\\/aweme\\/v\\d\\/web\\//;
          function fixUrl(u) {
            try {
              if (typeof u !== 'string' || u.length < 10) return u;
              if (!VID_URL.test(u)) return u;
              if (/[?&]channel=channel_pc_web(&|$)/.test(u)) return u;
              if (/[?&]channel=[^&]*/.test(u)) return u.replace(/([?&])channel=[^&]*/, '$1channel=channel_pc_web');
              return u + (u.indexOf('?') >= 0 ? '&' : '?') + 'channel=channel_pc_web';
            } catch (e) { return u; }
          }
          window.__dypc4kFixUrl = fixUrl;

          var AB_URL = /ab\\/params|mobile\\/ab|abtest/i;`;

if (!t.includes(anchor1)) { console.error('anchor1 missing'); process.exit(1); }
t = t.replace(anchor1, inject1);

// 2) fetch 里对 URL 做修正（字符串或 Request 两种情况）
const anchor2 = `            W.fetch = function (input, init) {
              var url = '';
              try { url = String(typeof input === 'string' ? input : (input && input.url) || ''); } catch (e) {}
              var p = of.apply(this, arguments);`;
const inject2 = `            W.fetch = function (input, init) {
              var url = '';
              try { url = String(typeof input === 'string' ? input : (input && input.url) || ''); } catch (e) {}
              // 补 channel 参数（只在需要时重建请求）
              try {
                var fixed = fixUrl(url);
                if (fixed !== url) {
                  if (typeof input === 'string') { input = fixed; url = fixed; }
                  else if (typeof Request !== 'undefined' && input instanceof Request) {
                    input = new Request(fixed, input); url = fixed;
                  }
                }
              } catch (e) {}
              var p = of.apply(this, arguments);`;

if (!t.includes(anchor2)) { console.error('anchor2 missing'); process.exit(1); }
t = t.replace(anchor2, inject2);

// 3) XHR open 里改 URL
const anchor3 = `            XO.prototype.open = function (m, u) { try { this.__dypc4kUrl = String(u || ''); } catch (e) {} return xopen.apply(this, arguments); };`;
const inject3 = `            XO.prototype.open = function (m, u) {
              try {
                var fu = fixUrl(String(u || ''));
                if (fu !== String(u || '')) { arguments[1] = fu; u = fu; }
                this.__dypc4kUrl = String(u || '');
              } catch (e) {}
              return xopen.apply(this, arguments);
            };`;

if (!t.includes(anchor3)) { console.error('anchor3 missing'); process.exit(1); }
t = t.replace(anchor3, inject3);

fs.writeFileSync(P, t, 'utf8');
console.log('patched: channel=channel_pc_web URL fixer (fetch + xhr)');
