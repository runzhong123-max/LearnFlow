"""Ensure corrupted answer labels and hidden input changes cannot pass an audit."""
from copy import deepcopy
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parent


class OracleCorruptionTests(unittest.TestCase):
    def test_each_checker_rejects_corrupted_labels_and_unseen_inputs(self):
        for name in ("foundations", "software", "operations"):
            data = json.loads((ROOT / "catalog" / f"{name}.json").read_text())
            for damage in ("wrong_gold", "false_negative", "hidden_input"):
                with self.subTest(catalog=name, corruption=damage):
                    changed = deepcopy(data)
                    probe = next(p for f in changed for p in f["probes"] if p["answer_validation"] == "executable")
                    if damage == "wrong_gold":
                        probe["correct_response"] = probe["incorrect_response"]
                    elif damage == "false_negative":
                        probe["incorrect_response"] = probe["correct_response"]
                    else:
                        probe["oracle_input"]["unseen_corruption_canary"] = 12345
                    with tempfile.TemporaryDirectory(prefix="learnflow-oracle-corruption-") as directory:
                        path = Path(directory) / f"{name}.json"
                        path.write_text(json.dumps(changed, ensure_ascii=False))
                        result = subprocess.run([sys.executable, str(ROOT / "checks" / f"{name}_check.py"), "--catalog", str(path)],
                                                capture_output=True, text=True, timeout=60)
                    self.assertNotEqual(result.returncode, 0, "corrupted data was accepted")
                    if name == "operations":
                        report = json.loads(result.stdout)
                        self.assertEqual(len(report["errors"]), 1)
                        self.assertEqual(report["errors"][0]["error_type"], "AssertionError")
                        self.assertEqual(report["errors"][0]["probe"], changed[0]["family_id"] + "/" + probe["id"])
                    else:
                        self.assertIn("AssertionError", result.stderr, "rejection must be a data assertion, not missing runtime/file")


if __name__ == "__main__":
    unittest.main()
