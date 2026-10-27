import fs from 'node:fs';
const P = 'preload-snippet.js';
let t = fs.readFileSync(P, 'utf8');
const before = t.length;
// 1) 去掉 channel 补写 + aid 补写 + host 改写
t = t.replace(/              \/\/ v1\.3：实测缺 aid[\s\S]*?catch \(e3\) \{\}\n/, '');
t = t.replace(/              \/\/ v1\.3：客户端用了 www-hj[\s\S]*?catch \(e4\) \{\}\n/, '');
// 2) 去掉只读 URL 日志
t = t.replace(/              \/\/ 只读诊断：把经过渲染层的视频请求记下来（每个 URL 只记一次）[\s\S]*?catch \(e0\) \{\}\n/, '');
// 3) 去掉 reqfix 记录
t = t.replace(/              var out = u \+ \(u\.indexOf\('\?'\) >= 0 \? '&' : '\?'\) \+ 'channel=channel_pc_web';\n              try \{ post\('reqfix'[\s\S]*?\n              return out;/, "              return u + (u.indexOf('?') >= 0 ? '&' : '?') + 'channel=channel_pc_web';");
fs.writeFileSync(P, t, 'utf8');
console.log('cleanup:', before, '->', t.length);
