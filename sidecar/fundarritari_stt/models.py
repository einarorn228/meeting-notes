"""Local model catalogue helpers: listing installed models and downloading them from Hugging Face."""

from __future__ import annotations

import fnmatch
import logging
import os
import threading
import time
from pathlib import Path
from typing import Callable, Dict, List, Optional

from .events import EventSink

log = logging.getLogger("fundarritari_stt.models")

# Mirrors LOCAL_MODELS in src/shared/types.ts (used as a fallback when the HF API is unreachable).
CATALOGUE: Dict[str, Dict[str, object]] = {
    "aalto-large-v3-is": {
        "repo": "Aalto-Speech-Synthesis/whisper-large-v3-Icelandic-finetuned-ct2",
        "size_mb": 3100,
        "punctuated": False,
    },
    "lvl-large-is": {
        "repo": "language-and-voice-lab/whisper-large-icelandic-62640-steps-967h-ct2",
        "size_mb": 3100,
        "punctuated": False,
    },
    "large-v3-turbo": {"repo": "deepdml/faster-whisper-large-v3-turbo-ct2", "size_mb": 1600, "punctuated": True},
    "large-v3": {"repo": "Systran/faster-whisper-large-v3", "size_mb": 3100, "punctuated": True},
}

# Files that are not needed by CTranslate2 (some repos ship the original PyTorch weights too).
IGNORE_PATTERNS: List[str] = ["*.pt", "*.pth", "*.safetensors", "*.h5", "*.msgpack", "*.ot", "*.onnx", "*.gguf"]

MODEL_FILE = "model.bin"
_download_lock = threading.Lock()


def is_punctuated(model_id: Optional[str], default: bool = True) -> bool:
    """Whether the model writes punctuation/casing itself (unknown models are assumed to)."""
    entry = CATALOGUE.get(model_id or "")
    return bool(entry["punctuated"]) if entry else default


def model_dir(models_dir: str | Path, model_id: str) -> Path:
    if not model_id or "/" in model_id or "\\" in model_id or model_id in (".", ".."):
        raise ValueError(f"invalid model_id {model_id!r}")
    return Path(models_dir).expanduser() / model_id


def is_installed(path: str | Path) -> bool:
    return (Path(path) / MODEL_FILE).is_file()


def list_installed(models_dir: str | Path) -> List[str]:
    """Model ids = sub-directories (symlinks allowed) that contain ``model.bin``."""
    root = Path(models_dir).expanduser()
    if not root.is_dir():
        return []
    return sorted(child.name for child in root.iterdir() if child.is_dir() and is_installed(child))


def dir_size_bytes(path: str | Path) -> int:
    """Total size of all files below ``path``, including huggingface_hub's ``.incomplete`` blobs."""
    total = 0
    for dirpath, _dirnames, filenames in os.walk(path, followlinks=True):
        for name in filenames:
            try:
                total += os.stat(os.path.join(dirpath, name)).st_size
            except OSError:
                pass
    return total


def _ignored(filename: str) -> bool:
    return any(fnmatch.fnmatch(filename, pattern) for pattern in IGNORE_PATTERNS)


def expected_size_bytes(repo: str, model_id: Optional[str] = None, timeout: float = 15.0) -> Optional[int]:
    """Expected download size from the HF API, else the catalogue's ``sizeMb``, else ``None``."""
    try:
        from huggingface_hub import HfApi

        info = HfApi().model_info(repo, files_metadata=True, timeout=timeout)
        sizes = [s.size for s in (info.siblings or []) if s.size and not _ignored(s.rfilename)]
        if sizes:
            return int(sum(sizes))
    except Exception as exc:  # noqa: BLE001 - offline or rate limited: fall back to the catalogue
        log.warning("could not query size of %s: %s", repo, exc)
    entry = CATALOGUE.get(model_id or "")
    if entry:
        return int(entry["size_mb"]) * 1_000_000
    return None


def download_model(
    model_id: str,
    repo: str,
    models_dir: str | Path,
    emit: EventSink,
    *,
    poll_interval: float = 0.5,
    snapshot_fn: Optional[Callable[..., object]] = None,
) -> Path:
    """Download ``repo`` into ``<models_dir>/<model_id>`` emitting ``progress`` and ``status`` events.

    Progress is estimated by polling the directory size against the expected total. Returns the
    model directory; raises on failure. Idempotent: an installed model returns immediately.
    """
    target = model_dir(models_dir, model_id)
    with _download_lock:
        if is_installed(target):
            return target
        target.mkdir(parents=True, exist_ok=True)
        total = expected_size_bytes(repo, model_id)
        total_mb = round(total / 1e6, 1) if total else None
        log.info("downloading %s (%s) to %s, expected %s MB", model_id, repo, target, total_mb)

        if snapshot_fn is None:
            from huggingface_hub import snapshot_download

            snapshot_fn = snapshot_download
        outcome: Dict[str, object] = {}

        def run() -> None:
            try:
                snapshot_fn(repo_id=repo, local_dir=str(target), ignore_patterns=IGNORE_PATTERNS, max_workers=4)
            except BaseException as exc:  # noqa: BLE001 - reported on the caller's thread
                outcome["error"] = exc

        thread = threading.Thread(target=run, name=f"download-{model_id}", daemon=True)
        thread.start()

        def report(progress: float, downloaded: int) -> None:
            emit.emit(
                "progress",
                model_id=model_id,
                progress=round(progress, 4),
                downloaded_mb=round(downloaded / 1e6, 1),
                total_mb=total_mb,
            )
            emit.emit(
                "status",
                state="downloading-model",
                message=f"Downloading {model_id}",
                progress=round(progress, 4),
                model_id=model_id,
            )

        last_progress = -1.0
        last_report = 0.0
        report(0.0, 0)
        while thread.is_alive():
            thread.join(poll_interval)
            downloaded = dir_size_bytes(target)
            progress = min(downloaded / total, 0.99) if total else 0.0
            now = time.monotonic()
            if progress - last_progress >= 0.005 or now - last_report >= 5.0:
                last_progress, last_report = progress, now
                report(progress, downloaded)

        error = outcome.get("error")
        if error is not None:
            raise RuntimeError(f"download of {repo} failed: {error}") from error  # type: ignore[arg-type]
        if not is_installed(target):
            raise RuntimeError(f"download of {repo} finished but {MODEL_FILE} is missing in {target}")
        report(1.0, dir_size_bytes(target))
        log.info("download of %s complete", model_id)
        return target
