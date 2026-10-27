# 手机网页版：固定 4K + 类 App 界面

> 文件：`douyin-4k.user.js`（Tampermonkey 用户脚本，v2.0.0）
> 状态：**已在 Chromium（手机视口 + 桌面版 UA）实测拿到 3840×2160 / 2160×3840 并稳定保持**，
> 真机（Kiwi）待你复验。证据见 [`../docs/08-手机网页版4K验证记录.md`](../docs/08-手机网页版4K验证记录.md)。

---

## 一、先记住三句话

1. **必须切「桌面版网站」**。移动版网页是引流页：只给 720P 带 logo 的 `playwm` 流，
   没有清晰度菜单，也不拉 AB 配置。脚本检测到会弹提示。
2. **4K 只有 HEVC**。浏览器不给 `hvc1` 支持就无解，HUD 右上角的 `hevc ✓/✗` 就是判这个。
3. **手机上能不能出现 2K/4K 档，全看 AB 里的 `has_2k`**。客户端逻辑是
   `isHas2K() = has_2k || (Windows 核数>8) || (Mac/鸿蒙 核数>=8)`，手机天然为 false，
   不强行置 1，手动选 4K 反而会被"就近降级"回 1080P，菜单里的 4K 项还会消失。

---

## 二、安装（不 root、不改包）

1. 手机装 **Kiwi Browser**（Chromium 内核，支持 Chrome 扩展）；
2. Kiwi 里装 **Tampermonkey**；
3. 导入 `douyin-4k.user.js`（Tampermonkey → 管理面板 → 工具/导入，或直接新建粘贴）；
4. 打开 `https://www.douyin.com/`；
5. **菜单 → 勾选「桌面版网站 / Request desktop site」→ 刷新**（这一步不能省）；
6. 登录（网页登录，不触发 APK 签名风控）；
7. 想更像 App：Kiwi 菜单 → **添加到主屏幕**，从桌面图标进入（无地址栏）。

### 装完检查

右下角（默认左下角，`dy4k.hud()` 可开关）HUD 三行：

```
2160x3840  超清 4K      ← 真实解码分辨率 + 当前档位
fps 30.0   33.5Mbps     ← rVFC 实测帧率 + 实测下载码率
ab16  hevc ✓  has2k=1   ← AB 命中改写数 + HEVC 能力 + AB 里 has_2k 的实际值
```

- `has2k=2` 或 `has2k=0` → 4K 档会被客户端剔掉（必须变成 `1`）；一直不是 1 说明 AB 改写没命中；
- `hevc ✗` → 这台机器的浏览器不给 HEVC，4K 拿不到（脚本无能为力）；
- 显示的是 `1280x720` 且弹了提示 → 你还在移动版网页。

---

## 三、脚本做了四件事

| 层 | 干什么 | 关键点 |
|---|---|---|
| 1 | 写 `sessionStorage['MANUAL_SWITCH']` = 超清 4K（gearType -2 / gearClarity "20"），并 400ms 心跳补写 | 只补"缺失/被改掉"，保留客户端真实的 `clarityReal`/`qualityType` 结构 |
| 2 | 改写 AB 响应（`fetch` + `XHR` 两条通道） | **`has_2k=1`**、`auto_clarity_reselect` / `switch_clarity_timing` / `smooth_switch_clarity` / `maxDownSwitchLevel` / `rebufferDegrade` 归零，`isOpenAutoDefi`/`isPlayAutoDefi` 置 false；**只改 `val`，保住 `vid`** |
| 3 | 类 App 界面 | 隐藏左侧导航/顶栏/下载条/"打开App"，播放器钉成全屏（`dy4k-stage`），底部标签栏（从网页版导航克隆），隐藏漏进可视区的右侧浮层，view 禁缩放 |
| 4 | HUD | 分辨率 / 档位 / 实测 fps / 实测码率 / AB 命中 / HEVC / has_2k |

> **为什么不能整体替换 AB 键**：线上响应是 `data.<key>.{val,vid}`，`vid` 是灰度版本号，
> 把 `data.has_2k` 直接赋成数字会毁掉结构（老脚本就是这么写的，实测会把 4K 项挤出菜单）。

### 控制台 API

```js
dy4k.state()              // cfg / manual / clarityReal / has2K / autoDefi / hevc / video
dy4k.target('2k')         // 4khdr | 4k | 2k | 1080p
dy4k.hud(true)            // HUD 开关
dy4k.tabbar(false)        // 底部标签栏开关
dy4k.immersive(true)      // 沉浸模式（播放器独占全屏）
dy4k.force2k(false)       // 关掉 has_2k 强制（排查用）
dy4k.pickGear('超清 4K')  // 兜底：手动点开清晰度菜单后执行，代点 4K
dy4k.debug(true)          // 控制台打 [dy4k] 日志
```

---

## 四、验收标准与实测结果

| 硬指标 | 要求 | 实测 |
|---|---|---|
| HUD 分辨率 | 2160×3840 或 3840×2160 | ✅ 视频 `7689731341721564658` → **2160×3840**；`7697934740980125171` → **3840×2160** |
| HUD 档位 | `超清 4K` | ✅ 客户端还弹了"清晰度已经切换至 超清 4K" |
| 连续 ≥30s 不掉 | 不降分辨率 | ✅ `7697934740980125171` 从 +9s 到 +44s 一直 3840×2160（35s） |
| 5 条以上视频多数可达 | 取决片源 | ⚠️ 4 条里 3 条成功；失败的 `7698098558267919667` 客户端自己没给 4K 档（接口里有 gear，菜单里没有） |

失败的典型表现：菜单只剩「标清 540P / 智能」。处理：手动打开清晰度菜单点一下「超清 4K」，
或在控制台 `dy4k.pickGear('超清 4K')`；仍然不行说明该视频/该账号没开 4K，换视频。

---

## 五、限制（实话）

| 限制 | 说明 |
|---|---|
| HEVC 解码 | 4K 只有 HEVC。老机型 / iOS Safari / 部分 WebView 可能不给 `hvc1`，HUD 显示 `hevc ✗` 就是这个 |
| 带宽 | 4K 档声明码率 2.7–4.1 Mbps，实测吞吐要稳在 5 Mbps 以上 |
| 界面 | CSS/JS 只能改外观，换不来原生控件与原生预加载 |
| 手机性能 | 网页端 4K 软解很吃 CPU，中端机可能掉帧（HUD 的 fps 会掉） |
| 前端改版 | 类名/AB 键名/`isHas2K` 都可能变；常量都集中在文件头与 `AB_FORCE` |
| 移动版网页 | 无解，只能切桌面版 |

---

## 六、工具链（都能重跑）

```powershell
cd F:\ddddddd\douyin-4k-mod          # 必须在本目录跑（上级有 0 字节 package.json）

node mobile-web/tools/test-userscript.mjs          # 离线回归 31 项断言
node mobile-web/tools/extract-gears.mjs --url <视频页>   # 这条视频有没有 2160P
node mobile-web/tools/probe-play.mjs --url <视频页> --seconds 40 --script mobile-web/douyin-4k.user.js
node mobile-web/tools/summarize-play.mjs            # 分辨率随时间曲线
node mobile-web/tools/probe-layout.mjs --url <视频页> --script mobile-web/douyin-4k.user.js
node mobile-web/tools/find-code.mjs --url <页面> --grep isHas2K    # 线上 bundle 检索
node mobile-web/tools/grep-chunks.mjs --pattern fR: --ctx 400      # 本地缓存 chunk 检索
```

`tools/lib/browser.mjs` 负责找 playwright-core 与 Chromium；没有 playwright 时用
`PW_CORE` / `PW_CHROME` 环境变量指定。
