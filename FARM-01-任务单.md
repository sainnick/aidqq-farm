# FARM-01 任务单｜测试农场（泳道 Y）搭建 + 并行一致性验收

> 派发对象：大云端机器上的 agent（Ubuntu 24.04、32 核、123GB、无 GPU）。复核：本地设计会话。
> 遇到颠覆性结论先停下报告；不扩大范围。

## 0. 背景与通道

- 项目：用本地任务层（Mineflayer）在 1.16.1 vanilla 固定种子上通关 Minecraft，最终目标成绩约 10 分钟。**全程零 LLM、零 key。** 本机的定位是"测试农场"：同时跑十几条无画面的测试泳道。
- **本仓库 `sainnick/aidqq-farm` 是公开的同步通道**（你的网络连不上 GitHub，只能经 GitHub MCP 读写公开仓库）：
  - **代码进来**：`bundles/MANIFEST.json` 写着最新的代码包文件名和 sha256。用 MCP 读取那个 `.tar.gz`，**校验 sha256** 后解压到工作区。包里有 `bench/`（测试脚本、`_lib`、`route/`、`cloud/`、`cloud/docs/` 文档快照）和 `mindcraft/`（任务层源码 + package.json）。
  - **结果出去**：只往本仓库的分支 **`farm/results`** 推送（报告 + 必要的小体积数据；原始遥测打成 tar.gz，单个文件 <900KB，超过就分卷）。**不要动 main 分支**，也不要碰你账号下的其他仓库。
- 必读（解压后）：`bench/cloud/docs/MC-手册.md`（重点 §3 坑表、§4 验收协议、§5 归因规则、§9 进程规则；Windows 专用的部分按 Linux 处理）；`bench/cloud/CLOUD-01-任务单.md` 和 `bench/cloud/CLOUD-01-报告.md`（小云端机的环境配方和踩过的坑：不要自己拍 TP 坐标、TPS = world age 增量 ÷ 墙钟秒数、NFS 删除要先 rename 等）；`bench/cloud/run_lane.mjs`（Linux 单泳道 runner，你要在它基础上扩展）。

## 1. 环境（按你的网络摸底结果）

1. Java：**Microsoft Build of OpenJDK 11.0.32.1**（aka.ms 下载，已验证可通）。
2. 服务端：Mojang 官方 vanilla **1.16.1** server jar（piston-meta 版本清单 → 下载 → 校验 sha1）。
3. npm：走**腾讯镜像**（`https://mirrors.tencent.com/npm/`）。在 `mindcraft/` 目录下**只装** bench 用到的包，版本**严格按** `bundles/MANIFEST.json` 的 `npmPins`（例：`npm install --no-save mineflayer@4.38.0 ...`）；跑一次看还缺哪个模块，缺就补（同样锁版本），把最终清单写进报告。不要对整个 mindcraft 做 `npm install`。
4. **先确认 overlay 盘在会话之间是否持久**。不持久的话，写 `farm_setup.sh`，从下载到装包一键重建，并把它推到 `farm/results`。

## 2. 多泳道 runner

把 `bench/cloud/run_lane.mjs` 扩展成 `run_farm.mjs`：N 条泳道并行，泳道 i 用端口 `25600+i`（RCON `25700+i`），各自独立的服务器目录（放在本机盘）、bot 名、世界。每局开服前查一次空闲内存和平均负载，资源不够就排队。**只结束自己 spawn 出来的子进程**。

## 3. 验收：并行一致性

BASIC-bootstrap，用本地基线 M4B4 的 20 个种子（种子名单在 `bench/stages/portal/run_portal.mjs` 里 `P2C_M4B4` 的定义处）：
- 先测并发曲线：**5 → 10 → 20 条泳道**依次跑，每档记录每局成功与否、TPS（平均 <18 的局标 LAGGED，照样计成绩）、内存峰值、平均负载。
- 20 并发那一轮：成功 ≥19/20；零 OOM、零端口冲突、零残留进程。
- 给出**推荐的默认并发数**（取"LAGGED 局数为 0 的最大并发"）。注意本机是能效核（Xeon 6981E），Minecraft 服务器主循环是单线程的，单核性能比本地弱，曲线比纸面算力更重要。

## 4. 交付

`farm/results` 分支上的 `reports/FARM-01.md`：环境清单（版本、装了哪些包）、盘是否持久、并发曲线表、20 局逐局结果、推荐并发数、提效条目（最多 3 条）。推送后停下，告诉用户结果。下一步（接手 F 线易物）等本地复核后另行通知。

## 5. 补充（2026-10-02，答 FARM-01 中止报告的三个问题）

1. **缺文件：已补包**（`bundles/MANIFEST.json` 指向新包 `code-20261002-1610.tar.gz`）。`bench/cloud/` 下现在有 `run_lane.mjs`、`tps_tap.mjs`、`fetch_jdk.sh`、`CLOUD-01-报告.md`（来自小云端机的 `cloud/lane-x` 分支）。服务端 jar **本来就不在包里**，按 §1 从 Mojang 下载；`experiments/...server-spike` 是本地 Windows 的旧目录，不需要。
2. **版本：按 1.16.1。** 代码里 1.21.1 的默认值是历史遗留（手册 §2 记过：脚本默认版本仍是 1.21.1，漏带参数会起 1.21.1）。**一律显式传 1.16.1**：`--mc-version 1.16.1`，并用环境变量 `MC_BENCH_JAR` / `MC_BENCH_SERVER` / `MC_BENCH_JAVA` 指向你下载的 vanilla 1.16.1 jar、本机盘上的服务器目录和 JDK。CLOUD-01 报告里有小云端机的实际调用方式，照着来。
3. **种子：`P2C_M4B4-01` 这类字符串就是种子本身，不需要映射。** Minecraft 的 `level-seed` 接受任意字符串，非数字字符串由服务端用 `String.hashCode()` 换算成数值种子，换算是确定的。本地 M4B4 基线就是用这些字符串跑的，同为 1.16.1 时世界完全一致。CLOUD-01 的 5 局也是这么跑的。

**授权**：先把 JDK 11 和 vanilla 1.16.1 服务端下载好；runner 在 `run_lane.mjs` 基础上扩展，按 §2 的端口和资源规则实现。照常推进，不用再等。
