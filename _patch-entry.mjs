import fs from 'node:fs';
const P='preload-snippet.js';
let t=fs.readFileSync(P,'utf8');
if(t.includes('__dypc4kEntryDump')){console.log('already');process.exit(0)}
// 在 step() 里加一次性 dump：把档位条目的键和首个条目打出来
const anchor = "          var list = defList(p);\n          if (!list) return;";
const inject = `          var list = defList(p);
          if (!list) return;
          // 一次性诊断：档位条目结构
          try {
            if (!W.__dypc4kEntryDump && list.length) {
              W.__dypc4kEntryDump = 1;
              post('entrykeys', JSON.stringify(Object.keys(list[0])));
              post('entry', JSON.stringify(list[0]).slice(0, 900));
            }
          } catch (e0) {}`;
if(!t.includes(anchor)){console.error('anchor missing');process.exit(1)}
t=t.replace(anchor,inject);
fs.writeFileSync(P,t,'utf8');
console.log('entry dump added');
