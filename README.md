# 抖音 4K 改造（PC 客户端 + 手机网页/App）

给抖音 PC 客户端和手机端做「最高画质」改造的完整工程：原理分析、注入实现、一键分发工具、以及一路踩过的坑。

> ⚠️ 仅供学习研究，请自行评估风险。不要用于商业用途或大规模分发。

---

## 一、先看结果

| 端 | 形态 | 效果 |
|---|---|---|
| **PC（Windows 客户端）** | 当前 `pc-oneclick/` 为 2026-11-16 高画质起播修复版；已发布 `v1.5` 为历史版本 | 在满足设备与同条视频源条件时优选原有高分辨率 HEVC 起播；保留原生 ABR 与卡顿恢复，实际画质以解码尺寸为准 |
| **手机（Android）** | `mobile-app` 里的原生壳 App | 抖音网页版 + 原生 4K 播放器（HEVC 硬解），推荐流/主页/评论都有原生实现 |

**当前工作区为 2026-11-16 高画质起播修复版，已在本机安装**：在保留安全播放边界的基础上，修复 2026-11-15 仅开启安全模式后丢失高画质起播路径的回归。部分视频的原始接口已有 4K/2K HEVC，但播放器初始化只选入较低分辨率 VVC；本次只在满足条件的同条视频原始数据中排除较低 VVC 候选，让播放器使用原有高分辨率 HEVC。原有 `Alt+I`、右键详情和命令结构保留；实际画质以当前可见视频的解码尺寸为准，不保证每条达到接口最高码率。

本次已确认的样本为视频 `7707193655605853931`：修复前实际 `1920×1080`，播放器 native 档位只有 H266 的 1080/720/540，而原始 API 已有 HEVC `3840×2160` 和 `2560×1440`。新初始化后实际达到 `3840×2160`，native 档位出现 4K/2K，并保留 720/576。26 次诊断尝试中 24 条有效、2 条无响应；有效首尾相距 `46.401s`，aid 与媒体源相同、`readyState=4`，未见暂停或媒体错误，观察到两次自然循环。这不是“一分钟无间断”、全视频覆盖或压力测试通过的结论；更多推荐页和 2K 验证以[本次报告](docs/22-PC高画质起播修复-20261116.md)记录为准。

补充推荐页短观察：针对抖音窗口滚轮切换 5 次，6 个观察窗口共 `24/24` 条有效、`0 miss`，未见暂停、媒体错误或低 readyState；每个窗口均为同媒体源的 4 条记录、约 `3.6s`。6 个窗口的实际尺寸依次为 `3840×2160`、`2160×3840`、`2880×2160`、`3840×2160`、`1024×576`、`2160×3840`。这是短时切换观察，未覆盖长时播放或冷起播测试。

另一个 2K 目标视频 `7707970938222094321` 的接口最高为 `1440×2560`、VVC 最高为 `1080×1920`；播放器 native 最高为 `1440×2560`（`def-1`），并保留 720/576 低档，实际解码为 `1440×2560`。同一 URI 为 `v1e00fgi0000dbs3d77og65qvhm3pf7g`。连续诊断 `10/10` 条有效，首尾 `10.799s`，播放时间从 `11.898441s` 前进到 `22.694510s`，媒体源相同，未见暂停、媒体错误或低 readyState，缓冲余量为 `30.472157–41.268226s`。这是已确认的短时连续播放证据，不能扩展为长时或全视频结论。

`v1.5` 的历史详情页测试为 12/12 达到接口最高分辨率（含 7 条 `3840×2160`），但未覆盖长期刷推荐页后的卡顿；该结果不能当作当前修复版的验收结论。

---

## 二、PC 端：一键补丁（给别人用）

```
pc-oneclick/
├─ 一键开启4K.cmd       ← 对方双击这个
├─ 恢复原版.cmd         ← 还原
├─ dypc4k.ps1           ← 自动定位安装目录 / 备份 / 注入 / 校验 / 还原
├─ preload-snippet.js   ← 注入的脚本本体
└─ 使用说明.txt
```

当前修复内容位于 `pc-oneclick/`，本次包名为 `douyin-4k-stable-quality-20261116.zip`，对应[2026-11-16 高画质起播修复报告](docs/22-PC高画质起播修复-20261116.md)。本次版本随当前提交上传到 GitHub，未创建 GitHub Release；旧 `v1.5` 与旧本地包 `douyin-4k-stability-20261115.zip` 及[2026-11-15 播放稳定性修复报告](docs/21-PC播放稳定性修复-20261115.md)保留为历史版本。

**当前原理**：抖音客户端的 `preload.js` 在页面脚本之前执行。修复版保留高画质偏好，并在原始数据进入播放器前有条件地优选起播编码：

1. 每 `400ms` 把 `sessionStorage['MANUAL_SWITCH']` 维持为 `{gearType:-2, gearClarity:'20', gearName:'超清 4K'}`；这只是存储偏好，不保证每条接口最高码率。
2. 仅在原始接口/初始数据属于同一 aweme、同一 URI 时处理；还须同时满足本机 CPU `>=8`、`MediaSource` 支持 `hev1.1.6.L93.B0`、有效非直播 SDR MP4 HEVC 最大短边 `>1080` 且高于 VVC 最大短边，并有 HEVC 直链。
3. 条件满足时，只移除这条视频较低的 numeric2 VVC 候选；保留原 HEVC/AVC 行、顺序、原 URL、元数据与低码率档。不注入新档位，不把其他视频或缓存中的档位补入播放器；条件不满足时保留原数据。
4. 轮询不操作媒体元素，不修改 `src`、`srcObject` 或播放进度，不调用 `load`、`pause`、`play`。不拦截降档、不修改编码能力、不强改清晰度标签。
5. 不改写服务端 AB 配置，保留原生 ABR 与卡顿恢复配置；原有 `Alt+I`、右键详情、只读档位采集和命令结构保留。

当前开关为 `SAFE_PLAYBACK=true`、`AB_PATCH=false`、`QUALITY_AB_PATCH=false`、`PREFER_HIGH_HEVC=true`。根目录与 `pc-oneclick/` 的 `preload-snippet.js` SHA256 均为 `4E7C058046135FD824303C1235764898F95EF9A62A9DED40DDBAF025766C8AC9`。

真实解码分辨率以详情面板为准。实际画质仍由视频源、设备、客户端和网络共同决定；原生带宽降档路径保留，但本次尚未实测带宽不足时是否真正降档。

本机原还原点 `_restore-points\before-buffer-fix-20261115-210609` 与 `恢复到本次修复前.cmd` 保留，用于恢复到其记录的修复前状态；包内 `恢复原版.cmd` 则通过原版备份恢复 pristine 客户端。两者恢复目标不同。

开发者用法：

```powershell
powershell -ExecutionPolicy Bypass -File .\install-preload.ps1 -Target 4k
powershell -ExecutionPolicy Bypass -File .\install-preload.ps1 -Target 4k -WithGearProbe   # 附带码流档位探针
powershell -ExecutionPolicy Bypass -File .\uninstall-preload.ps1                            # 还原
```

---

## 三、手机端

```
mobile-web/          用户脚本版（Tampermonkey 也能用）+ 探针工具
mobile-app/          Android 壳 App（WebView + 原生播放器 + 原生主页/推荐流）
```

- `mobile-web/douyin-4k.user.js`：注入脚本（4K 档位、AB 改写、类 App UI、`dy4kApi` 接口封装）
- `mobile-app/java/.../PlayerActivity.java`：原生 4K 播放器（`HttpMediaSource` 带 Referer + Cookie 拉流）
- `mobile-app/java/.../FeedActivity.java`：原生推荐流（上下滑切视频 / 评论半屏抽屉）
- `mobile-app/java/.../ProfileActivity.java`：原生作者主页 / 个人主页

构建（不需要 Gradle）：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\mobile-app\build.ps1
```

---

## 四、文档

| 文档 | 内容 |
|---|---|
| `docs/01-总览与使用.md` | 从零开始的入口 |
| `docs/02-原理篇-为什么抖音默认不是4K.md` | 档位系统、AB 降档、为什么默认不是 4K |
| `docs/03-实现篇-固定4K.md` | MANUAL_SWITCH 结构与写入方式 |
| `docs/05-避坑指南.md` | 客户端模板覆盖、幂等写入等坑 |
| `docs/12-抖音网页版接口逆向总览.md` | 网页版 100 个接口 + `a_bogus` 签名结论 |
| **`docs/22-PC高画质起播修复-20261116.md`** | 当前高画质起播优选、有效实测结果、测试限制与边界 |
| **`docs/21-PC播放稳定性修复-20261115.md`** | 历史播放稳定性修复、有效实测结果、测试限制与还原点 |
| **`docs/18-PC补丁v1.1定稿.md`** | 历史定稿：三次弯路与最终结论 |

---

## 五、目录结构

```
douyin-4k-mod/
├─ preload-snippet.js          PC 补丁注入片段（高画质起播修复版）
├─ install-preload.ps1         开发者安装器（支持探针开关）
├─ uninstall-preload.ps1       还原
├─ probe-gear.snippet.js       码流档位探针（只读诊断）
├─ analyze-gear-log.mjs        分析探针日志
├─ test-payload.mjs            CDP 注入片段的离线单测
├─ test-safe-playback.mjs      preload 主世界序列化隔离测试
├─ pc-oneclick/                面向普通用户的分发目录

├─ mobile-web/                 手机网页版用户脚本 + 探针工具
├─ mobile-app/                 Android 壳 App
└─ docs/                       全部文档
```

---

## 六、免责声明

本项目仅用于研究客户端实现与学习逆向工程方法。使用补丁可能违反服务条款，请自行承担风险；作者不对任何后果负责。
