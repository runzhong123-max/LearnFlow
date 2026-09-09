import unittest
from analyze import analyze, paired_deltas, summary, validate_rows


def row(case, cluster, variant, score):
    return dict(case_id=case, family_id=cluster, variant=variant, budget=1800, metrics={'coverage': score})


class AnalysisTests(unittest.TestCase):
    def test_empty_or_unmeasured_is_not_a_perfect_score(self):
        observed = summary([row('a', 'f', 'full', None)], ['variant'])[0]['metrics']['coverage']
        self.assertIsNone(observed['mean'])
        self.assertEqual(observed['denominator'], 0)
        self.assertEqual(observed['not_applicable_or_unmeasured'], 1)

    def test_clusters_not_repeated_questions_define_bootstrap(self):
        rows = []
        for i in range(100):
            rows += [row(str(i), 'large', 'full', 1), row(str(i), 'large', 'no_memory', 0)]
        rows += [row('last', 'small', 'full', 0), row('last', 'small', 'no_memory', 1)]
        result = paired_deltas(rows, 'family_id', repetitions=100)[0]
        self.assertEqual(result['clusters'], 2)
        self.assertEqual(result['paired_cases'], 101)
        self.assertEqual(result['cluster_equal_weight_delta'], 0)
        self.assertAlmostEqual(result['case_weighted_delta'], 99/101)

    def test_unmatched_and_null_pairs_reported(self):
        rows = [row('a', 'f', 'full', 1), row('a', 'f', 'no_memory', None), row('b', 'f', 'full', 1)]
        result = paired_deltas(rows, 'family_id', repetitions=100)[0]
        self.assertEqual(result['paired_cases'], 0)
        self.assertEqual(result['unmatched_full_cases'], 1)
        self.assertEqual(result['unmeasured_pairs'], 1)
        self.assertIsNone(result['cluster_equal_weight_delta'])

    def test_duplicate_conditions_are_not_new_samples(self):
        item = row('a', 'f', 'full', 1)
        with self.assertRaises(ValueError):
            validate_rows([item, item], 'family_id')

    def test_cluster_identity_mismatch_rejected(self):
        with self.assertRaises(ValueError):
            paired_deltas([row('a', 'f', 'full', 1), row('a', 'g', 'facts_only', 0)], 'family_id')

    def test_nonfinite_scores_do_not_become_data(self):
        observed = summary([row('a', 'f', 'full', float('nan'))], ['variant'])[0]
        self.assertEqual(observed['metrics']['coverage']['denominator'], 0)

    def test_analysis_keeps_track_unit(self):
        result = analyze([row('a', 'f', 'full', 0)], 'education', bootstrap=100)
        self.assertEqual(result['cluster_unit'], 'family_id')
        self.assertEqual(result['cases'], 1)


if __name__ == '__main__':
    unittest.main()
