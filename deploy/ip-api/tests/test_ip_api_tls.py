import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

MODULE = Path(__file__).resolve().parents[1] / "ip_api_tls.py"
spec = importlib.util.spec_from_file_location("ip_api_tls", MODULE)
tls = importlib.util.module_from_spec(spec)
spec.loader.exec_module(tls)


class CertificateLifecycle(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.parent = Path(self.directory.name)
        self.root = self.parent / "installation"
        self.original = self.parent / "Caddyfile"
        self.original.write_bytes(b"# existing domain\nlearn.example {\n respond 200\n}\n")
        tls.initialize(self.root, self.original, MODULE.parent)
        self.config = tls.settings(self.root)

    def enable_fixture(self):
        (self.root / "caddy/enabled/20-https.caddy").write_text("test enabled config")

    def test_bootstrap_preserves_domain_bytes_and_does_not_enable_absent_certificate(self):
        self.assertIn(self.original.read_bytes(), (self.root / "caddy/Caddyfile").read_bytes())
        self.assertEqual(self.original.read_bytes(), (self.root / "caddy/Caddyfile.original").read_bytes())
        self.assertTrue((self.root / "caddy/Caddyfile").read_text().startswith("{\n    default_sni 8.148.28.98\n}"))
        self.assertTrue((self.root / "caddy/enabled/10-http.caddy").exists())
        self.assertFalse((self.root / "caddy/enabled/20-https.caddy").exists())
        with self.assertRaises(ValueError):
            tls.initialize(self.root, self.original, MODULE.parent)

    def test_existing_global_options_are_not_silently_overwritten(self):
        original = self.parent / "custom"
        original.write_text("# user config\n{\n admin off\n}\nexample.com { respond 200 }")
        with self.assertRaises(ValueError):
            tls.initialize(self.parent / "other", original, MODULE.parent)
        self.assertFalse((self.parent / "other").exists())

    def test_wrong_mount_scope_stops_all_certificate_operations(self):
        with patch.object(tls, "execute", return_value="[]") as runner:
            with self.assertRaises(ValueError):
                tls.issue(self.root, self.config, "admin@example.test")
        self.assertEqual(runner.call_count, 1)

    def test_issue_uses_shortlived_webroot_production_by_default(self):
        with patch.object(tls, "assert_mounts"), patch.object(tls, "certbot") as run:
            tls.issue(self.root, self.config, "admin@example.test")
        args = run.call_args.args[2]
        for option in ("certonly", "--webroot", "--ip-address", "shortlived", tls.PRODUCTION):
            self.assertIn(option, args)
        self.assertNotIn("--standalone", args)
        self.assertEqual(args[args.index("--ip-address") + 1], tls.IP)
        self.assertFalse(run.call_args.kwargs["staging"])

    def test_staging_uses_separate_certificate_store_and_same_challenge_root(self):
        calls = []
        def run(args, **_):
            calls.append(args)
            return "certbot 5.4.0" if "--version" in args else ""
        with patch.object(tls, "execute", side_effect=run):
            tls.certbot(self.root, self.config, ["certonly"], staging=True)
        mounts = " ".join(calls[-1])
        self.assertIn(str(self.root / "staging/letsencrypt"), mounts)
        self.assertIn(str(self.root / "webroot"), mounts)
        self.assertNotIn("docker.sock", mounts)
        self.assertNotIn("--network=host", mounts)
        self.assertIn("--pull=never", calls[-1])

    def test_old_certbot_fails_before_issuance(self):
        with patch.object(tls, "execute", return_value="certbot 5.3.0") as runner:
            with self.assertRaises(ValueError):
                tls.certbot(self.root, self.config, ["certonly"])
        self.assertEqual(runner.call_count, 1)

    def test_only_official_pinned_image_is_accepted(self):
        path = self.root / "installation.json"
        value = json.loads(path.read_text())
        value["certbot_image"] = "someone/certbot:latest"
        path.write_text(json.dumps(value))
        with self.assertRaises(ValueError):
            tls.settings(self.root)

    def test_invalid_production_certificate_never_enables_https(self):
        with patch.object(tls, "assert_mounts"), patch.object(tls, "certificate_hash", side_effect=RuntimeError("bad certificate")), patch.object(tls, "reload_caddy") as reload:
            with self.assertRaises(RuntimeError):
                tls.enable_https(self.root, self.config)
        self.assertFalse((self.root / "caddy/enabled/20-https.caddy").exists())
        reload.assert_not_called()

    def test_failed_first_enable_restores_bootstrap_and_can_retry(self):
        with patch.object(tls, "assert_mounts"), patch.object(tls, "certificate_hash", return_value="new"), patch.object(tls, "reload_caddy", side_effect=[RuntimeError("validate failed"), None]):
            with self.assertRaises(RuntimeError):
                tls.enable_https(self.root, self.config)
            self.assertFalse((self.root / "caddy/enabled/20-https.caddy").exists())
            self.assertFalse((self.root / "loaded-certificate.json").exists())
            tls.enable_https(self.root, self.config)
        self.assertEqual(json.loads((self.root / "loaded-certificate.json").read_text()), {"sha256": "new"})

    def test_failed_reload_is_retried_even_when_certbot_does_not_issue_again(self):
        self.enable_fixture()
        marker = self.root / "loaded-certificate.json"
        marker.write_text('{"sha256":"old"}')
        with patch.object(tls, "assert_mounts"), patch.object(tls, "certbot"), patch.object(tls, "certificate_hash", return_value="new"), patch.object(tls, "reload_caddy", side_effect=[RuntimeError("reload failed"), None]) as reload:
            with self.assertRaises(RuntimeError):
                tls.renew(self.root, self.config)
            self.assertEqual(json.loads(marker.read_text())["sha256"], "old")
            tls.renew(self.root, self.config)
            tls.renew(self.root, self.config)
        self.assertEqual(reload.call_count, 2)
        self.assertEqual(json.loads(marker.read_text())["sha256"], "new")

    def test_dry_run_uses_staging_and_never_loads_a_test_certificate(self):
        self.enable_fixture()
        with patch.object(tls, "assert_mounts"), patch.object(tls, "certbot") as run, patch.object(tls, "certificate_hash") as cert, patch.object(tls, "reload_caddy") as reload:
            tls.renew(self.root, self.config, dry_run=True)
        args = run.call_args.args[2]
        self.assertIn(tls.STAGING, args)
        self.assertIn("--dry-run", args)
        self.assertNotIn(tls.PRODUCTION, args)
        cert.assert_not_called()
        reload.assert_not_called()

    def test_reload_validates_before_forcing_static_certificate_refresh(self):
        with patch.object(tls, "execute", return_value="") as runner:
            tls.reload_caddy(self.config)
        self.assertIn("validate", runner.call_args_list[0].args[0])
        self.assertIn("reload", runner.call_args_list[1].args[0])
        self.assertIn("--force", runner.call_args_list[1].args[0])
        self.assertFalse(any("restart" in call.args[0] or "stop" in call.args[0] for call in runner.call_args_list))


if __name__ == "__main__":
    unittest.main()
