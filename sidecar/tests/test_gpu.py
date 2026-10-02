"""The optional GPU pack: verified download, nothing half-written, and found by CTranslate2 once installed."""

from __future__ import annotations

import hashlib
import io
import os
import zipfile
from pathlib import Path

import pytest

from fundarritari_stt import gpu
from fundarritari_stt.server import Server
from fundarritari_stt.streaming import TranscriptionWorker

from .conftest import FakeEngine, RecordingSink

MEMBERS = ("nvidia/cublas/bin/cublas64_12.dll", "nvidia/cublas/bin/cublasLt64_12.dll")


def _wheel() -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr("nvidia/cublas/bin/cublas64_12.dll", b"cublas")
        z.writestr("nvidia/cublas/bin/cublasLt64_12.dll", b"cublasLt")
        z.writestr("nvidia/cublas/include/cublas.h", b"header nobody needs")
    return buf.getvalue()


def _pack(data: bytes, sha: str | None = None) -> gpu.Pack:
    return gpu.Pack(url="https://example.invalid/w.whl", sha256=sha or hashlib.sha256(data).hexdigest(), size=len(data), members=MEMBERS)


def _opener(data: bytes):
    return lambda url: io.BytesIO(data)


def test_installs_only_the_libraries_and_reports_progress(tmp_path: Path):
    data = _wheel()
    seen = []
    target = gpu.install(tmp_path / "gpu", pack=_pack(data), opener=_opener(data), on_progress=lambda p, d, t: seen.append(p))
    assert sorted(f.name for f in target.iterdir()) == ["cublas64_12.dll", "cublasLt64_12.dll"]
    assert (target / "cublas64_12.dll").read_bytes() == b"cublas"
    assert seen[-1] == 1.0
    # No download or staging debris next to it.
    assert sorted(p.name for p in tmp_path.iterdir()) == ["gpu"]


def test_refuses_a_file_that_does_not_match_the_pinned_hash(tmp_path: Path):
    data = _wheel()
    with pytest.raises(RuntimeError, match="fingrafar"):
        gpu.install(tmp_path / "gpu", pack=_pack(data, sha="0" * 64), opener=_opener(data))
    assert list(tmp_path.iterdir()) == []


def test_a_failed_download_keeps_a_working_earlier_pack(tmp_path: Path):
    data = _wheel()
    target = gpu.install(tmp_path / "gpu", pack=_pack(data), opener=_opener(data))

    def broken(url):
        raise OSError("network down")

    with pytest.raises(OSError):
        gpu.install(target, pack=_pack(data), opener=broken)
    assert (target / "cublasLt64_12.dll").read_bytes() == b"cublasLt"


def test_stops_a_download_that_is_larger_than_the_pack(tmp_path: Path):
    data = _wheel()
    small = gpu.Pack(url="https://example.invalid/w.whl", sha256=hashlib.sha256(data).hexdigest(), size=len(data) - 1, members=MEMBERS)
    with pytest.raises(RuntimeError, match="stærri"):
        gpu.install(tmp_path / "gpu", pack=small, opener=_opener(data))
    assert list(tmp_path.iterdir()) == []


def test_replaces_an_earlier_pack(tmp_path: Path):
    data = _wheel()
    target = tmp_path / "gpu"
    target.mkdir()
    (target / "stale.dll").write_bytes(b"old")
    gpu.install(target, pack=_pack(data), opener=_opener(data))
    assert sorted(f.name for f in target.iterdir()) == ["cublas64_12.dll", "cublasLt64_12.dll"]
    assert sorted(p.name for p in tmp_path.iterdir()) == ["gpu"]


def test_is_installed_needs_every_library(tmp_path: Path):
    assert not gpu.is_installed(tmp_path, platform="win32")
    (tmp_path / "cublas64_12.dll").write_bytes(b"x")
    assert not gpu.is_installed(tmp_path, platform="win32")
    (tmp_path / "cublasLt64_12.dll").write_bytes(b"x")
    assert gpu.is_installed(tmp_path, platform="win32")
    assert not gpu.is_installed(tmp_path, platform="darwin")


def test_the_pinned_pack_is_nvidias_cublas_over_https():
    pack = gpu.pack_for_platform("win32")
    assert pack is not None
    assert pack.url.startswith("https://files.pythonhosted.org/") and "nvidia_cublas_cu12" in pack.url
    assert len(pack.sha256) == 64
    assert gpu.pack_for_platform("darwin") is None


@pytest.mark.skipif(os.name != "nt", reason="the pack is Windows-only")
def test_activate_puts_the_pack_on_the_search_path(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("PATH", "C:\\Windows")
    assert not gpu.activate(tmp_path)
    assert str(tmp_path) not in os.environ["PATH"]
    for name in ("cublas64_12.dll", "cublasLt64_12.dll"):
        (tmp_path / name).write_bytes(b"x")
    assert gpu.activate(tmp_path)
    assert os.environ["PATH"].split(os.pathsep)[0] == str(tmp_path)


def test_hello_says_whether_the_pack_is_there(sink: RecordingSink, fake_engine: FakeEngine, tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("FUNDARRITARI_GPU_DIR", str(tmp_path))
    # The pack is Windows-only; pin it so the test says the same thing on the Linux and macOS runners.
    windows_pack = gpu.PACKS["win32"]
    monkeypatch.setattr(gpu, "pack_for_platform", lambda platform=None: windows_pack)
    worker = TranscriptionWorker(sink).start()
    try:
        srv = Server(io.StringIO(), sink, engine=fake_engine, worker=worker)  # type: ignore[arg-type]
        srv.handle({"type": "hello"})
        ready = sink.of_type("ready")[-1]
        assert "gpu_pack" in ready and ready["gpu_pack"] is False
        assert ready["gpu_pack_mb"] == 397
    finally:
        worker.stop()


def test_install_gpu_command_reports_done(sink: RecordingSink, fake_engine: FakeEngine, tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    data = _wheel()
    monkeypatch.setattr(gpu, "pack_for_platform", lambda platform=None: _pack(data))
    monkeypatch.setattr(gpu.urllib.request, "urlopen", lambda url, timeout=60: io.BytesIO(data))
    worker = TranscriptionWorker(sink).start()
    try:
        srv = Server(io.StringIO(), sink, engine=fake_engine, worker=worker)  # type: ignore[arg-type]
        srv.handle({"type": "install_gpu", "request_id": "g1", "target_dir": str(tmp_path / "gpu")})
        done = sink.wait_for(lambda e: e["type"] == "gpu_installed", timeout=10)
        assert done["request_id"] == "g1"
        assert (tmp_path / "gpu" / "cublas64_12.dll").is_file()
        assert any(e.get("state") == "installing-gpu" for e in sink.of_type("status"))
    finally:
        worker.stop()


def test_a_second_install_while_one_runs_is_refused(sink: RecordingSink, fake_engine: FakeEngine, tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    import threading

    release = threading.Event()

    def slow_install(target_dir, on_progress=None):
        release.wait(5)

    monkeypatch.setattr(gpu, "install", slow_install)
    worker = TranscriptionWorker(sink).start()
    try:
        srv = Server(io.StringIO(), sink, engine=fake_engine, worker=worker)  # type: ignore[arg-type]
        srv.handle({"type": "install_gpu", "request_id": "a", "target_dir": str(tmp_path / "gpu")})
        srv.handle({"type": "install_gpu", "request_id": "b", "target_dir": str(tmp_path / "gpu")})
        err = sink.wait_for(lambda e: e["type"] == "error" and e.get("request_id") == "b")
        assert "already running" in err["message"]
        release.set()
        sink.wait_for(lambda e: e["type"] == "gpu_installed" and e.get("request_id") == "a")
    finally:
        release.set()
        worker.stop()
