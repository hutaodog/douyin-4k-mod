import fs from 'node:fs';
const P='preload-snippet.js';
let t=fs.readFileSync(P,'utf8');
// XHR 路径也采集档位
const a1 = `                      var j = JSON.parse(t); var n = patchABObj(j, 0);`;
if(t.includes(a1)) t = t.replace(a1, `                      var j = JSON.parse(t); try { captureGears(j); } catch (e7) {} var n = patchABObj(j, 0);`);
// 去掉一次性条目 dump
t = t.replace(/          \/\/ 一次性诊断：档位条目结构[\s\S]*?catch \(e0\) \{\}\n/, '');
fs.writeFileSync(P,t,'utf8');
console.log('xhr capture + dump removed');
