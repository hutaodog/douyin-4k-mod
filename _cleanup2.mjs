import fs from 'node:fs';
const P='preload-snippet.js';
let t=fs.readFileSync(P,'utf8');
const start=t.indexOf('          // 【v1.2 关键修复】给视频数据请求补上 channel=channel_pc_web。');
const end=t.indexOf('          var AB_URL = /ab\\/params|mobile\\/ab|abtest/i;');
if(start<0||end<0){console.log('markers missing');process.exit(1)}
const keep=`          // 视频请求 URL 修正：实测 channel/aid/主机名都不影响档位表，这里保留一个空的钩子位，
          // 方便以后发现别的原因时在这里加（当前不做任何改写）。
          function fixUrl(u) { return u; }

`;
t = t.slice(0,start) + keep + t.slice(end);
fs.writeFileSync(P,t,'utf8');
console.log('removed channel block');
