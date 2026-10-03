// boot_lock_selftest.mjs — 验证起服锁的两级兜底（设计会话 10-02 夜复核 §1）
//   ① 持锁进程已死 → 立刻接管
//   ② 持锁进程存活但锁龄超 boot-timeout+30s → 才接管
//   ③ 持锁进程存活且锁龄未超 → 必须等待，不得抢锁（关键：慢起服不被误抢）
import fs from 'fs';
import path from 'path';
import os from 'os';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bootlock-'));
const LOCK = path.join(TMP, '.boot.lock');

// 与 run_lane.mjs 完全同构的逻辑
const BOOT_TIMEOUT_S = 300;
const BOOT_LOCK_STALE_MS = Math.max(BOOT_TIMEOUT_S * 1000 + 30000, 0);

function pidAlive(pid) {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try { process.kill(pid, 0); return true; }
    catch (e) { return e.code === 'EPERM'; }
}

// 返回 'taken-over' 或 'wait'
function tryTakeover() {
    let stale = false, why = '';
    try {
        const info = JSON.parse(fs.readFileSync(LOCK, 'utf8'));
        if (!pidAlive(info.pid)) { stale = true; why = `pid=${info.pid} 已退出`; }
        else {
            const age = Date.now() - fs.statSync(LOCK).mtimeMs;
            if (age > BOOT_LOCK_STALE_MS) { stale = true; why = `锁龄${(age/1000).toFixed(0)}s>${BOOT_LOCK_STALE_MS/1000}s`; }
        }
    } catch {
        try { const age = Date.now() - fs.statSync(LOCK).mtimeMs; if (age > BOOT_LOCK_STALE_MS) { stale = true; why = '不可解析且锁龄超'; } } catch {}
    }
    return stale ? { action: 'taken-over', why } : { action: 'wait' };
}

const results = [];
function check(name, cond, detail) { results.push({ name, pass: cond, detail }); }

// —— 用例 1：持锁进程已死（pid 999999 不存在）→ 应立刻接管
fs.writeFileSync(LOCK, JSON.stringify({ pid: 999999, label: 'dead', at: new Date().toISOString() }));
let r = tryTakeover();
check('① 持锁进程已死 → 立刻接管', r.action === 'taken-over', JSON.stringify(r));

// —— 用例 2：持锁进程存活（用本进程 pid），锁龄 0s → 必须等待
fs.writeFileSync(LOCK, JSON.stringify({ pid: process.pid, label: 'alive', at: new Date().toISOString() }));
r = tryTakeover();
check('② 存活 + 锁龄未超 → 必须等待（不抢慢起服）', r.action === 'wait', JSON.stringify(r));

// —— 用例 3：持锁进程存活，但锁龄被人为设为 STALE+10s → 应接管
fs.writeFileSync(LOCK, JSON.stringify({ pid: process.pid, label: 'alive-old', at: new Date().toISOString() }));
const old = new Date(Date.now() - (BOOT_LOCK_STALE_MS + 10000));
fs.utimesSync(LOCK, old, old);
r = tryTakeover();
check('③ 存活 + 锁龄超 boot-timeout+30s → 接管', r.action === 'taken-over', JSON.stringify(r));

// —— 用例 4：阈值关系 STALE > boot-timeout
check('④ STALE_MS(330s) > BOOT_TIMEOUT(300s)', BOOT_LOCK_STALE_MS / 1000 === 330, `STALE=${BOOT_LOCK_STALE_MS/1000}s`);

// —— 用例 5：慢起服场景专项（旧 bug 回归）
//   旧版硬编码 120s：进程存活、锁龄 130s（合法的慢起服）时会被误抢。
const OLD_STALE_MS = 120000;
const lockAge = 130000;
const oldWouldSteal = lockAge > OLD_STALE_MS;
const newWouldSteal = lockAge > BOOT_LOCK_STALE_MS;
check('⑤ 回归：130s 慢起服，旧版会误抢', oldWouldSteal === true, `oldscheme steal=${oldWouldSteal}`);
check('⑤ 回归：130s 慢起服，新版不抢', newWouldSteal === false, `newscheme steal=${newWouldSteal}`);

fs.rmSync(TMP, { recursive: true, force: true });

console.log('=== 起服锁两级兜底 自测 ===');
let allPass = true;
for (const t of results) {
    console.log(`${t.pass ? 'PASS' : 'FAIL'}  ${t.name}   ${t.detail}`);
    if (!t.pass) allPass = false;
}
console.log(allPass ? '\n全部通过 ✅' : '\n有失败 ❌');
process.exit(allPass ? 0 : 1);
