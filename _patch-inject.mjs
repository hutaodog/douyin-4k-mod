import fs from 'node:fs';

const P = 'preload-snippet.js';
let t = fs.readFileSync(P, 'utf8');

if (t.includes('__dypc4kInject')) {
  console.log('already patched');
  process.exit(0);
}

// ---------- 1) 在主世界加：采集接口档位 + 合成播放器档位条目 ----------
const anchor1 = `      // ============ 让客户端的清晰度标签跟上真实画质 ============`;
const inject1 = `      // ================= 档位补充（v1.2）=================
      // 实测：接口返回的 bit_rate 里有 4K/2K 档，但客户端只把其中一部分放进了播放器的
      // definition.list（例如某条视频接口给了 13 档含 1440p，播放器里却只有 720/540）。
      // 这里把接口档位按 uri 索引起来，发现播放器缺高档时，就合成一个条目塞进列表。
      // 字段与播放器自带条目一一对应（uri / url[{src}] / size / bitrate / definition / isH265 …）。
      var GEARMAP = {};    // uri -> [{def, gear}]
      W.__dypc4kGearMap = GEARMAP;
      function tierDef(h) {
        return h >= 2160 ? -2 : h >= 1400 ? -1 : h >= 1000 ? 1 : h >= 700 ? 2 : 3;
      }
      function captureGears(j) {
        try {
          if (!j || typeof j !== 'object') return;
          var stack = [j], guard = 3000;
          while (stack.length && guard-- > 0) {
            var v = stack.pop();
            if (!v || typeof v !== 'object') continue;
            if (Array.isArray(v)) { for (var i = 0; i < v.length && i < 80; i++) stack.push(v[i]); continue; }
            if (v.video && Array.isArray(v.video.bit_rate) && v.video.bit_rate.length) {
              for (var gi = 0; gi < v.video.bit_rate.length; gi++) {
                var g = v.video.bit_rate[gi];
                var pa = (g && g.play_addr) || {};
                var uri = String(pa.uri || '');
                if (!uri) continue;
                var arr = GEARMAP[uri] || (GEARMAP[uri] = []);
                var h = Math.min(pa.width || 0, pa.height || 0) || Math.max(pa.width || 0, pa.height || 0) || 0;
                arr.push({ def: tierDef(h), h: h, g: g });
              }
            }
            for (var k in v) { var c = v[k]; if (c && typeof c === 'object') stack.push(c); }
          }
        } catch (e) {}
      }
      W.__dypc4kCapture = captureGears;

      // 用接口档位合成一个播放器能用的条目
      function synthEntry(rec) {
        try {
          var g = rec.g, pa = g.play_addr || {};
          var urls = (pa.url_list || []).map(function (u) { return { src: u }; });
          if (!urls.length) return null;
          return {
            vid: String(pa.uri || ''),
            size: pa.data_size || 0,
            uri: String(pa.uri || ''),
            url: urls,
            bitrate: g.bit_rate || 0,
            realBitrate: g.bit_rate || 0,
            definition: rec.def,
            qualityType: g.quality_type,
            duration: 0,
            isH265: !!(g.is_h265 || g.is_bytevc1),
            gearName: g.gear_name,
            isH266: false, isHDR: false,
            vtype: 'normal', mediaType: 'video',
            codecType: (g.is_h265 || g.is_bytevc1) ? 'h265' : 'h264',
            fps: g.FPS || 30,
            width: pa.width, height: pa.height,
            format: g.format
          };
        } catch (e) { return null; }
      }

      // 给某个播放器的列表补上缺失的高档（返回补进来的档位定义值，没补则返回 null）
      function fillMissing(list) {
        try {
          if (!list || !list.length) return null;
          var vid = String((list[0] && list[0].uri) || '');
          if (!vid) return null;
          var cands = GEARMAP[vid];
          if (!cands || !cands.length) return null;
          // 当前列表里最好的档位
          var bestDef = 99;
          for (var i = 0; i < list.length; i++) {
            var d = Number(list[i] && list[i].definition);
            if (!isNaN(d) && d < bestDef) bestDef = d;
          }
          // 接口里最好的档位
          var best = null;
          for (var j = 0; j < cands.length; j++) {
            if (!best || cands[j].def < best.def) best = cands[j];
          }
          if (!best || !(best.def < bestDef)) return null;
          var entry = synthEntry(best);
          if (!entry) return null;
          list.push(entry);
          return best.def;
        } catch (e) { return null; }
      }
      W.__dypc4kFill = fillMissing;

      // ============ 让客户端的清晰度标签跟上真实画质 ============`;

if (!t.includes(anchor1)) { console.error('anchor1 missing'); process.exit(1); }
t = t.replace(anchor1, inject1);

// ---------- 2) 在 step() 里调用 fillMissing，并把目标切到补进来的档 ----------
const anchor2 = `          // 3) 没在"该列表能给的最高档"上 —— 钉回去（目标可能是 4K，也可能是这条视频最高的 2K）`;
const inject2 = `          // 2.5) 播放器列表缺高档？用接口档位补进来，并把目标改成补进来的那一档
          try {
            var filled = fillMissing(list);
            if (filled !== null) {
              post('inject', 'added definition=' + filled + ' (uri=' + String((list[0] || {}).uri || '').slice(-16) + ')');
              effTgt = entryIn(list, filled);
              effDef = filled;
            }
          } catch (e5) {}

          // 3) 没在"该列表能给的最高档"上 —— 钉回去（目标可能是 4K，也可能是这条视频最高的 2K）`;

if (!t.includes(anchor2)) { console.error('anchor2 missing'); process.exit(1); }
t = t.replace(anchor2, inject2);

// ---------- 3) fetch / XHR 响应里调用 captureGears ----------
const anchor3 = `                  var n = patchABObj(j, 0);
                  stat.fetch++;`;
const inject3 = `                  try { captureGears(j); } catch (e6) {}
                  var n = patchABObj(j, 0);
                  stat.fetch++;`;

if (!t.includes(anchor3)) { console.error('anchor3 missing'); process.exit(1); }
t = t.replace(anchor3, inject3);

fs.writeFileSync(P, t, 'utf8');
console.log('patched: gear capture + fillMissing + inject');
