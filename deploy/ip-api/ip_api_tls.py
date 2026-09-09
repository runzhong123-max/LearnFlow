#!/usr/bin/env python3
"""Explicit IP certificate bootstrap/renewal; never invokes Compose or stops a service."""
from __future__ import annotations

import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess

IP = "8.148.28.98"
CERT_NAME = "learnflow-ip-" + IP
PRODUCTION = "https://acme-v02.api.letsencrypt.org/directory"
STAGING = "https://acme-staging-v02.api.letsencrypt.org/directory"
IMAGE = "certbot/certbot:v5.4.0"


def execute(args: list[str], *, input: str | None = None) -> str:
    result = subprocess.run(args, input=input, text=True, capture_output=True, timeout=780)
    if result.returncode:
        # Details stay in Certbot's protected log directory, never print keys,
        # arbitrary upstream bodies or the full Docker environment.
        raise RuntimeError(f"{args[0]} operation failed (exit {result.returncode})")
    return result.stdout.strip()


def atomic_text(path: Path, content: str):
    temporary = path.with_name(path.name + ".pending")
    with temporary.open("x") as stream:
        stream.write(content)
    temporary.chmod(0o600)
    temporary.replace(path)


def initialize(root: Path, original: Path, templates: Path):
    if root.exists():
        raise ValueError("A new empty installation directory is required; preserve existing state")
    original_bytes = original.read_bytes()
    if b"/etc/learnflow/ip-api/" in original_bytes:
        raise ValueError("The supplied Caddyfile already imports this installation")
    significant = [line.strip() for line in original_bytes.decode().splitlines() if line.strip() and not line.lstrip().startswith("#")]
    if significant and significant[0].startswith("{"):
        raise ValueError("Existing global options require an explicit default_sni merge; do not overwrite them")
    root.mkdir(mode=0o700, parents=True)
    for relative in ("caddy/enabled", "caddy/available", "webroot", "letsencrypt", "work", "logs", "bin"):
        (root / relative).mkdir(mode=0o700, parents=True, exist_ok=True)
    (root / "caddy/Caddyfile.original").write_bytes(original_bytes)
    # IP clients normally omit SNI. Domain clients keep selecting their normal
    # certificates; only no-SNI connections use the explicit IP certificate.
    (root / "caddy/Caddyfile").write_bytes(b"{\n    default_sni 8.148.28.98\n}\n\n" + original_bytes + b"\n# LearnFlow IP API; existing domain configuration above is unchanged.\nimport /etc/learnflow/ip-api/enabled/*.caddy\n")
    shutil.copyfile(templates / "http.caddy", root / "caddy/enabled/10-http.caddy")
    shutil.copyfile(templates / "https.caddy", root / "caddy/available/20-https.caddy")
    shutil.copyfile(Path(__file__), root / "bin/ip_api_tls.py")
    atomic_text(root / "installation.json", json.dumps({"ip": IP, "original_sha256": hashlib.sha256(original_bytes).hexdigest(),
                "caddy_container": "cohost-caddy-1", "certbot_image": IMAGE}, indent=2))


def settings(root: Path) -> dict:
    value = json.loads((root / "installation.json").read_text())
    if value.get("ip") != IP or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,127}", value.get("caddy_container", "")):
        raise ValueError("Unexpected IP or Caddy container")
    # Operators may pin an official Certbot image digest after verifying it.
    if not re.fullmatch(r"certbot/certbot(?::v?\d+\.\d+\.\d+|@sha256:[a-f0-9]{64})", value.get("certbot_image", "")):
        raise ValueError("Use a pinned official certbot/certbot version or digest")
    return value


def assert_mounts(root: Path, config: dict):
    mounts = json.loads(execute(["docker", "inspect", "--format", "{{json .Mounts}}", config["caddy_container"]]))
    expected = {"/etc/caddy/Caddyfile": root / "caddy/Caddyfile", "/etc/learnflow/ip-api": root / "caddy",
                "/var/www/learnflow-ip-acme": root / "webroot", "/etc/learnflow/ip-certificates": root / "letsencrypt"}
    for destination, source in expected.items():
        if not any(item.get("Destination") == destination and item.get("Source") == str(source) and not item.get("RW") for item in mounts):
            raise ValueError("Caddy does not use the expected read-only IP certificate installation")


def certbot(root: Path, config: dict, arguments: list[str], *, staging: bool = False):
    image = config["certbot_image"]
    version = execute(["docker", "run", "--rm", "--pull=never", "--network=none", image, "--version"])
    match = re.search(r"certbot (\d+)\.(\d+)\.(\d+)", version)
    if not match or tuple(map(int, match.groups())) < (5, 4, 0):
        raise ValueError("Certbot >= 5.4.0 is required for IP webroot validation")
    state = root / "staging" if staging else root
    for relative in ("letsencrypt", "work", "logs"):
        (state / relative).mkdir(mode=0o700, parents=True, exist_ok=True)
    args = ["docker", "run", "--rm", "--pull=never", "--cap-drop=ALL", "--security-opt=no-new-privileges"]
    for source, destination in ((state / "letsencrypt", "/etc/letsencrypt"), (state / "work", "/var/lib/letsencrypt"),
                                (state / "logs", "/var/log/letsencrypt"), (root / "webroot", "/var/www/acme")):
        args.extend(["--mount", f"type=bind,source={source},target={destination}"])
    execute([*args, image, *arguments])


def issue(root: Path, config: dict, email: str, *, staging: bool = False):
    assert_mounts(root, config)
    if not re.fullmatch(r"[^\s@]+@[^\s@]+\.[^\s@]+", email):
        raise ValueError("A contact email is required for this explicit certificate request")
    certbot(root, config, ["certonly", "--non-interactive", "--agree-tos", "--email", email,
            "--server", STAGING if staging else PRODUCTION, "--preferred-profile", "shortlived",
            "--preferred-challenges", "http", "--webroot", "--webroot-path", "/var/www/acme",
            "--ip-address", IP, "--cert-name", CERT_NAME, "--keep-until-expiring"], staging=staging)


def certificate_hash(root: Path) -> str:
    live = root / "letsencrypt/live" / CERT_NAME
    # Verify IP SAN, public trust, key match, and a non-expired leaf before
    # enabling/reloading. Do not trust a staging or private CA by accident.
    execute(["openssl", "x509", "-in", str(live / "cert.pem"), "-noout", "-checkip", IP])
    execute(["openssl", "x509", "-in", str(live / "cert.pem"), "-noout", "-checkend", "3600"])
    execute(["openssl", "verify", "-purpose", "sslserver", "-verify_ip", IP,
             "-untrusted", str(live / "chain.pem"), str(live / "cert.pem")])
    cert_public = execute(["openssl", "x509", "-in", str(live / "cert.pem"), "-pubkey", "-noout"])
    key_public = execute(["openssl", "pkey", "-in", str(live / "privkey.pem"), "-pubout"])
    if cert_public != key_public:
        raise ValueError("Certificate and private key do not match")
    return hashlib.sha256((live / "fullchain.pem").read_bytes()).hexdigest()


def reload_caddy(config: dict):
    common = ["docker", "exec", config["caddy_container"], "caddy"]
    execute([*common, "validate", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"])
    # Static certificate paths do not alter JSON; force reload rereads the cert.
    execute([*common, "reload", "--force", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"])


def enable_https(root: Path, config: dict):
    assert_mounts(root, config)
    fingerprint = certificate_hash(root)
    enabled = root / "caddy/enabled/20-https.caddy"
    newly_enabled = not enabled.exists()
    if newly_enabled:
        atomic_text(enabled, (root / "caddy/available/20-https.caddy").read_text())
    try:
        reload_caddy(config)
    except Exception:
        # Restore the bootstrap file set if this first enable failed. The
        # candidate remains in available/; a later server start stays viable.
        if newly_enabled:
            enabled.unlink()
        raise
    atomic_text(root / "loaded-certificate.json", json.dumps({"sha256": fingerprint}))


def renew(root: Path, config: dict, *, dry_run: bool = False):
    assert_mounts(root, config)
    if not (root / "caddy/enabled/20-https.caddy").is_file():
        raise ValueError("Enable the production HTTPS site before activating renewal")
    args = ["renew", "--non-interactive", "--cert-name", CERT_NAME, "--server", STAGING if dry_run else PRODUCTION,
            "--preferred-profile", "shortlived", "--webroot", "--webroot-path", "/var/www/acme",
            "--no-directory-hooks"]
    if dry_run:
        args.append("--dry-run")
    certbot(root, config, args)
    if dry_run:
        return
    fingerprint = certificate_hash(root)
    loaded = root / "loaded-certificate.json"
    previous = json.loads(loaded.read_text()).get("sha256") if loaded.exists() else None
    if previous != fingerprint:
        reload_caddy(config)
        # Persist only after success: a failed reload is retried on the next
        # timer even when Certbot has nothing more to renew that day.
        atomic_text(loaded, json.dumps({"sha256": fingerprint}))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["initialize", "issue", "enable-https", "renew"])
    parser.add_argument("--root", type=Path, default=Path("/opt/ceg/ip-api"))
    parser.add_argument("--original-caddyfile", type=Path)
    parser.add_argument("--email")
    parser.add_argument("--staging", action="store_true")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    os.umask(0o077)
    root = args.root.resolve()
    if args.staging and args.action != "issue" or args.dry_run and args.action != "renew":
        parser.error("staging is only for issue; dry-run is only for renew")
    if args.action == "initialize":
        if not args.original_caddyfile:
            parser.error("initialize requires the current active --original-caddyfile")
        initialize(root, args.original_caddyfile, Path(__file__).parent)
    else:
        config = settings(root)
        with (root / "certificate.lock").open("a") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            if args.action == "issue":
                issue(root, config, args.email or "", staging=args.staging)
            elif args.action == "enable-https":
                enable_https(root, config)
            else:
                renew(root, config, dry_run=args.dry_run)
    print(json.dumps({"action": args.action, "completed": True, "ip": IP, "staging": args.staging, "dry_run": args.dry_run}))


if __name__ == "__main__":
    main()
