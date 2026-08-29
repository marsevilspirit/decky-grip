"""Safe backup primitive shared by GRIP's local position stores."""

from __future__ import annotations

import os
import stat
import tempfile
from pathlib import Path
from typing import Optional, Tuple


FileSignature = Tuple[int, int, int, int, int]


class ManagedFileTooLargeError(OSError):
    """Raised before a managed local file can be read past its budget."""


class ManagedFileChangedError(OSError):
    """Raised when a managed local file changes during a bounded read."""


def _file_signature(metadata: os.stat_result) -> FileSignature:
    return (
        metadata.st_dev,
        metadata.st_ino,
        metadata.st_size,
        metadata.st_mtime_ns,
        metadata.st_ctime_ns,
    )


def read_bounded_regular_file(
    path: Path,
    max_bytes: int,
    *,
    known_signature: Optional[FileSignature] = None,
) -> Tuple[Optional[bytes], FileSignature]:
    """Read one stable regular file without following or blocking on special files.

    ``None`` is returned instead of file bytes when ``known_signature`` still
    matches, allowing validated-cache callers to retain their fast path.
    """

    if type(max_bytes) is not int or max_bytes < 0:
        raise ValueError("max_bytes must be a non-negative integer")
    nofollow = getattr(os, "O_NOFOLLOW", None)
    nonblock = getattr(os, "O_NONBLOCK", None)
    if nofollow is None or nonblock is None:
        raise OSError("safe managed-file reads are unsupported on this platform")

    source_path = Path(path)
    descriptor = -1
    try:
        descriptor = os.open(
            str(source_path),
            os.O_RDONLY
            | nofollow
            | nonblock
            | getattr(os, "O_CLOEXEC", 0),
        )
        initial_metadata = os.fstat(descriptor)
        if not stat.S_ISREG(initial_metadata.st_mode):
            raise OSError("managed path is not a regular file")
        if initial_metadata.st_size < 0 or initial_metadata.st_size > max_bytes:
            raise ManagedFileTooLargeError("managed file exceeds its size limit")
        initial_signature = _file_signature(initial_metadata)

        if known_signature == initial_signature:
            payload: Optional[bytes] = None
        else:
            chunks = []
            total = 0
            while total <= max_bytes:
                chunk = os.read(
                    descriptor,
                    min(1024 * 1024, max_bytes + 1 - total),
                )
                if not chunk:
                    break
                chunks.append(chunk)
                total += len(chunk)
            if total > max_bytes:
                raise ManagedFileTooLargeError(
                    "managed file exceeds its size limit"
                )
            payload = b"".join(chunks)

        final_metadata = os.fstat(descriptor)
        final_signature = _file_signature(final_metadata)
        if (
            not stat.S_ISREG(final_metadata.st_mode)
            or final_signature != initial_signature
            or (payload is not None and len(payload) != final_metadata.st_size)
        ):
            raise ManagedFileChangedError("managed file changed while being read")

        try:
            path_metadata = os.stat(source_path, follow_symlinks=False)
        except FileNotFoundError as error:
            raise ManagedFileChangedError(
                "managed file changed while being read"
            ) from error
        if (
            not stat.S_ISREG(path_metadata.st_mode)
            or _file_signature(path_metadata) != final_signature
        ):
            raise ManagedFileChangedError("managed file changed while being read")
        return payload, final_signature
    finally:
        if descriptor >= 0:
            try:
                os.close(descriptor)
            except OSError:
                pass


def backup_corrupt_file(path: Path) -> Path:
    """Copy ``path`` to an exclusive same-directory backup and sync it."""

    source_path = Path(path)
    source_descriptor = -1
    backup_descriptor = -1
    backup_name = ""
    try:
        source_descriptor = os.open(
            str(source_path),
            os.O_RDONLY
            | getattr(os, "O_NOFOLLOW", 0)
            | getattr(os, "O_NONBLOCK", 0)
            | getattr(os, "O_CLOEXEC", 0),
        )
        metadata = os.fstat(source_descriptor)
        if not stat.S_ISREG(metadata.st_mode):
            raise OSError("position store is not a regular file")
        backup_descriptor, backup_name = tempfile.mkstemp(
            prefix=f"{source_path.name}.corrupt-",
            suffix=".bak",
            dir=str(source_path.parent),
        )
        os.fchmod(backup_descriptor, 0o600)
        while True:
            chunk = os.read(source_descriptor, 1024 * 1024)
            if not chunk:
                break
            view = memoryview(chunk)
            while view:
                written = os.write(backup_descriptor, view)
                if written <= 0:
                    raise OSError("could not write position store backup")
                view = view[written:]
        os.fsync(backup_descriptor)
    except Exception:
        if backup_name:
            try:
                os.unlink(backup_name)
            except OSError:
                pass
        raise
    finally:
        if source_descriptor >= 0:
            try:
                os.close(source_descriptor)
            except OSError:
                pass
        if backup_descriptor >= 0:
            try:
                os.close(backup_descriptor)
            except OSError:
                pass

    directory_descriptor = -1
    try:
        directory_descriptor = os.open(
            str(source_path.parent),
            os.O_RDONLY | getattr(os, "O_DIRECTORY", 0),
        )
        os.fsync(directory_descriptor)
    except Exception:
        try:
            os.unlink(backup_name)
        except OSError:
            pass
        raise
    finally:
        if directory_descriptor >= 0:
            try:
                os.close(directory_descriptor)
            except OSError:
                pass
    return Path(backup_name)
