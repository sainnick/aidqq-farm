#!/usr/bin/env node
// run_micro_linux.mjs — G 线（S0 生存/防御）微基准的 **Linux 移植 runner**
//
// ============================================================================
// 为什么是「新文件」而不是改 run_bench.mjs / _lib：
//   手册 §9「bench 脚本：各开发线在自己的 stage 下工作；_lib/ 只能新增文件，
//   改已有文件要先报告」。G 线的 `run_bench.mjs` → `_lib/runner_core.mjs` →
//   `_lib/{preflight,cleanup,line_lock,reserve}.mjs` 整条链是 **Windows 专属**：
//     - runner_core.killTree() → `taskkill /PID /T /F`
//     - preflight.mjs → `powershell.exe Get-CimInstance Win32_Process` + `netstat -ano`
//     - cleanup.mjs → tasklist/taskkill
//     - line_lock.mjs → `tasklist /NH /FO CSV` + `.lane-owners/<lane>.json` 心跳
//     - reserve.mjs → 同族
//   这些在本机（Ubuntu）必然抛 ENOENT。任务单明确「判据一行不改」「移植改动单独列出」，
//   所以本文件是 **run_lane.mjs 那份 Linux 原语的复用**：编排语义（fresh world →
//   起服 → 起 bot → 读 result.json → stdin stop）对齐 runner_core，平台原语全换 Linux 实现。
//
// **判据一行不改**：本文件**不碰** scenarios.mjs / micro_defense.mjs。
//   场景真源（ARENA / commonGates / SCENARIOS）与 bot 侧判据原样使用：
//     - kit 串由 scenarios.mjs 的 {kit, console} 拼出（与 run_bench.mjs 的 microKit 同构）；
//     - 判负只看 `micro_defense.mjs` 落盘的 result.json.verdict（PASS/FAIL），
//       runner 侧只做「起场景 + 收结果」，不解释、不改写 verdict。
//   与 run_bench.mjs 的唯一差别：outcome 直接取 verdict，不再有 runner_core 那套
//   「botExit!==0 ⇒ FAIL(?)」的矩阵语义（那正是 run_bench.remapMicroOutcomes 事后要修的）。
//
// 移植改动清单（相对 Windows 版）见文件尾 COMMENT「移植改动清单」。
//
// 用法：
//   node run_micro_linux.mjs --scenario creeper --trials 30 \
//        --stamp MIC_CREEPER_L1 --mc-version 1.16.1
//   node run_micro_linux.mjs --scenario gaze --trials 30 --stamp MIC_GAZE_L1
//
// 环境变量（与 run_lane.mjs 对齐）：
//   MC_BENCH_JAVA        JDK 11 java（必填）
//   MC_BENCH_JAR         vanilla 1.16.1 server jar（必填）
//   MC_BENCH_SERVER      测试服目录（默认 <WS>/servers/microL）
//   TASK_LAYER_DIR       任务层根（默认 <WS>/mindcraft-s0-survival）
//   MC_LANE_PORT         端口（默认 25566）
//   MC_LANE_NAME         泳道名（默认 ML）

import { spawn, spawnSync } from 'child_process';
import { createServer } from 'net';
import { fileURLToPath, pathToFileURL } from 'url';
import os from 'os';
import fs from 'fs';
import path from 'path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BENCH = path.resolve(HERE, '..');
const WORKSPACE = path.resolve(BENCH, '..');

function argOf(argv, name, dflt) {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : dflt;
}
const log = (m) => console.log(`[micro ${new Date().toISOString().slice(11, 19)}] ${m}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- CLI ----
const SCENARIO = argOf(process.argv, 'scenario', 'creeper');
const TRIALS = parseInt(argOf(process.argv, 'trials', '30'), 10);
const START = parseInt(argOf(process.argv, 'start', '1'), 10);
const SEED_RAW = argOf(process.argv, 'seeds', '');
const MC_VERSION = argOf(process.argv, 'mc-version', '1.16.1');
const TIMEOUT_MS = parseInt(argOf(process.argv, 'timeout-ms', '240000'), 10);
const NO_PROGRESS_S = parseInt(argOf(process.argv, 'no-progress-s', '240'), 10);
const PROBE_MS = parseInt(argOf(process.argv, 'probe-ms', '3000'), 10);
const XMX = argOf(process.argv, 'xmx', '1G');
const BOOT_TRIES = parseInt(argOf(process.argv, 'boot-tries', '3'), 10);
const BOOT_TIMEOUT_S = parseInt(argOf(process.argv, 'boot-timeout-s', '300'), 10);
const KEEP_WORLD = process.argv.includes('--keep-world');
// 微基准：场景自带 kit（物品 + 控制台命令）；起服后由本 runner 经 stdin 注入。
// 场景定义在 scenarios.mjs（唯一真源）——本文件不复制任何坐标/物品。

const LANE_NAME = process.env.MC_LANE_NAME || 'ML';
const LANE_PORT = parseInt(process.env.MC_LANE_PORT || '25566', 10);
const JAVA = process.env.MC_BENCH_JAVA;
const JAR = process.env.MC_BENCH_JAR;
const SERVER_DIR = process.env.MC_BENCH_SERVER || path.join(WORKSPACE, 'servers', 'microL');
const TASK_LAYER = process.env.TASK_LAYER_DIR || path.join(WORKSPACE, 'mindcraft-s0-survival');
const USERNAME = `MicroBot${LANE_NAME}`;

const MICRO_DIR = path.join(BENCH, 'stages', 'basic-survival', 'micro');
const RUNS_DIR = path.join(HERE, 'runs', argOf(process.argv, 'stamp', `MIC_${SCENARIO.toUpperCase()}_${new Date().toISOString().slice(0, 13).replace(/[-T:]/g, '')}`));
const SUMMARY = path.join(RUNS_DIR, 'summary.jsonl');

const SEEDS = SEED_RAW
    ? SEED_RAW.split(',').map((s) => s.trim()).filter(Boolean)
    : Array.from({ length: TRIALS }, (_, i) => `MIC-${SCENARIO}-${String(START + i).padStart(2, '0')}`);

// ---- 只属于本进程的 child 集合（手册 §9.2：只结束自己 spawn 的）----
const spawned = new Map();
function trackChild(child, role) {
    spawned.set(child.pid, { child, role });
    child.on('exit', () => spawned.delete(child.pid));
    return child;
}
function killOwn(pid, signal = 'SIGKILL') {
    const rec = spawned.get(pid);
    if (!rec) return false;
    try { process.kill(pid, signal); return true; } catch { return false; }
}
function killAllOwn(signal = 'SIGKILL') { for (const pid of [...spawned.keys()]) killOwn(pid, signal); }
function installExitHooks() {
    for (const sig of ['SIGINT', 'SIGTERM']) {
        process.on(sig, () => { log(`收到 ${sig}，回收本进程 spawn 的子进程…`); killAllOwn(); releaseBootLock(); process.exit(130); });
    }
    process.on('exit', () => { killAllOwn(); releaseBootLock(); });
}

// ---- 端口检查：优先 ss，否则 Node bind 探测（与 run_lane.mjs 同构）----
function hasSs() { return spawnSync('sh', ['-c', 'command -v ss'], { encoding: 'utf8' }).status === 0; }
const SS_AVAILABLE = hasSs();
function portViaSs(port) {
    const r = spawnSync('ss', ['-ltnH'], { encoding: 'utf8' });
    if (r.status !== 0) return null;
    return (r.stdout || '').split('\n').some((l) => new RegExp(`[:.]${port}\\s`).test(l) && l.includes('LISTEN'));
}
async function portFree(port) {
    if (SS_AVAILABLE) { const viaSs = portViaSs(port); if (viaSs !== null) return !viaSs; }
    return await new Promise((resolve) => {
        const srv = createServer();
        srv.once('error', (e) => resolve(e.code !== 'EADDRINUSE'));
        srv.once('listening', () => srv.close(() => resolve(true)));
        srv.listen(port, '127.0.0.1');
    });
}

function rssKb(pid) {
    try {
        const m = /^VmRSS:\s+(\d+)\s+kB/m.exec(fs.readFileSync(`/proc/${pid}/status`, 'utf8'));
        return m ? parseInt(m[1], 10) : 0;
    } catch { return 0; }
}

// ---- 测试服目录（生成难度参数按 G 线口径：easy）----
function ensureServerDir() {
    fs.mkdirSync(SERVER_DIR, { recursive: true });
    if (!fs.existsSync(path.join(SERVER_DIR, path.basename(JAR)))) fs.copyFileSync(JAR, path.join(SERVER_DIR, path.basename(JAR)));
    fs.writeFileSync(path.join(SERVER_DIR, 'eula.txt'), '# 由 run_micro_linux runner 生成\neula=true\n');
    const spPath = path.join(SERVER_DIR, 'server.properties');
    const want = {
        'server-port': String(LANE_PORT),
        'server-ip': '127.0.0.1',
        'online-mode': 'false',
        'view-distance': '8',
        'level-name': 'spike_world',
        'difficulty': 'easy',            // ★ G 线口径（run_bench materializeTemplate 同值）
        'gamemode': 'survival',
        'spawn-protection': '0',
        'max-players': '4',
        'sync-chunk-writes': 'false',
        'enable-rcon': 'false',
        'spawn-monsters': 'true',        // easy 下敌对要能刷（同 run_bench）
        'motd': 'aidqq micro linux',
    };
    let lines = fs.existsSync(spPath) ? fs.readFileSync(spPath, 'utf8').split(/\r?\n/) : Object.keys(want).map((k) => `${k}=`);
    const seen = new Set();
    lines = lines.filter((l) => { const k = l.split('=')[0]; if (!(k in want)) return true; if (seen.has(k)) return false; seen.add(k); return true; })
        .map((l) => { const k = l.split('=')[0]; return (k in want) ? `${k}=${want[k]}` : l; });
    for (const [k, v] of Object.entries(want)) if (!seen.has(k)) lines.push(`${k}=${v}`);
    lines = lines.filter((l) => !l.startsWith('level-seed='));
    fs.writeFileSync(spPath, lines.join('\n') + '\n');
    return path.join(SERVER_DIR, path.basename(JAR));
}

const WORLD_DIRS = ['spike_world', 'spike_world_nether', 'spike_world_the_end'];
function rmBestEffort(target, tries = 5) {
    for (let i = 1; i <= tries; i++) {
        if (!fs.existsSync(target)) return true;
        try { fs.rmSync(target, { recursive: true, force: true }); return !fs.existsSync(target); }
        catch (e) {
            if (i === tries) { log(`  ! 删不掉 ${path.basename(target)}（${e.code}）`); return false; }
            const end = Date.now() + 400 * i; while (Date.now() < end) { /* 退避 */ }
        }
    }
    return !fs.existsSync(target);
}
function freshWorld(jarInDir, seed) {
    // 微基准的 arena 建在 y=200 的空中，与出生点无关；但世界仍逐局重建，
    // 保证 bot 出生点/区块状态一致（与 run_bench 的 freshWorld 语义一致）。
    for (const d of WORLD_DIRS) {
        const p = path.join(SERVER_DIR, d);
        if (!fs.existsSync(p)) continue;
        const trash = `${p}.trash.${Date.now()}`;
        try { fs.renameSync(p, trash); } catch { rmBestEffort(p); continue; }
        rmBestEffort(trash);
    }
    const spPath = path.join(SERVER_DIR, 'server.properties');
    const lines = fs.readFileSync(spPath, 'utf8').split(/\r?\n/).filter((l) => !l.startsWith('level-seed='));
    lines.push(`level-seed=${seed}`);
    fs.writeFileSync(spPath, lines.join('\n') + '\n');
    return jarInDir;
}

// ---- 全局起服锁（与 run_lane.mjs 完全同构：两级兜底）----
const BOOT_LOCK = path.join(HERE, 'runs', '.boot.lock');
const BOOT_LOCK_STALE_MS = Math.max(
    BOOT_TIMEOUT_S * 1000 + 30000,
    parseInt(process.env.MC_BENCH_BOOT_LOCK_STALE_MS || '0', 10) || 0);
function pidAlive(pid) {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}
async function acquireBootLock(label) {
    const t0 = Date.now();
    for (;;) {
        try {
            const fd = fs.openSync(BOOT_LOCK, 'wx');
            fs.writeSync(fd, JSON.stringify({ pid: process.pid, ppid: process.ppid, label, at: new Date().toISOString() }));
            fs.closeSync(fd);
            return { waitedMs: Date.now() - t0 };
        } catch (e) {
            if (e.code !== 'EEXIST') throw e;
            let stale = false, why = '';
            try {
                const info = JSON.parse(fs.readFileSync(BOOT_LOCK, 'utf8'));
                if (!pidAlive(info.pid)) { stale = true; why = `持有者 pid=${info.pid} 已退出`; }
                else {
                    const age = Date.now() - fs.statSync(BOOT_LOCK).mtimeMs;
                    if (age > BOOT_LOCK_STALE_MS) { stale = true; why = `锁龄 ${(age / 1000).toFixed(0)}s > ${(BOOT_LOCK_STALE_MS / 1000).toFixed(0)}s，pid=${info.pid} 仍存活`; }
                }
            } catch {
                try { const age = Date.now() - fs.statSync(BOOT_LOCK).mtimeMs; if (age > BOOT_LOCK_STALE_MS) { stale = true; why = `锁文件不可解析且锁龄 ${(age / 1000).toFixed(0)}s`; } } catch { /* 锁刚释放 */ }
            }
            if (stale) { log(`${label}: 起服锁接管（${why}）`); fs.rmSync(BOOT_LOCK, { force: true }); continue; }
            await sleep(1000);
        }
    }
}
function releaseBootLock() { try { fs.rmSync(BOOT_LOCK, { force: true }); } catch { /* 忽略 */ } }

// ---- 起服 / 停服 ----
async function bootServer(jarInDir, runDir) {
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
        try { if (fs.readFileSync(serverLog, 'utf8').includes('Done (')) { releaseBootLock(); return { child, pid: child.pid, bootMs: Date.now() - t0, out }; } } catch { /* 日志未落盘 */ }
        if (child.exitCode !== null) break;
    }
    const crashed = child.exitCode !== null;
    if (!crashed) killOwn(child.pid, 'SIGKILL');
    try { fs.closeSync(out); } catch { /* 忽略 */ }
    releaseBootLock();
    const e = new Error(crashed ? `server crashed on boot (exit=${child.exitCode})` : `server boot timeout (${BOOT_TIMEOUT_S}s)`);
    e.crashed = crashed;
    throw e;
}
async function stopServer(server) {
    try { if (server.child.stdin && !server.child.stdin.destroyed) server.child.stdin.write('stop\n'); } catch { /* 已断 */ }
    const t0 = Date.now();
    while (server.child.exitCode === null && Date.now() - t0 < 15000) await sleep(500);
    if (server.child.exitCode === null) killOwn(server.pid, 'SIGKILL');
    try { fs.closeSync(server.out); } catch { /* 忽略 */ }
    await sleep(1500);
}

// ---- kit 注入：拼法与 run_bench.mjs 的 microKit 同构（exec: 命令 + 物品），走服务器 stdin ----
// 注意 exec: 后面的服务器命令自带冒号（`fill ... minecraft:air`），必须**从第一个冒号处**切，
// 否则会把命令从最后一个冒号截断（runner_core.injectKit 头注的实测坑，这里同样适用）。
function splitKit(kit) {
    return String(kit).split(',').map((s) => s.trim()).filter(Boolean).map((raw) => {
        const idx = raw.indexOf(':');
        const name = idx >= 0 ? raw.slice(0, idx).trim() : raw;
        const count = idx >= 0 ? raw.slice(idx + 1).trim() : '1';
        return { raw, name, count };
    });
}
async function injectKit(server, runDir, kit, username) {
    const items = splitKit(kit);
    const logPath = path.join(runDir, 'server.log');
    const t0 = Date.now();
    let joined = false;
    while (Date.now() - t0 < 90000) {
        try { if (/joined the game/.test(fs.readFileSync(logPath, 'utf8'))) { joined = true; break; } } catch { /* 未落盘 */ }
        if (server.child.exitCode !== null) break;
        await sleep(700);
    }
    if (!joined) { log('kit: bot 90s 未进服，跳过注入'); return { ok: false, joined: false }; }
    const logSize = () => { try { return fs.statSync(logPath).size; } catch { return 0; } };
    const cmds = items.filter((i) => i.name === 'exec').map((i) => i.raw.slice('exec'.length).replace(/^:/, '').trim().replace(/@s\b/g, username));
    for (const c of cmds) {
        const at0 = logSize();
        try { server.child.stdin.write(`${c}\n`); } catch (e) { log(`kit: exec 发送失败 ${c}: ${e}`); }
        await sleep(300);
        let delta = '';
        try { delta = fs.readFileSync(logPath, 'utf8').slice(at0).trim(); } catch { /* 未落盘 */ }
        log(delta ? `kit exec ${c.slice(0, 70)} → ${delta.split(/\r?\n/).slice(0, 1).join('').slice(0, 110)}`
                  : `kit exec ${c.slice(0, 70)} → ⚠ 服务端零输出（没执行？语法错？）`);
    }
    if (cmds.length) { log(`kit: 先跑 ${cmds.length} 条 exec（布景），等 1200ms`); await sleep(1200); }
    for (const it of items.filter((i) => i.name !== 'exec')) {
        try { server.child.stdin.write(`give ${username} minecraft:${it.name} ${it.count}\n`); } catch { /* 忽略 */ }
        await sleep(120);
    }
    await sleep(700);
    const rec = { kit: items.map((i) => `${i.name}:${i.count}`).join(','), username, at: new Date().toISOString(), joined: true };
    fs.writeFileSync(path.join(runDir, 'kit.json'), JSON.stringify(rec, null, 2));
    fs.writeFileSync(path.join(runDir, 'kit_done.json'), JSON.stringify(rec, null, 2));
    log(`kit: 已注入 ${items.length} 项（exec ${cmds.length} 条）`);
    return { ok: true, ...rec };
}

// ---- 无进展探针（语义同 runner_core.awaitBotExit）----
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

// ---- 场景 kit 串：从 scenarios.mjs（唯一真源）拼出，和 run_bench.microKit 同构 ----
async function buildKit() {
    const mod = await import(pathToFileURL(path.join(MICRO_DIR, 'scenarios.mjs')).href);
    const s = mod.SCENARIOS[SCENARIO];
    if (!s) throw new Error(`未知场景 "${SCENARIO}"（可用：${Object.keys(mod.SCENARIOS).join(' / ')}）`);
    const items = String(s.kit || '').split(',').map((x) => x.trim()).filter(Boolean);
    const cmds = (s.console || []).map((c) => `exec:${c}`);
    return { kit: [...cmds, ...items].join(','), label: s.label };
}

async function main() {
    installExitHooks();
    if (!JAVA || !fs.existsSync(JAVA)) throw new Error(`MC_BENCH_JAVA 未设置或不存在：${JAVA}`);
    if (!JAR || !fs.existsSync(JAR)) throw new Error(`MC_BENCH_JAR 未设置或不存在：${JAR}`);
    if (!fs.existsSync(path.join(MICRO_DIR, 'micro_defense.mjs'))) throw new Error(`micro_defense.mjs 不存在：${MICRO_DIR}`);
    if (!fs.existsSync(TASK_LAYER)) throw new Error(`TASK_LAYER_DIR 不存在：${TASK_LAYER}`);

    const { kit, label } = await buildKit();
    log(`port check: bind-probe ${LANE_PORT}…`);
    if (!(await portFree(LANE_PORT))) throw new Error(`端口 ${LANE_PORT} 已被占用`);

    const jarInDir = ensureServerDir();
    fs.mkdirSync(RUNS_DIR, { recursive: true });
    fs.writeFileSync(path.join(RUNS_DIR, 'run_meta.json'), JSON.stringify({
        stamp: path.basename(RUNS_DIR), mode: 'MICRO', scenario: SCENARIO, label,
        lane: LANE_NAME, port: LANE_PORT, mcVersion: MC_VERSION,
        jar: path.basename(jarInDir), java: JAVA, serverDir: SERVER_DIR, taskLayer: TASK_LAYER,
        startedAt: new Date().toISOString(),
        params: { trials: TRIALS, seeds: SEEDS, xmx: XMX, timeoutMs: TIMEOUT_MS, noProgressS: NO_PROGRESS_S, kit },
    }, null, 2));

    log(`=== MICRO/${SCENARIO}（${label}）| ${TRIALS} 局 | 泳道 ${LANE_NAME} :${LANE_PORT} | MC ${MC_VERSION} ===`);
    log(`judgement source: scenarios.mjs.gates/measure + micro_defense.mjs（未改一行）`);

    const rows = [];
    for (let i = 0; i < TRIALS; i++) {
        const n = START + i;
        const seed = SEEDS[i] ?? `MIC-${SCENARIO}-${String(n).padStart(2, '0')}`;
        const runDir = path.join(RUNS_DIR, `trial_${String(n).padStart(2, '0')}`);
        fs.mkdirSync(runDir, { recursive: true });
        for (const f of ['probe.jsonl', 'bot.log', 'bot_console.log', 'server.log', 'result.json', 'telemetry.jsonl', 'kit.json', 'kit_done.json']) {
            try { fs.rmSync(path.join(runDir, f), { force: true }); } catch { /* 忽略 */ }
        }
        const row = { trial: n, seed, lane: LANE_NAME, port: LANE_PORT, scenario: SCENARIO, startedAt: new Date().toISOString() };

        freshWorld(jarInDir, seed);
        log(`trial ${n}: fresh world seed=${seed}，起服（free=${(os.freemem() / 1048576).toFixed(0)}MB）`);
        let server, booted = false;
        for (let a = 1; a <= BOOT_TRIES; a++) {
            try { server = await bootServer(jarInDir, runDir); booted = true; break; }
            catch (e) {
                if (e.crashed && a < BOOT_TRIES) { log(`trial ${n}: 启动即崩，冷却 15s 重试 ${a + 1}/${BOOT_TRIES}`); await sleep(15000); continue; }
                row.outcome = 'SERVER_FAIL'; row.error = String(e).slice(0, 200); break;
            }
        }
        if (!booted) { rows.push(row); fs.appendFileSync(SUMMARY, JSON.stringify(row) + '\n'); continue; }
        row.bootMs = server.bootMs;
        log(`trial ${n}: 服务端就绪 ${(server.bootMs / 1000).toFixed(0)}s`);

        const botProc = trackChild(spawn(process.execPath,
            [path.join(MICRO_DIR, 'micro_defense.mjs'),
             '--scenario', SCENARIO, '--trial', String(n), '--seed', seed, '--out', runDir,
             '--port', String(LANE_PORT), '--username', USERNAME,
             '--mc-version', MC_VERSION, '--timeout-ms', String(TIMEOUT_MS), '--probe-ms', String(PROBE_MS),
             '--kit-desc', kit],
            {
                cwd: MICRO_DIR,
                stdio: ['ignore', fs.openSync(path.join(runDir, 'bot_console.log'), 'a'), fs.openSync(path.join(runDir, 'bot_console.log'), 'a')],
                env: { ...process.env, TASK_LAYER_DIR: TASK_LAYER, NODE_OPTIONS: process.env.NODE_OPTIONS || '--max-old-space-size=512' },
            }), 'bot');
        log(`trial ${n}: bot 已起 pid=${botProc.pid}`);

        const kitRes = await injectKit(server, runDir, kit, USERNAME);
        row.kit = kitRes.ok ? true : false;

        const mem = { peakCombinedKb: 0, timer: null };
        mem.timer = setInterval(() => { mem.peakCombinedKb = Math.max(mem.peakCombinedKb, rssKb(server.pid) + (botProc.pid ? rssKb(botProc.pid) : 0)); }, 1000);
        mem.timer.unref?.();

        const exitCode = await awaitBotExit(botProc, runDir, row);
        row.botExit = exitCode;
        await stopServer(server);
        clearInterval(mem.timer);
        row.memPeakCombinedMb = +(mem.peakCombinedKb / 1024).toFixed(1);

        // ★ 判据完全取自 micro_defense.mjs 的 result.json.verdict（不改写）
        try {
            const result = JSON.parse(fs.readFileSync(path.join(runDir, 'result.json'), 'utf8'));
            row.result = result;
            row.microVerdict = result.verdict;
            row.outcome = result.verdict === 'PASS' ? 'MICRO_PASS' : `MICRO_FAIL(${result.detail?.why ?? result.verdict ?? '?'})`;
        } catch {
            row.outcome = row.abort?.reason === 'no_progress' ? 'FAIL(NO_PROGRESS_ABORT)' : (exitCode === -8 ? 'NO_PROGRESS_ABORT' : 'NO_RESULT');
        }
        if (row.result?.durationMs != null) row.durationSec = row.result.durationMs / 1000;
        row.wallSec = +((Date.now() - new Date(row.startedAt).getTime()) / 1000).toFixed(1);
        rows.push(row);
        fs.appendFileSync(SUMMARY, JSON.stringify(row) + '\n');
        log(`trial ${n}: ${row.outcome} wall=${row.wallSec}s`);
        await sleep(1500);
    }

    log('收工：停服、删 world、回收本进程 spawn 的子进程');
    killAllOwn();
    await sleep(2000);
    if (!KEEP_WORLD) {
        for (const d of WORLD_DIRS) rmBestEffort(path.join(SERVER_DIR, d));
        try { for (const n of fs.readdirSync(SERVER_DIR).filter((x) => x.includes('.trash.'))) rmBestEffort(path.join(SERVER_DIR, n)); } catch { /* 忽略 */ }
    }
    log(`端口 ${LANE_PORT} 释放确认：${(await portFree(LANE_PORT)) ? '空闲 ✓' : '仍被占用 ✗'}`);
    log(`残留 child：${spawned.size} 个（应为 0）`);

    const ok = rows.filter((r) => r.outcome === 'MICRO_PASS').length;
    const fails = rows.filter((r) => String(r.outcome).startsWith('MICRO_FAIL'));
    const byWhy = {};
    for (const r of fails) { const w = r.outcome.replace(/^MICRO_FAIL\(/, '').replace(/\)$/, ''); byWhy[w] = (byWhy[w] ?? 0) + 1; }
    const PASS_PCT = rows.length ? +(100 * ok / rows.length).toFixed(1) : 0;
    const summary = {
        mode: 'MICRO', scenario: SCENARIO, label, lane: LANE_NAME, port: LANE_PORT, mcVersion: MC_VERSION,
        totalTrials: rows.length, pass: ok, fail: fails.length, passPct: PASS_PCT,
        failByWhy: byWhy,
        peakCombinedMb: Math.max(0, ...rows.map((r) => r.memPeakCombinedMb ?? 0)),
        finishedAt: new Date().toISOString(),
        rows: rows.map((r) => ({ trial: r.trial, seed: r.seed, outcome: r.outcome, verdict: r.microVerdict ?? null, wallSec: r.wallSec, bootSec: r.bootMs != null ? +(r.bootMs / 1000).toFixed(1) : null, memPeakCombinedMb: r.memPeakCombinedMb ?? null, why: r.result?.detail?.why ?? null })),
    };
    fs.writeFileSync(path.join(RUNS_DIR, 'micro_summary.json'), JSON.stringify(summary, null, 2));
    log(`=== DONE ${ok}/${rows.length} MICRO_PASS（${PASS_PCT}%）| 失败构成 ${JSON.stringify(byWhy)} ===`);
    log(`汇总：${path.join(RUNS_DIR, 'micro_summary.json')}`);
    return summary;
}

main().then((s) => process.exit(0))
    .catch((e) => { console.error(`[micro FATAL] ${e && e.stack ? e.stack : e}`); killAllOwn(); process.exit(1); });

// ============================================================================
// 移植改动清单（相对 Windows 版 run_bench.mjs + _lib/runner_core.mjs）
//   1. 进程回收：runner_core.killTree() 的 `taskkill /PID /T /F` → **只** process.kill 打
//      本进程 spawn 出来、登记在 spawned 里的 child（server/bot）。手册 §9.2「只结束自己
//      spawn 的」；不做任何按名字/按端口/按命令行的全局扫描。
//   2. 端口检查：preflight.mjs 的 `netstat -ano` → 优先 ss（若装了），否则 Node TCP bind
//      探测（服务端真正要执行的就是这个 bind，最权威）。
//   3. 泳道/线锁：line_lock.mjs 的 `tasklist` + `.lane-owners/<lane>.json` 心跳 → 本机单
//      泳道场景不需要；跨进程互斥改用 run_lane.mjs 同款**起服文件锁**（O_CREAT|O_EXCL +
//      两级兜底：pid 存活判定，再 mtime > boot-timeout+30s）。
//   4. 预约/reserve.mjs：Windows 心跳协议无对应物，不移植（本机农场不跑拍摄预约）。
//   5. preflight 的「按命令行为匹配杀残留」整段废除（手册 §9.2 已明令废除该逻辑）。
//   6. 起服模板：不再依赖 experiments/mc1161-gate 模板目录，直接由本文件在
//      MC_BENCH_SERVER 下生成（difficulty=easy / spawn-monsters=true，与 run_bench 同值）。
//   7. 判据：**一行未改**。scenarios.mjs / micro_defense.mjs 原样调用；outcome 直接取
//      result.json.verdict，不再有 runner_core 的矩阵语义（也就省掉了 remapMicroOutcomes）。
//   8. JAVA_TOOL_OPTIONS / Node 20 便携路径等 Windows 环境假设移除，改读 MC_BENCH_JAVA /
//      process.execPath。
// ============================================================================
