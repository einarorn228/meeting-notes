"""The optional GPU pack: NVIDIA's cuBLAS libraries, fetched on request instead of shipped with every install.

CTranslate2 already carries everything else it needs for CUDA, and the NVIDIA driver brings the rest. What a
normal Windows machine lacks is ``cublas64_12.dll``/``cublasLt64_12.dll``: without them a model on ``cuda``
loads, then fails its first inference, and the engine falls back to the CPU. Measured on an RTX 4050 laptop
with the Icelandic large-v3 model, the GPU runs at about 4x realtime against 1.35x for 8 CPU threads, so a
machine that has the card gains a lot from 400 MB. cuDNN is not needed: Whisper ran with cuBLAS alone.

The wheel is NVIDIA's own from PyPI, pinned by URL and SHA-256, so a changed or substituted file is refused
rather than loaded into the process.
"""

from __future__ import annotations

import hashlib
import logging
import os
import shutil
import sys
import tempfile
import time
import urllib.request
import zipfile
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Optional

log = logging.getLogger("fundarritari_stt.gpu")


@dataclass(frozen=True)
class Pack:
    url: str
    sha256: str
    size: int
    # Paths inside the wheel, extracted flat into the pack directory.
    members: tuple


# cuBLAS 12.4 (CUDA 12.4): what CTranslate2 4.x is built against, and old enough to run on any driver that
# supports CUDA 12 at all.
PACKS = {
    "win32": Pack(
        url="https://files.pythonhosted.org/packages/e2/2a/4f27ca96232e8b5269074a72e03b4e0d43aa68c9b965058b1684d07c6ff8/nvidia_cublas_cu12-12.4.5.8-py3-none-win_amd64.whl",
        sha256="5a796786da89203a0657eda402bcdcec6180254a8ac22d72213abc42069522dc",
        size=396895858,
        members=("nvidia/cublas/bin/cublas64_12.dll", "nvidia/cublas/bin/cublasLt64_12.dll"),
    ),
}


def pack_for_platform(platform: str = sys.platform) -> Optional[Pack]:
    return PACKS.get(platform)


def is_installed(target_dir: str | Path, platform: str = sys.platform) -> bool:
    pack = pack_for_platform(platform)
    if pack is None:
        return False
    target = Path(target_dir)
    return all((target / Path(m).name).is_file() for m in pack.members)


def activate(target_dir: str | Path) -> bool:
    """Make the pack's libraries findable by CTranslate2. Safe to call when the pack is absent."""
    target = Path(target_dir)
    if not is_installed(target):
        return False
    path = str(target)
    if path not in os.environ.get("PATH", "").split(os.pathsep):
        os.environ["PATH"] = path + os.pathsep + os.environ.get("PATH", "")
    add = getattr(os, "add_dll_directory", None)
    if add is not None:
        try:
            add(path)
        except OSError as exc:  # the PATH entry above still works
            log.warning("add_dll_directory(%s) failed: %s", path, exc)
    return True


Opener = Callable[[str], "urllib.response.addinfourl"]


def install(
    target_dir: str | Path,
    *,
    on_progress: Optional[Callable[[float, int, int], None]] = None,
    pack: Optional[Pack] = None,
    opener: Optional[Opener] = None,
) -> Path:
    """Download the pack, verify it and unpack only its libraries into ``target_dir``.

    Nothing is left half-written: the download goes to a temporary file, the libraries are unpacked into a
    staging directory, and only a verified, complete set replaces what was there.
    """
    pack = pack or pack_for_platform()
    if pack is None:
        raise RuntimeError(f"Skjákortsstuðningur er ekki í boði á {sys.platform}.")
    target = Path(target_dir)
    target.parent.mkdir(parents=True, exist_ok=True)
    # Private to this call and on the same volume as the target, so the final step is a rename.
    work = Path(tempfile.mkdtemp(prefix=target.name + ".", dir=target.parent))
    part = work / "pack.whl"
    staging = work / "staging"
    open_url = opener or (lambda url: urllib.request.urlopen(url, timeout=60))  # noqa: S310 - pinned https URL
    digest = hashlib.sha256()
    done = 0
    last = 0.0
    try:
        with open_url(pack.url) as response, open(part, "wb") as out:
            while True:
                block = response.read(1 << 20)
                if not block:
                    break
                done += len(block)
                if done > pack.size:
                    raise RuntimeError("Skjákortsskráin var stærri en hún á að vera; henni var hent.")
                out.write(block)
                digest.update(block)
                now = time.monotonic()
                if on_progress is not None and (now - last >= 0.5 or done == pack.size):
                    last = now
                    on_progress(min(done / pack.size, 0.99), done, pack.size)
        if done != pack.size or digest.hexdigest() != pack.sha256:
            raise RuntimeError("Skjákortsskráin passaði ekki við væntanlegt fingrafar; henni var hent.")
        staging.mkdir(parents=True)
        with zipfile.ZipFile(part) as wheel:
            for member in pack.members:
                with wheel.open(member) as src, open(staging / Path(member).name, "wb") as dst:
                    shutil.copyfileobj(src, dst, 1 << 20)
        # Swap by renames, never by deleting in place: a locked DLL makes the first rename fail loudly with the
        # old pack untouched, instead of leaving a half-deleted pack behind.
        old = work / "old"
        if target.exists():
            target.rename(old)
        try:
            staging.rename(target)
        except OSError:
            if old.exists():
                old.rename(target)
            raise
    finally:
        shutil.rmtree(work, ignore_errors=True)
    if on_progress is not None:
        on_progress(1.0, done, pack.size)
    log.info("GPU pack installed in %s", target)
    return target
