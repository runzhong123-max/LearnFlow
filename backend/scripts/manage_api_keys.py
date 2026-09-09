"""Explicit server-operator provisioning; never prints the credential to stdout."""
import argparse
import asyncio
import json
import os
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from sqlalchemy import select
from app.db.database import async_session
from app.models.learning import UserAccount
from app.services.api_keys import issue_api_key, metadata, revoke_api_key
from app.services.auth import normalize_username


async def run(args):
    # Deliberately does not run init_db/migrations or choose a default account.
    async with async_session() as db:
        account = (await db.execute(select(UserAccount).where(
            UserAccount.username_normalized == normalize_username(args.username),
        ))).scalar_one_or_none()
        if account is None:
            raise ValueError("The explicitly named account does not exist")
        if args.operation == "revoke":
            key = await revoke_api_key(db, account.id, args.id)
            await db.commit()
            return metadata(key)
        token, key = await issue_api_key(db, account, args.name, args.expires_in_days)
        output = Path(args.output)
        descriptor = os.open(output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        try:
            os.fchmod(descriptor, 0o600)
            with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
                json.dump({"api_key": token, "metadata": metadata(key)}, stream, default=str, ensure_ascii=False)
                stream.write("\n")
                stream.flush()
                os.fsync(stream.fileno())
            await db.commit()
        except BaseException:
            output.unlink(missing_ok=True)
            raise
        return metadata(key)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--username", required=True)
    actions = parser.add_subparsers(dest="operation", required=True)
    create = actions.add_parser("create")
    create.add_argument("--name", required=True)
    create.add_argument("--expires-in-days", type=int, default=30)
    create.add_argument("--output", required=True, help="New secret file, created exclusively with permissions 0600")
    revoke = actions.add_parser("revoke")
    revoke.add_argument("--id", required=True, type=int)
    args = parser.parse_args()
    try:
        result = asyncio.run(run(args))
    except Exception as error:
        # Never serialize request/SQL parameters or the key in a traceback.
        print(f"API key operation failed ({type(error).__name__}); no credential was printed.", file=sys.stderr)
        return 1
    print(json.dumps(result, default=str, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
