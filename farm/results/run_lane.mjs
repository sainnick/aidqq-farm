#!/usr/bin/env node
// run_lane.mjs — MC-CLOUD-01 泳道 X（云端 Linux）单泳道 runner
//
// 为什么不复用 stages/_lib/runner_core.mjs：
//   runner_core 静态 import preflight/cleanup/line_lock/reserve，这四个模块的
//   procInfo() 走 PowerShell CIM、netstatListeners() 走 netstat -ano、killTree() 走
//   taskkill、line_lock 走 tasklist —— 在 Linux 上必然抛错。任务单 §2 明确「不要改这些
//   现有文件」（归本地 A 线维护），所以本文件是一份**独立复刻**：编排语义（fresh world →
//   起服 → 起 bot → 无进展硬中止 → 读 result.json → stdin stop）逐行对齐 runner_core，
//   平台原语全部换成 Linux 实现。
//
// 与 runner_core 的三处刻意差异（均为任务单 §2 授权范围内）：
//   1. 端口检查：本镜像没有 iproute2，ss / netstat 都不存在。优先 ss（若装了），
//      否则用 Node 自己的 TCP bind 探测（最权威：就是服务端真正要绑的那个动作），
//      lsof 仅作诊断兜底。详见 portFree()。
//   2. 进程回收：**只**用 process.kill 打自己 spawn 出来的 child（server/bot 都在
//      spawned 集合里），不做任何按名字/按端口的全局扫描——任务单 §3「只结束自己 spawn 的」。
//   3. 不做线锁/预约/多泳道：云端机器上只有泳道 X 一条线，line_lock 那套 tasklist 语义
//      在这里没有对应物。
//
// 环境变量（任务单 §2）：
//   MC_BENCH_JAVA        JDK 11 的 java 可执行文件（必填）
//   MC_BENCH_JAR         vanilla 1.16.1 server jar 绝对路径（必填）
//   MC_BENCH_SERVER      测试服目录（默认 <WS>/servers/laneX）
//   MC_MINDCRAFT_ROOT    任务层代码根；end-probe 要指向 worktree
//   MC_LANE_PORT         端口（默认 25566）
//   MC_LANE_NAME         泳道名（默认 X）
//
// 用法：
//   node run_lane.mjs --stage basic-bootstrap --trials 5 \
//        --seeds P2C_M4B4-01,P2C_M4B4-02,P2C_M4B4-03,P2C_M4B4-04,P2C_M4B4-05 \
//        --target 16 --mc-version 1.16.1
//   node run_lane.mjs --stage end-probe --trials 1 --mode detect --mc-version 1.16.1

import { spawn, spawnSync } from 'child_process';
import { createServer } from 'net';
import { fileURLToPath } from 'url';
import os from 'os';
import fs from 'fs';
import path from 'path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BENCH = path.resolve(HERE, '..');                 // <WS>/bench（本文件在 bench/cloud/ 下）
const WORKSPACE = path.resolve(BENCH, '..');             // <WS>

// ---- CLI ----
function argOf(argv, name, dflt) {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : dflt;
}
const log = (m) => console.log(`[lane ${new Date().toISOString().slice(11, 19)}] ${m}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const STAGE = argOf(process.argv, 'stage', 'basic-bootstrap');
const TRIALS = parseInt(argOf(process.argv, 'trials', '5'), 10);
const START = parseInt(argOf(process.argv, 'start', '1'), 10);
const SEEDS_RAW = argOf(process.argv, 'seeds', '');
const TARGET = parseInt(argOf(process.argv, 'target', '16'), 10);
const MODE = argOf(process.argv, 'mode', 'detect');
const KIT = argOf(process.argv, 'kit', 'red_bed:12,cobblestone:48,cooked_beef:16,stone_sword:1');
const DIFFICULTY = argOf(process.argv, 'difficulty', 'peaceful');   // 对齐 end-probe/run_probe.mjs:68（MODE==='easy' ? easy : peaceful）
const TP_TARGET = argOf(process.argv, 'tp', '0 70 0');             // 对齐 run_probe.mjs:71「末地主岛顶面实测 y≈66」；TP 到 y=60 会把人丢进虚空
const GOD_MODE = process.argv.includes('--god-mode');              // 对齐 run_probe.mjs:108
const TIMEOUT_MS = parseInt(argOf(process.argv, 'timeout-ms', '420000'), 10);
const NO_PROGRESS_S = parseInt(argOf(process.argv, 'no-progress-s', '120'), 10);
const PROBE_MS = parseInt(argOf(process.argv, 'probe-ms', '10000'), 10);
const XMX = argOf(process.argv, 'xmx', '1G');
const MIN_FREE_MB = parseInt(argOf(process.argv, 'min-free-mb', '1024'), 10);
const MC_VERSION = argOf(process.argv, 'mc-version', '1.16.1');
const BOOT_TRIES = parseInt(argOf(process.argv, 'boot-tries', '3'), 10);
// 起服超时（秒）。原为硬编码 300s；改为参数以便在慢盘/高负载下调整（设计会话 10-02 夜复核 §1）。
const BOOT_TIMEOUT_S = parseInt(argOf(process.argv, 'boot-timeout-s', '300'), 10);
const KEEP_WORLD = process.argv.includes('--keep-world');

const LANE_NAME = process.env.MC_LANE_NAME || 'X';
const LANE_PORT = parseInt(process.env.MC_LANE_PORT || '25566', 10);
const JAVA = process.env.MC_BENCH_JAVA;
const JAR = process.env.MC_BENCH_JAR;
const SERVER_DIR = process.env.MC_BENCH_SERVER || path.join(WORKSPACE, 'servers', 'laneX');
const MINDCRAFT = process.env.MC_MINDCRAFT_ROOT || path.join(WORKSPACE, 'mindcraft');
const USERNAME = `LaneBot${LANE_NAME}`;

const STAGE_DIR = path.join(BENCH, 'stages', STAGE);
const RUNS_DIR = path.join(HERE, 'runs', argOf(process.argv, 'stamp', `X${new Date().toISOString().slice(0, 13).replace(/[-T:]/g, '')}`));
const SUMMARY = path.join(RUNS_DIR, 'summary.jsonl');

const SEEDS = SEEDS_RAW
    ? SEEDS_RAW.split(',').map((s) => s.trim()).filter(Boolean)
    : Array.from({ length: TRIALS }, (_, i) => `${STAGE}-${String(START + i).padStart(2, '0')}`);

// ---- 只属于本进程的 child 集合（任务单 §3：只结束自己 spawn 的）----
const spawned = new Map(); // pid -> { child, role }
function trackChild(child, role) {
    spawned.set(child.pid, { child, role });
    child.on('exit', () => spawned.delete(child.pid));
    return child;
}
function killOwn(pid, signal = 'SIGKILL') {
    const rec = spawned.get(pid);
    if (!rec) return false;   // 不是自己 spawn 的 → 拒绝动手
    try { process.kill(pid, signal); return true; } catch { return false; }
}
function killAllOwn(signal = 'SIGKILL') {
    for (const pid of [...spawned.keys()]) killOwn(pid, signal);
}
function installExitHooks() {
    for (const sig of ['SIGINT', 'SIGTERM']) {
        process.on(sig, () => { log(`收到 ${sig}，回收本进程 spawn 的子进程…`); killAllOwn(); releaseBootLock(); process.exit(130); });
    }
    process.on('exit', () => { killAllOwn(); releaseBootLock(); });
}

// ---- 端口检查（任务单 §2 要求用 ss；本镜像没有，见文件头注释）----
function hasSs() { return spawnSync('sh', ['-c', 'command -v ss'], { encoding: 'utf8' }).status === 0; }
const SS_AVAILABLE = hasSs();
function portViaSs(port) {
    const r = spawnSync('ss', ['-ltnH'], { encoding: 'utf8' });
    if (r.status !== 0) return null;
    return (r.stdout || '').split('\n').some((l) => new RegExp(`[:.]${port}\\s`).test(l) && l.includes('LISTEN'));
}
/** true = 端口空闲。bind 探测为准：服务端真正要执行的就是这个 bind。 */
async function portFree(port) {
    if (SS_AVAILABLE) { const viaSs = portViaSs(port); if (viaSs !== null) return !viaSs; }
    return await new Promise((resolve) => {
        const srv = createServer();
        srv.once('error', (e) => resolve(e.code !== 'EADDRINUSE'));
        srv.once('listening', () => srv.close(() => resolve(true)));
        srv.listen(port, '127.0.0.1');
    });
}
function portDiagnostics(port) {
    const r = spawnSync('lsof', ['-nP', '-iTCP', `-i:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8' });
    return (r.stdout || '').trim() || '(lsof 无输出)';
}

// ---- 内存 ----
function rssKb(pid) {
    try {
        const m = /^VmRSS:\s+(\d+)\s+kB/m.exec(fs.readFileSync(`/proc/${pid}/status`, 'utf8'));
        return m ? parseInt(m[1], 10) : 0;
    } catch { return 0; }
}
async function waitFreeMem(minBytes) {
    let waited = 0;
    while (os.freemem() < minBytes) {
        if (waited % 30000 === 0) log(`memory guard: free=${(os.freemem() / 1048576).toFixed(0)}MB < ${minBytes / 1048576}MB, 等待…`);
        await sleep(5000); waited += 5000;
    }
}

// ---- 测试服目录 ----
function ensureServerDir() {
    fs.mkdirSync(SERVER_DIR, { recursive: true });
    if (!fs.existsSync(path.join(SERVER_DIR, JAR))) {
        fs.copyFileSync(JAR, path.join(SERVER_DIR, path.basename(JAR)));
    }
    const eula = path.join(SERVER_DIR, 'eula.txt');
    fs.writeFileSync(eula, '# 由泳道 X runner 生成\neula=true\n');

    const spPath = path.join(SERVER_DIR, 'server.properties');
    const want = {
        'server-port': String(LANE_PORT),
        'server-ip': '127.0.0.1',
        'online-mode': 'false',
        'view-distance': '8',
        'level-name': 'spike_world',       // 与 worldDirsOf() 对齐
        'difficulty': DIFFICULTY,
        'gamemode': 'survival',
        'spawn-protection': '0',
        'max-players': '4',
        'sync-chunk-writes': 'false',
        'enable-rcon': 'false',
        'motd': 'aidqq lane X',
    };
    let lines;
    if (fs.existsSync(spPath)) {
        lines = fs.readFileSync(spPath, 'utf8').split(/\r?\n/);
    } else {
        lines = Object.keys(want).map((k) => `${k}=`);
    }
    const seen = new Set();
    lines = lines.filter((l) => {
        const k = l.split('=')[0];
        if (!(k in want)) return true;
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
    }).map((l) => {
        const k = l.split('=')[0];
        return (k in want) ? `${k}=${want[k]}` : l;
    });
    for (const [k, v] of Object.entries(want)) if (!seen.has(k)) lines.push(`${k}=${v}`);
    lines = lines.filter((l) => !l.startsWith('level-seed='));
    fs.writeFileSync(spPath, lines.join('\n') + '\n');
    return path.join(SERVER_DIR, path.basename(JAR));
}

const WORLD_DIRS = ['spike_world', 'spike_world_nether', 'spike_world_the_end'];

/** 尽力删除：NFS 上被打开的句柄会让 unlink 抛 EBUSY/ENOTEMPTY，重试若干次后就放弃。
 *  删不掉不是致命错误——世界目录已经被 rename 挪走了，本局拿到的一定是新世界。 */
function rmBestEffort(target, tries = 5) {
    for (let i = 1; i <= tries; i++) {
        if (!fs.existsSync(target)) return true;
        try { fs.rmSync(target, { recursive: true, force: true }); return !fs.existsSync(target); }
        catch (e) {
            if (i === tries) { log(`  ! 删不掉 ${path.basename(target)}（${e.code}），已隔离不重试`); return false; }
            sleepSync(400 * i);
        }
    }
    return !fs.existsSync(target);
}
function sleepSync(ms) { const end = Date.now() + ms; while (Date.now() < end) { /* 同步退避 */ } }

function freshWorld(jarInDir, seed) {
    // 工作区是 NFS 挂载：直接 unlink 一个仍被打开的世界目录会拿到 EBUSY/ENOTEMPTY，
    // 还会留下 .nfsXXXX silly-rename 残片（实测 EBUSY: unlink 'spike_world/.nfs000...'）。
    // 策略：先原子 rename 挪走（rename 在 NFS 上是元数据操作，不受句柄影响），
    // 保证本局拿到的是全新世界；再对改名后的目录尽力删除，失败就留给收工阶段。
    for (const d of WORLD_DIRS) {
        const p = path.join(SERVER_DIR, d);
        if (!fs.existsSync(p)) continue;
        const trash = `${p}.trash.${Date.now()}`;
        try { fs.renameSync(p, trash); }
        catch { rmBestEffort(p); continue; }
        rmBestEffort(trash);
    }
    const spPath = path.join(SERVER_DIR, 'server.properties');
    const lines = fs.readFileSync(spPath, 'utf8').split(/\r?\n/).filter((l) => !l.startsWith('level-seed='));
    lines.push(`level-seed=${seed}`);
    fs.writeFileSync(spPath, lines.join('\n') + '\n');
    return jarInDir;
}

// ---- 全局起服锁（跨进程互斥，设计会话 10-02 夜裁决 §2）----
// 约束：同一时刻**全机最多 1 个 Minecraft 服在生成世界**。
// 为什么不能只在 run_farm 里串行放行泳道：每条泳道要跑多局，泳道 i 的第 2 局会与
//   泳道 i+1 的第 1 局撞上，父进程管不到这个层级。所以锁必须落在每局起服处。
// 实现：O_CREAT|O_EXCL 原子建锁文件；拿到锁才 spawn java，世界生成完（Done）释放。
//   持锁者崩溃时的兜底分两级（设计会话 10-02 夜复核 §1）：
//     ① 优先判「持锁进程是否还活着」（kill(pid,0)）——能区分「起服慢」与「进程已死」，
//        死锁几乎立刻可接管，不会误抢慢起服；
//     ② 进程活着时，再用 mtime 过期兜底，且过期阈值必须 **> boot-timeout**，
//        否则 300s 的慢起服会在 120s 被别的泳道当成陈旧锁抢走（旧版 120s 硬编码的 bug）。
const BOOT_LOCK = path.join(HERE, 'runs', '.boot.lock');
// 过期 = 起服超时 + 30s 余量。可用环境变量覆盖（覆盖值同样不得小于 boot-timeout+30）。
const BOOT_LOCK_STALE_MS = Math.max(
    BOOT_TIMEOUT_S * 1000 + 30000,
    parseInt(process.env.MC_BENCH_BOOT_LOCK_STALE_MS || '0', 10) || 0);

// 持锁进程是否还活着。EPERM 视为活着（存在但无权限发信号）。
function pidAlive(pid) {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try { process.kill(pid, 0); return true; }
    catch (e) { return e.code === 'EPERM'; }
}

async function acquireBootLock(label) {
    const t0 = Date.now();
    for (;;) {
        try {
            const fd = fs.openSync(BOOT_LOCK, 'wx');   // wx = O_CREAT|O_EXCL
            fs.writeSync(fd, JSON.stringify({ pid: process.pid, ppid: process.ppid, label, at: new Date().toISOString() }));
            fs.closeSync(fd);
            return { waitedMs: Date.now() - t0 };
        } catch (e) {
            if (e.code !== 'EEXIST') throw e;
            // 兜底 ①：持锁进程已死 → 立刻接管（不看 mtime，避免慢起服被误判）
            let stale = false, why = '';
            try {
                const raw = fs.readFileSync(BOOT_LOCK, 'utf8');
                const info = JSON.parse(raw);
                if (!pidAlive(info.pid)) { stale = true; why = `持有者 pid=${info.pid} 已退出`; }
                else {
                    // 兜底 ②：进程活着，但锁龄超过 boot-timeout+30s（异常，例如 SIGSTOP 挂住）
                    const age = Date.now() - fs.statSync(BOOT_LOCK).mtimeMs;
                    if (age > BOOT_LOCK_STALE_MS) {
                        stale = true; why = `锁龄 ${(age / 1000).toFixed(0)}s > ${(BOOT_LOCK_STALE_MS / 1000).toFixed(0)}s，且 pid=${info.pid} 仍存活`;
                    }
                }
            } catch {
                // 锁文件损坏 / 读不到：按 mtime 兜底
                try {
                    const age = Date.now() - fs.statSync(BOOT_LOCK).mtimeMs;
                    if (age > BOOT_LOCK_STALE_MS) { stale = true; why = `锁文件不可解析且锁龄 ${(age / 1000).toFixed(0)}s`; }
                } catch { /* 锁刚被释放 */ }
            }
            if (stale) {
                log(`${label}: 起服锁接管（${why}）`);
                fs.rmSync(BOOT_LOCK, { force: true });
                continue;
            }
            await sleep(1000);
        }
    }
}

function releaseBootLock() {
    try { fs.rmSync(BOOT_LOCK, { force: true }); } catch { /* 忽略 */ }
}

// ---- 起服 / 停服 ----
async function bootServer(jarInDir, runDir) {
    // —— 全局起服闸：先拿锁，再 spawn。排队时间不计入 bootMs（起服时间照记、不计成绩）。
    const lock = await acquireBootLock(LANE_NAME);
    if (lock.waitedMs > 2000) log(`${LANE_NAME}: 起服闸排队 ${(lock.waitedMs / 1000).toFixed(1)}s`);
    const serverLog = path.join(runDir, 'server.log');
    const out = fs.openSync(serverLog, 'w');
    let child;
    try {
        child = trackChild(spawn(JAVA, ['-Xms512M', `-Xmx${XMX}`, '-jar', jarInDir, '--nogui'],
            { cwd: SERVER_DIR, stdio: ['pipe', out, out] }), 'server');
    } catch (e) { releaseBootLock(); throw e; }
    const t0 = Date.now();
    while (Date.now() - t0 < BOOT_TIMEOUT_S * 1000) {
        await sleep(2000);
        try {
            if (fs.readFileSync(serverLog, 'utf8').includes('Done (')) {
                releaseBootLock();   // 世界生成完成 → 让出闸门
                return { child, pid: child.pid, bootMs: Date.now() - t0, out };
            }
        } catch { /* 日志还没落盘 */ }
        if (child.exitCode !== null) break;
    }
    const crashed = child.exitCode !== null;
    // 超时/崩溃分支必须回收：只打自己 spawn 的那个 java pid（手册 §9.2）。
    // 原版缺这一步 → 超时的 java 会继续吃 CPU/IO 变成孤儿，污染后续泳道（设计会话 10-02 夜复核 §1）。
    if (!crashed) killOwn(child.pid, 'SIGKILL');
    try { fs.closeSync(out); } catch { /* 忽略 */ }
    releaseBootLock();   // 失败路径也必须让出闸门，否则后续泳道永久排队
    const e = new Error(crashed ? `server crashed on boot (exit=${child.exitCode})` : `server boot timeout (${BOOT_TIMEOUT_S}s)`);
    e.crashed = crashed;
    throw e;
}

async function stopServer(server) {
    try { if (server.child.stdin && !server.child.stdin.destroyed) server.child.stdin.write('stop\n'); } catch { /* 已断 */ }
    const t0 = Date.now();
    while (server.child.exitCode === null && Date.now() - t0 < 15000) await sleep(500);
    if (server.child.exitCode === null) killOwn(server.pid, 'SIGKILL');   // 只打自己 spawn 的那个 pid
    try { fs.closeSync(server.out); } catch { /* 忽略 */ }
    await sleep(1500);
}

// ---- kit 注入（服务器 stdin 控制台，端口径同 runner_core.injectKit）----
async function injectKit(server, runDir, kit, username) {
    const items = String(kit).split(',').map((s) => s.trim()).filter(Boolean).map((s) => {
        const [name, count] = s.split(':');
        return { name: name.trim(), count: String(count ?? '1').trim() };
    });
    const logPath = path.join(runDir, 'server.log');
    const t0 = Date.now();
    let joined = false;
    while (Date.now() - t0 < 90000) {
        try { if (/joined the game/.test(fs.readFileSync(logPath, 'utf8'))) { joined = true; break; } } catch { /* 还没落盘 */ }
        if (server.child.exitCode !== null) break;
        await sleep(700);
    }
    if (!joined) { log('kit: bot 90s 未进服，跳过注入'); return { ok: false, joined: false }; }
    for (const c of items.filter((i) => i.name.startsWith('exec:')).map((i) => i.name.slice(5).trim())) {
        try { server.child.stdin.write(`${c}\n`); } catch { /* 忽略 */ }
        await sleep(200);
    }
    for (const it of items.filter((i) => !i.name.startsWith('exec:'))) {
        try { server.child.stdin.write(`give ${username} minecraft:${it.name} ${it.count}\n`); } catch { /* 忽略 */ }
        await sleep(120);
    }
    await sleep(700);
    const rec = { kit: items.map((i) => `${i.name}:${i.count}`).join(','), username, at: new Date().toISOString(), joined: true };
    fs.writeFileSync(path.join(runDir, 'kit.json'), JSON.stringify(rec, null, 2));
    fs.writeFileSync(path.join(runDir, 'kit_done.json'), JSON.stringify(rec, null, 2));
    log(`kit: 已注入 ${rec.kit}`);
    return { ok: true, ...rec };
}

// ---- 无进展探针（语义同 runner_core.awaitBotExit 的签名冻结判据）----
function tailLine(fp) {
    try {
        const st = fs.statSync(fp);
        if (!st.size) return null;
        const fd = fs.openSync(fp, 'r');
        const len = Math.min(st.size, 8192);
        const buf = Buffer.alloc(len);
        fs.readSync(fd, buf, 0, len, st.size - len);
        fs.closeSync(fd);
        const lines = buf.toString('utf8').split('\n').filter((l) => l.trim());
        return JSON.parse(lines.at(-1));
    } catch { return null; }
}
const probeSig = (p) => p ? JSON.stringify({ i: p.inv ?? null, p: p.pos ?? null, d: !!p.digging, f: p.furnace ?? null, t: p.tree ?? '' }) : null;

function awaitBotExit(botProc, runDir, row) {
    return new Promise((resolve) => {
        let probePoll = 0, lastSig = null, lastChangeAt = Date.now();
        const t0b = Date.now();
        const poll = setInterval(() => {
            if (botProc.exitCode !== null) { clearInterval(poll); resolve(botProc.exitCode); return; }
            if (Date.now() - t0b > TIMEOUT_MS + 90000) { clearInterval(poll); killOwn(botProc.pid); resolve(-9); return; }
            probePoll++;
            if (NO_PROGRESS_S > 0 && probePoll % 5 === 0) {
                const sig = probeSig(tailLine(path.join(runDir, 'probe.jsonl')));
                if (sig) {
                    if (sig !== lastSig) { lastSig = sig; lastChangeAt = Date.now(); }
                    else if (Date.now() - lastChangeAt > NO_PROGRESS_S * 1000) {
                        row.abort = { reason: 'no_progress', frozenMs: Date.now() - lastChangeAt };
                        clearInterval(poll); killOwn(botProc.pid); resolve(-8);
                    }
                }
            }
        }, 1000);
        botProc.on('exit', (code) => { clearInterval(poll); resolve(code); });
    });
}

// ---- TPS（world age 增量 / 墙钟，tps_tap.mjs 旁路采样）----
// 公式：TPS = Δ(worldAgeTicks) / Δ(wallSec)。world age 单位就是 tick，1 tick = 1/20 s，
// 所以「世界每秒推进多少 tick」直接就是 TPS——**不要再除 20**（除了 20 会把 19.x 变成 0.96）。
// 采样有量化误差：vanilla 每 20 tick 才发一次时间包，实测相邻增量分布 {20:71, 0:3, 40:4}，
// 因此取整局首尾两点（误差 ±20 tick / ~1560 tick ≈ ±1.3%），不取相邻点均值。
function tpsFromWorldAge(runDir) {
    try {
        const rows = fs.readFileSync(path.join(runDir, 'world_age.jsonl'), 'utf8')
            .split('\n').filter(Boolean).map((l) => JSON.parse(l));
        if (rows.length < 2) return null;

        // 取「最长连续采样段」：相邻样本间隔 > 3s 视为断档（跨轮残留 / 进程重启）。
        // 单点采样间隔应 ≈ MC_TPS_SAMPLE_MS(1s)，> 3s 必然是另一个世界周期的样本。
        // 这样即使 world_age.jsonl 被污染，也只取本局的连续段做首尾两点。
        let best = null, cur = [rows[0]];
        for (let i = 1; i < rows.length; i++) {
            if (rows[i].wallMs - rows[i - 1].wallMs <= 3000) cur.push(rows[i]);
            else { if (!best || cur.length > best.length) best = cur; cur = [rows[i]]; }
        }
        if (!best || cur.length > best.length) best = cur;
        if (best.length < 2) return null;

        const a = best[0], b = best.at(-1);
        const wallSec = (b.wallMs - a.wallMs) / 1000;
        const tickDelta = b.worldAgeTicks - a.worldAgeTicks;
        if (wallSec <= 0 || tickDelta <= 0) return null;
        const tps = tickDelta / wallSec;
        return { tps: +tps.toFixed(2), wallSec: +wallSec.toFixed(1), ticks: tickDelta,
                 samples: rows.length, segSamples: best.length, laged: tps < 18 };
    } catch { return null; }
}

// ---- 内存峰值采样（服务端 + bot 合计）----
function startMemSampler(serverPid, getBotPid) {
    const s = { peakRssKb: 0, peakCombinedKb: 0, peakSystemUsedKb: 0, samples: 0 };
    const totalKb = () => {
        const m = /^MemTotal:\s+(\d+)/m.exec(fs.readFileSync('/proc/meminfo', 'utf8'));
        const a = /^MemAvailable:\s+(\d+)/m.exec(fs.readFileSync('/proc/meminfo', 'utf8'));
        return m && a ? parseInt(m[1], 10) - parseInt(a[1], 10) : 0;
    };
    s.timer = setInterval(() => {
        const srv = rssKb(serverPid);
        const bot = getBotPid() ? rssKb(getBotPid()) : 0;
        s.samples++;
        s.peakRssKb = Math.max(s.peakRssKb, srv);
        s.peakCombinedKb = Math.max(s.peakCombinedKb, srv + bot);
        s.peakSystemUsedKb = Math.max(s.peakSystemUsedKb, totalKb());
    }, 1000);
    s.timer.unref?.();
    return s;
}

// ---- 每个 stage 的 bot 入口 ----
const STAGES = {
    'basic-bootstrap': {
        bot: () => path.join(STAGE_DIR, 'exec_bot.mjs'),
        botArgs: (n, seed, runDir) => [
            '--trial', String(n), '--seed', seed, '--out', runDir,
            '--port', String(LANE_PORT), '--username', USERNAME,
            '--timeout-ms', String(TIMEOUT_MS), '--mc-version', MC_VERSION,
            '--probe-ms', String(PROBE_MS), '--target', String(TARGET),
        ],
        kit: null,
    },
    'end-probe': {
        bot: () => path.join(STAGE_DIR, 'end_probe_bot.mjs'),
        botArgs: (n, seed, runDir) => [
            '--trial', String(n), '--seed', seed, '--out', runDir,
            '--port', String(LANE_PORT), '--username', USERNAME,
            '--mode', MODE, '--timeout-ms', String(TIMEOUT_MS),
            '--mc-version', MC_VERSION, '--probe-ms', String(PROBE_MS),
        ],
        kit: KIT,
    },
};

async function main() {
    installExitHooks();
    if (!JAVA || !fs.existsSync(JAVA)) throw new Error(`MC_BENCH_JAVA 未设置或不存在：${JAVA}`);
    if (!JAR || !fs.existsSync(JAR)) throw new Error(`MC_BENCH_JAR 未设置或不存在：${JAR}`);
    const spec = STAGES[STAGE];
    if (!spec) throw new Error(`未知 stage "${STAGE}"，可用：${Object.keys(STAGES).join(', ')}`);
    if (!fs.existsSync(spec.bot())) throw new Error(`bot 入口不存在：${spec.bot()}`);

    log(`port check: ss=${SS_AVAILABLE ? 'available' : 'MISSING(用 bind 探测)'} bind-probe 25566…`);
    if (!(await portFree(LANE_PORT))) {
        throw new Error(`端口 ${LANE_PORT} 已被占用。占用者：\n${portDiagnostics(LANE_PORT)}`);
    }
    log(`端口 ${LANE_PORT} 空闲 ✓`);

    const jarInDir = ensureServerDir();
    fs.mkdirSync(RUNS_DIR, { recursive: true });
    fs.writeFileSync(path.join(RUNS_DIR, 'run_meta.json'), JSON.stringify({
        stamp: path.basename(RUNS_DIR), stage: STAGE, lane: LANE_NAME, port: LANE_PORT,
        mcVersion: MC_VERSION, jar: path.basename(jarInDir), java: JAVA,
        serverDir: SERVER_DIR, mindcraft: MINDCRAFT,
        startedAt: new Date().toISOString(),
        params: { trials: TRIALS, seeds: SEEDS, target: TARGET, mode: MODE, xmx: XMX, timeoutMs: TIMEOUT_MS, noProgressS: NO_PROGRESS_S, ssAvailable: SS_AVAILABLE },
    }, null, 2));

    log(`=== ${STAGE} | ${TRIALS} 局 | 泳道 ${LANE_NAME} :${LANE_PORT} | MC ${MC_VERSION} | xmx=${XMX} ===`);

    const rows = [];
    for (let i = 0; i < TRIALS; i++) {
        const n = START + i;
        const seed = SEEDS[i] ?? `${STAGE}-${n}`;
        const runDir = path.join(RUNS_DIR, `trial_${String(n).padStart(2, '0')}`);
        fs.mkdirSync(runDir, { recursive: true });
        // 清空本局遥测：runDir 在跨轮测试间会被复用，而 tps_tap.mjs 用 appendFileSync
        // 追加 world_age.jsonl。若不清空，上一轮的残留样本会被并进本局首尾两点，
        // 把空闲时间算进 TPS 分母 → 假 LAGGED（实测 STAGGER30/lane0 曾算出 tps=3.01）。
        // 设计会话 10-02 夜复核衍生修复。
        for (const f of ['world_age.jsonl', 'telemetry.jsonl', 'probe.jsonl', 'bot.log',
                         'bot_console.log', 'server.log', 'result.json', 'bot_ready.json']) {
            try { fs.rmSync(path.join(runDir, f), { force: true }); } catch { /* 忽略 */ }
        }
        const row = { trial: n, seed, lane: LANE_NAME, port: LANE_PORT, stage: STAGE, startedAt: new Date().toISOString() };

        await waitFreeMem(MIN_FREE_MB * 1048576);
        freshWorld(jarInDir, seed);
        log(`trial ${n}: fresh world seed=${seed}，起服（free=${(os.freemem() / 1048576).toFixed(0)}MB）`);

        let server;
        let booted = false;
        for (let a = 1; a <= BOOT_TRIES; a++) {
            try { server = await bootServer(jarInDir, runDir); booted = true; break; }
            catch (e) {
                if (e.crashed && a < BOOT_TRIES) { log(`trial ${n}: 启动即崩，冷却 15s 后重试 ${a + 1}/${BOOT_TRIES}`); await sleep(15000); continue; }
                row.outcome = 'SERVER_FAIL'; row.error = String(e).slice(0, 200); break;
            }
        }
        if (!booted) { rows.push(row); fs.appendFileSync(SUMMARY, JSON.stringify(row) + '\n'); continue; }
        row.bootMs = server.bootMs;
        log(`trial ${n}: 服务端就绪 ${(server.bootMs / 1000).toFixed(0)}s`);

        const botProc = trackChild(spawn(process.execPath, ['--import', path.join(HERE, 'tps_tap.mjs'),
            spec.bot(), ...spec.botArgs(n, seed, runDir)], {
            cwd: STAGE_DIR,
            stdio: ['ignore', fs.openSync(path.join(runDir, 'bot_console.log'), 'a'), fs.openSync(path.join(runDir, 'bot_console.log'), 'a')],
            env: { ...process.env, MC_MINDCRAFT_ROOT: MINDCRAFT, NODE_OPTIONS: process.env.NODE_OPTIONS || '--max-old-space-size=512' },
        }), 'bot');
        log(`trial ${n}: bot 已起 pid=${botProc.pid}`);

        if (spec.kit) {
            const kit = await injectKit(server, runDir, spec.kit, USERNAME);
            row.kit = kit.ok ? kit.kit : null;
            // 等 bot 报到（kit 到位）→ 下难度 + tp 进末地
            const readyPath = path.join(runDir, 'bot_ready.json');
            const t0 = Date.now();
            let setup = { ok: false };
            while (Date.now() - t0 < 90000) {
                if (fs.existsSync(readyPath)) {
                    const cmds = [
                        `difficulty ${DIFFICULTY}`,
                        ...(GOD_MODE ? [`effect give ${USERNAME} minecraft:resistance 9999 4 true`] : []),
                        `execute in minecraft:the_end run tp ${USERNAME} ${TP_TARGET}`,
                    ];
                    for (const c of cmds) { try { server.child.stdin.write(`${c}\n`); } catch { /* 忽略 */ } await sleep(200); }
                    setup = { ok: true, cmds, at: new Date().toISOString() };
                    log(`trial ${n}: 已下发 ${cmds.join(' | ')}`);
                    break;
                }
                if (botProc.exitCode !== null) break;
                await sleep(500);
            }
            row.setup = setup;
        }

        const mem = startMemSampler(server.pid, () => botProc.pid);
        const exitCode = await awaitBotExit(botProc, runDir, row);
        row.botExit = exitCode;
        log(`trial ${n}: bot exit=${exitCode}，停服…`);
        await stopServer(server);
        clearInterval(mem.timer);

        row.memPeakRssMb = +(mem.peakRssKb / 1024).toFixed(1);
        row.memPeakCombinedMb = +(mem.peakCombinedKb / 1024).toFixed(1);
        row.memPeakSystemUsedMb = +(mem.peakSystemUsedKb / 1024).toFixed(1);
        row.tps = tpsFromWorldAge(runDir);

        try {
            const result = JSON.parse(fs.readFileSync(path.join(runDir, 'result.json'), 'utf8'));
            row.result = result;
            row.outcome = result.status === 'SUCCESS' ? 'SUCCESS' : `FAIL(${result.failReason ?? '?'})`;
        } catch {
            if (row.abort?.reason === 'no_progress') row.outcome = 'FAIL(NO_PROGRESS_ABORT)';
            else if (exitCode === -8) row.outcome = 'NO_PROGRESS_ABORT';
            else row.outcome = 'NO_RESULT';
        }
        if (row.result?.durationMs != null) row.durationSec = +(row.result.durationMs / 1000).toFixed(1);
        row.wallSec = +((Date.now() - new Date(row.startedAt).getTime()) / 1000).toFixed(1);
        rows.push(row);
        fs.appendFileSync(SUMMARY, JSON.stringify(row) + '\n');
        log(`trial ${n}: ${row.outcome} wall=${row.wallSec}s tps=${row.tps ? row.tps.tps : 'n/a'} memPeak(server+bot)=${row.memPeakCombinedMb}MB`);
        await sleep(2000);
    }

    // ---- 收工（任务单 §3）----
    log('收工：停服、删 world、回收本进程 spawn 的子进程');
    killAllOwn();
    await sleep(2000);
    if (!KEEP_WORLD) {
        for (const d of WORLD_DIRS) rmBestEffort(path.join(SERVER_DIR, d));
        // 收走 freshWorld 留下的 trash 目录（NFS 上可能删不掉，如实报告）
        let left = [];
        try {
            left = fs.readdirSync(SERVER_DIR).filter((n) => n.includes('.trash.'));
            for (const n of left) rmBestEffort(path.join(SERVER_DIR, n));
        } catch { /* 忽略 */ }
        if (left.length) log(`! 收工时仍有 ${left.length} 个 trash 目录未删净：${left.join(', ')}`);
    }
    log(`端口 ${LANE_PORT} 释放确认：${(await portFree(LANE_PORT)) ? '空闲 ✓' : '仍被占用 ✗'}`);
    log(`残留 child：${spawned.size} 个（应为 0）`);

    const ok = rows.filter((r) => r.outcome === 'SUCCESS').length;
    const lagged = rows.filter((r) => r.tps?.laged).length;
    const summary = {
        stage: STAGE, lane: LANE_NAME, port: LANE_PORT, mcVersion: MC_VERSION,
        success: ok, total: rows.length, laggedGames: lagged,
        peakCombinedMb: Math.max(0, ...rows.map((r) => r.memPeakCombinedMb ?? 0)),
        ssAvailable: SS_AVAILABLE,
        finishedAt: new Date().toISOString(),
        rows: rows.map((r) => ({ trial: r.trial, seed: r.seed, outcome: r.outcome, durationSec: r.durationSec, wallSec: r.wallSec, bootSec: r.bootMs != null ? +(r.bootMs / 1000).toFixed(1) : null, tps: r.tps?.tps ?? null, laged: !!r.tps?.laged, memPeakCombinedMb: r.memPeakCombinedMb })),
    };
    fs.writeFileSync(path.join(RUNS_DIR, 'lane_summary.json'), JSON.stringify(summary, null, 2));
    log(`=== DONE ${ok}/${rows.length} SUCCESS（LAGGED ${lagged} 局，合计计成绩）| 内存峰值 ${summary.peakCombinedMb}MB ===`);
    log(`汇总：${path.join(RUNS_DIR, 'lane_summary.json')}`);
    return summary;
}

main().then((s) => process.exit(s.success >= 0 ? 0 : 1))
    .catch((e) => { console.error(`[lane FATAL] ${e && e.stack ? e.stack : e}`); killAllOwn(); process.exit(1); });
