# 交接文档：手机端「固定 4K + 类 App 界面」

> 交接对象：在新会话里继续做这件事的人（或另一个 AI 助手）。
> 本文自带全部背景、结论、代码位置、验证方法和待办——不用读之前的对话。
>
> - 初版：2026-10-24（脚本已写好、未验证）
> - 二版：2026-10-24（脚本 v2.0.0，Chromium 手机模拟 + 桌面版 UA 实测拿到 4K）
> - **三版：2026-10-24（交付形态升级为 APK：`../mobile-app/`，Redmi K40 真机实测 4K）**
>
> ⚠️ **先看这条**：网页脚本只是"最容易验证"的形态。真正给手机上用的是
> **`../mobile-app/`（安卓壳 App）** —— 系统 WebView 打底 + 原生 MediaPlayer 硬解 4K，
> 因为本机 WebView 104 不支持 HEVC，网页里最高只能 1080P。
> 细节与真机数据：[`../docs/09-安卓壳App-K40实测.md`](../docs/09-安卓壳App-K40实测.md)，
> 构建/安装：[`../mobile-app/README.md`](../mobile-app/README.md)。

---

## 0. 一句话背景

抖音 PC 端的"固定 4K"已跑通（preload 注入 + 改写 AB）。手机改包路线已证明失败
（重签名 → 服务端判「当前版本过低」）。所以走 **自己带壳**：不 root、不改包、登录正常。
壳里的网页层就是本文这套注入脚本（`douyin-4k.user.js`），4K 播放由壳的原生播放器兜底。

**本轮的结论：这条路成立，但和初版文档的设想差三点**——
① 必须用**桌面版网站**（移动版 UA 是引流页，只给 720P 水印流）；
② 必须把 AB 的 **`has_2k` 强制成 `1`**（服务端这次给的是 `2`，实测 2 不解锁 4K）；
③ 必须**关掉播放器的自动清晰度**，否则带宽一抖就从 4K 掉到 540P。

---

## 1. 目标与验收标准

**目标**：手机浏览器打开抖音网页版，做到
1. 清晰度固定最高（4K），关掉"看着看着自动降档"；
2. 界面尽量像 App（去 web 痕迹、全屏、无地址栏观感）；
3. 登录正常（网页登录，不触发 APK 签名风控）。

**验收标准（硬指标）与当前状态**

| 硬指标 | 状态 | 证据 |
|---|---|---|
| HUD 显示 `2160×3840`（或 `3840×2160`） | ✅ 达成 | `2160×3840`：视频 `7689731341721564658`；`3840×2160`：`7697934740980125171` |
| HUD 显示 `gear=超清 4K` | ✅ 达成 | 客户端还弹了"清晰度已经切换至 超清 4K" |
| 连续播放 ≥30 秒不降分辨率 | ✅ 达成 | 同一视频 +9s → +44s 一直 `3840×2160`（35 秒） |
| 切 5 条以上视频，多数能到 4K | ⚠️ 4 条里 3 条 | 见第 7 节"个别视频客户端自己不给 4K" |

> 验证环境：Windows + Playwright Chromium（393×852 视口 / DPR 3 / 触摸 / 桌面版 UA）。
> 真机（Kiwi）仍需你复验一次，方法见第 5 节。

---

## 2. 当前资产清单

```
F:\ddddddd\douyin-4k-mod\
├─ mobile-app\                 ★★ 真正给手机上用的交付物（APK）
│   ├─ AndroidManifest.xml / res\ / java\com\dypc4k\douyink4\
│   │   ├─ MainActivity.java      WebView 壳（桌面 UA / HTML 注入 / 全屏 / JS 桥 / 返回键）
│   │   ├─ PlayerActivity.java    原生 4K 播放器（MediaPlayer + 宽高比 + 双击缩放）
│   │   └─ HttpMediaSource.java   带 Referer 的 Range 数据源（4K 直链 403 的解法）
│   ├─ assets\dy4k.js          构建时从 ../mobile-web/douyin-4k.user.js 拷进来
│   ├─ build.ps1               无 Gradle 构建：aapt2 → javac → d8 → zipalign → apksigner
│   ├─ tools\acceptance.mjs    真机一键验收（CDP + logcat，自动出表）
│   ├─ tools\device.mjs        设备操作台（info / eval / nav / shot / log）
│   ├─ shots\                  真机截图 + acceptance.json
│   └─ README.md               构建、安装、用法、限制
├─ mobile-web\                 网页层（壳内复用，也可单独当油猴脚本用）
│   ├─ douyin-4k.user.js      ★ 注入脚本 v2.0.0（node --check 通过）
│   ├─ README.md              安装 + 验收 + 限制
│   ├─ HANDOVER.md            本文
│   ├─ tools\                 探针/测试工具（见第 8 节）
│   │   ├─ lib\browser.mjs    找 playwright-core / Chromium
│   │   ├─ test-userscript.mjs   离线回归 31 项断言（不联网）
│   │   ├─ probe-play.mjs        播放探针：分辨率曲线 / 档位 / HUD / 诊断
│   │   ├─ probe-layout.mjs      真实 DOM & 类名 & 浮层（写 CSS 用）
│   │   ├─ probe-mobile-web.mjs  AB 请求与响应键名、MANUAL_SWITCH 真实写入
│   │   ├─ extract-gears.mjs     这条视频服务端给了哪些档位（有没有 2160P）
│   │   ├─ find-code.mjs         线上 chunk 下载 + 正则检索
│   │   ├─ grep-chunks.mjs       本地 chunk 检索
│   │   └─ summarize-play.mjs    play-*.json → 曲线表
│   └─ probe-output\           实测数据（json/png，可复查）
├─ docs\
│   ├─ 01…07                  PC 端文档（02 原理、05 避坑必读）
│   ├─ 08-手机网页版4K验证记录.md   网页层证据链（含线上代码原文）
│   └─ 09-安卓壳App-K40实测.md     ★★ 真机 4K 证据链（WebView 无 HEVC / Referer / 原生解码）
└─ preload-snippet.js         PC 端完整实现（第 1、2 层从它抽出来的）
```

### 手机端最终形态（一句话）

```
APK（WebView 壳 + 桌面 UA + 注入脚本打底）
   └─ 视频页右下角「原生 2160x3840 HEVC」按钮
        └─ PlayerActivity（MediaPlayer 硬解，HttpMediaSource 带 Referer 拉流）
```

---

## 3. 技术原理（与 PC 端同源，但有 3 个手机版差异）

### 3.1 第 1 层：`sessionStorage['MANUAL_SWITCH']`

```js
{ "done":1, "gearType":-2, "gearClarity":"20", "gearName":"超清 4K", "qualityType":1, "clarityReal":[...] }
```

档位表（`gearType` / `gearClarity`）：`-3/"30"` 4K HDR、`-2/"20"` 超清 4K、`-1/"10"` 2K、
`1/"5"` 1080P、`2/"4"` 720P、`0/"0"` 智能。

客户端在页面加载时 `removeItem` 它，所以要**定时补写**（脚本 400ms 心跳 + 启动期加密）。

### 3.2 第 2 层：AB 改写（真正止血）

线上响应结构（实测 `GET https://www.douyin.com/service/2/abtest_config/`）：

```json
{ "data": {
  "auto_clarity_reselect":     {"val":1,"vid":12922345},
  "switch_clarity_timing":     {"val":1,"vid":…},
  "smooth_switch_clarity":     {"val":1,"vid":…},
  "abr_config": {"val":{"algoArg":{"maxDownSwitchLevel":1,"rebufferDegrade":1,"safeRebufferDegrade":0},
                        "isOpenAutoDefi":true,"isPlayAutoDefi":true,"abrDriveMode":1},"vid":17888440},
  "has_2k":                    {"val":2,"vid":90332711},
  "bitrate_selector": {"val":{"white_list":["normal_1080_0","normal_720_0",…]}}
} }
```

脚本改：

```
has_2k → 1                              ← ★ 手机端的钥匙（服务端发的是 2，不认；见 3.3）
auto_clarity_reselect / switch_clarity_timing / smooth_switch_clarity → val=0
maxDownSwitchLevel / rebufferDegrade / safeRebufferDegrade → 0
isOpenAutoDefi / isPlayAutoDefi → false  ← 关"自动清晰度"
```

**只改 `val`，不动 `vid`**。老脚本把整个键赋 `0`，会毁掉结构。

### 3.3 第 3 层差异：`isHas2K()` 才是门禁

`client-entry_10c01432.c547b4c0.js` 模块 `785079`（导出 `fR`）原文：

```js
let c=()=>{let n=o.Le.getConfig(o.gI.AbtestData);
  if(n?.has2K) return !0;                                     // ① AB has_2k
  let i=["Win32","Windows"].includes(navigator.platform),
      r=["Mac68K","MacPPC","Macintosh","MacIntel"].includes(navigator.platform);
  return i&&hardwareConcurrency>8 || r&&hardwareConcurrency>=8 || Ohos&&hardwareConcurrency>=8
};
```

档位列表过滤（`isHas2K()` 为 false 时）：

```js
if (userselection) { if (!isHas2K()) a = a.filter(不保留 adapt_lowest_4_1 / adapt_lowest_1440_1); }
```

→ 手选 4K 一旦生效就走这条路，`isHas2K()` 为 false 时 4K/2K 会被直接从菜单里删掉。
**实测这个匿名会话服务端下发的是 `data.has_2k.val = 2`，而 2 不解锁 4K**
（E 组实验两次复现：4K 档重建时被剔掉、播放停在 720×1280）；强制改成 `1` 才稳定拿到 4K（C 组）。
AB 键声明表里就是 `{key:"has_2k", alias:"has2K", defaultVal:0}`
（`client-entry_2.a5a52241.js`），另外还有同款 `{key:"has_hdr", alias:"hasHDR"}`。

脚本用两条通道保证：① 响应改写把 `has_2k.val` 置 1（`vid` 原样保留）；
② 轮询 `window.abTestData`（客户端把 AB 数据挂在这上面，alias `has2K`），不是 1 就补。

### 3.4 4K 只有 HEVC

`/aweme/v1/web/aweme/detail/` 的 `video.bit_rate[]` 里：

```
2160p 3840x2160  adapt_lowest_4_1  qt=72  4113kbps  h265  ← 4K 只有 h265
1440p 2560x1440  adapt_lowest_1440_1 qt=7 2580kbps  h265
1920p 1080x1920  normal_1080_0     qt=1   2869kbps  h264  ← h264 天花板是 1080P
```

所以 `MediaSource.isTypeSupported('video/mp4; codecs="hvc1…"')` 必须是 true。

---

## 4. 脚本结构（`douyin-4k.user.js` v2.0.0）

| 段落 | 函数 | 作用 |
|---|---|---|
| 配置 | `CFG` / `PRESETS` | `target` / `abPatch` / `force2k` / `forceHdr` / `killAutoDefi` / `uiRestyle` / `hud` / `tabbar` / `debug` |
| 第 1 节 | `Storage.prototype` 钩子 + `tick()` | 学真实结构当模板；缺失/被改时补写 4K；记录客户端降档次数 |
| 第 2 节 | `patchABObj()` / `installABPatch()` | 拦 `fetch`/`XHR`（含 `responseText`/`response` getter），改 6 类键 + 强置 `has_2k`；`window.abTestData` 兜底轮询 |
| 第 3 节 | `CSS` + `applyUI()` + `immersive()` + `buildTabbar()` + `hideOffscreenLayers()` | 类 App：隐藏左侧导航/顶栏/引流条，播放器钉全屏，底部标签栏，隐藏漏进可视区的右侧浮层，viewport 改写 |
| 第 4 节 | `renderHud()` | 分辨率 / 档位 / 实测 fps（rVFC）/ 实测码率（XHR progress + fetch 流计数）/ AB 命中 / HEVC / has_2k |
| 末尾 | `window.dy4k` | `state()` `target()` `hud()` `tabbar()` `immersive()` `force2k()` `pickGear()` `debug()` `toast()` |

**为什么仍然没有"播放器锁"**：AB 改写 + `has_2k` + 关自动清晰度已经把问题解决；
再去抓 `xgplayer` 实例属于加戏，且网页端实例入口不稳定。

---

## 5. 安装与验证（真机）

1. 手机装 **Kiwi Browser** → 装 **Tampermonkey** → 导入 `douyin-4k.user.js`；
2. 打开 `https://www.douyin.com/` → **菜单里勾「桌面版网站」→ 刷新**（关键，没有这一步脚本会弹提示）；
3. 登录；
4. 看 HUD：
   - `2160x3840 / 3840x2160` + `超清 4K` + `hevc ✓ has2k✓` → 成功；
   - `hevc ✗` → 浏览器不给 HEVC，此路不通；
   - `has2k✗` → AB 没命中，见第 7 节；
   - 出现"请切桌面版网站"提示 → 还是移动版网页；
5. Kiwi 菜单 →「添加到主屏幕」，从桌面图标进入（无地址栏，观感最像 App）。

**调试**

```js
dy4k.state()        // 一次看全：manual / clarityReal / has2K / autoDefi / hevc / video
dy4k.debug(true)    // 控制台 [dy4k] 日志（MANUAL_SWITCH、ab(xhr) changed N）
dy4k.pickGear('超清 4K')   // 个别视频不自动上 4K 时，手动点开菜单后执行
```

**PC 上复现（不用手机）**

```powershell
cd F:\ddddddd\douyin-4k-mod
node mobile-web/tools/probe-play.mjs --url https://www.douyin.com/video/7689731341721564658 `
     --seconds 40 --script mobile-web/douyin-4k.user.js
node mobile-web/tools/summarize-play.mjs
```

---

## 6. TODO（按优先级，已完成的打勾）

- [x] **真机路线可行性**：确认移动版 UA 不可行 / 桌面版 UA 可行（证据在 `docs/08`）
- [x] **4K 能不能拿到**：能。缺的是 `has_2k`，已定位并验证（3840×2160 / 2160×3840）
- [x] **CSS 选择器改成真实类名**：`#douyin-navigation`、`#douyin-header`、`.adapt-login-header`、
      `.bottom-btn-con-new-dyselect`、`.douyin-player`、`.xgplayer` 等（探针抓的）
- [x] **底部标签栏**：从网页版左侧导航克隆文字与链接，渲染成底部 tab bar
- [x] **视频区域全屏化**：`dy4k-stage` 钉 `inset:0`，隐藏 web 外壳与右侧漏入浮层
- [x] **HUD 增加实测 fps / 码率**：rVFC 帧率 + XHR progress/fetch 流字节统计（2 秒窗口）
- [x] **离线回归测试**：`tools/test-userscript.mjs`，31 项断言全过
- [x] **安卓 App（APK）**：`mobile-app/` 自建 WebView 壳，无 Gradle 构建，`adb install` 可装
- [x] **K40 真机上真的出 4K**：原生 MediaPlayer 硬解，`2160×3840` / `3840×2160` 均实测
- [x] **一键真机验收**：`node mobile-app/tools/acceptance.mjs --shot`，自动出表
- [x] **WebView 无 HEVC 的兜底**：视频页出「原生 4K」按钮，把 4K 直链交给原生播放器
- [x] **4K 直链 403 的兜底**：自写 `HttpMediaSource` 带 `Referer` 做 Range 拉流
- [ ] **账号态差异**：登录后 AB 返回值可能不同（尤其 `has_2k`）；脚本强置策略对两种状态都成立，
      但仍建议抓一份登录态的 `abtest_config` 存档到 `probe-output/`
- [ ] **升级系统 WebView 到 107+**：升级后网页内也能直接 4K，原生播放器就当兜底
      （`adb shell dumpsys webviewupdate` 可看当前版本）
- [ ] **原生播放器补功能**：弹幕、倍速、选集、进度记忆
- [ ] **弹幕/评论面板**：网页侧只隐藏外壳，评论抽屉（`.commentBoard_*`）没有专门处理
- [ ] **多视频连播**：SPA 内切换视频时 `immersive()` 会重钉，但"自动切下一条"仍靠页面自带行为

---

## 7. 故障排查表（按症状）

| 症状 | 可能原因 | 处理 |
|---|---|---|
| 弹"检测到移动版网页" | 没切桌面版网站 | 浏览器菜单 → 桌面版网站 → 刷新 |
| HUD 不出现 | 脚本没运行 / `@match` 不覆盖 | Tampermonkey 里确认启用；看控制台有没有 `[dy4k]` |
| HUD 显示 `hevc ✗` | 浏览器不给 HEVC | 换 Kiwi/Chrome；iOS Safari 基本没戏 |
| HUD 显示 `has2k✗` | AB 改写没命中 | `dy4k.debug(true)` 看有没有 `ab(xhr) changed N`；没有就扩 `AB_URL` 正则 |
| 菜单里有「超清 4K」但一选就掉回 1080P | `has_2k` 没生效（老脚本行为 / 服务端原值 2） | 确认脚本是 v2.0.0 且 `CFG.force2k=true`；`dy4k.state().has2K` 应为 `1` |
| 菜单只剩「标清 540P / 智能」 | 个别视频客户端自己不给 4K（接口里有 gear 也没用） | `dy4k.pickGear('超清 4K')` 或换视频 |
| 播一会儿掉档 | 网速抖动触发自动清晰度 | 确认 `killAutoDefi` 生效（`dy4k.state().autoDefi` 为 false/false） |
| 界面没变 | 还在移动版网页 / 类名改版 | 切桌面版；用 `probe-layout.mjs` 重抓类名 |
| 右侧有半截浮层漏进来 | 桌面版按 786px 排版被缩到 393px | 脚本 `hideOffscreenLayers()` 已处理；没有就 `dy4k.debug(true)` 看元素 |
| 画面被裁切 | 页面播放器自己的 `object-fit` | 脚本对 stage 里的 video 设了 `contain`；若仍裁切，是该视频自带裁切版本 |

---

## 8. 工具链速查

| 工具 | 用途 |
|---|---|
| `tools/test-userscript.mjs` | 本地假页面 + route 拦截，31 项断言（不联网，改了脚本先跑它） |
| `tools/extract-gears.mjs` | 展开某条视频全部档位（判断"没给 4K"还是"给了没选"） |
| `tools/probe-play.mjs` | 真页面播放 40s：分辨率曲线 / 菜单文字 / HUD / AB / 诊断 |
| `tools/summarize-play.mjs` | 把 `play-*.json` 变成曲线表 |
| `tools/probe-layout.mjs` | DOM 骨架 + 类名关键词表 + 固定浮层 + 截图 |
| `tools/probe-mobile-web.mjs` | AB 请求/响应键名、`MANUAL_SWITCH` 真实写入 |
| `tools/find-code.mjs` | 下载线上 chunk 到 `probe-output/code/_chunks` 再 grep |
| `tools/grep-chunks.mjs` | 在本地 chunk 里按正则找上下文（`isHas2K` 就是这么找到的） |

> ⚠️ 一律在 `F:\ddddddd\douyin-4k-mod` 下执行 node：上级目录有个 **0 字节 package.json**，
> 会让 node 报 `ERR_INVALID_PACKAGE_CONFIG`（`docs/05` 第 16 条）。
> playwright-core 从 `rea-agents` 全局安装借；浏览器用本机 `ms-playwright\chromium-*`。

---

## 9. 边界（不要浪费时间的方向）

1. **不要试图把网页版变成原生 App**：控件/手势/播放器内核都是网页实现；
2. **不要试图让改包版能登录**：签名不同 → 服务端风控（`docs/06`）；
3. **不要改客户端本地 AB 数据库**：会被服务端覆盖（`docs/05` 第 3 条）；
4. **不要在网页版做"播放器锁"**：AB 改写已经足够；
5. **不要一次改太多 AB 键**：PC 端踩过——多改 `use_h266_client` / `degradeBitrateFactors`
   会让部分视频只剩 720P/540P（`docs/05` 第 10 条）。本轮只加了 `has_2k` 和两个 `*AutoDefi`，
   并且都能用 `dy4k.force2k(false)` 单独关掉。
6. **不要指望移动版网页**：`playwm` + `ratio=720p` 是引流流，改不出来。

---

## 10. 关键结论备忘（省得重新验证）

| 结论 | 证据位置 |
|---|---|
| 移动版 UA = 引流页，无 AB、无菜单、720P 水印流 | `docs/08` 第一节 |
| 桌面版 UA 在手机上会被识别成 `is-mobile-pc`，viewport 是 `initial-scale=0.5` | `docs/08` 第一节 |
| 4K 档 `adapt_lowest_4_1` 存在且只有 HEVC | `docs/08` 第二节 |
| 手机能不能选 2K/4K 由 `isHas2K()` 决定，钥匙是 AB `has_2k` 且必须等于 `1`（服务端的 `2` 无效） | `docs/08` 第三节 + 第零节 E 组 |
| AB 响应是 `data.<key>.{val,vid}`，不能整体替换 | `docs/08` 第三节 |
| 只改 5 个 AB 键 + 写 MANUAL_SWITCH → 4K 项消失、锁 1080P（反例） | `docs/08` 第零节 B 组 |
| 加 `has_2k` 后 → 3840×2160 / 2160×3840，35 秒不掉档 | `docs/08` 第零节 C 组 |
| 8.7.0 调试端口开不出来 | `docs/05` 第 1 条 |
| 手机改包必被风控判"版本过低" | `docs/06` 第四节 |
| 降档不走 `changeDefinition`，拦 API 无效 | `docs/05` 第 7 条 |

---

## 11. 下一步建议

1. **真机复验**（半小时内能出结论）：Kiwi + 桌面版网站 + 登录 → 看第 1 节四项硬指标；
2. 通了 → 把 `dy4k.target('4khdr')` 试一下 HDR 档（需要设备真支持 10bit）；
3. 不通但 `hevc ✗` → 换内核/换机，或退回"固定 1080P + 关降档"（脚本 `dy4k.target('1080p')`）；
4. 想继续打磨观感：评论抽屉、搜索页、个人页的 web 痕迹（类名用 `probe-layout.mjs` 重抓）。
