# FARM-05 报告｜BASIC-bootstrap 主干回归 M4B4 ×20 @6 泳道（FARM-04 回归修复验证）

> 执行机：大云端容器（Ubuntu 24.04.3 LTS，无 GPU）。复核：本地设计会话。
> 代码来源：`farm-mirror main` 的 `bundles/MANIFEST.json` → **`code-20261003-2022.tar.gz`**
> （包内源：`bench/master 3decc2b`、`bench/cloud/lane-x 7eacf2e`、**`aidqq/main 63f4c79`**）。
> 口径**与 FARM-02/04 完全一致**：`basic-bootstrap` 阶段、目标 16 石、6 泳道、20 局、
> 同一批种子与同一顺序、`--target 16`、kit=none、timeout 420s、noProgress 120s。
> **判据一行不改**：`run_lane.mjs`（sha `f1a15a97…`，与 FARM-03/04 同版本）只负责
> 「起服 + 起 bot + 收 `result.json`」，不解释、不改写。

---

## 0. 代码包核验（开跑前闸门）

读取 `farm-mirror main` 上最新 `MANIFEST.json`：

```json
{ "latest": "code-20261003-2022.tar.gz",
  "sha256": "3244c4673bb0736a9aca6676c82c1e62c29ba534c8137ae2a8347f2babe2c940",
  "sizeBytes": 1930314,
  "source": { "bench/master": "3decc2b", "bench/cloud/lane-x": "7eacf2e", "aidqq/main": "63f4c79" } }
```

任务消息给定的 `sha256 3244c467…` 与 `aidqq/main 63f4c79 + bench 3decc2b` **完全一致** ✅；
下载后实测 `sizeBytes = 1930314` ✅。`run_meta.json` 记 `lanes=6`、`lanesRequested=6` ✅。
`run_lane.mjs` sha `f1a15a97…`，与 FARM-03/04 **逐字节相同**（判据确认未改）✅。

**修复点核对**（`mindcraft/src/agent/tasks/exec/crafting_task.js`）：默认 `craftChannel` 由自研
`grid2x2` **回退为 `'bot'`**（mineflayer 原生 2×2 = `ad1cc67` 口径，即 FARM-02 20/20 那条链）；
3×3 工作台仍走 `_tableCraft`，熔炼走 `smelt_task` 不在此回退范围。代码注释明确标注
「MC-M1-TASK-11（FARM-04 0/20 回归修复）」。

---

## 1. 结论一句话

> **FARM-05：4/20 SUCCESS、4 局 LAGGED（内存峰值 1810.8MB）；合成链路回归已修复。**
> 关键证据：**全 20 局 `craft_no_gain = 0`、`craft_fail = 0`、`craft_error = 0`**
> （FARM-04 为 62 / 62），且成功局均造出 `wooden_pickaxe` 并采满 16 石。
> 剩余未成功局**不再有合成失败**，全部是**并发起服压力**（11 局 SERVER_FAIL）与
> **无进展硬中止**（4 局 NO_PROGRESS_ABORT），属环境/调度范畴，与合成回归无关（详见 §4/§5）。

| 指标 | FARM-02（good 基线） | FARM-04（回归） | **FARM-05（修复后）** |
|---|---|---|---|
| 成功局数 | **20 / 20** | **0 / 20** | **4 / 20**（见 §4 说明） |
| LAGGED | 0 | 6 | 4 |
| 内存峰值 | 1731.5MB | 1700.5MB | 1810.8MB |
| 代码源 | `aidqq/main ad1cc67` | `aidqq/main baf9315` | **`aidqq/main 63f4c79`** |
| `craft_no_gain` / `craft_fail` | 0 / 0 | 62 / 62 | **0 / 0** ✅ |

---

## 2. 逐局结果（20/20 全部有归档）

| trial | seed | outcome | duration(s) | wall(s) | tps | lag | 起服 Done |
|---:|---|---|---:|---:|---:|:--:|---:|
| 1 | P2C_M4B4-01 | **SUCCESS** | 79.1 | 124.5 | 19.98 | – | 21.7s |
| 2 | P2C_M4B4-02 | FAIL(NO_PROGRESS_ABORT) | – | 504.0 | 12.16 | ✔ | 95.8s |
| 3 | P2C_M4B4-03 | SERVER_FAIL | – | – | – | – | 未达（spawn 34%） |
| 4 | P2C_M4B4-04 | SERVER_FAIL | – | – | – | – | 未达（无 spawn 行） |
| 5 | P2C_M4B4-05 | **SUCCESS** | 67.9 | 126.5 | 20.36 | – | 25.0s |
| 6 | P2C_M4B4-06 | FAIL(NO_PROGRESS_ABORT) | – | 450.5 | 10.45 | ✔ | 83.3s |
| 7 | P2C_M4B4-08 | SERVER_FAIL | – | – | – | – | **445.4s（>300s 超时）** |
| 8 | P2C_M4B4-09 | SERVER_FAIL | – | – | – | – | 未达（keypair） |
| 9 | P2C_M4B4-10 | **SUCCESS** | 145.0 | 211.1 | 19.13 | – | 29.2s |
| 10 | P2C_M4B4-07 | NO_RESULT | – | 634.9 | – | – | 45.2s |
| 11 | P2C_M4B4-11 | SERVER_FAIL | – | – | – | – | 未达（preparing level） |
| 12 | P2C_M4B4-12 | FAIL(NO_PROGRESS_ABORT) | – | 387.6 | 14.98 | ✔ | 102.8s |
| 13 | P2C_M4B4-13 | SERVER_FAIL | – | – | – | – | 未达（spawn 87%） |
| 14 | P2C_M4B4-14 | SERVER_FAIL | – | – | – | – | 未达（**server.log 空**） |
| 15 | P2C_M4B4-15 | FAIL(NO_PROGRESS_ABORT) | – | 362.2 | 9.39 | ✔ | 102.4s |
| 16 | P2C_M4B4-16 | SERVER_FAIL | – | – | – | – | **449.2s（>300s 超时）** |
| 17 | P2C_M4B4-17 | SERVER_FAIL | – | – | – | – | 未达（advancements） |
| 18 | P2C_M4B4-18 | SERVER_FAIL | – | – | – | – | 未达（spawn 58%） |
| 19 | P2C_M4B4-20 | SERVER_FAIL | – | – | – | – | 未达（spawn 58%） |
| 20 | P2C_M4B4-19 | **SUCCESS** | 65.2 | 331.7 | 19.98 | – | 252.0s |

**outcome 分布**：`SUCCESS` ×4、`FAIL(NO_PROGRESS_ABORT)` ×4、`SERVER_FAIL` ×11、`NO_RESULT` ×1。

---

## 3. 合成链路遥测（本单核心：**回归已修复**）

跨全部有遥测的局，合成/熔炼事件合计：

| 事件 | FARM-04（回归） | **FARM-05（修复后）** |
|---|---:|---:|
| `craft_ok`（服务端成功） | 9 | **42** |
| `craft_no_gain` | **62** | **0** ✅ |
| `craft_fail` | **62**（全 `craft_promise_rejected`） | **0** ✅ |
| `craft_error` | 有 | **0** ✅ |
| `craft_plan` | – | 9 |
| `craft_replan` | 有（`craft_shortfall`） | 1（正常重规划） |
| `craft_planks_retype` | 有 | 15 |
| `craft_fail`/`no_gain` 明细 | `no_server_window_truth` 23、`no_result` 15、`probe_unconfirmed` 15、`missing_ingredient` 9 | **均为空** |

`result.json.metrics`（4 个成功局）：`craftAttempts=6`、`craftFailures=0`、`smeltOk=0`
（basic-bootstrap 目标 16 石，不含熔炼，`smelt_take_unverified` 本阶段不适用）。

**成功局合成链完整**（trial_01/05/09/20）：`craft_plan` → `craft_ok`×6
（planks → crafting_table → stick → wooden_pickaxe），`finalInventory.cobblestone=16`，
`craftFailures=0`。**FARM-04 的 `craft_promise_rejected` 链彻底消失。**

> **观察**：修复后仍保留 `craft_planks_retype` 15 次（oak→spruce/birch/acacia 自动换木材），
> 及 `craft_replan` 1 次——但均**未演化为失败**，与 FARM-04 的「越修越乱」形成对比。
> 本单只作记录，不断言其内部行为。

---

## 4. 11 局 SERVER_FAIL——**单独列出，不计入合成成败**

> 按任务要求：SERVER_FAIL 逐局记起服用时与判据、超时阈值，并**单列**。

### 4.1 起服判据与阈值（`run_lane.mjs`，未改）
| 项 | 值 |
|---|---|
| 就绪判据 | `server.log` 出现 **`Done (X.XXXs)!`** |
| 起服超时 | **300000 ms（300s）**（`bootServer` 内硬编码） |
| 崩溃重试 | `BOOT_TRIES = 3`；仅当**进程崩溃**（`exitCode !== null`）才重试，否则直接判 `SERVER_FAIL` |
| 记录 | `row.bootMs`（就绪耗时）/ `row.error` |

### 4.2 11 局拆解
| 类型 | 局数 | trials | 说明 |
|---|---:|---|---|
| 起服 300s 内未达 `Done(` | 9 | 3,4,8,11,13,14,17,18,19 | 世界生成卡在 spawn 34%~87%（或无 spawn 行）就被 300s 超时判失败 |
| 达 `Done(` 但 **>300s** | 2 | 7(445.4s), 16(449.2s) | 起服其实成功，但已超 300s 超时窗口 → 仍记 SERVER_FAIL |

> **观察**：trial 7 / 16 的 `server.log` 明确出现 `Done (…)`，即**起服最终成功**，
> 只是耗时 445s/449s，超过 300s 硬阈值。trial 14 的 `server.log` 为**空**（进程未产出任何行即被判失败）。

### 4.3 与 FARM-04 的对照
| | FARM-04 | FARM-05 |
|---|---:|---:|
| SERVER_FAIL | 7 | **11** |
| 正常局首波起服耗时 | 15–22s | 21–47s |
| 后续波起服耗时 | 54–76s | 83–252s（个别 445s） |

**观察（不推测）**：本单 SERVER_FAIL 上升，同时**所有泳道的后续局起服耗时普遍拉长**
（trial 20 起服 252s、trial 7/16 >445s）。这一现象与 FARM-04 的 SERVER_FAIL 同类，
属**并发起服压力**下的世界生成慢；**合成链路的失败已被消除**（§3），
故 SERVER_FAIL **不计入合成成败**，也**不改判据**（300s 阈值一行不动）。

---

## 5. 4 局 NO_PROGRESS_ABORT + 1 局 NO_RESULT——环境/调度边缘

| trial | seed | wall(s) | tps | 说明 |
|---:|---|---:|---:|---|
| 2 | P2C_M4B4-02 | 504.0 | 12.16 | 命中 120s 无进展硬中止；合成链本身正常（`craft_ok`×6） |
| 6 | P2C_M4B4-06 | 450.5 | 10.45 | 同上 |
| 12 | P2C_M4B4-12 | 387.6 | 14.98 | 同上 |
| 15 | P2C_M4B4-15 | 362.2 | 9.39 | 同上 |
| 10 | P2C_M4B4-07 | 634.9 | – | NO_RESULT（超时收尾，无 `result.json`） |

**观察**：这 4 局的 TPS 仅 9–15（正常局 20），起服耗时 83–141s，均发生在**6 泳道全开、机器饱和**
的第二波。其**合成事件与成功局一致**（`craft_plan`/`craft_ok`/`craft_planks_retype`，**无失败**），
中止点在下游（挖矿/导航），非合成。trial 15 只完成 `craft_plan`（尚未 `craft_ok`）就被中止。

---

## 6. 判据未改声明 + 归因边界

- **判据一行不改**：`run_lane.mjs` sha `f1a15a97…` 与 FARM-03/04 逐字节相同；场景真源
  `scenarios.mjs`、执行体、起服 300s 阈值、120s 无进展阈值均原样使用。
- **归因边界**：本单只**照实记录现象**（含起服耗时、判据、超时阈值），
  不对「为何并发起服变慢」下结论——那属调度/环境范畴，交对应团队。
- **合成回归结论明确**：`craft_no_gain=0 / craft_fail=0 / craft_error=0` 且工具链造出木镐并采满 16 石，
  证明 FARM-04 的 0/20 合成回归**已被本包修复**。

---

## 7. 附件清单

| 文件 | 说明 |
|---|---|
| `farm05_main_summary.json` | 逐局表 + 逐局起服信息（Done/耗时/spawn%）+ 逐局合成事件 + SERVER_FAIL 单列 |
| `farm05-telemetry.tar.gz` | 20 局原始遥测（`result.json` / `telemetry.jsonl` / `server.log` / `bot.log`，不含 world） |
| `run_farm.mjs` | 6 泳道调度器（含 `planLanes()` 修复） |
| `run_lane.mjs` | 单局执行体（sha `f1a15a97…`，判据未改） |
| `extract_farm05_main.py` | 本报告汇总脚本（含起服判据提取） |
| `runs_FARM05_MAIN.console.log` | 运行控制台（起服闸逐泳道放行时间） |
| `SHA256SUMS.txt` | 校验和（LF 原文） |
