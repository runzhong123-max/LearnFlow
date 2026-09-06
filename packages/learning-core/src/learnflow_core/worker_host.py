"""Separate memory worker hosting without a second API or learner authority."""
from __future__ import annotations
import asyncio
from contextlib import contextmanager
import os
from pathlib import Path
import signal

@contextmanager
def worker_lease(path: str):
    # One worker per shared data volume; separate hosts must not run duplicate
    # recovery passes. The OS releases this lock even after a killed process.
    import fcntl
    lock = Path(path)
    lock.parent.mkdir(parents=True, exist_ok=True)
    with lock.open("a+") as handle:
        try:
            fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as exc:
            raise RuntimeError("A memory worker already owns this data volume") from exc
        try:
            yield
        finally:
            fcntl.flock(handle.fileno(), fcntl.LOCK_UN)

async def run_worker():
    from app.core.config import settings
    from app.db.database import init_db, engine
    from app.services.memory_worker import memory_worker_loop
    if settings.memory_worker_embedded:
        raise RuntimeError("Standalone worker requires MEMORY_WORKER_EMBEDDED=false")
    if not settings.memory_auto_synthesis_enabled:
        raise RuntimeError("Standalone worker requires MEMORY_AUTO_SYNTHESIS_ENABLED=true")
    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    for signum in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(signum, stop.set)
    try:
        await init_db()
        await memory_worker_loop(stop)
    finally:
        for signum in (signal.SIGINT, signal.SIGTERM):
            loop.remove_signal_handler(signum)
        await engine.dispose()

def main():
    with worker_lease(os.environ.get("LEARNFLOW_WORKER_LOCK", "runtime/memory-worker.lock")):
        asyncio.run(run_worker())
