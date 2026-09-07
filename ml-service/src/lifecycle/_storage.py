"""
Phase 3J — Atomic JSON storage & cross-process lock (stdlib only).

Provides:
- atomic_write_json: temp-file + os.replace (atomic on POSIX)
- append_jsonl: append-only audit log
- FileLock: cross-process lock via os.O_CREAT | os.O_EXCL

No external dependencies (filelock/portalocker not available). Matches the
existing JSON/JSONL persistence convention used across the service.

Design rules
------------
1. Writes are atomic — a crash mid-write never leaves a partial file
   (spec §72 crash-safety).
2. The lock is cross-process safe via O_EXCL. Stale locks are detected by age.
3. No np.random.* — deterministic.
"""

from __future__ import annotations

import json
import os
import time
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator


def atomic_write_json(path: str | Path, data: Any) -> None:
    """
    Atomically write `data` as JSON to `path`.

    Writes to a temp file in the same directory, fsyncs, then os.replace()s
    onto the target. os.replace is atomic on POSIX, so a crash never leaves a
    partially-written target file.
    """
    p = Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix(p.suffix + f".tmp.{os.getpid()}")
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, default=str, sort_keys=True)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, p)   # atomic


def read_json(path: str | Path) -> Any:
    """Read JSON from path. Returns None if the file does not exist."""
    p = Path(path)
    if not p.exists():
        return None
    with open(p, encoding="utf-8") as f:
        return json.load(f)


def append_jsonl(path: str | Path, record: dict) -> None:
    """
    Append one record to a JSONL audit log.

    Append mode with a single write + flush + fsync is atomic for small records
    on POSIX (single write() syscall for line-sized payloads).
    """
    p = Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    line = json.dumps(record, default=str, sort_keys=True) + "\n"
    with open(p, "a", encoding="utf-8") as f:
        f.write(line)
        f.flush()
        os.fsync(f.fileno())


def read_jsonl(path: str | Path) -> list[dict]:
    """Read all records from a JSONL file. Returns [] if missing."""
    p = Path(path)
    if not p.exists():
        return []
    out = []
    for line in p.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line:
            try:
                out.append(json.loads(line))
            except json.JSONDecodeError:
                continue
    return out


class LockAcquisitionError(RuntimeError):
    """Raised when a cross-process lock cannot be acquired."""


@contextmanager
def FileLock(
    lock_path: str | Path,
    timeout: float = 10.0,
    poll_interval: float = 0.05,
    stale_after: float = 60.0,
) -> Iterator[None]:
    """
    Cross-process advisory lock using os.O_CREAT | os.O_EXCL.

    Creating a file with O_EXCL is atomic — only one process can succeed.
    The lock is released by deleting the file.

    Stale-lock recovery: if the lock file is older than `stale_after` seconds,
    it is considered abandoned (crashed holder) and forcibly removed. This
    prevents a crash during promotion from permanently blocking the registry
    (spec §72).

    Raises LockAcquisitionError on timeout.
    """
    lp = Path(lock_path)
    lp.parent.mkdir(parents=True, exist_ok=True)
    deadline = time.monotonic() + timeout
    fd = None

    while True:
        try:
            fd = os.open(str(lp), os.O_CREAT | os.O_EXCL | os.O_WRONLY)
            os.write(fd, f"{os.getpid()}:{time.time()}".encode())
            break
        except FileExistsError:
            # Check for stale lock
            try:
                age = time.time() - lp.stat().st_mtime
                if age > stale_after:
                    # Abandoned lock — remove and retry
                    lp.unlink(missing_ok=True)
                    continue
            except FileNotFoundError:
                continue   # released between checks; retry immediately

            if time.monotonic() >= deadline:
                raise LockAcquisitionError(
                    f"Could not acquire lock {lp} within {timeout}s "
                    "(another process holds the registry lock)."
                )
            time.sleep(poll_interval)

    try:
        yield
    finally:
        if fd is not None:
            os.close(fd)
        lp.unlink(missing_ok=True)
