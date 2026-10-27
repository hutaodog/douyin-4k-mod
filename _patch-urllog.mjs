import fs from 'node:fs';

const P = 'preload-snippet.js';
let t = fs.readFileSync(P, 'utf8');

if (t.includes('__dypc4kUrlLog')) {
  console.log('already instrumented');
  process.exit(0);
}

const anchor = `          function fixUrl(u) {
            try {
              if (typeof u !== 'string' || u.length < 10) return u;
              if (!VID_URL.test(u)) return u;`;

const inject = `          var __uSeen = {};
          function fixUrl(u) {
            try {
              if (typeof u !== 'string' || u.length < 10) return u;
              if (!VID_URL.test(u)) return u;
              // 只读诊断：把经过渲染层的视频请求记下来（每个 URL 只记一次）
              try {
                var key = u.slice(0, 220);
                if (!__uSeen[key] && Object.keys(__uSeen).length < 60) {
                  __uSeen[key] = 1;
                  post('req', String(u).slice(0, 300));
                }
              } catch (e0) {}`;

if (!t.includes(anchor)) { console.error('anchor missing'); process.exit(1); }
t = t.replace(anchor, inject);

// 同时把"改写发生"也记一笔
const anchor2 = `              return u + (u.indexOf('?') >= 0 ? '&' : '?') + 'channel=channel_pc_web';`;
const inject2 = `              var out = u + (u.indexOf('?') >= 0 ? '&' : '?') + 'channel=channel_pc_web';
              try { post('reqfix', 'ADDED channel -> ' + out.slice(0, 200)); } catch (e1) {}
              return out;`;

if (!t.includes(anchor2)) { console.error('anchor2 missing'); process.exit(1); }
t = t.replace(anchor2, inject2);

fs.writeFileSync(P, t, 'utf8');
console.log('instrumented url logging');
