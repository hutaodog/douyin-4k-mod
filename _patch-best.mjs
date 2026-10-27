import fs from 'node:fs';

const P = 'preload-snippet.js';
let t = fs.readFileSync(P, 'utf8');

if (t.includes('effTgt')) {
  console.log('already patched');
  process.exit(0);
}

const oldBlock = `          var list = defList(p);
          if (!list) return;
          var tgt = entryIn(list, CFG.gear);
          if (tgt) {`;

const newBlock = `          var list = defList(p);
          if (!list) return;
          var tgt = entryIn(list, CFG.gear);

          // 【v1.2】列表里没有目标档（4K）时，退而取"该列表里的最高档"。
          // 之前这块直接 return，导致"只有 2K 的视频"被客户端自己落在 720 上不动。
          var effTgt = tgt, effDef = CFG.gear;
          if (!effTgt) {
            var bestE = null;
            for (var bi = 0; bi < list.length; bi++) {
              var e2 = list[bi];
              if (!e2 || e2.isBackup || e2.definition == null) continue;
              var d2 = Number(e2.definition);
              if (isNaN(d2)) continue;
              if (!bestE || d2 < Number(bestE.definition)) bestE = e2;
            }
            if (bestE) { effTgt = bestE; effDef = Number(bestE.definition); }
          }

          if (tgt) {`;

if (!t.includes(oldBlock)) {
  console.error('anchor 1 not found');
  process.exit(1);
}
t = t.replace(oldBlock, newBlock);

// 把"钉回去"那段改成用 effTgt / effDef
const oldPin = `          // 3) 列表里有 4K，但没在 4K 上 —— 钉回去
          if (!tgt || atTarget(cur)) return;
          var vkey;
          try { vkey = (p.video && p.video.currentSrc) || ('i' + idx); } catch (e) { vkey = 'i' + idx; }
          reverts[vkey] = (reverts[vkey] || 0) + 1;
          if (reverts[vkey] > 3) { post('giveup', 'cur=' + cur + ' reverts>3'); return; }
          post('revert', 'cur=' + cur + ' -> ' + CFG.gear + ' (#' + reverts[vkey] + ')');
          try { p.changeDefinition(tgt, p.curDefinition); } catch (e) { post('err', 'changeDefinition: ' + e.message); }`;

const newPin = `          // 3) 没在"该列表能给的最高档"上 —— 钉回去（目标可能是 4K，也可能是这条视频最高的 2K）
          if (!effTgt || Number(cur) === Number(effDef)) return;
          var vkey;
          try { vkey = (p.video && p.video.currentSrc) || ('i' + idx); } catch (e) { vkey = 'i' + idx; }
          vkey = vkey + '|' + effDef;
          reverts[vkey] = (reverts[vkey] || 0) + 1;
          if (reverts[vkey] > 5) { post('giveup', 'cur=' + cur + ' eff=' + effDef + ' reverts>5'); return; }
          post('revert', 'cur=' + cur + ' -> ' + effDef + (effDef === Number(CFG.gear) ? ' (4K)' : ' (该视频最高)') + ' #' + reverts[vkey]);
          try { p.changeDefinition(effTgt, p.curDefinition); } catch (e) { post('err', 'changeDefinition: ' + e.message); }`;

if (!t.includes(oldPin)) {
  console.error('anchor 2 not found');
  process.exit(1);
}
t = t.replace(oldPin, newPin);

fs.writeFileSync(P, t, 'utf8');
console.log('patched: fallback-to-best + effDef pin');
