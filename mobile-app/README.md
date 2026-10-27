# 抖音 4K 手机壳（Douyin4K · Android）

> 一个**不用 root、不改官方包**的安卓 App：系统 WebView 加载抖音桌面版网页打底，
> 4K 播放交给原生 `MediaPlayer`（硬件 HEVC 解码）。
>
> **已在 Redmi K40（alioth / Android 13）上实测：`2160×3840`、`3840×2160` 都能出画面。**
> 证据与踩坑见 [`../docs/09-安卓壳App-K40实测.md`](../docs/09-安卓壳App-K40实测.md)。

---

## 一、为什么长这样

| 事实（都是实测） | 后果 |
|---|---|
| 改包必然被服务端判「当前版本过低」 | 只能自己做个壳，不碰官方 APK |
| 移动版网页是引流页（720P 水印流、无清晰度菜单、不拉 AB） | 壳里必须伪装**桌面版 UA** |
| 4K 码流只有 HEVC（`adapt_lowest_4_1` = 2160p h265） | 浏览器/WebView 必须能解 HEVC |
| K40 的 WebView 是 104（Chrome 107 才支持 HEVC） | 网页播放器最高只能 1080P H.264 |
| K40 平台有硬解：`OMX.qcom.video.decoder.hevc hw=true` | **改用原生 MediaPlayer 播 4K 直链** |
| douyinvod 的 4K 直链要求 `Referer: https://www.douyin.com/`（不带 = 403） | 自写 `HttpMediaSource` 带头发 Range 请求 |

所以整体是**混合体**：

```
Android App
├─ MainActivity        WebView（桌面版 UA）+ 注入脚本 + 全屏沉浸 + 底部标签栏
│   └─ assets/dy4k.js  = mobile-web/douyin-4k.user.js
│        第 1 层  MANUAL_SWITCH 心跳写 4K
│        第 2 层  AB 响应改写（has_2k=1 / 关自动降级 / 关自动清晰度）
│        第 3 层  类 App 界面（全屏播放器 / 隐藏 web 外壳 / 标签栏 / 评论抽屉 / 浮层）
│        第 4 层  嗅探 aweme 接口里的 bit_rate[] → 找最高档 mp4 直链
│        第 5 层  window.dy4kApi（页面上下文里 fetch 用户/作品接口，供原生页用）
│   └─ dy4kNative.play4k(url,w,h,title)  ← JS 桥（原生 4K 播放）
│   └─ dy4kNative.openProfile(secUid,nick)  ← JS 桥（原生主页）
├─ PlayerActivity      MediaPlayer 全屏播放 4K（HttpMediaSource 带 Referer + Cookie 拉流）
├─ FeedActivity        原生推荐流：上下滑切视频 / 浮层 / 评论半屏抽屉（开屏即进这里）
└─ ProfileActivity     原生「作者主页 / 个人主页」（头像/资料/关注粉丝获赞/作品 3 列网格）
    └─ 数据来自 WebData → 主 WebView 的 dy4kApi（带登录态，无需签名）
    └─ 图片走 ImgLoader（抖音图床要 Referer）
```

网页里看视频页时，右下角会出现 `原生 2160x3840 HEVC` 按钮，点一下就是真 4K。

---

## 二、构建（不需要 Gradle / Android Studio）

```powershell
cd F:\ddddddd\douyin-4k-mod

# 只构建
powershell -NoProfile -ExecutionPolicy Bypass -File .\mobile-app\build.ps1

# 构建 + 装到已连接的手机
powershell -NoProfile -ExecutionPolicy Bypass -File .\mobile-app\build.ps1 -Install

# 构建 + 覆盖安装 + 重启 App
powershell -NoProfile -ExecutionPolicy Bypass -File .\mobile-app\build.ps1 -Reinstall
```

产物：`mobile-app/build/Douyin4K.apk`（约 45 KB，v1/v2/v3 签名都验过）。

构建链是手工的 `aapt2 → javac → d8 → zipalign → apksigner`，参数：

| 参数 | 默认值 | 说明 |
|---|---|---|
| `-SdkPath` | `F:\ruanjian\Android SDK` | 你的 SDK 路径 |
| `-BuildTools` | `36.1.0` | 34.0.0 的 d8 在 JDK 21 下会崩（内部 NPE），用 36.x |
| `-Platform` | `android-34` | 编译用 android.jar |
| `-MinSdk` / `-TargetSdk` | `21` / `33` | |

> 脚本故意写成**纯 ASCII**：Windows PowerShell 5.1 会按 ANSI 读无 BOM 的 .ps1，
> 里面只要有中文就会解析失败（`docs/05` 第 15 条）。

首次构建会生成签名用 keystore：`mobile-app/keys/dypc4k.p12`（口令 `dypc4k`，仅个人使用）。

---

## 三、在手机上怎么用

1. 装上 APK，桌面图标是黑底红圆带播放三角；
2. 打开 → 会自动加载 `https://www.douyin.com/`（桌面版页面）；
3. 登录：右上角登录 → 扫码（网页登录，不涉及 APK 签名风控）；
4. 进任意视频页 → 右下角出现 `原生 2160x3840 HEVC` → 点它 → 原生全屏 4K 播放；
5. 原生播放器：单击出控制条，双击切换 **完整 / 铺满**，返回键退出。

手感补齐：

| 操作 | 行为 |
|---|---|
| 返回 | 有历史就后退，没有就提示"再按一次退出" |
| 长按返回 | 重新加载当前页 |
| 底部标签栏 | 精选 / 推荐 / AI抖音 / 关注 / 朋友 / 我的（从网页版左侧导航克隆） |
| HUD（左下角） | 分辨率 / 档位 / fps / 码率 / AB 命中 / `hevc ✓✗` / `has2k=` |

---

## 四、真机验收（一条命令）

```powershell
node mobile-app/tools/acceptance.mjs            # 默认 6 条视频
node mobile-app/tools/acceptance.mjs --videos 7689731341721564658 --shot
```

它会：强制重启 App → 逐个打开视频页 → 读 `dy4k.gears()` → 点原生按钮 →
从 logcat 里取 `video size -> WxH` → 汇总成表（同时落盘 `mobile-app/shots/acceptance.json`）。

其它调试工具：

```powershell
node mobile-app/tools/device.mjs info                     # 设备 / App / WebView 版本 / 可调试 target
node mobile-app/tools/device.mjs eval "dy4k.state()"      # 在 WebView 里跑 JS（CDP）
node mobile-app/tools/device.mjs nav https://www.douyin.com/video/<id>
node mobile-app/tools/device.mjs shot mobile-app/shots/x.png
node mobile-app/tools/device.mjs log dy4k                 # 看 App 日志
```

`device.mjs` 走的是 `adb forward tcp:9222 localabstract:webview_devtools_remote_<pid>`，
所以 App 里开了 `WebView.setWebContentsDebuggingEnabled(true)`。

---

## 五、已知限制（都是明牌）

| 限制 | 说明 | 有没有解 |
|---|---|---|
| WebView 无 HEVC | 网页播放器最高 1080P。HUD 的 `hevc ✗` 就是这个 | 更新「Android System WebView」到 107+ 后，网页内也能 4K（不需要走原生） |
| 4K 只在原生播放器里 | 网页里点「原生 4K」跳过去播 | 就这样，够用 |
| 直链有有效期 | 签名 URL 大约几小时后过期 | 过期后重进视频页再点一次 |
| 片源没有 2160 | 按钮会显示 `原生 2560x1440` 之类 | 换视频，这是服务端没给 4K |
| 登录/私信 | 网页登录可用，部分功能引导装 App | 忽略 |
| 播放器没有弹幕/倍速 | 原生播放器只有 播放/暂停/拖动/缩放 | 需要的话可以再补 |

---

## 六、文件

```
mobile-app/
├─ AndroidManifest.xml
├─ res/                        图标 + 主题 + 文案（纯 XML vector，无 PNG）
├─ java/com/dypc4k/douyink4/
│   ├─ MainActivity.java       WebView 壳（桌面 UA / 注入 / 全屏 / JS 桥 / 返回键）
│   ├─ PlayerActivity.java     原生 4K 播放器（MediaPlayer + 宽高比 + 双击缩放）
│   └─ HttpMediaSource.java    带 Referer 的分块 HTTP 数据源（解决 403）
├─ assets/dy4k.js              构建时从 ../mobile-web/douyin-4k.user.js 拷进来
├─ build.ps1                   aapt2 + javac + d8 + zipalign + apksigner
├─ tools/
│   ├─ acceptance.mjs          真机 4K 验收（CDP + logcat）
│   └─ device.mjs              设备操作台（info/eval/nav/shot/log）
├─ shots/                      真机截图与验收 JSON
└─ keys/dypc4k.p12             签名用 keystore（首次构建生成）
```
