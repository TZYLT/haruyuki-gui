# haruyuki-gui

[English](README.en.md) · 简体中文

> **AIGC 声明**：本项目的代码与文档大量由 AI 辅助生成，再由人类维护者审阅、裁决与验证。AI 生成的内容可能包含逻辑错误、过时信息或安全缺陷；本项目按 **"AS IS"** 提供，使用或再分发前请自行审查、测试与评估风险。发现问题欢迎在仓库的 issue 中反馈。

## 1. 这个项目是什么

**Haruyuki-gui 是基于 Haruyuki 的桌面应用，以及具有类似功能的衍生插件。**

Haruyuki 本身是一个成本节约型陪伴 agent 运行时，具备复杂的机制与丰富的使用场景，TUI 已经不能满足长期使用的需要。因此 Haruyuki-gui 致力于为其赋予好用美观的 GUI，让长期和多场景使用成为可能。我们的设计尽量向日常的场景靠拢，但仍有考虑不周之处，请谅解，也欢迎贡献不同的想法。

这一节和下一节讲的是**你拿到包能看到什么**，不是内部计划；运行方式、命令与目录在第三到第六节。

### 我们的目标

| 目标                       | 含义                                                                             |
| -------------------------- | -------------------------------------------------------------------------------- |
| **全能易用的桌面应用**     | 覆盖日常使用所需的完整能力，而不是一个只能聊天的窗口；其衍生插件也会尽量做到。   |
| **完全本地自持**           | 不依赖任何云服务。状态、数据、配置都在你自己的机器上。                           |
| **良好的视觉设计与可视化** | 界面本身要好看、信息要看得懂——把一个强大的运行时，变成一个人愿意每天打开的应用。 |

## 2. 当前状态

这一版是**能装起来的地基**，不是能聊天的成品。诚实地说清楚两边：

**已经有的：**

- **一条命令出包**：`node apps/desktop/scripts/release.mjs` 串起装依赖、取引擎、构建、打 Windows 目录包与 zip、生成发布清单与校验和。
- **Linux 单文件包在容器里出**：`bash apps/desktop/scripts/verify-linux-package.sh` 负责进镜像跑同一条流水线并产出 `AppImage`，同时做存活与绘制探针。**没有 Docker 就没有 Linux 产物**，此时清单会写 `not-built` 并给出原因，而不是假装做了。
- **一个能开的窗口**：产物是 zip，解压到任意空目录后双击 `Haruyuki.exe` 启动；启动时校验随包引擎，通过后界面可用。
- **一个关于窗口**：菜单「帮助 → 关于 Haruyuki」。里面是软件版本、引擎版本与来源、上次启动的校验结果、运行环境，以及三份许可文件的本地入口，还有仓库地址与反馈链接。内容全部来自包内与本机记录，**断网也能看**。
- **检查更新**：同一个窗口里的按钮，**只在你点的时候联网**，五种结果各自可辨；额度耗尽或断网时**不会**说"已是最新"。
- **随包的法务文件**：包根有 `LICENSE`、`NOTICE`、`THIRD-PARTY`、`LICENSE.electron.txt`、`LICENSES.chromium.html`，`resources/engine/` 下还有引擎自己的 `LICENSE`、`NOTICE`、`THIRD-PARTY-NOTICES.md`。少任何一份都是缺陷，不是"精简"。

**还没有的：**

- 对话、流式、审批、终端、文件树、设置页——都还没有。**能打包 ≠ 能聊天。**
- 主界面顶栏（含它的检查更新入口）还没有；检查更新现在只能从「帮助」菜单进。
- 自动更新、自动下载、自动重启都没有，也不会加：更新只在你点的时候查一次。

**未验证项**（不是"没做"，是"没验"）集中在第 7 节，包括 Linux 的人工体验与干净 Windows 机器上的首次启动。

## 3. 三步跑起来

### 你要自己出包（维护者路径）

1. **克隆并进入目录**

   ```bash
   git clone https://github.com/TZYLT/haruyuki-gui.git && cd haruyuki-gui
   ```

2. **装依赖**（Node 24；先按第四节把 corepack 指好）

   ```bash
   corepack enable pnpm --install-directory "$(dirname "$(command -v node)")"
   pnpm install --frozen-lockfile
   ```

3. **跑一条命令**（它自己会补齐剩下的前置步骤，包括下载 Electron 二进制）

   ```bash
   node apps/desktop/scripts/release.mjs --win-only        # Windows：产物 + 清单 + 校验和
   node apps/desktop/scripts/release.mjs --skip-bundle     # 只到运行时树与锁
   bash apps/desktop/scripts/verify-linux-package.sh       # Linux 单文件包（进容器跑）
   ```

   **在 Windows 上不要省略 `--win-only`**：不给平台参数意味着"两个都做"，而 Linux 那一半必须在 Linux 上做，在这台机器上会以 `exit 1` 失败（约 7 秒）。Linux 产物走第三条命令，它自己起容器。若这一版就是不出 Linux 包，只写 `--win-only` 就够：清单会把 Linux 记成「本版不需要」（`skipped`/`not-required`）。**不要再加 `--linux-not-built=…`** —— 那个参数是给「要了 Linux 但这台机器做不了」用的，与 `--win-only` 同时给是用法错误（`exit 2`）。

   产物落在 `apps/desktop/release/`：Windows 是 `Haruyuki-<版本>-win-x64.zip` 与 `win-unpacked/`；Linux 是 `Haruyuki-<版本>-linux-x86_64.AppImage`（注意是 `x86_64`）。
   建 tag、建 Release、上传附件**由你亲手做**，这条命令最后会把上传步骤打印出来。

### 你只想用（使用者路径）

- **Windows**：下载 `Haruyuki-<版本>-win-x64.zip` → 解压到一个空目录 → 双击 `Haruyuki.exe`。不要求你装 Node、不要求开终端。**第一次会被 SmartScreen 拦**，见第 7 节。
- **Linux**：下载 `Haruyuki-<版本>-linux-x86_64.AppImage` → `chmod +x` → 运行。缺 `libfuse2` 时的两条等价做法见第 7 节。

## 4. 环境要求

以下都是本项目的**实测结论**，不是通用常识；照做能省掉一整轮自我怀疑。

| 要求             | 值                                                                                     | 说明                                                                                                                                     |
| ---------------- | -------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Node.js          | `>= 24`（开发机实测 `24.22.3`）                                                        | 由根 `package.json` 的 `engines` 声明                                                                                                    |
| pnpm             | `10.24.0`                                                                              | 由 `packageManager` 钉住；版本墙是已知风险，别用别的版本                                                                                 |
| corepack         | `corepack enable pnpm --install-directory <node 所在目录>`                             | 只写 `corepack pnpm` 与 `pnpm` 不等价，子进程会找不到 pnpm                                                                               |
| electron         | 首次 `require` 才下载二进制                                                            | 本仓的 `electron` 依赖没有 `postinstall`；需要时跑 `pnpm --filter @haruyuki/desktop setup:electron`，发布命令会自动做一次                |
| electron-builder | 打包机先 `pnpm install --frozen-lockfile`                                              | 主检出的 `node_modules` 可能没有它，直接 `pnpm exec electron-builder` 会报找不到                                                         |
| Docker Desktop   | **做 Linux 包时必须常开**：`27.5.1` 以上、WSL2 后端                                    | 没有 Docker 就没有 Linux 产物（清单里会写 `not-built` 并给出原因，不会假装做了）；daemon 没起时 `docker info` 报 `Internal Server Error` |
| 镜像站           | 所有镜像加 `docker.m.daocloud.io` 前缀                                                 | **Docker Hub 官方站直连在本项目开发网络上不通**（实测超时）。这一条写在这里，是因为它能省下一个人十分钟的自我怀疑                        |
| 容器镜像         | `docker.m.daocloud.io/library/node:24-bookworm-slim`                                   | digest 为 `sha256:5ba3c1ded6eada2ea16582327a87c672fb3889fca362ee3ac0d78ed742b583c0`；有 Node 24 与 glibc                                 |
| 容器内 GUI 库    | `libglib2.0-0`、`libnss3`、`libgbm1`、`libgtk-3-0`、`libxss1`、`libasound2`、`libdrm2` | 缺任何一个，Electron 二进制连动态链接都过不了（报 `libglib-2.0.so.0` 找不到）。这是探针查出来的                                          |
| 容器内构建工具   | `python3`、`make`、`g++`                                                               | 终端组件没有 Linux 预编译产物，必须现场编译；`apt-get` 的退出码只证明"命令成功"，要逐包核对                                              |
| 容器内启动方式   | 普通用户 + `Xvfb :99 -screen 0 1280x800x24`                                            | root 下 Chromium 一律拒绝启动，而本项目**不用** `--no-sandbox` 换绿                                                                      |
| 用户机（Linux）  | `libfuse2`                                                                             | Ubuntu 22.04 起默认不带；没有它就用 `--appimage-extract`，见第 7 节                                                                      |
| 网络             | `registry.npmjs.org`、GitHub 的 Electron 发布页、`nodejs.org/dist`                     | 离线构建不在本项目范围内                                                                                                                 |

## 5. 命令清单

| 命令                                                | 用途                                                                               | 退出码                                                         |
| --------------------------------------------------- | ---------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| `pnpm verify`                                       | 全部门禁，一条命令跑完默认段                                                       | `0` 全绿；`1` 至少一段失败                                     |
| `pnpm verify:full`                                  | 再加仓库纪律三项（体积、环依赖、模块归属）                                         | 同上                                                           |
| `pnpm test`                                         | 单元测试                                                                           | `0` / `1`                                                      |
| `pnpm lint`                                         | ESLint                                                                             | `0` / `1`                                                      |
| `pnpm typecheck`                                    | 各工作区包 + 门禁脚本的类型检查                                                    | `0` / `1`                                                      |
| `pnpm contract:check`                               | 契约产物与真源一致（另有 `contract:update`、`contract:generate`、`contract:diff`） | `0` / `1`                                                      |
| `pnpm i18n:check`                                   | 文案目录的完整性与一致性                                                           | `0` / `1`                                                      |
| `pnpm fixtures:check`                               | 录制样本的格式与头部                                                               | `0` / `1`                                                      |
| `pnpm hooks:install`                                | 让 git 指向版本化的提交钩子（重复运行无害）                                        | `0` 已装或已存在；`1` 不在仓库里；`2` 环境坏                   |
| `pnpm --filter @haruyuki/desktop start`             | 用本机构建产物直接开窗（开发者路径）                                               | Electron 进程退出码                                            |
| `pnpm --filter @haruyuki/desktop setup:electron`    | 手动下载 Electron 二进制                                                           | `0` / `1`                                                      |
| `node apps/desktop/scripts/release.mjs`             | 一条命令出产物与清单（见下面的退出码）                                             | `0` / `1` / `2` / `3`                                          |
| `node apps/desktop/scripts/verify-round-one.mjs`    | 判"运行时树与锁是否就位"                                                           | 同 `release.mjs`                                               |
| `node apps/desktop/scripts/verify-artifacts.mjs`    | 判"有没有解包树与至少一个压缩包"                                                   | `0` / `1`；`2` 发布目录不存在                                  |
| `node apps/desktop/scripts/verify-manifest.mjs`     | 判清单与磁盘是否逐条相符、两处哈希是否一致                                         | `0` / `1`；`2` 没有清单可判                                    |
| `bash apps/desktop/scripts/verify-linux-package.sh` | 容器内产出 Linux 单文件包，并做存活与绘制探针                                      | `0` 通过；`1` 产物起不来；`3` 这台机器做不了（没有 Docker 等） |
| `node apps/desktop/scripts/manifest.mjs`            | 单独重写发布清单与校验和（单一产出者）                                             | `0` 写出且两表一致；`2` 输入不足以描述一次构建                 |

**`release.mjs` 的退出码语义**（三条命令共用同一套，判据程序不发明自己的码）：

- `0` 每个请求的目标都成功，或因为没有相应能力而被跳过；
- `1` 某个目标被尝试过并且失败了；
- `2` **什么都没尝试**：前置步骤失败、命令行不合法，或这个版本号已经打过 tag。三个来源共用一个码，但**第一行文案前缀各自固定**，所以只读退出码分不清、读日志分得清：
  - `error: prerequisite failed` —— 装依赖/取引擎之类的前置失败了；
  - `error: usage` —— 命令行不合法；
  - `error: version conflict: tag exists` / `error: version conflict: tag list unreadable` —— 版本号已被发布，或读不到 tag 列表（读不到也拒绝，因为"不知道"必须比"没有"更响）。
- `3` 唯一被请求的目标在这台机器上做不了。

选项：`--win-only`、`--linux-only`（互为排斥，都不给 = 两个都做）、`--skip-install`、`--skip-fetch`、`--skip-bundle`、`--linux-not-built=<docker-unavailable|machine-offline|toolchain-missing>`（**只对 requested target 有效**：与 `--win-only` 同给是用法错误）。版本号已打 tag 时**拒绝构建，且不留下任何文件**。

## 6. 目录结构

只给一层，够你判断"东西大概在哪"。

- `apps/` — 两个应用壳：`desktop/`（Electron 桌面端）与 `vscode/`（编辑器扩展）
- `packages/` — 三个共享包：`core/`（会话与引擎对接）、`protocol/`（消息与契约）、`ui/`（组件与样式）
- `scripts/` — 全部门禁脚本与它们的自测；`pnpm verify` 跑的就是这里
- `fixtures/` — 门禁自测用的固定样本（红/绿成对），不是产品数据
- 根目录 — 工作区声明（`package.json`、`pnpm-workspace.yaml`、`pnpm-lock.yaml`）、配置（`tsconfig.base.json`、`eslint.config.mjs`、`vitest.config.mts`）、三份法务文件与这两份 README

产物不进仓库：`apps/desktop/release/`、`apps/desktop/dist/`、`apps/desktop/runtime/` 都是本机生成物。

## 7. 产物与校验

**产物名**（随版本号变化，架构段照抄，别改）：

- Windows：`Haruyuki-<版本>-win-x64.zip`，解压后根目录有 `Haruyuki.exe`；
- Linux：`Haruyuki-<版本>-linux-x86_64.AppImage`（是 `x86_64`，不是 `x64`）。

**Windows SmartScreen**：本包**未签名**。第一次双击会看到「Windows 已保护你的电脑」，点「更多信息 → 仍要运行」即可。这是**预期摩擦，不是故障**，应用内不会再弹提示。

**Linux 缺 `libfuse2`**（Ubuntu 22.04 起默认不带）：装 `sudo apt install libfuse2`；或者不解包地用等价路径：

```bash
./Haruyuki-<版本>-linux-x86_64.AppImage --appimage-extract
./squashfs-root/AppRun
```

**校验下载的包**：每个 Release 正文里有一张哈希表，同一份内容另有一个 `SHA256SUMS` 文件，两处逐行相同。

```bash
# Linux
sha256sum -c SHA256SUMS
```

```powershell
# Windows：逐行与 SHA256SUMS 比对
Get-FileHash .\Haruyuki-<版本>-win-x64.zip -Algorithm SHA256
```

哈希证明"两份东西字节相同"，**不证明"是谁发的"**——能证明后者的是签名，而本项目不签名。所以它挡不住"发布页本身被改"，这是前提，不是遗漏。

**Linux 未验证清单**（登记为**未验证**，不是"已支持"）：

- **双击运行**：未验证。构建容器里没有桌面环境与 FUSE。
- **桌面集成**（图标、菜单项、文件关联）：未验证。
- **真实显示器上的渲染**：未验证。容器里只验到进程存活与产物可解包，没有截图工具能证明"窗口真的画出来了"。
- **多发行版**：未验证。只在 Debian bookworm 的构建镜像里跑过，没有在第二、第三个发行版上试过。

此外：**在另一台干净的 Windows 机器上的首次启动**也未验证——只在打包机上换目录验证过启动。

## 8. 本项目的对外文档口径

这份 README 面向"想用或想参与的人"，不假设你读过任何内部资料。它按六条自我约束写：

1. **这个项目是什么**——第一节讲的是你能拿到什么，第三节起讲动手。
2. **环境要求**——第四节的每一条都是实测踩出来的，不是通用常识；尤其 Docker 与镜像站两条，缺了就没有 Linux 产物。
3. **clone 后怎么跑**——第三节，三步以内；使用者路径（双击产物）也在那里。
4. **命令清单**——第五节，含发布相关的全部脚本与退出码语义。
5. **目录结构**——第六节，只给一层。
6. **不写内部编号**——本文不引用任何内部设计文档、裁决记录、阶段计划、工作包代号或内部术语；看到某个说法不确定，问 issue 就好，不需要先读别的文档。

中英两份 README 在契约级内容上**逐条对应**：环境要求、安装步骤、命令清单、目录结构、许可与声明五部分条目数与含义一致；叙事性内容允许各自行文。两侧若对不上，以条目少的一侧为缺陷。

## 9. 许可与声明

以 Apache License 2.0 发布，全文见 [LICENSE](LICENSE)。

- [NOTICE](NOTICE) 记录必须随分发传播的第三方署名，并写明何时需要新增条目。
- [THIRD-PARTY](THIRD-PARTY) 是实际随产物分发的第三方组件清单与登记规则；dev-only 依赖不登记。
- 包根另有 Electron 的 `LICENSE.electron.txt` 与 `LICENSES.chromium.html`；`resources/engine/` 下另有引擎自己的 `LICENSE`、`NOTICE`、`THIRD-PARTY-NOTICES.md`，随包但不改动。
- 关于窗口里的三个按钮打开的就是上面这三份**本地文件**（不是网页）；断网也能打开。

在适用法律要求的范围内，除非另有书面约定，所有贡献均按 "AS IS" 提供，不附带任何明示或暗示的担保。
