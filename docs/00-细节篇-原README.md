# 抖音 PC 客户端「推荐页最高 1080P、切一次 4K 才恢复」——REA 结论与 4K 锁定方案

> 📚 **整理版文档在 `docs/`，建议从这里开始读：**
> - `docs/01-总览与使用.md` —— 当前装了什么、怎么装/卸/换档
> - `docs/02-原理篇-为什么抖音默认不是4K.md` —— 默认 1080P 与"8 秒掉档"的成因（含代码位置与日志）
> - `docs/03-实现篇-固定4K.md` —— preload 注入点、四层机制、核心代码
> - `docs/04-实现篇-右键视频详情.md` —— 菜单注入、实时面板、码率/帧率测量算法
> - `docs/05-避坑指南.md` —— 20 个坑（现象 → 原因 → 正确做法）
> - `docs/06-安卓端尝试记录.md` —— 手机端为什么走不通

> 目标：`D:\软件\抖音\douyin`（客户端 8.7.0，Electron 36.4，网页层 `www.douyin.com`）
> 分析日期：2026-10-24 · 分析对象：安装目录 + `%APPDATA%\douyin` 运行时数据 + 线上 web 包

---

## 一、一句话结论

抖音 PC 客户端的「手动清晰度」**只存在 sessionStorage 的 `MANUAL_SWITCH` 里，而且每次页面加载时客户端会主动把它删掉**（`pC(MANUAL_SWITCH)` = `removeItem`）。
没有这个键时，推荐流播放器走的是**自适应码率（ABR）白名单**，这套白名单按 CPU 核数分档，**最高只列到 `normal_1080_0`（1080P）**，所以「直接进推荐页滑动，最高全是 1080P」。

你手动切一次 4K 后，`MANUAL_SWITCH` 有了值，播放器构造时 `userselection` 就非空，于是**跳过了白名单 + 码率过滤**，直接用你手选的档位——这就是「切一次之后，来回滑大部分都是 4K」。
但它是 **sessionStorage**，客户端 sessionStorage 不落盘，**关掉抖音就没了**，下次又回到 1080P。客户端里根本没有「记住清晰度」这个持久化设置。

这不是 bug，是产品设计：清晰度被当成"本次会话内的临时偏好"，而推荐流的默认必须自适应、封顶 1080P。

**已在这台机器上修好并实测**：preload 补丁把该键锁在 `gearType:-2 / gearClarity:"20" / 超清 4K`，
重启客户端不丢；并且**在渲染层改写了服务端 AB 配置里的自动降档开关**，所以第 8 秒也不会再自己降档。
真机确认：4K 视频全程 4K（详见"三点七、最终解法"）。
`install-preload.ps1` 一条命令安装，`uninstall-preload.ps1` 还原。

---

## 二、证据链（都可以自己复核）

### 1）档位枚举与文案 —— `chunk player-Clarity.bcdc1fa4.js`、`client-entry~6f4ee80d.40c52456.js`

```js
// 8 档 / 7 档两套编号 + 字符串码 + 数值 gearType + 中文文案
r = {HD4KHDR:8, HD4K:7, HD2K:6, Hd:5, Clear:4, Smooth:3, Fast:2, Auto:1, ...}
o = {HD4KHDR:7, HD4K:6, HD2K:5, Hd:4, Clear:3, Smooth:2, Auto:1, ...}
a = {HD4KHDR:"30", HD4K:"20", HD2K:"10", Hd:"5", Clear:"4", Smooth:"3", Fast:"2", Auto:"0"}   // gearClarity
s = {HD4KHDR:-3, HD4K:-2, HD2K:-1, Hd:1, Clear:2, Smooth:3, Fast:4, Auto:0}                   // gearType
c = {HD4KHDR:"超清4K HDR", HD4K:"超清 4K", HD2K:"超清 2K",
     Hd:"高清 1080P", Clear:"高清 720P", Smooth:"标清 540P", Fast:"极速", Auto:"智能"}          // 菜单文案
```

> 注意 `超清 4K` 那一项在未登录时渲染成「登录即享」——**4K 需要登录**。

### 2）存储键与读写语义 —— `client-entry~192ceba9`（键名）+ `client-entry~5.46f927bf`（模块 389，实现）

```js
SessionStorageKeys = { manualSwitch: "MANUAL_SWITCH", ... }        // 键名
G   = k     => JSON.parse(sessionStorage.getItem(k))               // 读（解析 JSON）
t_  = (k,v) => sessionStorage.setItem(k, JSON.stringify(v))        // 写
pC  = k     => sessionStorage.removeItem(k)                        // 删  ← 关键
```

### 3）每次页面加载主动清空 —— `client-entry~4.e7ecfc84.js`（根布局挂载）

```js
useEffect(() => {
  C.pC(SessionStorageKeys.manualSwitch);   // ← 一进 app 就把 MANUAL_SWITCH 删掉
  ...
}, []);
```

**这就是"关掉重开就回到 1080P"的直接原因**：不是没保存，是每次加载都被清掉。

### 4）播放器构造时读它决定档位 —— `async_routes-route.2cc2c67d.js`

```js
// 三处构造播放器配置，都是同一个写法
a2({ awemeInfo, abtestData,
     userselection: (0,l$.G)(L.SessionStorageKeys.manualSwitch)?.gearType })
```

### 5）有它 / 没它，走两条完全不同的过滤分支 —— `as()`（偏移 300645）

```js
as = (list, abtest, awemeInfo, codec, userselection, enableSr, disableBitRateFilter) => {
  if (userselection || disableBitRateFilter) {
    // 手动选了清晰度：只做 4K 能力检查，不再按白名单/码率裁剪
    if (!isHas2K()) a = a.filter(name => !/adapt_lowest_4_1|adapt_lowest_1440_1/.test(name));
  } else {
    // 没选：先按 white_list 白名单裁，再按 quality_filter 码率区间裁
    a = au(ad(a, white_list /* 默认 ai */, ...), quality_filter /* 默认 at */, ...);
  }
}
```

### 6）默认白名单封顶 1080P —— `client-entry~6f4ee80d.40c52456.js`（偏移 656209 ~ 659358）

按 `navigator.hardwareConcurrency` 选 ABR 配置：

| 核心数 | white_list 里的最高档 | 实际上限 |
|---|---|---|
| ≤ 3 核 | `normal_720_0 … adapt_lowest_720_1` | **720P** |
| 4–7 核 | `normal_1080_0` | **1080P** |
| ≥ 8 核（你的机器 32 核） | `normal_1080_0` | **1080P** |
| > 8 核且满足 DT 条件 | `normal_1440_0` | 1440P |

**没有任何一档把 4K（`adapt_lowest_4_1` / `normal_4_*`）放进自适应白名单**——自适应永远不会自己升到 4K。
同时 `quality_filter` 还限制了码率（例如 `normal_1080_0: {upper: 1.3e6}`，即 1080P 也只给到 ~1.3 Mbps）。

### 7）手动切一次之后，为什么整段会话都是 4K —— `async_routes-route.2cc2c67d.js`

```js
dd = ({player, config, awemeInfo}) => {
  let n = SessionStorageKeys.manualSwitch 的 gearType;
  player.isPlaying
    ? (player.config.userSelectDefinition !== n && dr({player, gearType:n, ...}), ...)
    : (player.config.userSelectDefinition !== n ? (dr(...), player.start()) : ...);
}
// dr(): player.config.userSelectDefinition = gearType;
```

`MANUAL_SWITCH` 一旦有值，**每个新播放器实例都会带上 `userselection`，并且每次播放都会校正 `userSelectDefinition`**——所以在推荐页里"来回滑动"能持续 4K。

### 8）运行时佐证（你这台机器）

* `%APPDATA%\douyin\Default\Session Storage\leveldb` 里只有 Chromium 的记账键
  `namespace-<guid>-https://www.douyin.com/`，**没有任何用户键被持久化**；
* 分析时抖音正在运行（PID 14652，12:37 启动），本次会话里没有 `MANUAL_SWITCH` 条目 →
  与"默认 1080P"一致；
* 推荐流请求 `GET https://www.douyin.com/aweme/v1/web/tab/feed/…` 的
  `aweme_pc_rec_raw_data` 里只有 `is_dash_user:1 / related_recommend:1 / …`，
  **没有任何画质参数** → 档位 100% 由前端 `MANUAL_SWITCH` 决定，服务端不管你选了什么。

### 9）客户端本体只是壳

* `resources/app.asar`（15 MB，2313 个文件）里没有 feed 播放器业务代码，
  主进程逻辑被编译进 `app.asar.unpacked\__META-INF__\Common.Build-*.node`（自定义序列化，非明文）；
* 页面由 `app.asar.unpacked\preload.js`（41 KB，CANS/Annie JSBridge 容器）注入 `TTE_ENV` 后加载 `www.douyin.com`；
* 所以"清晰度"这件事完全发生在网页层，**不需要动 asar，只需要在网页层写入那一个 sessionStorage 键**。

---

## 三、方案（已按实测结果排序）

> **实测结论先看这条**：8.7.0 客户端把远程调试口封了。
> `douyin.exe --remote-debugging-port=92258` 启动后，主进程命令行里确实带着这个开关，
> 但 **92258 从未 listen**；换 `--inspect=9339` 同样不开口（`EnableNodeCliInspectArguments` 那类加固）。
> 所以 CDP / Node inspector 这条路在 8.7.0 上**不可用**，能落地的只有 preload 补丁。

### 方案 A（永久、已在真机跑通）：preload 补丁 ✅

`install-preload.ps1` 把一段注入代码追加到
`D:\软件\抖音\douyin\8.7.0\resources\app.asar.unpacked\preload.js` 末尾
（原文件备份成 `preload.dypc4k.bak`）。preload 在网页脚本**之前**执行，每帧、每次启动都会先把键写好。

```bat
powershell -ExecutionPolicy Bypass -File install-preload.ps1                 :: 默认 4k
powershell -ExecutionPolicy Bypass -File install-preload.ps1 -Target 4khdr
powershell -ExecutionPolicy Bypass -File install-preload.ps1 -WithQualityProbe
powershell -ExecutionPolicy Bypass -File uninstall-preload.ps1
```

注入内容做三件事：

1. 页面脚本跑之前就把 `sessionStorage['MANUAL_SWITCH']` 写成目标档位；
2. 启动阶段密集补写（0/30/80/160/320/600/1000/1600 ms），之后 400 ms 常驻复查 ——
   客户端根布局 mount 时 `pC(MANUAL_SWITCH)` 的清除会在下一次复查（≤400 ms）内被拉回；
3. 把客户端真实写过的结构（`clarityReal` 等）存进 localStorage 当模板，字段格式与客户端完全一致。

preload 跑在隔离世界（contextIsolation=true），够不到页面自己的 `Storage.prototype`，
所以用不了方案 B 那套 `removeItem` 钩子，只能靠上面的密集补写——实测够用。

**注意**：安装目录的 `md5.json` 记录了该文件原哈希
（实测 `bfcb8e31fae5a7370c5bee258ffcdfad`，与 md5.json 完全一致）。
客户端更新/自修复可能覆盖回原版，覆盖后重跑一次安装脚本即可。脚本会先要求抖音完全退出；
只想先试装、稍后自己重启，加 `-AllowRunning`。
已在一份 preload.js 拷贝上跑过完整往返：安装 → 语法校验通过、补丁块唯一、
重复安装幂等（换 `-Target` 是替换而不是叠加）→ 卸载后 md5 回到 `bfcb8e31…` 原值。

### 方案 B（参考实现，8.7.0 上不可用）：CDP 注入

`启动-4K抖音.cmd` + `inject.mjs` + `payload.js` 是一套完整的 CDP 注入实现：
带 `--remote-debugging-port` 启动，通过 DevTools 协议给每个新页面注入，payload 还额外
hook 了 `Storage.prototype.removeItem`（客户端清除它的那一刻同步补写，比方案 A 更彻底）。

* 已在 **Edge 155 headless** 上端到端验证：注入后
  `sessionStorage.getItem('MANUAL_SWITCH')` == `{"done":1,"gearType":-2,"gearClarity":"20","gearName":"超清 4K","qualityType":1}`，
  新开窗口能被自动接管；逻辑层 18 项断言全通过（`node test-payload.mjs`）。
* 但在 8.7.0 客户端上调试端口开不出来（见本节开头的实测），所以只作为参考/将来版本备用。
* 如果哪天客户端放开了调试口，直接双击 `启动-4K抖音.cmd` 就能用，比改文件更干净。

### 方案 C：什么都不装（你现在的做法）

每次启动后在推荐页找一个支持 4K 的视频切到 4K，本次会话内就都 4K。缺点就是你说的：关掉重开又要重来。

---

## 三点五、真机验证记录

| 步骤 | 做的事 | 结果 |
|---|---|---|
| 1 | `douyin.exe --remote-debugging-port=92258` | 主进程命令行带开关，但 **92258 不 listen** → 方案 B 不可用 |
| 2 | `douyin.exe --inspect=9339` | **9339 不 listen** → inspector 也被封 |
| 3 | 给 `app.asar.unpacked\preload.js` 加一段探针，重启客户端 | `%APPDATA%\douyin\dypc4k-probe.log` 出现 4 类页面记录：`about:blank`、`file:///…/pages/firstLoading/index.html`、**`https://www.douyin.com/`**、`https://live.douyin.com/preload-living`；在 `www.douyin.com` 上 `sessionStorage/localStorage` 均可用 → **确认这个文件就是被加载的 preload**，注入点成立 |
| 4 | 安装正式补丁（`-Target 4k -WithQualityProbe`），重启客户端 | `%APPDATA%\douyin\Local Storage\leveldb` 里出现 `__DYPC4K_STATE__` = `{"by":"dypc4k-preload","target":…,"manualSwitch":{"done":1,"gearType":-2,"gearClarity":"20",…}}` |
| 5 | 质量探针读页面真实解码分辨率（未手动切任何清晰度） | 打开的第一条视频 `1920x1080`（该视频只有 1080P 档，`clarityReal` 里有 `adapt_lowest_4_1` 但片子本身没 4K 码流） |
| 6 | 用户点开一条 4K 视频、放几秒 | **`2026-10-24T05:42:28.382Z [["2160x3840","2160x3840"], {…"gearType":-2,"gearClarity":"20","gearName":"超清 4K"…}]`** → 真实解码就是 2160p，且**全程没手动切过清晰度** |
| 7 | 关掉抖音重开 | 会话内注入值仍在（以前是空）→ **"关掉重开就回 1080P" 已修复** |
| 8 | 观察客户端与补丁的拉锯 | `05:41:42` 客户端把值写成 `gearType:1 / 高清 1080P`（该视频无 4K 档时的自我回退），**1.5 s 后被补丁改回 `-2 / 超清 4K`**，视频继续正常播放 |

> 第 5 步正对应你说的"得先找一个支持 4K 的视频"：4K 能不能出画面取决于**那条视频本身有没有 4K 码流**；
> 本方案保证的是"档位选择永远停在 4K、且重启不丢"，不是"把 1080P 视频变 4K"。
> 第 6 步就是你要的效果：不用再手动切，4K 片子直接按 4K 放。

想看某条视频究竟解出多少分辨率，用 `-WithQualityProbe` 装上探针，然后：

```bat
type "%APPDATA%\douyin\dypc4k-quality.log"
```

每行是 `时间戳 [["宽x高", ...], "当时的 MANUAL_SWITCH"]`，只有分辨率变化时才记一行。

---

## 三点六、最终结论：为什么单条视频看 8 秒左右还会降档

**这是客户端自己的解码/编码族治理，不是偏好没记住。** 真机日志（`dypc4k-lock.log`）抓到了切换瞬间：

```
07:48:44.874  codec     restore codecType=h264  was=h266     ← 客户端把编码族换成 h266
07:48:44.875  reinject  list lost 4K -> re-inserted (#1)
07:49:35.749  codec     restore codecType=h265  was=h266
07:49:54.949  codec     restore codecType=h265  was=h266
state  gears: ["720_1_2@2","720_2_2@2","540_2_2@3","1080_1_1@1"]   ← 换族后的列表，4K/2K 项凭空消失
```

机制：

1. 4K 档（`adapt_lowest_4_1@-2`）**只存在于原来的那一套编码族**里；
2. 播放约 8 秒后，客户端把 `config.codecType` 换成另一族（日志里是 `→ h266`），并按新族重建 `config.definition.list`；
3. 新族里没有 4K，也没有 2K，于是播放器掉到 1080P——菜单里看到的"超清 2K"只是标签，实际解码是 1080×1920；
4. 触发它换族的统计项在埋点名字里能看出来：`h265_failure_rate`、`current_low_decode_count`、`decoder_mode`、`codec_format`——它是按解码表现/首段播放统计做决定的，所以这个时间点很稳定。

**能抢回来吗？能，但不划算。** 补丁已经能拿到播放器实例，日志证明"把 4K 项塞回列表 + `changeDefinition`"确实能让 `cur` 回到 -2、重新解出 2160×3840；但客户端每 8~20 秒又换一次族，于是变成"4K → 重载 → 4K → 重载"的拉锯。

所以默认策略改成**不拉锯**：

| 策略 | 效果 | 怎么装 |
|---|---|---|
| `FIGHT=false`（默认） | 每条视频以 4K 起播；客户端降档后保持稳定，无闪断 | `install-preload.ps1 -Target 4k` |
| `FIGHT=true` | 4K 被抽走就抢回来，4K 时间更长，但每 ~10 秒闪一次重载 | `install-preload.ps1 -Target 4k -Fight` |
| 换档位 | 目标改成 2K / 1080P / 4K HDR | `-Target 2k` / `1080p` / `4khdr` |

> 另一个可以自己试的方向：客户端设置里有「硬件解码」开关（IPC 通道 `getHardwareDecodeState` / `setHardwareDecodeState`）。
> 4K 那一族在 Chromium 里通常只能软解，开关切到另一边有可能改变它换族的判定——属于客户端侧的可调项，不影响本补丁。

### 能不能靠"钉编码 + 拦 API"硬压住它？实测：不能

补丁后来拿到了播放器实例，两招都上了：

```
07:57:58.742  guard  changeDefinition guard installed      ← 给 changeDefinition 套了拦截
08:02:07.158  codec  pin codecType=h264 was=h265            ← 编码族钉回 h264（4K 所在的那一族）
08:02:15.130  block  blocked downgrade -> 1                 ← 确实拦下了它"切到 1080P"的调用
08:02:15.211  media.resize 1080x1920                        ← 但媒体流还是被换掉了
08:02:29.450  state  [...{"cur":1,"sel":1}...]              ← 它还把 1080P 写回了 MANUAL_SWITCH
```

结论：**降档不走 `changeDefinition`**（我们拦住的那次只是后续的 UI 同步），播放器是在内部直接换 `playAddr` / MSE 码流；而且它会把降档结果当成"用户的选择"写回存储。所以无论是 sessionStorage、播放器配置、还是播放器 API 层面，都拦不住它。

要真正"钉死"只剩一条路：**改播放器内部的判定函数**（就是本文开头引用的 `as()` / `q()` 那些逻辑），它们被打包在加密/混淆后的 CDN chunk 里。做法只能是重打包 `app.asar` 或在网络层拦截并改写 JS 响应——客户端一升级就失效，且安装目录里有 `md5.json` 与 `douyin_guard.exe`，风险和维护成本都很高，不建议。

**所以最终形态就是"起播 4K、8 秒后由客户端降档"**：这不是补丁失效，是客户端自己的播放治理。

---

## 三点七、最终解法（2026-10-24 真机确认：4K 不再掉）

**真正的开关不在播放器代码里，而在服务端 AB 配置里。** 客户端缓存在
`%APPDATA%\douyin\douyin_app_config`（SQLite，表 `app_config`，键 `abconfig`）里的一整套参数：

```
auto_clarity_reselect   = 1      ← 自动重选清晰度（8 秒后那一下的主谋）
switch_clarity_timing   = 1      ← 择机切清晰度
smooth_switch_clarity   = 1      ← 平滑切清晰度
use_h266_client         = 1      ← 启用 H.266 客户端
degradeBitrateFactors   = [0.5, 0.8]   ← 实测码率低于目标 0.5/0.8 倍就降档
abr_config.algoArg.maxDownSwitchLevel = 1   ← ABR 允许降一档
```

**改这个库没用**：每次启动客户端都会重新拉取覆盖（实测改完 20 秒复查全部回到 1）。
所以改成在**渲染层拦响应**：preload 在主世界 hook `fetch` / `XMLHttpRequest`，
把 `/service/2/abtest_config/`（以及 `/aweme/v1/web/mobile/ab/params/`）响应里的上述开关改成 0，
再交给客户端。

真机日志：

```
08:27:37.642  abpatch  xhr https://www.douyin.com/service/2/abtest_config/ changed=1
08:27:37.705  abpatch  xhr https://www.douyin.com/service/2/abtest_config/ changed=1
（abpatch 共 4 次；block / lost4k / revert 一次都没有 → 客户端根本没再尝试降档）
```

用户复测确认：**整条视频一直 4K，第 8 秒不再跳 2K。**

### 当前生效配置（已装在客户端上）

| 项 | 值 | 作用 |
|---|---|---|
| `TARGET` | `4k` | 起播即 4K，且重启不丢 |
| `AB_PATCH` | `true` | **关键**：改写 AB 里的自动重选/降档开关 |
| `FIGHT` | `false` | 不再与客户端拉锯（用不上了） |
| `LOCK_CODEC` | `h264` | 钉编码族 |
| `REFUSE` | `none` | 不封任何编码（封 HEVC 会连 4K 一起封掉，只剩 1080P） |
| `needAutoBitrate` | `false` | 关掉 ABR |

重装/复现这条命令即可：

```bat
powershell -ExecutionPolicy Bypass -File install-preload.ps1 -Target 4k -Refuse none
```

想关掉 AB 改写（回到"8 秒后降档"的状态）加 `-NoAbPatch`；想彻底恢复原版用 `uninstall-preload.ps1`。

### 踩过的坑（免得以后重复）

| 尝试 | 结果 |
|---|---|
| 改本地 SQLite `abconfig` | 每次启动被服务端新数据覆盖 |
| 封 HEVC/VVC/AV1，只留 H.264 | 这条视频的 4K 就是 HEVC，封完只剩 1080P |
| 只封 VVC(H.266) | 仍然 8 秒降档（降档不走编码族） |
| 钉 `codecType` / 拦 `changeDefinition` / 塞回 4K 项 | 客户端绕开 API 直接换 MSE 流，拦不住 |
| **改写 AB 响应里的 auto_clarity_reselect 等开关** | **成了** |

---

## 四、可调项

`payload.js`（CDP 路线）自带控制台 API，在抖音页面 F12 里执行：

```js
__DYPC4K__.status()                       // 看当前 target / mode / 实际值
__DYPC4K__.setTarget('4khdr')             // 超清 4K HDR（gearType -3）
__DYPC4K__.setTarget('4k')                // 超清 4K（默认，-2）
__DYPC4K__.setTarget('2k')                // 超清 2K（-1）
__DYPC4K__.setTarget('1080p')             // 高清 1080P（1）
__DYPC4K__.setMode('remember')            // 不强制：你手选什么就记住什么，重开还原
__DYPC4K__.setMode('force')               // 强制锁定 target（默认）
__DYPC4K__.reset()                        // 恢复默认
```

`mode: 'remember'` 就是"像 B 站那样记住上次选的清晰度"，`mode: 'force'` 是"永远 4K"，两种都持久化到 localStorage。

preload 补丁路线（方案 A）改档位不加命令：直接改 `preload.js` 里补丁段的
`var TARGET = '4k';`，或用 `install-preload.ps1 -Target 4khdr` 重装一次（会自动替换旧块）。
它同样认 localStorage 里的 `__DYPC4K_CFG__`：

```js
localStorage.setItem('__DYPC4K_CFG__', JSON.stringify({target:'4khdr'}))                       // 换档
localStorage.setItem('__DYPC4K_CFG__', JSON.stringify({mode:'remember'}))                      // 改成"记住你的手选"
localStorage.getItem('__DYPC4K_STATE__')                                                       // 看注入是否在跑、当前值
localStorage.removeItem('__DYPC4K_CFG__')                                                      // 回默认
```

> 客户端自己的 localStorage 注意：`www.douyin.com` 的 localStorage 落在
> `%APPDATA%\douyin\Local Storage\leveldb`（不是 `Default\Local Storage`），
> 排查时别找错目录。

---

## 五、边界与风险（务必看）

| 项 | 说明 |
|---|---|
| 4K 需要登录 | 未登录时清晰度菜单里的 4K 显示「登录即享」，本方案不能绕过 |
| 视频本身没有 4K | 播放器按该视频可用档位回退，不会报错（`definition.list` 里没有 -2 就走默认档）。真机探针已见到：注入值生效但该视频只解出 1920×1080 |
| `isHas2K()` 为假 | 客户端连 4K 选项都不显示（屏幕/能力判定），本方案无法凭空造出 4K；你这台 2560×1440 满足条件（你能手动切出来就是证据） |
| 调试端口 | 8.7.0 实测 `--remote-debugging-port` 与 `--inspect` 都不开端口，CDP 路线不可用 |
| 版本升级 | 升级会重下 `app.asar.unpacked\preload.js`，补丁被冲掉 → 重跑 `install-preload.ps1` 即可（备份文件 `preload.js.dypc4k.bak` 会保留） |
| 只改一个键 | 只写 `sessionStorage['MANUAL_SWITCH']`（+ 自己的 localStorage 标记），不伪造签名、不绕登录、不改请求签名 |
| 随时可撤 | `uninstall-preload.ps1` 还原备份（实测 md5 回到 `bfcb8e31…` 原值） |

---

## 六、文件清单

| 文件 | 作用 | 状态 |
|---|---|---|
| `install-preload.ps1` / `uninstall-preload.ps1` | **主方案**：preload 补丁安装/回滚（备份、幂等、可选档位与探针） | 已在真机跑通 |
| `preload-snippet.js` | 追加到 `preload.js` 的注入片段（档位常量 + 心跳） | 同上 |
| `quality-probe.snippet.js` | 可选质量探针：把 `<video>` 真实分辨率写进 `dypc4k-quality.log` | 已实测 |
| `payload.js` | CDP 路线的注入脚本（含 `removeItem` 钩子、localStorage 持久化、控制台 API） | 参考实现 |
| `inject.mjs` | CDP 注入器，Node ≥22 无依赖；`--verify` 打印 `MANUAL_SWITCH` | PowerShell 参考实现 |
| `启动-4K抖音.cmd` | 带调试端口启动抖音 + 拉起注入器（8.7.0 上端口不开，仅备用） | 8.7.0 不可用 |
| `probe-snippet.js` | 一次性探针，用来证明 `preload.js` 真的被加载、能用哪些 API | 已验证，留档 |
| `test-payload.mjs` | payload 逻辑测试（假 DOM 环境，18 项断言） | 全通过 |
| `patch-abconfig.mjs` | 直接读写 `%APPDATA%\douyin\douyin_app_config` 里的 AB 配置（show/apply/revert 三个命令） | 排查工具；注意改库会被客户端覆盖 |
| `inspect-appconfig.mjs` / `inspect-abconfig.mjs` / `inspect-degrade.mjs` | 把客户端 AB 配置库里的键、降档策略、播放器开关全量列出来 | 只读，找出上面那些开关用的 |
| `extract-settings.mjs` | 从 web 包抽出播放器设置注册表（499 项 key/alias/default） | 只读 |
| `timeline.mjs` | 把 `dypc4k-diag.log` 解析成时间线 | 排查用 |
| `package.json` | 让 Node 在任意目录下正常解析脚本（工作区上级有个 0 字节 package.json 会干扰） | — |

跑测试：

```bat
node test-payload.mjs
```
