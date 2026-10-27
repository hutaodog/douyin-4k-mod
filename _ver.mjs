import fs from 'node:fs';
const P='preload-snippet.js';
let t=fs.readFileSync(P,'utf8');
if(!t.includes('dypc4k v1.2')){
  t = t.replace('/* ==== dypc4k begin ==== */', '/* ==== dypc4k begin ==== */\n/* dypc4k v1.2 —— 变更：\n *   1) 不再钉死编码族（客户端要 h265，而 4K/2K 只存在于 h265）\n *   2) 档位表里没有 4K 时，钉该列表的最高档（原来直接 return，导致 2K 视频落 720）\n *   3) 新增"补档位"：用接口返回的 bit_rate 合成播放器条目，补回被客户端裁掉的高档\n *   4) 底部清晰度标签跟随真实解码分辨率\n */');
  fs.writeFileSync(P,t,'utf8');
}
console.log('version tag:', /dypc4k v1\.2/.test(fs.readFileSync(P,'utf8')) ? 'ok' : 'missing');
