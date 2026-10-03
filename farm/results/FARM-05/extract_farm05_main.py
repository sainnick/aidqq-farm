#!/usr/bin/env python3
"""FARM-05 遥测提取：逐局表（含起服用时/判据）+ 合成/熔炼事件 + SERVER_FAIL 单列。
口径与 FARM-02/04 一致：只读 result.json / telemetry.jsonl / server.log，不改判据、不做推测。"""
import json, glob, os, sys, re, collections

RUN = sys.argv[1] if len(sys.argv) > 1 else "runs/FARM05_MAIN"

def jload(p, default=None):
    try:
        with open(p, encoding="utf-8") as f: return json.load(f)
    except Exception: return default

def jl(p):
    out = []
    if not os.path.exists(p): return out
    for line in open(p, encoding="utf-8"):
        line = line.strip()
        if not line: continue
        try: out.append(json.loads(line))
        except Exception: pass
    return out

def boot_info(rundir):
    """从 server.log 判起服：Done ( 判据 + bootMs 记录。"""
    slog = os.path.join(rundir, "server.log")
    info = {"done": False, "done_ms": None, "last_line": None, "spawn_pct": None}
    if not os.path.exists(slog): return info
    txt = open(slog, encoding="utf-8", errors="replace").read()
    m = re.search(r"Done \(([\d.]+)s\)!", txt)
    if m:
        info["done"] = True; info["done_ms"] = float(m.group(1)) * 1000
    lines = [l for l in txt.splitlines() if l.strip()]
    if lines: info["last_line"] = lines[-1][:160]
    pcts = re.findall(r"Preparing spawn area: (\d+)%", txt)
    if pcts: info["spawn_pct"] = int(pcts[-1])
    return info

summ = jload(os.path.join(RUN, "farm_summary.json"), {})
rows = []
for L in summ.get("lanesDetail", []):
    for r in L.get("rows", []): rows.append(r)
rows.sort(key=lambda r: r.get("trial") or 0)

# 每局目录（trial_NN → laneX）
trial_dir = {}
for d in sorted(glob.glob(os.path.join(RUN, "lane*/trial_*"))):
    t = int(re.search(r"trial_(\d+)", d).group(1))
    trial_dir[t] = d

craft = {}
for t, d in sorted(trial_dir.items()):
    ng = collections.Counter(); cf = collections.Counter(); ok = collections.Counter()
    sm = collections.Counter()
    for e in jl(os.path.join(d, "telemetry.jsonl")):
        ev = e.get("event")
        if ev == "craft_no_gain": ng[e.get("reason")] += 1
        elif ev == "craft_fail": cf[e.get("error")] += 1
        elif ev == "craft_ok": ok[e.get("item")] += 1
        elif ev and "smelt" in ev: sm[ev] += 1
    if ng or cf or ok or sm:
        craft[t] = {"no_gain": dict(ng), "fail": dict(cf), "ok": dict(ok), "smelt": dict(sm)}

# 逐局起服信息
boot = {}
for t, d in sorted(trial_dir.items()):
    boot[t] = boot_info(d)

# SERVER_FAIL / 其他边缘单列
outcomes = collections.Counter(str(r.get("outcome")) for r in rows)
server_fail = [r for r in rows if str(r.get("outcome")) == "SERVER_FAIL"]
craft_trials = [r for r in rows if str(r.get("outcome")).startswith("FAIL(") and r.get("outcome") != "SERVER_FAIL"]

out = {
    "run": RUN,
    "farm_summary": {k: summ.get(k) for k in ("stamp","stage","lanes","lanesRequested","totalTrials","success","laggedGames","peakCombinedMb")},
    "outcome_distribution": dict(outcomes),
    "boot_criteria": {
        "success_marker": "server.log contains 'Done ('",
        "boot_timeout_ms": 300000,
        "boot_tries": 3,
        "note": "SERVER_FAIL = 起服未达 Done( 且崩溃重试耗尽；单独列出，不计入合成成败",
    },
    "trials": rows,
    "boot_by_trial": boot,
    "server_fail_trials": [r.get("trial") for r in server_fail],
    "craft_events_by_trial": craft,
    "craft_totals": {
        "no_gain_reasons": dict(collections.Counter(k for c in craft.values() for k, v in c["no_gain"].items() for _ in range(v))),
        "fail_errors": dict(collections.Counter(k for c in craft.values() for k, v in c["fail"].items() for _ in range(v))),
        "ok_items": dict(collections.Counter(k for c in craft.values() for k, v in c["ok"].items() for _ in range(v))),
        "smelt_events": dict(collections.Counter(k for c in craft.values() for k, v in c["smelt"].items() for _ in range(v))),
    },
}
print(json.dumps(out, ensure_ascii=False, indent=2))
