#!/usr/bin/env python3
"""FARM-04 遥测提取：从 runs/FARM04_MAIN 汇总出「逐局表 + 合成事件统计」。
口径与 FARM-02 一致：只读 result.json / telemetry.jsonl，不改判据、不做推测。"""
import json, glob, os, sys, collections

RUN = sys.argv[1] if len(sys.argv) > 1 else "runs/FARM04_MAIN"

def jload(p, default=None):
    try:
        with open(p, encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return default

def jl(p):
    out = []
    if not os.path.exists(p): return out
    for line in open(p, encoding="utf-8"):
        line = line.strip()
        if not line: continue
        try: out.append(json.loads(line))
        except Exception: pass
    return out

summ = jload(os.path.join(RUN, "farm_summary.json"), {})
rows = []
for L in summ.get("lanesDetail", []):
    for r in L.get("rows", []):
        rows.append(r)
rows.sort(key=lambda r: r.get("trial") or 0)

# 逐局 craft 事件
craft = {}
for d in sorted(glob.glob(os.path.join(RUN, "lane*/trial_*"))):
    t = os.path.basename(d)
    ng = collections.Counter(); cf = collections.Counter(); ok = collections.Counter()
    no_gain_detail = []
    for e in jl(os.path.join(d, "telemetry.jsonl")):
        ev = e.get("event")
        if ev == "craft_no_gain":
            ng[e.get("reason")] += 1
            no_gain_detail.append({k: e.get(k) for k in ("item","gained","expected","reason","cursorSource","slotCount")})
        elif ev == "craft_fail":
            cf[e.get("error")] += 1
        elif ev == "craft_ok":
            ok[e.get("item")] += 1
    if ng or cf or ok:
        craft[t] = {"no_gain": dict(ng), "fail": dict(cf), "ok": dict(ok), "no_gain_detail": no_gain_detail}

out = {
    "run": RUN,
    "farm_summary": {k: summ.get(k) for k in ("stamp","stage","lanes","lanesRequested","totalTrials","success","laggedGames","peakCombinedMb")},
    "trials": rows,
    "craft_events_by_trial": craft,
    "craft_totals": {
        "no_gain_reasons": dict(collections.Counter(
            r for c in craft.values() for r in c["no_gain"] for _ in range(c["no_gain"][r]))),
        "fail_errors": dict(collections.Counter(
            r for c in craft.values() for r in c["fail"] for _ in range(c["fail"][r]))),
        "ok_items": dict(collections.Counter(
            r for c in craft.values() for r in c["ok"] for _ in range(c["ok"][r]))),
    },
}
print(json.dumps(out, ensure_ascii=False, indent=2))
