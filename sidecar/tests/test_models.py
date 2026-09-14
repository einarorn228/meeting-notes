from pathlib import Path

from fundarritari_stt import models

from .conftest import RecordingSink


def test_catalogue_flags():
    assert models.is_punctuated("aalto-large-v3-is") is False
    assert models.is_punctuated("large-v3") is True
    assert models.is_punctuated("unknown") is True
    assert models.is_punctuated(None) is True


def test_download_polls_progress_with_fake_snapshot(tmp_path: Path, monkeypatch):
    monkeypatch.setattr(models, "expected_size_bytes", lambda repo, model_id=None, timeout=15.0: 4_000_000)

    def fake_snapshot(repo_id, local_dir, ignore_patterns, max_workers):
        import time

        target = Path(local_dir)
        (target / "config.json").write_bytes(b"{}" * 1000)
        time.sleep(0.15)
        (target / "model.bin").write_bytes(b"\0" * 3_998_000)

    sink = RecordingSink()
    path = models.download_model("large-v3", "Systran/faster-whisper-large-v3", tmp_path, sink, poll_interval=0.05, snapshot_fn=fake_snapshot)
    assert path == tmp_path / "large-v3" and models.is_installed(path)
    progress = [e["progress"] for e in sink.of_type("progress")]
    assert progress[0] == 0.0 and progress[-1] == 1.0
    assert progress == sorted(progress)
    assert sink.of_type("progress")[-1]["total_mb"] == 4.0
    assert all(e["state"] == "downloading-model" for e in sink.of_type("status"))
    # Second call is a no-op.
    assert models.download_model("large-v3", "x", tmp_path, sink, snapshot_fn=None) == path


def test_download_failure_raises(tmp_path: Path, monkeypatch):
    monkeypatch.setattr(models, "expected_size_bytes", lambda repo, model_id=None, timeout=15.0: None)

    def failing(**kwargs):
        raise OSError("disk full")

    sink = RecordingSink()
    try:
        models.download_model("large-v3", "x/y", tmp_path, sink, poll_interval=0.05, snapshot_fn=failing)
    except RuntimeError as exc:
        assert "disk full" in str(exc)
    else:
        raise AssertionError("expected RuntimeError")
