"""Pinned source identity from the previously published corpus, never regenerated gold."""
import hashlib
import json

EDUCATION_MANIFEST_SHA256 = "57f01d56473fcb683a1d2d9adaaaf04760fdd81a9db3c5e157fd5168f6f80873"


def verify_education_source(dataset):
    manifest_path = dataset / "data/manifest.json"
    actual = hashlib.sha256(manifest_path.read_bytes()).hexdigest()
    if actual != EDUCATION_MANIFEST_SHA256:
        raise ValueError("Education source manifest differs from the frozen v1 corpus")
    manifest = json.loads(manifest_path.read_text())
    for name, expected in manifest["files"].items():
        if hashlib.sha256((dataset / name).read_bytes()).hexdigest() != expected:
            raise ValueError("Frozen education source differs: " + name)
    return manifest
