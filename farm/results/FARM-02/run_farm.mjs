#!/usr/bin/env node
// run_farm.mjs — MC-FARM-01 测试农场（泳道 Y）多泳道并行 runner
//
// 定位：本机（Ubuntu 24.04 / 32 核 / 123GB）是「测试农场」，要同时跑十几条无画面的
//   测试泳道。本文件是 run_lane.mjs（CLOUD-01 的单泳道 Linux runner）之上的**调度层**。
//
// 为什么是「调度器 fork 子进程」而不是改 run_lane.mjs：
//   手册 §9「bench 脚本：各开发线在自己的 stage 下工作；_lib/ 只能新增文件，改已有文件要
//   先报告」。run_lane.mjs 是 CLOUD-01 在 cloud/lane-x 分支上的交付物，本单（FARM-01）
//   的任务是**扩展**成多泳道（任务单 §2），不是改它。所以：
//   - run_lane.mjs 一行不改，它继续是「单泳道、一条线独占」的实现；
//   - run_farm.mjs 为每条泳道 i fork 一个 run_lane.mjs 子进程，用环境变量
//     （MC_LANE_PORT / MC_LANE_NAME / MC_BENCH_SERVER / MC_MINDCRAFT_ROOT）把它参数化——
//     这些变量 run_lane.mjs 本来就支持（见其文件头 §环境变量）。
//   这样单泳道行为与 CLOUD-01 完全一致（同一份代码），并行只是多开几个进程。
//
// 泳道规划（任务单 §2）：
//   泳道 i（0-based）→ 端口 25600+i，RCON 25700+i，服务器目录 <WS>/servers/laneY<i>，
//   bot 名 LaneBotY<i>，各自独立的 world。端口/RUNS 目录/世界互不重叠。
//
// 资源闸门（任务单 §2「每局开服前查一次空闲内存和平均负载，资源不够就排队」）：
//   每条泳道在开自己的局之前，先通过 waitForResources() 检查：
//     - 系统可用内存 ≥ MIN_FREE_MB（默认按每泳道 2.5GB × 并发数估算，手册 §9 内存口径）
//     - 1 分钟平均负载 < nproc × LOAD_FACTOR（默认 1.0）
//   不够就轮询等待（排队），不抢别人的资源、不 kill 别人。
//
// 进程纪律（任务单 §2、手册 §9.2）：
//   **只结束自己 spawn 出来的子进程**。本文件只 track 自己 fork 的 run_lane.mjs 子进程，
//   收工时只 process.kill 这些 pid；绝不按命令行模式/端口做全局扫描。
//
// 环境变量（与 run_lane.mjs 对齐，另加农场专属）：
//   MC_BENCH_JAVA        JDK 11 java 可执行（必填，透传给每条泳道）
//   MC_BENCH_JAR         vanilla 1.16.1 server jar 绝对路径（必填）
//   MC_MINDCRAFT_ROOT    任务层代码根（默认 <WS>/mindcraft）
//   MC_FARM_BASE_PORT    泳道起始端口（默认 25600）
//   MC_FARM_BASE_RCON    泳道起始 RCON 端口（默认 25700）
//   MC_FARM_SERVER_ROOT  各泳道服务器目录的父目录（默认 <WS>/servers）
//   MC_FARM_MIN_FREE_MB  开新局前要求的最小空闲内存（默认 5120 = 2 泳道余量）
//
// 用法：
//   node run_farm.mjs --stage basic-bootstrap --lanes 5 \
//        --seeds P2C_M4B4-01,...,P2C_M4B4-05 --target 16 --mc-version 1.16.1
//   node run_farm.mjs --stage basic-bootstrap --lanes 20 --seeds <20 个> --stamp FARM20
//
// 输出：<cloud>/runs/<stamp>/farm_summary.json（汇总）+ 各泳道 lane<i>/ 下的 run_lane 原始产物。

import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import os from 'os';
import fs from 'fs';
import path from 'path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BENCH = path.resolve(HERE, '..');
const WORKSPACE = path.resolve(BENCH, '..');

const log = (m) => console.log(`[farm ${new Date().toISOString().slice(11, 19)}] ${m}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function argOf(argv, name, dflt) {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : dflt;
}

// ---- CLI ----
const LANES = parseInt(argOf(process.argv, 'lanes', '1'), 10);
const STAGE = argOf(process.argv, 'stage', 'basic-bootstrap');
const SEEDS_RAW = argOf(process.argv, 'seeds', '');
const TARGET = argOf(process.argv, 'target', '16');
const MC_VERSION = argOf(process.argv, 'mc-version', '1.16.1');
const TIMEOUT_MS = argOf(process.argv, 'timeout-ms', '420000');
const NO_PROGRESS_S = argOf(process.argv, 'no-progress-s', '120');
const PROBE_MS = argOf(process.argv, 'probe-ms', '10000');
const XMX = argOf(process.argv, 'xmx', '1G');
const BOOT_TRIES = argOf(process.argv, 'boot-tries', '3');
// 起服超时（秒），透传给每个泳道的 run_lane.mjs（设计会话 10-02 夜复核 §1）。
const BOOT_TIMEOUT_S = argOf(process.argv, 'boot-timeout-s', '300');
const MODE = argOf(process.argv, 'mode', 'detect');         // end-probe 用
const KIT = argOf(process.argv, 'kit', 'red_bed:12,cobblestone:48,cooked_beef:16,stone_sword:1');
const GOD_MODE = process.argv.includes('--god-mode');
const KEEP_WORLD = process.argv.includes('--keep-world');

const BASE_PORT = parseInt(process.env.MC_FARM_BASE_PORT || '25600', 10);
const BASE_RCON = parseInt(process.env.MC_FARM_BASE_RCON || '25700', 10);
const SERVER_ROOT = process.env.MC_FARM_SERVER_ROOT || path.join(WORKSPACE, 'servers');
const MIN_FREE_MB = parseInt(process.env.MC_FARM_MIN_FREE_MB || '5120', 10);
// 负载闸门：1 分钟平均负载 < nproc × LOAD_FACTOR。Minecraft 服务端主循环是单线程，
// 但世界生成/GC/chunk 序列化会用多核；1.0 倍核数是「每核一个可运行任务」的经验上限。
const LOAD_FACTOR = parseFloat(process.env.MC_FARM_LOAD_FACTOR || '1.0');
// 起服闸额外间隔（默认 0）：闸门本身已保证「同一时刻只有 1 个服在生成世界」，
//   不再需要额外 sleep。保留参数仅供压测对照（设为 >0 会在闸门之上再插一段间隔）。
const BOOT_STAGGER_MS = parseInt(process.env.MC_FARM_BOOT_STAGGER_MS || '0', 10);
// 起服闸的等待上限。默认 Infinity = 硬约束：不因前一条起服慢而提前放行
//   （放宽会让两个服同时生成世界，正是 FARM5 崩溃的成因）。
//   仅当显式设成数字时才可能超时放行（对照实验用）。
const _sw = process.env.MC_FARM_STAGGER_WAIT_MS;
const STAGGER_WAIT_MS = (_sw === undefined || _sw === '' || _sw === 'Infinity')
    ? Number.POSITIVE_INFINITY : parseInt(_sw, 10);

const JAVA = process.env.MC_BENCH_JAVA;
const JAR = process.env.MC_BENCH_JAR;
const MINDCRAFT = process.env.MC_MINDCRAFT_ROOT || path.join(WORKSPACE, 'mindcraft');

const STAMP = argOf(process.argv, 'stamp', `FARM${new Date().toISOString().slice(0, 13).replace(/[-T:]/g, '')}`);
const RUNS_DIR = path.join(HERE, 'runs', STAMP);

const SEEDS = SEEDS_RAW ? SEEDS_RAW.split(',').map((s) => s.trim()).filter(Boolean) : [];

// ---- 只属于自己的子进程集合（任务单 §2：只结束自己 spawn 的）----
const spawned = new Map();   // pid -> { child, lane, seal }
function trackChild(child, lane) {
    spawned.set(child.pid, { child, lane });
    child.on('exit', () => spawned.delete(child.pid));
    return child;
}
function killOwn(pid, signal = 'SIGKILL') {
    if (!spawned.has(pid)) return false;      // 不是自己 spawn 的 → 拒绝动手
    try { process.kill(pid, signal); return true; } catch { return false; }
}
function killAllOwn(signal = 'SIGKILL') { for (const pid of [...spawned.keys()]) killOwn(pid, signal); }
function installExitHooks() {
    for (const sig of ['SIGINT', 'SIGTERM']) {
        process.on(sig, () => { log(`收到 ${sig}，回收本进程 spawn 的 ${spawned.size} 个子进程…`); killAllOwn(); process.exit(130); });
    }
    process.on('exit', () => killAllOwn());
}

// ---- 资源闸门（任务单 §2）----
function loadAvg1() { return os.loadavg()[0]; }
async function waitForResources(laneTag) {
    let waited = 0;
    for (;;) {
        const freeMb = os.freemem() / 1048576;
        const load = loadAvg1();
        const ncpu = os.cpus().length;
        const memOk = freeMb >= MIN_FREE_MB;
        const loadOk = load < ncpu * LOAD_FACTOR;
        if (memOk && loadOk) return { freeMb: Math.round(freeMb), load: +load.toFixed(2) };
        if (waited % 15000 === 0) {
            log(`${laneTag} 资源闸门：free=${freeMb.toFixed(0)}MB/${MIN_FREE_MB}MB ${memOk ? '✓' : '✗'} | load=${load.toFixed(2)}/${(ncpu * LOAD_FACTOR).toFixed(1)} ${loadOk ? '✓' : '✗'} → 排队等待`);
        }
        await sleep(5000); waited += 5000;
    }
}

// ---- 泳道规划 ----
// FARM-02 修正（farms/results 反馈的 lanes=5 vs "@ N=6" 口径分歧的根因）：
//   旧实现 `perLane = Math.ceil(SEEDS/LANES)` + `slice(i*perLane, (i+1)*perLane)`。
//   20 种子 / --lanes 6 ⇒ perLane = ceil(20/6) = 4 ⇒ 每泳道 4 局 ⇒ 只能排出 5 条泳道
//   （Y5 的 slice(20,24) 为空 → break）。于是 `--lanes 6` **静默塌陷成 5 泳道**。
//   曲线档位不受影响是因为那里 seeds 恰好 = 2×N（perLane=2，N 条泳道刚好排满），
//   唯独「20 种子 @ N=6」这一档塌陷——正是 FARM-01 一致性轮 lanes=5 的成因。
//   新实现：把种子尽量均匀地分到 **恰好 min(LANES, SEEDS.length)** 条泳道，
//   余数摊到前几条（前 r 条各多 1 局），保证实际泳道数 == 请求并发数。
function planLanes() {
    const lanes = [];
    const nLanes = Math.min(LANES, SEEDS.length) || 1;
    const base = Math.floor(SEEDS.length / nLanes);
    const rem = SEEDS.length % nLanes;
    let cursor = 0;
    for (let i = 0; i < nLanes; i++) {
        const take = base + (i < rem ? 1 : 0);
        const mySeeds = SEEDS.slice(cursor, cursor + take);
        cursor += take;
        if (!mySeeds.length) break;
        lanes.push({
            idx: i,
            name: `Y${i}`,
            port: BASE_PORT + i,
            rcon: BASE_RCON + i,
            serverDir: path.join(SERVER_ROOT, `laneY${i}`),
            start: cursor - take + 1,
            seeds: mySeeds,
        });
    }
    return lanes;
}

// ---- 起服闸：等某条泳道完成世界生成（server.log 出现 "Done ("）----
//   只看「起服完成」，不要求整局结束——世界生成才是 CPU 峰值所在。
//   设计会话 10-02 夜裁决 §2：同一时刻**最多 1 个服在生成世界**（硬约束，不许放宽）。
//   故本函数在 maxMs=Infinity 时不超时返回；放行条件只能是「观察到 Done (」或「泳道已退出」。
async function waitLaneBooted(lane, maxMs) {
    const t0 = Date.now();
    // 该泳道第一局的 server.log 位置：<cloud>/runs/L<idx>/trial_<nn>/server.log
    while (Date.now() - t0 < maxMs) {
        if (lane.child.exitCode !== null) return { ok: false, sec: +((Date.now() - t0) / 1000).toFixed(1), why: 'lane-exited' };
        try {
            const base = path.join(HERE, 'runs', `L${lane.idx}`);
            if (fs.existsSync(base)) {
                for (const d of fs.readdirSync(base)) {
                    const slog = path.join(base, d, 'server.log');
                    if (fs.existsSync(slog)) {
                        const txt = fs.readFileSync(slog, 'utf8');
                        const m = /Done \(([\d.]+)s\)!/.exec(txt);
                        if (m) return { ok: true, sec: +((Date.now() - t0) / 1000).toFixed(1), bootSec: parseFloat(m[1]) };
                    }
                }
            }
        } catch { /* 文件还在写 */ }
        await sleep(2000);
    }
    return { ok: false, sec: +((Date.now() - t0) / 1000).toFixed(1), why: 'timeout' };
}

// ---- fork 一条泳道 ----
function launchLane(lane) {
    const laneRunStamp = `L${lane.idx}`;
    // 预置退出 promise（在 spawn 之后立刻挂监听，避免「进程已退出、监听器才建立」的竞态）
    let resolveExit;
    lane.exitPromise = new Promise((r) => { resolveExit = r; });
    lane.resolveExit = resolveExit;
    const args = [
        path.join(HERE, 'run_lane.mjs'),
        '--stage', STAGE,
        '--trials', String(lane.seeds.length),
        '--start', String(lane.start),
        '--seeds', lane.seeds.join(','),
        '--target', TARGET,
        '--mc-version', MC_VERSION,
        '--timeout-ms', TIMEOUT_MS,
        '--no-progress-s', NO_PROGRESS_S,
        '--probe-ms', PROBE_MS,
        '--xmx', XMX,
        '--boot-tries', BOOT_TRIES,
        '--boot-timeout-s', BOOT_TIMEOUT_S,
        '--mode', MODE,
        '--kit', KIT,
        '--stamp', laneRunStamp,
    ];
    if (GOD_MODE) args.push('--god-mode');
    if (KEEP_WORLD) args.push('--keep-world');

    const env = {
        ...process.env,
        MC_BENCH_JAVA: JAVA,
        MC_BENCH_JAR: JAR,
        MC_MINDCRAFT_ROOT: MINDCRAFT,
        MC_LANE_PORT: String(lane.port),
        MC_LANE_NAME: lane.name,
        MC_BENCH_SERVER: lane.serverDir,
        MC_FARM_RCON_PORT: String(lane.rcon),
        // 每泳道独立 RUNS 目录：run_lane.mjs 写 <cloud>/runs/<stamp>/，不同泳道用不同 stamp，
        // 但它们同属本农场 run；收工时再归集到 <RUNS_DIR>/lane<i>/。
    };
    const logPath = path.join(RUNS_DIR, `lane${lane.idx}.log`);
    const out = fs.openSync(logPath, 'a');
    const child = trackChild(spawn(process.execPath, args, { env, stdio: ['ignore', out, out] }), lane.name);
    lane.child = child;
    lane.logPath = logPath;
    lane.pid = child.pid;
    child.on('exit', (code) => {
        log(`泳道 ${lane.name} 退出 code=${code}`);
        lane.exitCode = code;
        lane.resolveExit({ lane: lane.name, idx: lane.idx, port: lane.port, exitCode: code, pid: lane.pid });
    });
    log(`泳道 ${lane.name} 起：pid=${child.pid} 端口 ${lane.port} 种子 ${lane.seeds.length} 个 [${lane.seeds[0]}…${lane.seeds.at(-1)}]`);
    return child;
}

async function main() {
    installExitHooks();
    if (!JAVA || !fs.existsSync(JAVA)) throw new Error(`MC_BENCH_JAVA 未设置或不存在：${JAVA}`);
    if (!JAR || !fs.existsSync(JAR)) throw new Error(`MC_BENCH_JAR 未设置或不存在：${JAR}`);
    if (!SEEDS.length) throw new Error('必须用 --seeds 给出种子列表（逗号分隔）');
    if (!fs.existsSync(path.join(HERE, 'run_lane.mjs'))) throw new Error('run_lane.mjs 不存在（本单要求基于它扩展）');

    const lanes = planLanes();
    fs.mkdirSync(RUNS_DIR, { recursive: true });
    fs.writeFileSync(path.join(RUNS_DIR, 'farm_meta.json'), JSON.stringify({
        stamp: STAMP, stage: STAGE, lanes: lanes.length, lanesRequested: LANES, mcVersion: MC_VERSION,
        basePort: BASE_PORT, baseRcon: BASE_RCON, seeds: SEEDS,
        java: JAVA, jar: path.basename(JAR), mindcraft: MINDCRAFT,
        minFreeMb: MIN_FREE_MB, loadFactor: LOAD_FACTOR,
        ncpu: os.cpus().length, memTotalMb: Math.round(os.totalmem() / 1048576),
        startedAt: new Date().toISOString(),
        params: { target: TARGET, xmx: XMX, timeoutMs: TIMEOUT_MS, noProgressS: NO_PROGRESS_S, bootTries: BOOT_TRIES, mode: MODE },
    }, null, 2));

    log(`=== FARM ${STAMP} | ${STAGE} | ${lanes.length} 条泳道 | ${SEEDS.length} 局 | MC ${MC_VERSION} | 端口 ${BASE_PORT}..${BASE_PORT + lanes.length - 1} ===`);
    log(`本机：${os.cpus().length} 核 / ${(os.totalmem() / 1073741824).toFixed(0)}GB / 可用 ${(os.freemem() / 1048576).toFixed(0)}MB`);

    // 资源闸门：并行铺开前先过一道（避免一次性抢）
    const gate = await waitForResources('farm');
    log(`资源闸门通过：free=${gate.freeMb}MB load=${gate.load}`);

    // ---- 起服闸（设计会话 10-02 夜裁决 §2，永久生效）----
    //   同一时刻**最多 1 个服在生成世界**：等上一条泳道 server.log 出现 "Done ("
    //   再起下一条。起服时间照记、不计成绩。不改 server.properties（不许关看门狗）。
    //   FARM5 的教训：同秒并发 5 个世界生成 → CPU 吃满 4 核配额 → 单 tick 77.49s →
    //   看门狗判死（栈停在 readBytes 只说明死时正在读区域文件，根因是 CPU 不够）。
    //   STAGGER_WAIT_MS 默认 Infinity（硬约束，不因起服慢而放行）。
    for (let i = 0; i < lanes.length; i++) {
        const lane = lanes[i];
        if (i > 0) {
            const prev = lanes[i - 1];
            const waited = await waitLaneBooted(prev, STAGGER_WAIT_MS);
            log(`起服闸：${prev.name} ${waited.ok ? `世界生成完成（起服 ${waited.bootSec}s，等待 ${waited.sec}s）` : `未确认完成（${waited.why}，等待 ${waited.sec}s）`} → 放行 ${lane.name}`);
        }
        await waitForResources(lane.name);   // 每条泳道起服前再过一次资源闸门（任务单 §2）
        launchLane(lane);
        if (BOOT_STAGGER_MS > 0) await sleep(BOOT_STAGGER_MS);
    }

    // 等全部泳道收工（监听器在 launchLane 里已挂好，不存在竞态）
    log('等待全部泳道收工…');
    const results = await Promise.all(lanes.map((lane) => lane.exitPromise));

    // 归集各泳道产物到本农场 run 目录
    log('归集各泳道产物…');
    const laneSummaries = [];
    for (const lane of lanes) {
        const src = path.join(HERE, 'runs', `L${lane.idx}`);
        const dst = path.join(RUNS_DIR, `lane${lane.idx}`);
        try {
            if (fs.existsSync(src)) {
                fs.mkdirSync(dst, { recursive: true });
                // 移动（同盘 rename）：保留每局目录结构与原始遥测
                for (const entry of fs.readdirSync(src)) {
                    const s = path.join(src, entry), d = path.join(dst, entry);
                    try { fs.renameSync(s, d); } catch { /* 已在别处 */ }
                }
            }
            const ls = path.join(dst, 'lane_summary.json');
            if (fs.existsSync(ls)) laneSummaries.push(JSON.parse(fs.readFileSync(ls, 'utf8')));
        } catch (e) {
            log(`! 归集泳道 ${lane.name} 失败：${e.message}`);
        }
    }

    // 汇总
    const allRows = [];
    for (const ls of laneSummaries) for (const r of (ls.rows || [])) allRows.push(r);
    const ok = allRows.filter((r) => r.outcome === 'SUCCESS').length;
    const lagged = allRows.filter((r) => r.laged).length;
    const summary = {
        stamp: STAMP, stage: STAGE, lanes: lanes.length, mcVersion: MC_VERSION,
        totalTrials: allRows.length, success: ok, laggedGames: lagged,
        peakCombinedMb: Math.max(0, ...allRows.map((r) => r.memPeakCombinedMb ?? 0)),
        lanesDetail: laneSummaries.map((ls) => ({
            lane: ls.lane, port: ls.port, success: ls.success, total: ls.total,
            lagged: ls.laggedGames, peakCombinedMb: ls.peakCombinedMb,
            rows: ls.rows,
        })),
        finishedAt: new Date().toISOString(),
    };
    fs.writeFileSync(path.join(RUNS_DIR, 'farm_summary.json'), JSON.stringify(summary, null, 2));

    log(`=== FARM DONE ${ok}/${allRows.length} SUCCESS | LAGGED ${lagged} 局 | 内存峰值 ${summary.peakCombinedMb}MB ===`);
    log(`汇总：${path.join(RUNS_DIR, 'farm_summary.json')}`);
    return summary;
}

main().then((s) => process.exit(s.success >= 0 ? 0 : 1))
    .catch((e) => { console.error(`[farm FATAL] ${e && e.stack ? e.stack : e}`); killAllOwn(); process.exit(1); });
