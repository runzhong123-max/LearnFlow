"""Compare frozen baseline and paired upgraded hosts without changing scoring."""
import argparse
import csv
import json
from pathlib import Path


def read(path, name):
    return json.loads((path / name).read_text())


def rows(path):
    return [json.loads(line) for line in (path / 'queries.jsonl').read_text().splitlines()]


def compare(baseline, web, desktop, output):
    summaries = [read(path, 'summary.json') for path in (baseline, web, desktop)]
    assert len({s['fixture_sha256'] for s in summaries}) == 1, 'Fixture/gold drift'
    wr, dr = rows(web), rows(desktop)
    def indexed(records):
        return {(r['case_id'], r['variant'], r['budget']):
                {k: v for k, v in r.items() if k != 'latency_ms'} for r in records}
    assert indexed(wr) == indexed(dr), 'Host content or score divergence'
    assert read(web, 'packets-audit.json') == read(desktop, 'packets-audit.json'), 'Audit packet divergence'
    for summary, records in zip(summaries[1:], (wr, dr)):
        assert not summary['network_attempts']
        assert all(not r['violations'] and r['budget_ok'] and r['repeat_stable'] for r in records)
    # Cached and rebuilt heads must yield the same scored/visible evidence.
    for records in (wr, dr):
        keyed = {(r['case_id'], r['variant'], r['budget']): r for r in records}
        for row in records:
            if row['variant'] == 'full':
                other = keyed[row['case_id'], 'no_head_cache', row['budget']]
                for field in ('selected_ids', 'observed_units', 'historical_units', 'tokens_estimate', 'path_count'):
                    assert row[field] == other[field], ('cache divergence', row['case_id'], field)
    output.mkdir(parents=True, exist_ok=True)
    audit = dict(fixture_sha256=summaries[1]['fixture_sha256'], paired_conditions=len(wr),
                 host_differences=0, safety_violations=0, budget_failures=0,
                 unstable_queries=0, cache_differences=0, network_attempts=0)
    (output / 'audit.json').write_text(json.dumps(audit, indent=2))
    comparison = []
    for label, summary in zip(('baseline_web', 'upgraded_web', 'upgraded_desktop'), summaries):
        comparison.extend(dict(run=label, **r) for r in summary['summary'] if r['variant'] == 'full')
    with (output / 'comparison.csv').open('w', newline='') as stream:
        writer = csv.DictWriter(stream, fieldnames=list(comparison[0]))
        writer.writeheader()
        writer.writerows(comparison)
    print(json.dumps(audit, indent=2))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    for flag in ('baseline', 'web', 'desktop', 'output'):
        parser.add_argument('--' + flag, required=True, type=Path)
    args = parser.parse_args()
    compare(args.baseline, args.web, args.desktop, args.output)
