#!/usr/bin/env python3
"""FARM-03 交付汇总构建器。

FARM-03 只跑 G 线微基准（gaze n=30 / melee n=3 / skeleton n=3），无主干回归。
把三组运行产物整理成交付用的 json：
  micro_gaze_summary.json     ← gaze（阈值 15°）
  micro_melee_summary.json    ← melee（NoAI 固定靶）
  micro_skeleton_summary.json ← skeleton（柱体 201..203 + 27 射线掩体）
写到 <DEST>（默认 cloud 目录）。

判据一行不改：verdict 直接取 result.json.verdict。
"""
import json, os, sys

CLOUD = os.path.dirname(os.path.abspath(__file__))
DEST = sys.argv[1] if len(sys.argv) > 1 else CLOUD
os.makedirs(DEST, exist_ok=True)


def micro_block(stamp, scenario, label, code_info):
    sd = os.path.join(CLOUD, 'runs', stamp)
    msum = json.load(open(os.path.join(sd, 'micro_summary.json'), encoding='utf-8'))
    detp = os.path.join(sd, 'micro_detail.json')
    det = json.load(open(detp, encoding='utf-8')) if os.path.exists(detp) else {'rows': []}
    out = {
        'ticket': 'FARM-03',
        'scenario': scenario,
        'label': label,
        'stamp': stamp,
        'n': msum['totalTrials'],
        'pass': msum['pass'],
        'fail': msum['fail'],
        'passPct': msum['passPct'],
        'failByWhy': msum['failByWhy'],
        'peakCombinedMb': msum['peakCombinedMb'],
        'code': code_info,
        'judgement': 'scenarios.mjs.gates/measure + micro_defense.mjs（未改一行）；verdict 直接取 result.json',
        'rows': msum['rows'],
        'detail': det['rows'],
    }
    json.dump(out, open(os.path.join(DEST, f'micro_{scenario}_summary.json'), 'w', encoding='utf-8'),
              ensure_ascii=False, indent=2)
    print(f'写了 micro_{scenario}_summary.json:', out['pass'], '/', out['n'], out['failByWhy'])
    return out


CODE = {
    'bundle': 'code-20261003-1336.tar.gz',
    'sha256': '7564a81ea7853f633b2ccf4477b6650fe66ec282e919cfdf8ff88b1d1f193ed9',
    'aidqq/s0-survival': 'ecaa5d0',
    'bench': 'f5663f9',
}

for stamp, scen, label in [
    ('MIC_GAZE_F03', 'gaze', '末影人 · 凝视守卫拦截（阈值 15°）'),
    ('MIC_MELEE_F03', 'melee', '僵尸近战 · MeleeTick 冷却门与击杀（NoAI 固定靶）'),
    ('MIC_SKELETON_F03', 'skeleton', '骷髅 · 掩体断视线与举盾推进（柱体 201..203）'),
]:
    if os.path.exists(os.path.join(CLOUD, 'runs', stamp, 'micro_summary.json')):
        micro_block(stamp, scen, label, CODE)
    else:
        print(f'!! {stamp} 尚无 micro_summary.json，跳过')

print('DONE →', DEST)
