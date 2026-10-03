# FARM-04 报告｜BASIC-bootstrap 主干回归 M4B4 ×20 @6 泳道

> 执行机：大云端容器（Ubuntu 24.04.3 LTS，无 GPU）。复核：本地设计会话。
> 代码来源：`farm-mirror main` 的 `bundles/MANIFEST.json` → **`code-20261003-1523.tar.gz`**
> （包内源：`bench/master 1ac7e7a`、`bench/cloud/lane-x 7eacf2e`、**`aidqq/main baf9315`**）。
> 口径**与 FARM-02 完全一致**：`basic-bootstrap` 阶段、目标 16 石、6 泳道、20 局、
> 同一批种子与同一顺序、`--target 16`、kit=none、timeout 420s、noProgress 120s。
> **判据一行不改**：`run_lane.mjs`（sha `f1a15a97…`，与 FARM-03 同版本）只负责「起服 + 起 bot + 收 `result.json`」，
> 不解释、不改写。

---

## 0. 代码包核验（开跑前闸门）

读取 `farm-mirror main` 上最新 `MANIFEST.json`：

```json
{ "latest": "code-20261003-1523.tar.gz",
  "sha256": "b3a32c6d9ee11c21a4d33e8bea7dbc687cceedf23884adb0fc150eaf6bf5e938",
  "sizeBytes": 1584038,
  "source": { "bench/master": "1ac7e7a", "bench/cloud/lane-x": "7eacf2e", "aidqq/main": "baf9315" } }
```

任务消息给定的 `sha256 b3a32c6d…` 与 `aidqq/main baf9315` **完全一致** ✅；下载后实测 `sizeBytes = 1584038` ✅。
`run_meta.json` 记 `lanes=6`、`lanesRequested=6`（`planLanes()` 修复在位，未再塌成 5 泳道）✅。

---

## 1. 结论一句话

> **FARM-04：0/20 SUCCESS，6 局 LAGGED（内存峰值 1700.5MB）。**
> 与 FARM-02（**20/20 SUCCESS，0 LAGGED**）形成**全量回归**——`aidqq/main baf9315` 上，
> **无工具起手（kit=none）的合成链路整体坏掉**，属于**主干回归**，不是农场环境问题（详见 §4 对照）。

| 指标 | FARM-02（good 基线） | **FARM-04（本单）** | 变化 |
|---|---|---|---|
| 成功局数 | **20 / 20** | **0 / 20** | **−20** |
| LAGGED | 0 | 6 | +6 |
| 内存峰值 | 1731.5MB | 1700.5MB | ≈ 持平（环境无异常） |
| 代码源 | `aidqq/main ad1cc67` | **`aidqq/main baf9315`** | 主干推进 |

---

## 2. 逐局结果（20/20 全部有归档）

| trial | seed | outcome | duration(s) | wall(s) | tps | lag |
|---:|---|---|---:|---:|---:|:--:|
| 1 | P2C_M4B4-01 | FAIL(TOOL_MISSING) | 67.8 | 107.5 | 20.03 | – |
| 2 | P2C_M4B4-02 | FAIL(TOOL_MISSING) | 80.5 | 227.8 | 16.43 | ✔ |
| 3 | P2C_M4B4-03 | SERVER_FAIL | – | – | – | – |
| 4 | P2C_M4B4-04 | SERVER_FAIL | – | – | – | – |
| 5 | P2C_M4B4-05 | FAIL(TOOL_MISSING) | 76.8 | 119.4 | 20.03 | – |
| 6 | P2C_M4B4-06 | FAIL(TOOL_MISSING) | 41.5 | 190.6 | 12.80 | ✔ |
| 7 | P2C_M4B4-08 | SERVER_FAIL | – | – | – | – |
| 8 | P2C_M4B4-09 | SERVER_FAIL | – | – | – | – |
| 9 | P2C_M4B4-10 | FAIL(TOOL_MISSING) | 125.9 | 178.2 | 17.50 | ✔ |
| 10 | P2C_M4B4-07 | FAIL(NO_PROGRESS_ABORT) | – | 324.0 | 5.14 | ✔ |
| 11 | P2C_M4B4-11 | SERVER_FAIL | – | – | – | – |
| 12 | P2C_M4B4-12 | FAIL(TOOL_MISSING) | 99.2 | 189.1 | 17.32 | ✔ |
| 13 | P2C_M4B4-13 | FAIL(?) = CONNECT_FAIL | – | 672.1 | – | – |
| 14 | P2C_M4B4-14 | FAIL(TOOL_MISSING) | 64.2 | 126.4 | 19.92 | – |
| 15 | P2C_M4B4-15 | FAIL(TOOL_MISSING) | 120.9 | 265.3 | 12.57 | ✔ |
| 16 | P2C_M4B4-16 | SERVER_FAIL | – | – | – | – |
| 17 | P2C_M4B4-17 | SERVER_FAIL | – | – | – | – |
| 18 | P2C_M4B4-18 | NO_RESULT | – | 730.1 | – | – |
| 19 | P2C_M4B4-20 | FAIL(TOOL_MISSING) | 66.3 | 117.6 | 19.95 | – |
| 20 | P2C_M4B4-19 | FAIL(TOOL_MISSING) | 53.1 | 88.2 | 19.97 | – |

**outcome 分布**：`FAIL(TOOL_MISSING)` ×10、`SERVER_FAIL` ×7、`FAIL(NO_PROGRESS_ABORT)` ×1、
`FAIL(?)`（CONNECT_FAIL）×1、`NO_RESULT` ×1。

### 2.1 十局 `FAIL(TOOL_MISSING)`——**同一条合成链路全挂**
`result.json.detail` 一致为：
```json
{ "rescueTool": "wooden_pickaxe", "childReason": "CRAFT_FAILED", "blockName": "stone" }
```
即：无工具起手 → 走 `tool_rescue` 造 `wooden_pickaxe` → 造镐失败 → 回落判 `TOOL_MISSING` → 无法采石。
十局中 `finalInventory.cobblestone` 全为 0，`craftAttempts` 6–9、`craftFailures` 4–9（见 §3）。

### 2.2 七局 `SERVER_FAIL`——服务器未完成起服
这 7 局的 `server.log` 停在 `Preparing spawn area: 5x~6x%`，**世界生成未完成就被判 SERVER_FAIL**
（trial 16 例外：其实 `Done (489.608s)!` 刚起好即被 420s 超时判失败）。属**并发起服压力**下的边缘样本，
与合成回归是两回事，单独标注。

### 2.3 两局边缘样本
- **trial 10 `NO_PROGRESS_ABORT`**：wall=324s、tps=5.14（该泳道当时在收尾/拥塞），120s 无进展被中止。
- **trial 13 `CONNECT_FAIL`**：`Error: connect ECONNREFUSED 127.0.0.1:25603`（该局 bot 连不上本泳道端口，属起服竞态）。
- **trial 18 `NO_RESULT`**：wall=730s 无 `result.json`（超时收尾）。

> 以上 7+1+1+1 = 10 局属**环境/并发边缘**，若要干净口径可在低并发下复跑；
> 但**核心信号在 §3**：即使这些边缘局全部排除，**剩下 10 局也全是 `TOOL_MISSING`**，回归结论不变。

---

## 3. 合成链路遥测（回归根因：**观察层口径，非推测**）

跨 10 局的合成事件合计：

| 事件 | 计数 | 明细 |
|---|---|---|
| `craft_ok`（服务端**成功**） | **9** | oak_planks 5、spruce_planks 2、birch_planks 1、acacia_planks 1 |
| `craft_no_gain` | **62** | `no_server_window_truth` 23、`no_result` 15、`probe_unconfirmed` 15、`missing_ingredient` 9 |
| `craft_fail` | **62** | 全部 `craft_promise_rejected` |

### 3.1 关键观察：**服务端成功了，客户端却判失败**
以 trial_01 为例（`lane0/trial_01/telemetry.jsonl`），时间线清晰：

```
craft_ok   spruce_planks  gained=4  inv=4  viaTable=false   ← 服务端确实给出 4 个木板
craft_no_gain crafting_table gained=0 reason=missing_ingredient   ← 紧接着说“缺料”
craft_fail    crafting_table error=craft_promise_rejected
...
craft_ok? 无
craft_no_gain spruce_planks gained=1 expected=1 reason=no_result  ← “拿到 1 个” 仍判 no_result
craft_fail    spruce_planks error=craft_promise_rejected
...
craft_no_gain spruce_planks gained=0 reason=no_server_window_truth cursorSource=ack_verified cursorMismatches=0 slotCount=46
craft_fail    spruce_planks error=craft_promise_rejected   （连续 4 次重试，craftRetries 1..4）
```

> 注意 `cursorSource=ack_verified`、`cursorMismatches=0`、`slotCount=46`——**游标校验自洽**，
> 但结果仍被 `no_server_window_truth` / `no_result` 判为「未获得」。
> 且 `craft_planks_retype`（oak→spruce 自动换木材）在两局出现，说明重试路径被反复触发。

### 3.2 归纳（只陈述观察）
- **合成请求在服务端生效**（有 `craft_ok gained=4` / `gained=1` 的实证），
  但**验证层把成功读成失败**（`no_result` / `no_server_window_truth`），随后 `craft_promise_rejected`。
- 失败后进入 `craft_replan`（`why=craft_shortfall`, `cause=no_recipe`），**越修越乱**，
  最终 `tool_rescue_fail` → 子任务 `CRAFT_FAILED` → 顶层 `TOOL_MISSING`。
- 该模式在 **10/10 个走到合成的局里 100% 复现**，跨 6 条泳道、不同种子、
  不同木材种类（oak/spruce/birch/acacia）**一致**——指向主干合成验证逻辑的通用回归，而非某局偶发。

> **归因边界**：按设计会话指示，本单只**照实记录现象**；根因定位（`aidqq/main baf9315` 相对 `ad1cc67`
> 在合成验证/`window_truth` 采集上的改动）交由对应团队，本报告不写推测结论。

---

## 4. 为什么这不是农场环境问题（对照 FARM-02）

| 维度 | FARM-02 | FARM-04 | 是否变化 |
|---|---|---|---|
| runner | `run_lane.mjs` sha `f1a15a97…` | 同 | 否 |
| 农场调度 | `run_farm.mjs`（含 `planLanes()` 修复） | 同 | 否 |
| 6 泳道 / 20 局 / 种子顺序 | 相同 | 相同 | 否 |
| JVM / 起服闸 / 资源闸门 | 相同 | 相同 | 否 |
| 内存峰值 | 1731.5MB | 1700.5MB | 否（更低） |
| 代码源 | `aidqq/main ad1cc67` | **`aidqq/main baf9315`** | **是** |

**唯一变量就是 `aidqq/main` 的代码推进（ad1cc67 → baf9315）。** 农场侧一切照旧，
故 FARM-04 的 0/20 归因于**主干代码回归**，FARM-02 的 20/20 仍为有效 good 基线。

---

## 5. 附件清单

| 文件 | 说明 |
|---|---|
| `farm04_main_summary.json` | 逐局表 + 逐局合成事件统计（本报告 §2/§3 的数据源） |
| `farm04-telemetry.tar.gz` | 20 局原始遥测（`result.json` / `telemetry.jsonl` / `server.log` / `bot.log`，不含 world） |
| `run_farm.mjs` | 6 泳道调度器（含 `planLanes()` 修复） |
| `run_lane.mjs` | 单局执行体（sha `f1a15a97…`） |
| `extract_farm04_main.py` | 本报告的汇总脚本 |
| `SHA256SUMS.txt` | 校验和（LF 原文） |

运行控制台：`runs_FARM04_MAIN.console.log`（含起服闸逐泳道放行时间）。
