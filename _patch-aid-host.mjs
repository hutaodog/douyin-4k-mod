import fs from 'node:fs';

const P = 'preload-snippet.js';
let t = fs.readFileSync(P, 'utf8');

if (t.includes('// v1.3')) {
  console.log('already patched');
  process.exit(0);
}

const anchor = `              if (!VID_URL.test(u)) return u;`;
const inject = `              if (!VID_URL.test(u)) return u;
              // v1.3：实测缺 aid 时服务端只给 5 档（最高 720），补齐
              try {
                if (!/[?&]aid=/.test(u)) u += (u.indexOf('?') >= 0 ? '&' : '?') + 'aid=6383';
              } catch (e2) {}
              // v1.3：客户端用了 www-hj.douyin.com（-hj 域名给的是裁剪档位），改回主域
              try {
                if (u.indexOf('//www-hj.douyin.com/') >= 0) {
                  u = u.replace('//www-hj.douyin.com/', '//www.douyin.com/');
                  post('reqfix', 'HOST www-hj -> www : ' + u.slice(0, 160));
                }
              } catch (e3) {}`;

if (!t.includes(anchor)) { console.error('anchor missing'); process.exit(1); }
t = t.replace(anchor, inject);
fs.writeFileSync(P, t, 'utf8');
console.log('patched: force aid=6383 + rewrite www-hj host');
