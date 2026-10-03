# FARM-01 报告｜测试农场（泳道 Y）搭建 + 并行一致性验收

> 执行机：大云端容器（Ubuntu 24.04.3 LTS，无 GPU）。复核：本地设计会话。
> 代码来源：`bundles/MANIFEST.json` → `code-20261002-1610.tar.gz`（sha256 校验通过）。
> 本报告覆盖 P0（农场搭建 + 并行一致性验收）。

---

## 0. 环境（务必先读）

| 项 | 值 |
|---|---|
| **可见 CPU 核数** | **32**（`nproc` = 32；`cpuset.cpus.effective` = `0-31`） |
| **cgroup CPU 配额** | **4 核** ← **关键** |
| `cpu.max` 原文 | `/sys/fs/cgroup/cpu.max` = **`400000 100000`**（quota=400000µs / period=100000µs → **4.00 核**） |
| **CPU 型号** | **AMD EPYC 9K65 192-Core Processor**（`/proc/cpuinfo`；任务单写的 "Xeon 6981E 能效核" 与实际不符，不影响结论） |
| cgroup 历史限流 | `nr_throttled=15567` / `throttled_usec=21023294461`（≈ **5.84 小时**累计被限流） |
| 内存 | 123 GiB（`free -g`：total 123 / available 96） |
| 盘 | overlay，256 GB，`df -T` 用量 1%；**跨会话持久**（已验证，见 §2） |
| OS | Ubuntu 24.04.3 LTS |
| Node | v22.13.1 |
| Java | `openjdk version "11.0.32.1"` / build `11.0.32.1+1-post-1ubuntu1-24.04-Ubuntu`（**apt 系统包** `openjdk-11-jdk-headless`，经授权使用；与 CLOUD-01 的 Microsoft Build 11.0.32.1+1 同基线） |
| 服务端 jar | `server-1.16.1.jar`，**37968964** 字节，sha1 **a412fd69db1f81db3f511c1463fd304675244077**（与任务要求逐字节一致） |

> ⚠️ **必须用 cgroup 口径理解本机算力。** `nproc=32` 是假象（cpuset 可见 32 核），
> 实际配额 **4 核**。实测 busy-loop：4 线程=389%、8 线程=392%、32 线程=398% —— 无论开多少
> 线程都被钉在 **~400%**。这意味着：
> 1. 所有"按 32 核估算"的并发预期都是错的，实际得多用 **8 倍余量**；
> 2. `vmstat` 的 us/sy/id 是全机 32 核视角，被稀释 8 倍，**不能直接解读**（必须用 cgroup 的 `cpu.stat`）。

**npm 依赖（腾讯镜像 `https://mirrors.tencent.com/npm/`，版本锁定）**

| 包 | 锁版本 |
|---|---|
| mineflayer | 4.38.0 |
| minecraft-protocol | 1.68.0 |
| minecraft-data | 3.114.0 |
| prismarine-item | 1.18.0 |
| prismarine-chunk | 1.41.0 |
| mineflayer-pathfinder | 2.4.5 |
| mineflayer-tool | **1.2.0**（补装：`exec_bot.mjs:91` 需要 `mineflayer-tool.plugin`） |
| protodef | 1.19.0 |
| vec3 | 0.1.10 |
| prismarine-registry | 1.12.0 |

模块解析：`exec_bot.mjs` 用 `createRequire(<WS>/mindcraft/main.js)`，故在 `<WS>` 下建 `node_modules` 软链指向 `deps/node_modules`。

## 1. 起服闸（永久生效，设计会话 10-02 夜裁决 §2）

**约束：同一时刻全机最多 1 个 Minecraft 服在生成世界。**

- 实现落点：`run_lane.mjs` 的 `bootServer()` 内置**跨进程文件锁**（`runs/.boot.lock`，`O_CREAT|O_EXCL` 原子建锁）。拿到锁才 spawn java，`server.log` 出现 `Done (` 即释放。
- 为何不放在 `run_farm.mjs`：每条泳道跑多局，泳道 i 的第 2 局会与泳道 i+1 的第 1 局撞上，父进程管不到这个层级。
- **锁接管的两级兜底**（设计会话 10-02 夜复核 §1）：
  1. 优先判**持锁进程是否还活着**（`kill(pid,0)`，`EPERM` 视为存活）—— 能区分「起服慢」与「进程已死」，
     死锁几乎立刻可接管，**不会误抢慢起服**；
  2. 进程仍存活时，才用 mtime 兜底，且阈值 = **`boot-timeout + 30s`（默认 330s）**，
     由 `Math.max(BOOT_TIMEOUT_S*1000 + 30000, 环境变量)` 计算。
     **旧版硬编码 120s 是 bug**：300s 的慢起服会在 120s 被别的泳道当成陈旧锁抢走（已修，见自测）。
- 自测：`bench/cloud/boot_lock_selftest.mjs`（6 项全通过，含"130s 慢起服旧版误抢 / 新版不抢"回归用例）。
- **起服时间照记、不计成绩**；**不改 `server.properties`**（**不许关看门狗**）。

## 2. 磁盘持久性：**持久**（已验证）

`.persist_test` 于 16:32:27 写入，**跨过一次沙箱休眠/恢复周期**后文件仍在、mtime 未变；同期解压的代码包、`bench/`、`deps/`、`mindcraft/` 全部保留 → overlay 盘在会话之间持久。仍按任务单要求提供 `bench/cloud/farm_setup.sh`（幂等，`bash -n` 通过）。

## 3. 环境证伪实验（a–c，原始输出见 §9）

### 3a 核数/配额/内存/盘
见 §0。**`cpu.max = 400000 100000`（4 核）是本轮最重要的发现。**

### 3b 单服 vs 5 服同时起服（cgroup 精确测量）

| 场景 | 墙钟 | Δusage | **实际核数** | Δthrottled |
|---|---|---|---|---|
| 单服 | 90s | 120.34 CPU·s | **1.34** | 0 |
| 5 服同时 | 150s | 598.64 CPU·s | **3.99** | 0 |

**解读（设计会话裁决 §3b）**：5 服把 4 核配额**吃满**（3.99/4.00）。单服起服 120 CPU·s、5 服 600 CPU·s，
4 核最快需 150s，**实测正好 150s** —— 这就是 CPU 不够。
`Δthrottled=0` **不能**用来反驳：配额可能在上层 cgroup 执行，计数不一定落在本层；
历史 `nr_throttled` 累计 5.84h 恰好对应 FARM20 那几轮。

> **FARM5 的 "A single server tick took 77.49 seconds" 是服务端看门狗（单 tick >60s 判死）；
> 崩溃栈停在 `RandomAccessFile.readBytes` 只说明死的时候正在读区域文件，根因是 CPU 不够。**

### 3c 5 服错峰 30s 起服
`5/5 SUCCESS | 0 LAGGED（修正后）| 内存峰值 1677.1MB`。见 §5 与 §9。

## 4. 并发曲线（3 / 4 / 5 / 6 四档，每档 2 轮）

> 口径：每档 ≥2×N 局；种子取一致性 20 颗的前缀；起服闸生效（同一时刻 1 个世界生成）；
> 起服时间照记不计成绩。**LAGGED 局照样计成绩**（手册 §4.7）。**NO_PROGRESS_ABORT 按失败计。**

<!--CURVE_TABLE-->
| 档位 | 局数 | 成功 | LAGGED | TPS 中位 | TPS 最低 | 起服中位 | 内存峰值 | cgroup 用量 |
|---|---|---|---|---|---|---|---|---|
| **N=3** | 6（2×3） | **6/6** | **0** | 19.98 | 19.98 | 29.3s | 1678 MB | 1.81 核（Δ249.1 CPU·s / 137s） |
| **N=4** | 8（2×4） | **8/8** | **0** | 19.98 | 19.97 | 30.2s | 1611 MB | 1.74 核（Δ373.6 CPU·s / 214s） |
| **N=5** | 10（2×5） | **10/10** | **0** | 19.99 | 19.81 | 31.3s | 1695 MB | 2.35 核（Δ497.7 CPU·s / 211s） |
| **N=6** | 12（2×6） | **12/12** | **0** | 19.98 | 19.78 | 32.3s | 1715 MB | 2.05 核（Δ617.6 CPU·s / 300s） |

**逐轮结果**

| 轮次 | 结果 | 内存峰值 |
|---|---|---|
| N=3 R1 | 3/3 SUCCESS, 0 LAGGED | 1544.3 MB |
| N=3 R2 | 3/3 SUCCESS, 0 LAGGED | 1678.0 MB |
| N=4 R1 | 4/4 SUCCESS, 0 LAGGED | 1610.9 MB |
| N=4 R2 | 4/4 SUCCESS, 0 LAGGED | 1531.7 MB |
| N=5 R1 | 5/5 SUCCESS, 0 LAGGED | 1695.4 MB |
| N=5 R2 | 5/5 SUCCESS, 0 LAGGED | 1633.4 MB |
| N=6 R1 | 6/6 SUCCESS, 0 LAGGED | 1630.6 MB |
| N=6 R2 | 6/6 SUCCESS, 0 LAGGED | 1715.0 MB |

**观察**：
- **起服闸生效后，3/4/5/6 四档全部零 LAGGED、零失败**（合计 36 局，见 §5 一致性另计）。
- TPS 中位稳定在 **19.98–19.99**，最低 19.78（N=6），离 LAGGED 线（<18）有充足余量。
- **未观测到拐点**：4 核配额下 6 并发仍稳定。这与"CPU 吃满"的 3b 结论并不矛盾 —— 3b 是
  **同秒抢世界生成**（CPU 峰值叠加，150s 顶到 4.00 核），而起服闸把世界生成串行化后，
  峰值被摊平，稳态只剩"跑 bot + 维持 tick"，负载远低于 4 核。
- 代价是**吞吐**：起服中位 29–32s（排队 + 世界生成），每档总时长随 N 线性增长。

## 5. 20 种子一致性（@ 推荐并发 N=6，起服闸生效）

**结果：19/20 SUCCESS，2 局 LAGGED，内存峰值 1713.5 MB** —— **达到验收线（≥19/20）**。

| 泳道 | 种子 | 结果 | TPS | 起服s | 墙钟s | LAGGED |
|---|---|---|---|---|---|---|
| Y0 | P2C_M4B4-01 | SUCCESS | 20.02 | 24.2 | 139.9 | |
| Y0 | P2C_M4B4-02 | SUCCESS | **17.89** | 36.5 | 180.6 | **是** |
| Y0 | P2C_M4B4-03 | SUCCESS | 19.87 | 36.4 | 174.1 | |
| Y0 | P2C_M4B4-04 | SUCCESS | 19.97 | 34.4 | 130.7 | |
| Y1 | P2C_M4B4-05 | SUCCESS | 20.09 | 28.2 | 104.3 | |
| Y1 | P2C_M4B4-06 | **FAIL(TOOL_MISSING)** | 18.19 | 36.4 | 135.5 | |
| Y1 | P2C_M4B4-08 | SUCCESS | 20.06 | 34.3 | 130.5 | |
| Y1 | P2C_M4B4-09 | SUCCESS | 20.10 | 36.4 | 145.0 | |
| Y2 | P2C_M4B4-10 | SUCCESS | 18.30 | 32.3 | 216.6 | |
| Y2 | P2C_M4B4-07 | SUCCESS | 20.03 | 30.3 | 375.0 | |
| Y2 | P2C_M4B4-11 | SUCCESS | 19.98 | 30.2 | 112.0 | |
| Y2 | P2C_M4B4-12 | SUCCESS | 19.98 | 26.2 | 100.5 | |
| Y3 | P2C_M4B4-13 | SUCCESS | 20.05 | 34.3 | 120.1 | |
| Y3 | P2C_M4B4-14 | SUCCESS | 20.09 | 54.1 | 157.7 | |
| Y3 | P2C_M4B4-15 | SUCCESS | 19.96 | 32.2 | 280.8 | |
| Y3 | P2C_M4B4-16 | SUCCESS | 19.98 | 32.4 | 148.7 | |
| Y4 | P2C_M4B4-17 | SUCCESS | **17.80** | 34.5 | 184.9 | **是** |
| Y4 | P2C_M4B4-18 | SUCCESS | 20.03 | 30.4 | 152.3 | |
| Y4 | P2C_M4B4-20 | SUCCESS | 20.15 | 36.3 | 147.0 | |
| Y4 | P2C_M4B4-19 | SUCCESS | 20.08 | 30.2 | 107.8 | |

**说明**：
- 起服时间 24.2–54.1s（起服闸排队 + 世界生成；已在闸门语义下正常），**照记、不计成绩**。
- 2 局 LAGGED（17.89 / 17.80）**已验证无采样断档，是真实的轻度滞后**（紧贴 18 线，非塌陷）。
- 唯一失败 `P2C_M4B4-06` = `FAIL(TOOL_MISSING)`，**bot 侧问题**（该局 TPS 18.19，服务器无滞后）。
  该种子在单跑复现实验（§3c 相关对照）中亦曾出现，属已知 flaky 观察项。
- 零 OOM、零端口冲突、零残留进程。

## 6. 推荐默认并发数

# **推荐并发数 = 6**

> **口径限定（设计会话 10-02 夜复核）**：此值适用于 **BASIC-bootstrap 类负载**。
> N=6 时 cgroup 实测仅用约 **2.05/4 核**，**不是本机天花板**；换更重的 stage 需重测。

依据（"零 LAGGED 的最大一档"，裁决 §3）：3/4/5/6 四档 ×2 轮共 36 局，**全部 SUCCESS、零 LAGGED**，
其中 **N=6 是本次测试的最大档位**，因此按定义推荐 **6**。

- N=6：TPS 中位 **19.98**、最低 **19.78**（离 LAGGED 线 <18 余量充足）；cgroup 平均仅 **2.05 核**（配额 4 核）。
- **但未观测到拐点**：N=6 仍远未触及 4 核上限，所以 6 **不是**"能跑多高"的天花板，只是"本次测过的最大档"。
  按裁决 §3 曲线只测到 6 档，故上界未知；若后续要探顶，建议以 8/10 为一档继续（**需另行授权**）。
- 注意：**推荐值的成立前提是"起服闸生效"**。一旦放宽闸门（允许并发世界生成），
  实测会立刻退化（见 §3b：5 服同秒起服即吃满 4 核 / FARM5 的看门狗击杀）。
- **吞吐权衡**：起服闸把世界生成串行化，起服中位 29–32s，20 局 @N=6 的总时长约 15 分钟量级。

## 7. 提效条目（3 条）

1. **起服闸必须常开，且不要在它之上再加固定 sleep**：本轮实测证明，只要"同一时刻 1 个世界生成"，
   3–6 并发全部零 LAGGED；一旦并发世界生成（FARM5 / 3b 的 5 服同秒）就顶满 4 核并触发看门狗。
   已在 `run_farm.mjs` 里把 `BOOT_STAGGER_MS` 默认改为 0、`STAGGER_WAIT_MS` 默认 `Infinity`。
2. **用 cgroup 口径做资源闸门，别用 `nproc`**：本机 `nproc=32` 但配额 4 核。现有闸门用
   `load1 < nproc × LOAD_FACTOR`（默认 32），**实际上形同虚设**。建议改为读 `/sys/fs/cgroup/cpu.max`
   与 `cpu.stat`，按**真实配额**判断（例如 `usage 增速 / 配额` 超过阈值就排队）。
3. **TPS 断档防护已固化**：`tpsFromWorldAge` 取"最长连续采样段" + 每局清空遥测文件，
   消除了跨轮残留导致的假 LAGGED。建议所有消费 `world_age.jsonl` 的下游都走这个函数，不要自己取首尾两点。

## 8. 待本地复核的决策点

1. **并发上界未知**：N=6 全绿且 cgroup 仅用 2.05/4 核，拐点未触及。若"推荐并发数"要用于压满吞吐，
   建议追加 8/10 档测试（每档 2 轮）后再定；否则 6 是"已验证安全"的值，不是"最优"值。
2. **起服闸 vs 吞吐**：当前每档总时长随 N 线性增长（起服串行）。若要提速，可考虑
   "世界生成串行、跑步阶段全并发"的流水线（本质上就是当前形态），或预生成 world 模板复用。
   后者会改变测试语义（种子化世界生成被绕过），**需你确认是否可接受**。
3. **FARM5/2b 的看门狗击杀**已按裁决解释为 CPU 不够（非 I/O）：栈停在 `readBytes` 只是巧合，
   根因是 4 核被并发世界生成吃满 → 单 tick 77.49s。请在复核时确认该归因。

## 9. 附：原始输出与遥测

### 9.1 环境证伪原始输出（2a）
```
nproc = 32
/sys/fs/cgroup/cpu.max = 400000 100000          → 4.00 核
cpuset.cpus.effective = 0-31
cpu model = AMD EPYC 9K65 192-Core
cpu.stat: nr_throttled=15567  throttled_usec=21023294461 (5.84h)
free -g: total 123, available 96
df -T /workspace/farm/servers/: overlay, 1% used
busy-loop: 4线程=389%  8线程=392%  32线程=398%   → 上限 ~400%
```

### 9.2 2b 对照原始输出
```
单服: Δusage=120.34s / wall=90s  → 1.34 核   Δthrottled=0
5服:  Δusage=598.64s / wall=150s → 3.99 核   Δthrottled=0
vmstat(单服,去首行): us=12-15 sy=15 id=62-72 wa=3-9
vmstat(5服, 去首行): us=11-15 sy=15-16 id=62-69 wa=3-13, b 最高 18
```

### 9.3 2c 错峰 30s（修正 TPS 污染 bug 后）
```
Y0 seed01 SUCCESS wall=117.5  tps=20.22(修正前误算3.01)
Y1 seed02 SUCCESS wall=113.8  tps=19.98
Y2 seed03 SUCCESS wall=116.7  tps=20.07
Y3 seed04 SUCCESS wall=104.0  tps=19.98
Y4 seed05 SUCCESS wall=104.9  tps=19.98
→ 5/5 SUCCESS, 0 LAGGED
```

### 9.4 runner 修复清单（本轮）
1. `run_lane.mjs`：起服超时改参数 `--boot-timeout-s`（默认 300）；超时分支 `killOwn` 自己 spawn 的 java。
2. `run_lane.mjs`：**TPS 断档 bug** —— `world_age.jsonl` 追加写 + runDir 跨轮复用未清空 → 残留样本混入，
   把空闲时间算进分母（实测 STAGGER30/lane0 曾算出 3.01）。两处修复：每局清空 8 个遥测文件 +
   `tpsFromWorldAge` 改取「最长连续采样段」（相邻间隔 ≤3s）。验证：3.01→20.22，正常局 19.98 不变。
3. `run_lane.mjs`：新增**全局起服锁**（见 §1）；锁接管两级兜底（pid 存活判定 + `boot-timeout+30s` 阈值），
   修复旧版 120s 硬编码导致慢起服被误抢的 bug。自测：`boot_lock_selftest.mjs` 6/6 通过。
4. `run_farm.mjs`：起服闸透传 `--boot-timeout-s`；`STAGGER_WAIT_MS` 默认 `Infinity`（硬约束）；`BOOT_STAGGER_MS` 默认 0。
5. `SERVER_FAIL` 核查：**代码完整、未丢**（`run_lane.mjs:442/445` 写 outcome+error 并 append；`run_farm.mjs` 从不生成 row）。

### 9.5 原始遥测位置
`bench/cloud/runs/CURVE_N{3,4,5,6}R{1,2}/`、`runs/GATE_SMOKE/`、`runs/FARM20/` 等；
打包：`farm-telemetry.tar.gz`。
