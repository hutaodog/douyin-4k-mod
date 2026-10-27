import fs from 'node:fs';
const P='preload-snippet.js';
let t=fs.readFileSync(P,'utf8');
// 修复：这段代码在 var W = window 之前执行，W 还是 undefined
t = t.replace("      W.__dypc4kGearMap = GEARMAP;", "      window.__dypc4kGearMap = GEARMAP;");
t = t.replace("      W.__dypc4kCapture = captureGears;", "      window.__dypc4kCapture = captureGears;");
t = t.replace("      W.__dypc4kFill = fillMissing;", "      window.__dypc4kFill = fillMissing;");
fs.writeFileSync(P,t,'utf8');
console.log('fixed W->window in gear block');
