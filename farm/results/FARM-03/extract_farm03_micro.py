#!/usr/bin/env python3
"""FARM-03 G 线微基准提取器（gaze / melee / skeleton）。

读 runs/<STAMP>/trial_*/result.json，逐局抽出判据与诊断字段，
写 runs/<STAMP>/micro_detail.json，并打印一张总表。

判据一行不改：verdict 直接取 result.json.verdict（由 micro_defense.mjs 落盘）。
本脚本只做「读 + 汇总」，不改写任何 verdict。
"""
import json
import sys
import glob
import os
from collections import Counter


def load(stamp_dir):
    rows = []
    for rd in sorted(glob.glob(os.path.join(stamp_dir, 'trial_*'))):
        rp = os.path.join(rd, 'result.json')
        trial = int(os.path.basename(rd).split('_')[1])
        if not os.path.exists(rp):
            rows.append({'trial': trial, 'verdict': None, 'why': 'no_result'})
            continue
        try:
            r = json.load(open(rp, encoding='utf-8'))
        except Exception as e:
            rows.append({'trial': trial, 'verdict': None, 'why': f'parse_error:{e}'})
            continue
        d = r.get('detail', {}) or {}
        row = {
            'trial': trial,
            'verdict': r.get('verdict'),
            'why': d.get('why'),
            'seed': r.get('seed'),
            'samples': r.get('samples'),
            'commonGates': {g['name']: g['ok'] for g in (r.get('commonGates') or [])},
            'gates': {g['name']: g['ok'] for g in (r.get('gates') or [])},
        }
        for k in ['damageTaken', 'hpBefore', 'hpAfter', 'survived', 'distAtTrigger',
                  'escapeMs', 'maxHdist', 'rePlans', 'targetRange', 'safeRange',
                  'triggerWaitMs', 'fuseBudgetMs',
                  'baselineStare', 'baselineDeg', 'rejected', 'pitchDeg',
                  'endermanMoved', 'endermanStillPresent', 'notAngry', 'guardInstalled',
                  'swings', 'minSwings', 'enoughSwings', 'cleared', 'died',
                  'minGapMs', 'medianGapMs', 'gapOk', 'weaponCooldownMs', 'gapFloorMs',
                  'timeToCoverMs', 'coverLosBroken', 'equipped', 'raised',
                  'plan', 'coverPos', 'distAtDecision']:
            if k in d:
                row[k] = d[k]
        row['fuseDetector'] = (d.get('fuseDetector') or {}).get('verdict')
        # melee 基线 / 无目标诊断
        row['baseline'] = d.get('baseline')
        row['noTargetDiag'] = d.get('noTargetDiag')
        rows.append(row)
    return rows


def summarize(rows):
    n = len(rows)
    passed = sum(1 for r in rows if r['verdict'] == 'PASS')
    why = Counter(r['why'] for r in rows if r['verdict'] != 'PASS')
    return {
        'total': n,
        'pass': passed,
        'fail': n - passed,
        'passPct': round(100.0 * passed / n, 1) if n else 0.0,
        'failByWhy': dict(why),
    }


def print_table(rows, scen):
    if scen == 'gaze':
        hdr = f"{'trial':>5} {'verdict':>6} {'base':>5} {'baseDeg':>8} {'rej':>4} {'pitch':>7} {'moved':>6} {'still':>5} {'notAngry':>8} {'why':>24}"
        print(hdr)
        for r in rows:
            bd = r.get('baselineDeg')
            print(f"{r['trial']:>5} {str(r['verdict']):>6} {str(r.get('baselineStare','')):>5} "
                  f"{('%.2f'%bd) if bd is not None else '':>8} {str(r.get('rejected','')):>4} "
                  f"{str(r.get('pitchDeg','')):>7} {str(r.get('endermanMoved','')):>6} "
                  f"{str(r.get('endermanStillPresent','')):>5} {str(r.get('notAngry','')):>8} {str(r.get('why') or '-'):>24}")
    elif scen == 'melee':
        hdr = f"{'trial':>5} {'verdict':>6} {'swings':>6} {'minGap':>7} {'medGap':>7} {'cleared':>7} {'died':>5} {'hp':>6} {'why':>22}"
        print(hdr)
        for r in rows:
            print(f"{r['trial']:>5} {str(r['verdict']):>6} {str(r.get('swings','')):>6} "
                  f"{str(r.get('minGapMs','')):>7} {str(r.get('medianGapMs','')):>7} "
                  f"{str(r.get('cleared','')):>7} {str(r.get('died','')):>5} "
                  f"{str(round(r['hpAfter'],1) if isinstance(r.get('hpAfter'),(int,float)) else r.get('hpAfter','')):>6} {str(r.get('why') or '-'):>22}")
    elif scen == 'skeleton':
        hdr = f"{'trial':>5} {'verdict':>6} {'phase':>7} {'coverLOS':>8} {'ttCover':>8} {'eq':>4} {'raised':>6} {'hpB':>4} {'hpA':>4} {'dmg':>4} {'why':>28}"
        print(hdr)
        for r in rows:
            ph = (r.get('plan') or {}).get('phase') if isinstance(r.get('plan'), dict) else r.get('plan')
            print(f"{r['trial']:>5} {str(r['verdict']):>6} {str(ph):>7} {str(r.get('coverLosBroken','')):>8} "
                  f"{str(r.get('timeToCoverMs','')):>8} {str(r.get('equipped','')):>4} {str(r.get('raised','')):>6} "
                  f"{str(r.get('hpBefore','')):>4} {str(r.get('hpAfter','')):>4} {str(r.get('damageTaken','')):>4} {str(r.get('why') or '-'):>28}")


def main():
    if len(sys.argv) < 2:
        print('用法: extract_farm03_micro.py <runs/STAMP 目录> <scenario>')
        sys.exit(2)
    stamp_dir = sys.argv[1]
    scen = sys.argv[2] if len(sys.argv) > 2 else os.path.basename(stamp_dir.rstrip('/')).lower()
    rows = load(stamp_dir)
    s = summarize(rows)
    print(f"=== MICRO {scen} n={s['total']} ===")
    print(f"总样本 {s['total']}  PASS {s['pass']}  FAIL {s['fail']}  通过率 {s['passPct']}%")
    if s['failByWhy']:
        print('失败构成:', json.dumps(s['failByWhy'], ensure_ascii=False))
    print()
    print_table(rows, scen)
    out = os.path.join(stamp_dir, 'micro_detail.json')
    json.dump({'scenario': scen, 'summary': s, 'rows': rows}, open(out, 'w', encoding='utf-8'), ensure_ascii=False, indent=2)
    print()
    print('明细已写:', out)


if __name__ == '__main__':
    main()
