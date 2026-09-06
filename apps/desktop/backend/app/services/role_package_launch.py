import base64
import hashlib
import hmac
import json
import re
import time
from typing import Any


ROLE_PACKAGE_LAUNCH_PROTOCOL = "role-package-launch.v1"
_HEX_64 = re.compile(r"^[0-9a-f]{64}$")


class RolePackageLaunchError(ValueError):
    pass


def _decode_base64url(value: str) -> bytes:
    try:
        return base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))
    except Exception as error:
        raise RolePackageLaunchError("role_package_launch_invalid") from error


def verify_role_package_launch(token: str, secret: str, *, now: int | None = None) -> dict[str, Any]:
    if len(token) > 8_192 or token.count(".") != 1:
        raise RolePackageLaunchError("role_package_launch_invalid")
    secret_bytes = secret.strip().encode("utf-8")
    if len(secret_bytes) < 32:
        raise RolePackageLaunchError("role_package_launch_not_configured")
    body, supplied = token.split(".", 1)
    expected = hmac.new(secret_bytes, body.encode("ascii"), hashlib.sha256).digest()
    actual = _decode_base64url(supplied)
    if not hmac.compare_digest(expected, actual):
        raise RolePackageLaunchError("role_package_launch_invalid")
    try:
        payload = json.loads(_decode_base64url(body))
    except Exception as error:
        raise RolePackageLaunchError("role_package_launch_invalid") from error
    current = int(time.time()) if now is None else int(now)
    package_ref = payload.get("packageRef") if isinstance(payload, dict) else None
    valid = (
        isinstance(payload, dict)
        and payload.get("protocol") == ROLE_PACKAGE_LAUNCH_PROTOCOL
        and isinstance(payload.get("launchId"), str) and 0 < len(payload["launchId"]) <= 120
        and isinstance(payload.get("subject"), str) and 0 < len(payload["subject"]) <= 160
        and isinstance(payload.get("roleTitle"), str) and 0 < len(payload["roleTitle"]) <= 255
        and payload.get("source") in {"graph_hub", "role_atlas"}
        and isinstance(payload.get("issuedAt"), int)
        and isinstance(payload.get("expiresAt"), int)
        and payload["issuedAt"] <= current + 30
        and payload["expiresAt"] > current
        and payload["expiresAt"] - payload["issuedAt"] <= 900
        and isinstance(package_ref, dict)
        and all(isinstance(package_ref.get(key), str) and package_ref[key] for key in ("packageId", "packageVersion", "snapshotId", "rootHash"))
        and bool(_HEX_64.fullmatch(package_ref.get("rootHash", "")))
    )
    if not valid:
        raise RolePackageLaunchError("role_package_launch_invalid")
    return payload
