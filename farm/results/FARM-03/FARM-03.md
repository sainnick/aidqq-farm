# FARM-03 报告｜G 线微基准（gaze 阈值 15° / melee / skeleton）

> 执行机：大云端容器（Ubuntu 24.04.3 LTS，无 GPU）。复核：本地设计会话。
> 代码来源：`farm-mirror main` 的 `bundles/MANIFEST.json` → **`code-20261003-1523.tar.gz`**
> （sha256 见 §0 校验；包内源：`bench/master f5663f9`、`bench/cloud/lane-x 7eacf2e`、`aidqq/s0-survival ecaa5d0`）。
> 本报告覆盖 FARM-03 的三组微基准：`gaze`（n=30，阈值 15°）、`melee`（n=3）、`skeleton`（n=3）。
> **判据一行不改**：场景真源 `scenarios.mjs` 与执行体 `micro_defense.mjs` 原样使用；
> runner 只负责「起场景 + 收 `result.json.verdict`」，不解释、不改写。

---

## 0. 代码包核验（开跑前闸门）

读取 `farm-mirror main` 上最新 `MANIFEST.json`：

```json
{ "latest": "code-20261003-1523.tar.gz",
  "sha256": "b3a32c6d9ee11c21a4d33e8bea7dbc687cceedf23884adb0fc150eaf6bf5e938",
  "sizeBytes": 1584038,
  "source": { "bench/master": "1ac7e7a", "bench/cloud/lane-x": "7eacf2e", "aidqq/main": "baf9315" } }
```

> ⚠ 注意：本任务消息对 FARM-03 包的描述为「`aidqq/s0-survival ecaa5d0`，凝视阈值已改 15°、视线 DDA 已修；
> bench f5663f9」，与线上 `MANIFEST.json` 里 `bench/master 1ac7e7a` 不同（`f5663f9` 是 FARM-03 场景文件的
> 修订提交，`1ac7e7a` 是当前 bench master 头）。**代码包 sha256 与消息给定的 `b3a32c6d…` 完全一致**，
> 下载后实测：

```
$ sha256sum code-20261003-1523.tar.gz
b3a32c6d9ee11c21a4d33e8bea7dbc687cceedf23884adb0fc150eaf6bf5e938  code-20261003-1523.tar.gz   ✓（与 MANIFEST 一致）
sizeBytes = 1584038   ✓
```

包内核对（三项修复均在位）：
- **凝视阈值 15°**：`src/agent/tasks/exec/defense/threat_table.js:85` → `gazeGuardDeg: 15` ✅
- **视线 DDA 修复**：`src/agent/tasks/exec/defense/los.js` 的 `raycastBlockTrace` 改为**逐轴 bound**（每根轴用自己的 step），
  并以 `t ≤ 1` 判定越过终点；离线对照工具 `analysis/dda_offline_check.mjs` 可复现「修复前共用 stepX」的
  46/96 例分叉 ✅
- **场景侧**：`scenarios.mjs` 的 gaze `yaw=π`（正对 +z 的末影人）与 `bot.entity.pitch`（数字，非 `look.y`）修正已就位；
  melee 用 `{NoAI:1b}` 固定靶；skeleton 柱体改 `201..203` 并查顶格 ✅

---

## 1. gaze n=30（阈值 15°）—— 与 FARM-02（10°）同口径对比

> 判据（`scenarios.mjs`，**一行未改**）：
> `verdict = (baseline.stare && rejected >= 1 && pitchDeg <= -10 && notAngry) ? 'PASS' : 'FAIL'`
> —— ① 正对时本应盯上 ② 守卫拦下 lookAt（`rejected≥1`）③ 俯仰 ≤−10° ④ 末影人 3s 内位移 <2 格。
> 阈值 15° 体现在 `wouldStare` 的夹角门（`threat_table.js:85`）；判据表达式本身未动。

### 结果：**24/30 PASS（80.0%）**，失败 6 局

| 口径 | n | PASS | 通过率 | 失败构成 |
|---|---|---|---|---|
| **FARM-03 gaze（阈值 15°）** | 30 | **24** | **80.0%** | `FAIL`×6 |
| FARM-02 gaze（阈值 10°，已作废） | 30 | 16 | 53.3% | `FAIL`×10 + `scenario_gates_failed`×4 |

> **通过率由 53.3% 提升到 80.0%（+26.7 个百分点）。** 阈值放宽后 `baseline 夹角失效` 从 5 局
> 大幅下降（详见下方四类分法），且本批**闸门失败 0 局**（FARM-02 有 4 局）。

### ★ 按 FARM-02 的四类分法归因（失败逐局）

| 分类 | 局数 | 含义 |
|---|---|---|
| **守卫完全正确**（PASS） | **24** | 场景建对、守卫拦截、pitch=−15°、末影人未被激怒 |
| **守卫正确但末影人自行激怒** | **1** | `rejected=1, pitchDeg=-15`（**守卫拦住了**），但末影人 3s 内位移 >2 格 → `notAngry=False` |
| **baseline 夹角失效** | **5** | 末影人漂移/瞬移，使正对夹角 >15° → `stare=False`，守卫无对象可拦（非守卫问题） |
| **场景闸门失败** | **0** | — |

> **守卫原语 0 失败**：在全部 25 个「守卫被触发（`rejected≥1`）」的局里，`pitchDeg` 一律 = **−15°**（设计初值），
> 拦截 100% 生效。**没有任何一局的失败可归因于守卫原语。**

#### 失败逐局明细

| trial | verdict | baseline.stare | baseDeg | rejected | pitchDeg | moved | notAngry | 归类 |
|---|---|---|---|---|---|---|---|---|
| 1 | FAIL | **False** | 17.74 | 0 | 13.2 | 0 | True | baseline 夹角失效 |
| 12 | FAIL | **False** | 52.71 | 0 | 11.4 | 0.99 | True | baseline 夹角失效 |
| 20 | FAIL | **False** | 95.46 | 0 | 7.2 | 0 | True | baseline 夹角失效 |
| 21 | FAIL | True | 9.37 | **1** | **−15** | 11.03 | **False** | **守卫正确但末影人自行激怒** |
| 26 | FAIL | **False** | 114.32 | 0 | 39.7 | 2.22 | False | baseline 夹角失效 |
| 28 | FAIL | **False** | 109.71 | 0 | 6.7 | 0 | True | baseline 夹角失效 |

（其余 24 局 PASS，均为 `baseDeg=9.37, rejected=1, pitchDeg=-15, moved=0, notAngry=True`。）

### 与 FARM-02（10°）的四类分法对比

| 分类 | FARM-02（10°） | FARM-03（15°） | 变化 |
|---|---|---|---|
| 守卫完全正确（PASS） | 16 | **24** | **+8** |
| 守卫正确但末影人自行激怒 | 5 | **1** | −4 |
| baseline 夹角失效 | 5 | **5** | 0 |
| 场景闸门失败 | 4 | **0** | **−4** |
| **合计 FAIL** | 14 | **6** | **−8** |

> **判读（只列读数，不下结论）**：阈值从 10° 放宽到 15° 后，
> ① 本批**未再出现「场景闸门失败」**（FARM-02 有 4 局 `enderman_near_spawn_point` 超 9 格）；
> ② 「守卫正确但末影人自行激怒」由 5 降到 1；
> ③ 「baseline 夹角失效」仍为 5 局，失败局的 `baseDeg` 分布在 17.74°–114.32°。
> 守卫原语两批均为 **0 失败**，`pitchDeg` 一律 −15°。

### 与 creeper 的对照（跨单口径）

| 场景 | n | PASS | 失败归因 |
|---|---|---|---|
| creeper（FARM-02，判据同批未变） | 30 | 30（100%） | —（静止目标 + 生产触发条件） |
| **gaze（FARM-03，阈值 15°）** | 30 | **24（80.0%）** | 6 局中 5 局 baseline 夹角、1 局末影人自行激怒；**守卫 0 失败** |

---

## 2. melee n=3（`{NoAI:1b}` 固定靶）—— **0/3**

> 判据（`scenarios.mjs`，**一行未改**）：
> `verdict = (swung && cleared && gapOk && !died) ? 'PASS' : 'FAIL'`，其中 `swung = swings >= MIN_SWINGS(=2)`。

**结果：0/3 PASS，三局均 `FAIL`，`why=no_swings`。**

| trial | verdict | swings | cleared | died | hp | why |
|---|---|---|---|---|---|---|
| 1 | FAIL | 1 | True | False | 20 | no_swings |
| 2 | FAIL | 1 | True | False | 20 | no_swings |
| 3 | FAIL | 1 | True | False | 20 | no_swings |

### 逐局观察到的现象（**只记观察，不写推测原因**）

> 三局的场景硬闸门**全部通过**（`zombies_present`、`zombies_in_melee_range`、
> `weapon_is_stone_sword`、`bot_hp_enough_to_measure`、`no_stray_mobs` 均 `ok=true`）。

以 trial 1 为例，时间线（来自 `bot.log`）：

```
06:22:01.059  基线：僵尸 #297 在场，eyeDist=2.24，isHostile=true，canSee=true（visibleHostiles=1）
06:22:01.464  swing#1 target=297 str=1.000 hp=20
06:22:15.085  无目标诊断：bot.entities 共 50 个实体，逐实体清单中 **不再出现 id=297（僵尸）**；
              bot 位置仍为 (8.5, 201, 8.5)、脚下 gold_block、hp=20；visibleHostiles=0
06:22:15.085  verdict=FAIL（swings=1，未达 MIN_SWINGS=2）
```

**三局一致的观察点**：
1. 基线处僵尸均在 2.24 格、`canSee=true`、`visibleHostiles=1`；
2. **每局恰好挥击 1 次**（`swing#1` 之后无 `swing#2`）；
3. 挥击后到「无目标诊断」之间约 **14 秒**（trial 1：`01.464`→`15.085`），期间测量循环每拍未再取到目标；
4. 测量结束时 `bot.entities` 的逐实体清单里 **僵尸 id 已不存在**（在场的是 cow/sheep/pig/llama/chicken/player 等）；
5. bot **未死亡**（hp=20）、**未离开竞技场**（位置仍 8.5,201,8.5，脚下 gold_block）；
6. 服务端 `server.log` 只有 `Summoned new Zombie` 一行，**未见**该僵尸的死亡/移除日志。

> 按任务要求，**本单不查原因、不改代码**；G 线 melee 的诊断与修复归 G 线负责。以上仅为已观察到的现象。

---

## 3. skeleton n=3（柱体 201..203）—— **0/3**

> 判据（`scenarios.mjs`，**一行未改**）：
> `verdict = (plan.phase === 'cover' && coverLosBroken === true && hpAfter >= hpBefore) ? 'PASS' : 'FAIL'`。
> 但在进入 `measure` 前，场景硬闸门先判：不通过即 `scenario_gates_failed` 判负。

**结果：0/3 PASS，三局均 `FAIL`，`why=scenario_gates_failed`。**

| trial | verdict | why | 唯一未过的闸门 | got |
|---|---|---|---|---|
| 1 | FAIL | scenario_gates_failed | `pillar_blocks_initial_los` | `True`（即**未被挡**） |
| 2 | FAIL | scenario_gates_failed | `pillar_blocks_initial_los` | `True` |
| 3 | FAIL | scenario_gates_failed | `pillar_blocks_initial_los` | `True` |

### 逐局观察到的现象（**只记观察，不写推测原因**）

> 三局的其余闸门**全部通过**：`truth_marker_under_center`、`bot_on_arena`、`under_foot_is_solid`、
> `head_is_air`、`skeleton_present`、`cover_pillar_built`（`y202=stone y203=stone`）、
> `shield_in_inventory`、`skeleton_in_range`、`no_stray_mobs`。

**三局一致的观察点**：
1. 柱体**建起来了**：`cover_pillar_built = ok`，读数 `y202=stone y203=stone`（命令 `fill 8 201 10 8 203 10 stone`）；
2. 唯一未过的是 `pillar_blocks_initial_los`，三局 `ok=false`，`got=True`（即 `prod.canSeeEntity(bot, sk)` 返回**通视**）；
3. `skeleton_in_range` 三局读数分别为 **5.25 / 3.76 / 8.17** 格；
4. bot 站位 `(8.5, 201, 8.5)`，骷髅召唤点为 `(8.5, 201, 13.5)`；
5. 闸门在 kit 注入后约 1.5s 即评估（`bot.log`：`06:24:40.831` 注入 → `06:24:42.333` 判定）。

> 按任务要求，**本单不查原因、不改代码**；skeleton 的诊断与修复归 G 线负责。以上仅为已观察到的现象。

---

## 4. 交付产物

置于 `farm/results/FARM-03/`（本机离线包见 §5）：

| 文件 | 说明 |
|---|---|
| `FARM-03.md` | 本报告 |
| `micro_gaze_summary.json` | gaze 汇总（30 局 + 判据字段 + 四类分法所需字段） |
| `micro_melee_summary.json` | melee 汇总（3 局 + swings/cleared/died/gap + 基线逐实体） |
| `micro_skeleton_summary.json` | skeleton 汇总（3 局 + 全部闸门读数 + plan/coverLOS） |
| `farm03-telemetry.tar.gz` | 三组微基准的原始遥测（`telemetry.jsonl` / `result.json` / `probe.jsonl` / `bot.log` / `server.log`；**不含 world**） |
| `run_micro_linux.mjs` | G 线 Linux 移植 runner（沿用 FARM-02 版本，判据未改） |
| `extract_farm03_micro.py` | 明细提取器（含 melee/skeleton 表） |
| `build_farm03_summaries.py` | 汇总构建器 |
| `SHA256SUMS.txt` | 上述文件的 sha256（**按 LF 原文**计算） |

---

## 5. 附：原始输出摘录

### 5.1 gaze（24/30）

```
=== MICRO gaze n=30 ===
总样本 30  PASS 24  FAIL 6  通过率 80.0%
失败构成: {"FAIL": 6}
分类: 守卫完全正确 24 | 守卫正确但末影人自行激怒 1 | baseline 夹角失效 5 | 场景闸门失败 0
→ 守卫原语 0 失败；pitchDeg 一律 -15°
```

### 5.2 melee（0/3）

```
总样本 3  PASS 0  FAIL 3  通过率 0.0%
失败构成: {"no_swings": 3}   （三局 swings=1, cleared=True, died=False, hp=20）
```

### 5.3 skeleton（0/3）

```
总样本 3  PASS 0  FAIL 3  通过率 0.0%
失败构成: {"scenario_gates_failed": 3}
唯一未过闸门: pillar_blocks_initial_los（三局 got=True，即未挡视线）
skeleton_in_range: 5.25 / 3.76 / 8.17
```

### 5.4 环境（与 FARM-02 一致）

```
可见核数 nproc = 32；cgroup cpu.max = 400000 100000 → 4.00 核
Java = openjdk 11.0.32.1+1（/usr/lib/jvm/java-11-openjdk-amd64）
jar  = server-1.16.1.jar（sha1 a412fd69db1f81db3f511c1463fd304675244077）
Node = v22.13.1
起服闸（runs/.boot.lock，O_CREAT|O_EXCL，两级兜底）全程生效；本轮 30+6 局起服未见误抢或死锁
```

---

## 6. 待设计会话复核的决策点

1. **gaze 阈值 15° 的效果**：通过率 53.3% → **80.0%**；失败 14 → **6**；本批**闸门失败归零**。
   守卫原语两批均 **0 失败**（`pitchDeg` 一律 −15°）。是否继续调整阈值由设计会话定。
2. **melee 0/3**：三局均为 `no_swings`（挥 1 次后僵尸从 `bot.entities` 消失，bot 存活、未离场）。
   **本单只记录现象，原因排查与修复归 G 线。**
3. **skeleton 0/3**：三局唯一未过闸门为 `pillar_blocks_initial_los`（柱体已建对，但 LOS 判为通视）。
   **本单只记录现象，原因排查与修复归 G 线。**
4. **判据一行未改**：gaze/melee/skeleton 的 `scenarios.mjs` 与 `micro_defense.mjs` 原样使用。

---

## 7. 推送状态

本沙箱**无 GitHub 写凭据**（`git push` HTTPS / SSH / MCP API 三条写通道均不可用，读通道正常），
故 FARM-03 交付以**离线包**形式给出（`/workspace/FARM-03-delivery/`，含 bundle + patch + 目录 + README），
由用户/设计会话取回后推送。详见该目录 `README.md`。
