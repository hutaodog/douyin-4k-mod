# 抖音 4K 改造（PC 客户端 + 手机网页/App）

给抖音 PC 客户端和手机端做「最高画质」改造的完整工程：原理分析、注入实现、一键分发工具、以及一路踩过的坑。

> ⚠️ 仅供学习研究，请自行评估风险。不要用于商业用途或大规模分发。

---

## 一、先看结果

| 端 | 形态 | 效果 |
|---|---|---|
| **PC（Windows 客户端）** | 双击即用的补丁包 `douyin-4k-patch-v1.5.zip` | 每条视频按**该视频能给的最高档**播放（有 4K 播 4K60，没有就取最高 2K/1080P），不再被自动降档 |
| **手机（Android）** | `mobile-app` 里的原生壳 App | 抖音网页版 + 原生 4K 播放器（HEVC 硬解），推荐流/主页/评论都有原生实现 |

PC 端补丁实测：批量 12 条视频，**12/12 达到接口给到的最高分辨率**（含 7 条 3840×2160），`err=0`、`giveup=0`；清晰度标签同步显示「超清 4K」。

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

打包成品：`douyin-4k-patch-v1.5.zip`。

**原理**：抖音客户端的 `preload.js` 在页面脚本之前执行。补丁在其末尾追加一段脚本，做四件事：

1. 把 `sessionStorage['MANUAL_SWITCH']` 写成 `{gearType:-2, gearClarity:'20', gearName:'超清 4K'}`（每 400ms 幂等重写）；
2. 改写服务端 AB 配置里"自动降档/自动重选清晰度"的开关；
3. 钉住编码族、拦截 4K 档被客户端抽走；
4. 让客户端底部清晰度标签跟上真实解码分辨率（纯文字）。

播放器自己会"够得着 4K 就 4K、够不着就取列表最高档"，所以最终效果就是每条视频的最高画质。

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
| **`docs/18-PC补丁v1.1定稿.md`** | 本轮定稿：三次弯路与最终结论 |

---

## 五、目录结构

```
douyin-4k-mod/
├─ preload-snippet.js          PC 补丁注入片段（v1.5）
├─ install-preload.ps1         开发者安装器（支持探针开关）
├─ uninstall-preload.ps1       还原
├─ probe-gear.snippet.js       码流档位探针（只读诊断）
├─ analyze-gear-log.mjs        分析探针日志
├─ test-payload.mjs            注入片段的离线单测
├─ pc-oneclick/                面向普通用户的分发目录

├─ mobile-web/                 手机网页版用户脚本 + 探针工具
├─ mobile-app/                 Android 壳 App
└─ docs/                       全部文档
```

---

## 六、免责声明

本项目仅用于研究客户端实现与学习逆向工程方法。使用补丁可能违反服务条款，请自行承担风险；作者不对任何后果负责。
