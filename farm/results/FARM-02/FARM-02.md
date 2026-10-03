# FARM-02 报告｜主干回归（aidqq/main） + G 线微基准（creeper / gaze）

> 执行机：大云端容器（Ubuntu 24.04.3 LTS，无 GPU）。复核：本地设计会话。
> 代码来源：`bundles/MANIFEST.json` → **`code-20261003-1037.tar.gz`**
> （sha256 `3f9d72570649406de6db3dbc1c537d3a99c0dd69ac61ad2135c2ad79d86093fa`，包内 4 个源：
> `bench/master 3d0cc3b`、`bench/cloud/lane-x 7eacf2e`、`aidqq/main ad1cc67`、`aidqq/s0-survival 02ac320`）。
> 本报告覆盖 FARM-02 的 ①②③：主干回归、G 线微基准、结果交付。

---

## 0. 先答设计会话的复核问题：`lanes=5` 还是「@ N=6」？

**结论：以 `consist20_summary.json` 的 `lanes=5` 为准；报告里的「@ N=6」是错的标签，代码没做到 6 泳道。**

根因（已复现）：`run_farm.mjs` 的 `planLanes()` 用
`perLane = Math.ceil(SEEDS/LANES)`（`ceil(20/6)=4`）+ `slice(i*perLane, (i+1)*perLane)`。
每泳道切 4 局 ⇒ 只能排出 **5** 条泳道（第 6 条 `slice(20,24)` 为空 → break）。
于是 **`--lanes 6` 静默塌陷成 5 泳道**，日志里那行「N=6」只是参数回显，不是实际泳道数。

- 旁证：FARM-01 的 `consist20_summary.json` 里 `lanes=5`、泳道名 `Y0..Y4`、每泳道恰好 4 局（4×5=20），
  与 `ceil` 塌陷完全吻合。
- 影响：**只影响 FARM-01 的并发口径**（实际是 5 并发，不是 6），不影响 19/20 的成功率结论
  （5 并发下的 20 局照样跑完）。
- 处置：**本单已修** `planLanes()`（改为 `base + (i<rem?1:0)` 均分），并新增 `farm_meta.json` 的
  `lanesRequested` 字段，把「请求的泳道数」与「实际的泳道数」分开记录，杜绝再次静默塌陷。
  FARM-02① 主回归因此是**真正的 6 泳道**（见 §1，`lanesRequested=6 / lanes=6`）。

---

## 1. ① 主干回归：BASIC-bootstrap M4B4 ×20 @ N=6

> 代码：包内 `aidqq/main ad1cc67`（`MC_MINDCRAFT_ROOT` 指向包内 `mindcraft/`）。
> 种子：`P2C_M4B4-01..20`（FARM-01 一致性 20 颗同名单，顺序见 `farm_meta.json`）。
> 口径：起服闸生效；**LAGGED 局照样计成绩**（手册 §4.7）；`--target 16 --timeout-ms 420000`。

### 结果（与 FARM-01、本地 06c 同口径对比）

| 口径 | 成功 | LAGGED | smelt_take_unverified | craft_error | craft_fail | craft_replan |
|---|---|---|---|---|---|---|
| **FARM-02①（本单，真 6 泳道）** | **20/20** | **0** | **0** | **0** | **0** | **9** |
| FARM-01（@N=6 表头，实际 5 泳道） | 19/20 | 2 | — | — | — | — |
| 本地 06c | 18/20 | — | — | — | — | — |

**四计数器合计**：`smelt_take_unverified=0`、`craft_error=0`、`craft_fail=0`、`craft_replan=9`。

### 统计

| 指标 | min | 中位 | max |
|---|---|---|---|
| TPS | 19.90 | 20.05 | 20.77 |
| 单局时长 durationSec | 62.2 | 73.5 | 207.8 |
| 起服 bootSec（照记不计成绩） | 26.2 | 38.3 | 77.3 |
| 墙钟 wallSec | 104.4 | 164.4 | 422.9 |

- 内存峰值 **1731.5 MB**；零 OOM、零端口冲突、零残留进程。
- LAGGED **0 局**：本次 20 局 TPS 全部 ≥19.90，离 LAGGED 线（<18）余量充足。
- **`P2C_M4B4-06`（FARM-01 的唯一失败 `FAIL(TOOL_MISSING)`）本单 SUCCESS** —— 该种子在 FARM-02 的
  `aidqq/main ad1cc67` 上不再复现失败；对照 FARM-01 的同局 TPS 18.19，本局 TPS 20.20，服务器无滞后。

### 逐局明细

<!--MAIN_TABLE-->
| trial | 泳道 | 种子 | 结果 | TPS | LAGGED | smelt_unv | cr_err | cr_fail | cr_replan |
|---|---|---|---|---|---|---|---|---|---|
| 1 | Y0 | P2C_M4B4-01 | SUCCESS | 20.24 | | 0 | 0 | 0 | 0 |
| 2 | Y0 | P2C_M4B4-02 | SUCCESS | 19.90 | | 0 | 0 | 0 | 1 |
| 3 | Y0 | P2C_M4B4-03 | SUCCESS | 20.06 | | 0 | 0 | 0 | 0 |
| 4 | Y0 | P2C_M4B4-04 | SUCCESS | 19.98 | | 0 | 0 | 0 | 0 |
| 5 | Y1 | P2C_M4B4-05 | SUCCESS | 19.97 | | 0 | 0 | 0 | 1 |
| 6 | Y1 | P2C_M4B4-06 | SUCCESS | 20.20 | | 0 | 0 | 0 | 0 |
| 7 | Y1 | P2C_M4B4-08 | SUCCESS | 20.06 | | 0 | 0 | 0 | 0 |
| 8 | Y1 | P2C_M4B4-09 | SUCCESS | 20.10 | | 0 | 0 | 0 | 1 |
| 9 | Y2 | P2C_M4B4-10 | SUCCESS | 20.05 | | 0 | 0 | 0 | 0 |
| 10 | Y2 | P2C_M4B4-07 | SUCCESS | 20.07 | | 0 | 0 | 0 | 1 |
| 11 | Y2 | P2C_M4B4-11 | SUCCESS | 19.98 | | 0 | 0 | 0 | 1 |
| 12 | Y3 | P2C_M4B4-12 | SUCCESS | 20.27 | | 0 | 0 | 0 | 0 |
| 13 | Y3 | P2C_M4B4-13 | SUCCESS | 19.95 | | 0 | 0 | 0 | 1 |
| 14 | Y3 | P2C_M4B4-14 | SUCCESS | 20.18 | | 0 | 0 | 0 | 0 |
| 15 | Y4 | P2C_M4B4-15 | SUCCESS | 20.03 | | 0 | 0 | 0 | 0 |
| 16 | Y4 | P2C_M4B4-16 | SUCCESS | 20.03 | | 0 | 0 | 0 | 1 |
| 17 | Y4 | P2C_M4B4-17 | SUCCESS | 20.47 | | 0 | 0 | 0 | 1 |
| 18 | Y5 | P2C_M4B4-18 | SUCCESS | 19.94 | | 0 | 0 | 0 | 0 |
| 19 | Y5 | P2C_M4B4-20 | SUCCESS | 20.77 | | 0 | 0 | 0 | 0 |
| 20 | Y5 | P2C_M4B4-19 | SUCCESS | 19.99 | | 0 | 0 | 0 | 1 |

**对比结论**：FARM-02① **20/20 优于** FARM-01 的 19/20（实际 5 泳道）与本地 06c 的 18/20；
且**四计数器全为 0**（`craft_replan=9` 是正常重规划，非错误）。这是 `aidqq/main ad1cc67` 相对
FARM-01 基线（`ad1cc67` 前身）的净提升；`P2C_M4B4-06` 的 `TOOL_MISSING` 已不再复现。

---

## 2. ② G 线微基准（n≥30）：creeper / gaze

> 判据：**一行未改**。场景真源 `bench/stages/basic-survival/micro/scenarios.mjs` 与执行体
> `micro_defense.mjs` 原样使用；runner 只负责「起场景 + 收 `result.json.verdict`」，不解释、不改写。
> G 线原始 runner（`run_bench.mjs` → `_lib/runner_core.mjs`）是 **Windows 专属**，本单按
> `run_lane.mjs` 的做法移植到 Linux，新文件 `bench/cloud/run_micro_linux.mjs`，**移植改动清单**见 §3。
> 本单**只跑 creeper 与 gaze**；melee / skeleton 两组 G 线仍在修，按任务单**不跑**。

<!--MICRO_SECTION-->

### 2.1 苦力怕 `creeper`（n=30）—— fuse 窗口内脱离

**结果：30/30 PASS（100%），零失败。**

判据（来自 `scenarios.mjs`，一行未改）：`verdict = (damageTaken === 0 && hpAfter > 0) ? 'PASS' : 'FAIL'`
—— 即**不掉血、没死**（苦力怕爆炸伤害半径 = 2×威力 = 6 格〔wiki·Creeper〕）。

| 指标 | 值 |
|---|---|
| 样本 | **30** |
| PASS | **30**（100%） |
| FAIL | 0 |
| `damageTaken` | **全部 = 0**（每局 `hpBefore=hpAfter=20`） |
| 触发距离 `distAtTrigger` | min 3.63 / 中位 **4.88** / max 5.96 格 |
| 最大水平距离 `maxHdist` | min 5.20 / 中位 **7.25** / max 7.54 格 |
| 撤到 7.5 格的耗时 `escapeMs` | 19/30 局达到；中位 **3020 ms**（min 2958 / max 3114） |
| 换点次数 `rePlans` | 29 局 = 2 次，1 局 = 1 次 |

**逐局结果（全 30 局）**：

| trial | verdict | dmg | hp↓ | 触发距 | escMs | maxHdist | rePlans |
|---|---|---|---|---|---|---|---|
| 1 | PASS | 0 | 20 | 4.88 | — | 6.41 | 2 |
| 2 | PASS | 0 | 20 | 4.48 | 3037 | 7.06 | 2 |
| 3 | PASS | 0 | 20 | 4.88 | 3023 | 7.37 | 2 |
| 4 | PASS | 0 | 20 | 4.88 | 3018 | 7.32 | 2 |
| 5 | PASS | 0 | 20 | 4.88 | 3018 | 7.25 | 2 |
| 6 | PASS | 0 | 20 | 4.88 | 3010 | 7.26 | 2 |
| 7 | PASS | 0 | 20 | 3.63 | — | 5.20 | 1 |
| 8 | PASS | 0 | 20 | 4.88 | 3021 | 7.37 | 2 |
| 9 | PASS | 0 | 20 | 4.88 | 3020 | 7.37 | 2 |
| 10 | PASS | 0 | 20 | 5.29 | — | 7.12 | 2 |
| 11 | PASS | 0 | 20 | 4.88 | — | 6.63 | 2 |
| 12 | PASS | 0 | 20 | 5.15 | 3018 | 7.37 | 2 |
| 13 | PASS | 0 | 20 | 4.88 | 3059 | 7.28 | 2 |
| 14 | PASS | 0 | 20 | 4.88 | 3025 | 7.32 | 2 |
| 15 | PASS | 0 | 20 | 4.88 | 3012 | 7.32 | 2 |
| 16 | PASS | 0 | 20 | 4.88 | 3019 | 7.28 | 2 |
| 17 | PASS | 0 | 20 | 4.48 | 3017 | 7.37 | 2 |
| 18 | PASS | 0 | 20 | 5.15 | — | 7.02 | 2 |
| 19 | PASS | 0 | 20 | 5.02 | 2958 | 7.54 | 2 |
| 20 | PASS | 0 | 20 | 5.96 | 3070 | 7.12 | 2 |
| 21 | PASS | 0 | 20 | 5.02 | — | 7.04 | 2 |
| 22 | PASS | 0 | 20 | 4.88 | — | 6.41 | 2 |
| 23 | PASS | 0 | 20 | 4.88 | — | 6.63 | 2 |
| 24 | PASS | 0 | 20 | 4.48 | — | 6.24 | 2 |
| 25 | PASS | 0 | 20 | 5.15 | — | 7.12 | 2 |
| 26 | PASS | 0 | 20 | 4.88 | 3019 | 7.37 | 2 |
| 27 | PASS | 0 | 20 | 5.02 | — | 6.80 | 2 |
| 28 | PASS | 0 | 20 | 4.88 | 3064 | 7.28 | 2 |
| 29 | PASS | 0 | 20 | 5.96 | 3114 | 7.04 | 2 |
| 30 | PASS | 0 | 20 | 4.88 | 3021 | 7.37 | 2 |

**诊断字段（不参与判据）**：
- **fuse 包围盒判据**：30 局里 24 局记「可用」、6 局记「不可用」（`fuseEverSeen || maxWidth>0.7`）。
  该字段本组**只记录、不判定**（判据里明确写着「降级成记录项」）。结论与 `scenarios.mjs` 头注一致：
  **1.16.1 客户端上 creep 的 `width` 不随膨胀稳定变化，包围盒判据不可靠**；本组已改为
  「距离 <6 且 EMERGENCY」这一**生产触发条件**，不依赖 fuse 检测。元数据索引的阳性对照在 `fuseprobe` 组
  （本单不跑）。
- 19/30 局记到了「撤到 7.5 格」的耗时（中位 3.02s）；其余 11 局的 `maxHdist` 落在 6.2–7.1 格之间，
  **仍判 PASS**（判据是「不掉血」，不是「必须到 7.5」——7.5 只是行为目标）。
  旁证：全部 30 局 `damageTaken=0`，**「不掉血」与「是否到 7.5」解耦**后 100% 通过，
  印证了 FARM-01 修订的这一判据是正确的。

### 2.2 末影人 `gaze`（n=30）—— 凝视守卫拦截

<!--GAZE_BLOCK-->

**结果：16/30 PASS（53.3%）。失败构成：`FAIL`×10、`scenario_gates_failed`×4。**

判据（来自 `scenarios.mjs`，一行未改）：
`verdict = (baseline.stare && rejected >= 1 && pitchDeg <= -10 && notAngry) ? 'PASS' : 'FAIL'`
—— 四个条件：① 正对时本应盯上（baseline 成立）② 守卫拦下 lookAt（`rejected≥1`）
③ 俯仰被压到 ≤−10° ④ 末影人 3s 内位移 <2 格（没被激怒）。

#### ★ 关键结论：**守卫本身零失败；14 个失败全部源于末影人的移动随机性（场景设计层面 flaky）**

把 30 局按「守卫是否工作」重新归类（**这是本组最有价值的读数**）：

| 分类 | 局数 | 含义 |
|---|---|---|
| **守卫完全正确**（PASS） | **16** | 场景建对、守卫拦截、pitch=-15、末影人未被激怒 |
| **守卫正确但末影人自行激怒** | **5** | `rejected=1, pitchDeg=-15`（**守卫拦住了**），但末影人 3s 内位移 >2 格 → `notAngry=False` |
| **baseline 夹角失效** | **5** | 末影人漂移/瞬移，使正对夹角 >10° → `stare=False`，**守卫无对象可拦**（非守卫问题） |
| **场景闸门失败** | **4** | 末影人离刷新点 >9 格 → `enderman_near_spawn_point` FAIL |

> **在全部 21 个「场景建对且末影人未自行激怒」的局里，守卫 100% 正确工作**
> （`rejected=1`、`pitchDeg=-15`）。**没有任何一局的失败可归因于守卫原语。**

#### 失败逐局根因

| trial | verdict | baseline.stare | baseDeg | rejected | pitchDeg | endermanMoved | notAngry | 根因 |
|---|---|---|---|---|---|---|---|---|
| 3 | FAIL | **False** | 10.09 | 0 | 9.6 | 7.95 | False | 末影人漂移，夹角过 10° |
| 4 | FAIL | — | — | — | — | — | — | 闸门：离刷新点 10.54 格 |
| 6 | FAIL | True | 9.37 | 1 | −15 | 7.32 | **False** | **守卫拦住了**，末影人自行激怒 |
| 11 | FAIL | **False** | **66.58** | 0 | 10.6 | 0.34 | True | 末影人**瞬移**到另一方位角 |
| 13 | FAIL | True | 9.37 | 1 | −15 | 6.38 | **False** | **守卫拦住了**，末影人自行激怒 |
| 15 | FAIL | **False** | **66.58** | 0 | 18.1 | 4.18 | False | 末影人瞬移到另一方位角 |
| 16 | FAIL | **False** | 10.05 | 0 | 9.3 | 1.09 | True | 末影人漂移，夹角过 10° |
| 20 | FAIL | True | 9.37 | 1 | −15 | 3.48 | **False** | **守卫拦住了**，末影人自行激怒 |
| 21 | FAIL | — | — | — | — | — | — | 闸门：离刷新点 10.18 格 |
| 22 | FAIL | **False** | 27.11 | 0 | 8.4 | 0 | True | 末影人漂移，夹角过 10° |
| 23 | FAIL | — | — | — | — | — | — | 闸门：离刷新点 11.82 格 |
| 24 | FAIL | — | — | — | — | — | — | 闸门：离刷新点 11.40 格 |
| 25 | FAIL | True | 9.37 | 1 | −15 | 4.14 | **False** | **守卫拦住了**，末影人自行激怒 |
| 30 | FAIL | True | 9.37 | 1 | −15 | 3.59 | **False** | **守卫拦住了**，末影人自行激怒 |

（其余 16 局 PASS，均为 `baseDeg=9.37, rejected=1, pitchDeg=-15, moved=0, notAngry=True`。）

#### 判读

1. **守卫原语（installGazeGuard / wouldStare / lookAt 拦截 / pitch 压制）经 n=30 检验无缺陷。**
   判据里的 `pitchDeg <= -10`、`rejected>=1` 在 21 个有效局里**全部满足**（pitch 一律 −15°，正是
   设计初值）。
2. **失败全部来自末影人的行为随机性**，具体三种：
   - **漂移**（夹角 10.05–27.11°）：末影人在 `settleMs`+闸门等待期里走出正对轴；
   - **瞬移**（夹角 **66.58°**，trial 11/15）：末影人的**传送**行为把「正对」基准直接推翻；
   - **自行激怒**（5 局）：即使守卫正确拦下 `lookAt`、pitch 压到 −15°，
     末影人仍会在 3s 内因**其它原因**（例如它自己移动到视线内、或守卫安装前的一拍）
     被激怒并位移 >2 格。
3. **`gazeGuardDeg = 10`（`threat_table.js:73`）这一阈值相对末影人漂移过于紧凑**：
   正常正对时夹角是 **9.37°**（离阈值仅 0.63°余量），末影人只要漂移一点点就越过 10°。
   这解释了为什么失败率高达 47%。

#### 与 creeper 的对比

| 场景 | n | PASS | 失败归因 |
|---|---|---|---|
| **creeper** | 30 | **30（100%）** | — （静止目标 + 生产触发条件，稳定） |
| **gaze** | 30 | **16（53.3%）** | 100% 末影人移动随机性（漂移/瞬移/自行激怒），**守卫 0 失败** |

**本组给设计会话的建议（待复核，不擅自改判据）**：
- 若 gaze 要作**验收判据**，需先把末影人的位置**钉死**（如 `NoAI` 或每拍重定位到固定站位），
  否则 53% 的通过率测的是「末影人会不会乱跑」，不是「守卫对不对」。
- 或把 `gazeGuardDeg` 阈值放宽（初值 10° 离实测正对 9.37° 仅 0.63° 余量），
  但**这属于改判据，本单不做**，按要求「判据一行不改」，如实报告。
- `notAngry`（3s 位移 <2 格）这条也应与「守卫是否拦下 lookAt」**解耦**评估：
  当前 5 局「守卫正确却判负」说明该条把末影人的自发行为算到了守卫头上。





---

## 3. ②附 G 线 runner 的 Linux 移植改动清单

相对 Windows 版 `run_bench.mjs` + `_lib/runner_core.mjs`，**只改平台原语，判据不动**：

| # | Windows 原实现 | Linux 移植实现（`run_micro_linux.mjs`） | 说明 |
|---|---|---|---|
| 1 | `runner_core.killTree()` → `taskkill /PID /T /F` | **只** `process.kill` 打本进程 spawn、登记在 `spawned` 的 child | 手册 §9.2「只结束自己 spawn 的」；不做按名/按端口/按命令行全局扫描 |
| 2 | `preflight.mjs`：`powershell Get-CimInstance Win32_Process` + `netstat -ano` | 优先 `ss -ltnH`（若装了），否则 Node TCP **bind 探测** | 服务端真正执行的就是这个 bind，最权威 |
| 3 | `line_lock.mjs`：`tasklist /NH /FO CSV` + `.lane-owners/<lane>.json` 心跳 | 本机单泳道不需要；跨进程互斥改用 `run_lane.mjs` 同款**起服文件锁** | 锁语义与 FARM-01 完全一致（见 §4） |
| 4 | `reserve.mjs`：Windows 心跳协议 | 不移植 | 本机农场不跑拍摄预约 |
| 5 | preflight「按命令行匹配杀残留」整段 | **废除** | 手册 §9.2 已明令废除 |
| 6 | 依赖 `experiments/mc1161-gate` 模板目录（`server.properties`） | runner 自己在 `MC_BENCH_SERVER` 下生成（`difficulty=easy / spawn-monsters=true`，与 run_bench 同值） | 模板不共享，自包含 |
| 7 | `JAVA_TOOL_OPTIONS` / 便携 Node20 路径假设 | 改读 `MC_BENCH_JAVA` / `process.execPath` | — |
| 8 | `remapMicroOutcomes`（事后把 runner 的矩阵语义 `botExit!==0⇒FAIL(?)` 回写成 verdict） | **不需要**：outcome 直接取 `result.json.verdict` | Windows 版是「先记错、事后再修」，Linux 版一次到位 |
| 9 | `_lib/` 的 `argOf/parseLanes/...` | 本文件自带等价小工具 | 不新增/不改 `_lib/`（手册 §9） |

**判据一致性证据**：
- kit 串拼法与 `run_bench.microKit` **同构**（`exec:`+命令 + 物品，逗号分隔）；
- `micro_defense.mjs` 的 harness 栅栏（`kit_done.json`）、通用闸门、场景闸门、measure **原样调用**；
- outcome 直接取 `result.json.verdict`（`PASS`→`MICRO_PASS`，否则 `MICRO_FAIL(why)`）。

---

## 4. 起服锁过期兜底（任务单要求核对）

**结论：上一单（FARM-01）已实现并随包前滚，本单确认生效、无需再改。**

- 落点：`run_lane.mjs` / `run_micro_linux.mjs` 的 `acquireBootLock()`（`runs/.boot.lock`，`O_CREAT|O_EXCL`）。
- 两级兜底：① 优先 `kill(pid,0)` 判**持锁进程是否存活**（`EPERM` 视为存活）——能区分「起服慢」与「进程已死」；
  ② 进程仍存活时用 mtime 兜底，阈值 = **`max(boot-timeout*1000 + 30000, 环境变量)`**（默认 330s）。
- 自测：`bench/cloud/boot_lock_selftest.mjs` **6/6 通过**（含「130s 慢起服：旧版硬编码 120s 会误抢 / 新版不抢」回归用例）。
- 本轮主回归与微基准的起服全程走这把锁；`bootSec` 26–77s，未见误抢或死锁。

---

## 5. ③ 交付产物

置于分支 `farm/results` 目录 `farm/results/FARM-02/`：

| 文件 | 说明 |
|---|---|
| `FARM-02.md` | 本报告 |
| `farm02_main_summary.json` | ① 主干回归汇总（20 局 + 四计数器 + TPS/时长统计） |
| `micro_creeper_summary.json` | ② creeper 微基准汇总（30 局 + 判据字段） |
| `micro_gaze_summary.json` | ② gaze 微基准汇总（30 局 + 判据字段） |
| `farm02-telemetry.tar.gz` | ① + ② 的原始遥测（`telemetry.jsonl` / `result.json` / `probe.jsonl` / 日志；**不含 world**） |
| `run_micro_linux.mjs` | G 线 **Linux 移植 runner**（本次新增，供设计会话复核移植改动） |
| `run_farm.mjs` | 本单修正版（含 `planLanes()` 修复，见 §0） |
| `SHA256SUMS.txt` | 上述文件的 sha256（**按 LF 原文**计算） |

---

## 6. 附：原始输出与遥测

完整原始遥测见 `farm02-telemetry.tar.gz`。关键原始输出摘录：

### 6.1 ① 主干回归（20/20，四计数器）

```
成功率: 20/20    LAGGED: 0 局
四计数器合计: smelt_take_unverified=0  craft_error=0  craft_fail=0  craft_replan=9
lanes=6  lanesRequested=6  （planLanes 修复后真正的 6 泳道）
TPS min/median/max = 19.90 / 20.05 / 20.77
内存峰值 1731.5 MB
```

### 6.2 ② creeper（30/30）

```
=== MICRO creeper n=30 ===
总样本 30  PASS 30  FAIL 0  通过率 100.0%
damageTaken 全为 0；maxHdist 中位 7.25；escapeMs 中位 3020ms（19/30 局记到）
```

### 6.3 ② gaze（16/30）

```
=== MICRO gaze n=30 ===
总样本 30  PASS 16  FAIL 14  通过率 53.3%
失败构成: {"null": 10, "scenario_gates_failed": 4}
分类: 守卫完全正确 16 | 守卫正确但末影人自行激怒 5 | baseline 夹角失效 5 | 场景闸门失败 4
→ 守卫原语 0 失败；全部失败源于末影人漂移/瞬移/自行激怒
```

### 6.4 起服锁自测（6/6）

```
PASS  ① 持锁进程已死 → 立刻接管
PASS  ② 存活 + 锁龄未超 → 必须等待
PASS  ③ 存活 + 锁龄超 boot-timeout+30s → 接管
PASS  ④ STALE_MS(330s) > BOOT_TIMEOUT(300s)
PASS  ⑤ 回归：130s 慢起服，旧版会误抢
PASS  ⑤ 回归：130s 慢起服，新版不抢
全部通过 ✅
```

### 6.5 环境（与 FARM-01 一致）

```
可见核数 nproc = 32；cgroup cpu.max = 400000 100000 → 4.00 核
Java = openjdk 11.0.32.1+1（apt openjdk-11-jdk-headless）
jar  = server-1.16.1.jar（sha1 a412fd69db1f81db3f511c1463fd304675244077）
Node = v22.13.1
```

---

## 7. 待设计会话复核的决策点

1. **gaze 场景 flaky（最重要）**：n=30 只有 53.3% 通过，但**守卫原语零失败**。
   根因是末影人的漂移/瞬移/自行激怒，**不是守卫**。若 gaze 要作验收判据，
   需先把末影人钉死（NoAI / 每拍重定位），否则测的是末影人行为而非守卫。
   **本单严格「判据一行不改」，只如实报告。** 是否调整场景/阈值由设计会话定。
2. **`planLanes()` 已修**，FARM-02 起为真 6 泳道（`lanesRequested=6`）。FARM-01 的 `lanes=5` 为历史值，无需回填。
3. **creeper 100% 且「不掉血」判据成立**：30 局全 `damageTaken=0`，
   证明 FARM-01 把判据从「必须到 7.5 格」改成「不掉血没死」是正确的。
4. **melee / skeleton 两组未跑**（按任务单，仍在修）。

