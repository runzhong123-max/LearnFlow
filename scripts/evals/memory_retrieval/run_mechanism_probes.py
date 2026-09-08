#!/usr/bin/env python3
"""Post-hoc diagnostic, separate from the frozen formal v2 experiment."""
import argparse
import json
from pathlib import Path
import run_expanded as runner

original=runner.make_fixture
async def fixture(path,seeds):
    data=await original(path,seeds)
    queries={'two_hop_dependency':'仪器联调','dense_edge_window':'密集依赖入口'}
    data['cases']=[{**c,'query':queries[c['family']],'cohort':'posthoc_edge_only_probe'}
                   for c in data['cases'] if c['family'] in queries]
    data['version']='posthoc-mechanism-probe.v1'
    return data

if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__)
    for name in ('repo','host','output'):p.add_argument('--'+name,type=Path,required=True)
    a=p.parse_args();a.full_only=True;a.pilot=False;a.trajectories=6;a.repetitions=2;a.budgets=[1800,2800,5600]
    runner.make_fixture=fixture;runner.run(a)
    path=a.output/'summary.json';s=json.loads(path.read_text())
    s['kind']='posthoc_mechanism_diagnostic_not_formal_v2'
    s['source_hashes'].update(mechanism_driver=runner.digest(__file__),mechanism_protocol=runner.digest(Path(__file__).with_name('MECHANISM_PROBES.md')))
    path.write_text(json.dumps(s,ensure_ascii=False,indent=2))
