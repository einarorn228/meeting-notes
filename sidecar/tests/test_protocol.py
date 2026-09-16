"""Protocol parsing and dispatch with a fake engine (no model, no network)."""

from __future__ import annotations

import io
import json
import re
from pathlib import Path

import numpy as np
import pytest

from fundarritari_stt import models
from fundarritari_stt.audio import encode_pcm_base64
from fundarritari_stt.events import EventWriter
from fundarritari_stt.server import Server
from fundarritari_stt.streaming import TranscriptionWorker

from .conftest import SR, FakeEngine, RecordingSink, silence, speech


@pytest.fixture
def server(sink: RecordingSink, fake_engine: FakeEngine, monkeypatch: pytest.MonkeyPatch):
    worker = TranscriptionWorker(sink).start()
    srv = Server(io.StringIO(), sink, engine=fake_engine, worker=worker)  # type: ignore[arg-type]
    yield srv
    worker.stop()


def test_event_writer_writes_one_json_line_per_event():
    out = io.StringIO()
    writer = EventWriter(out)
    writer.emit("segment", text="íslenska", start=np.float32(1.5), partial=False)
    writer.emit("stopped", session_id="a")
    lines = out.getvalue().splitlines()
    assert [json.loads(l)["type"] for l in lines] == ["segment", "stopped"]
    assert json.loads(lines[0]) == {"type": "segment", "text": "íslenska", "start": 1.5, "partial": False}


def test_hello_and_bad_input_never_crash(server: Server, sink: RecordingSink):
    server.handle_line('{"type": "hello"}')
    server.handle_line("this is not json")
    server.handle_line("[1, 2, 3]")
    server.handle_line("")
    server.handle_line('{"type": "no_such_command"}')
    server.handle_line('{"type": 42}')
    server.handle_line('{"type": "stop"}')  # missing session_id
    server.handle_line('{"type": "pause", "session_id": "nope"}')
    server.handle_line('{"type": "list_models"}')
    types = [e["type"] for e in sink.events]
    assert types[0] == "ready"
    ready = sink.events[0]
    assert set(ready) >= {"version", "cuda", "python", "faster_whisper"}
    errors = sink.of_type("error")
    assert len(errors) == 7
    assert all(e["fatal"] is False for e in errors)
    assert "invalid JSON" in errors[0]["message"]
    assert "requires field 'session_id'" in errors[4]["message"]
    assert "unknown session" in errors[5]["message"]
    assert "requires field 'models_dir'" in errors[6]["message"]


def test_list_models_only_dirs_with_model_bin(server: Server, sink: RecordingSink, tmp_path: Path):
    (tmp_path / "good").mkdir()
    (tmp_path / "good" / "model.bin").write_bytes(b"x")
    (tmp_path / "half").mkdir()
    (tmp_path / "stray.txt").write_text("nope")
    linked = tmp_path / "elsewhere" / "aalto"
    linked.mkdir(parents=True)
    (linked / "model.bin").write_bytes(b"x")
    (tmp_path / "aalto-large-v3-is").symlink_to(linked, target_is_directory=True)
    server.handle({"type": "list_models", "models_dir": str(tmp_path)})
    assert sink.of_type("models")[-1]["installed"] == ["aalto-large-v3-is", "good"]
    server.handle({"type": "list_models", "models_dir": str(tmp_path / "missing")})
    assert sink.of_type("models")[-1]["installed"] == []


def test_stream_session_flow(server: Server, sink: RecordingSink, fake_engine: FakeEngine):
    server.handle({"type": "start", "session_id": "m1", "language": "is", "channels": ["mic", "system"],
                   "vocabulary": ["Chunk"], "partials": False, "punctuated": False})
    server.handle({"type": "start", "session_id": "m1"})  # duplicate
    assert "already running" in sink.of_type("error")[-1]["message"]
    audio = np.concatenate([silence(0.5), speech(2.0), silence(1.0)])
    chunk = int(0.1 * SR)
    for offset in range(0, len(audio), chunk):
        server.handle({"type": "audio", "session_id": "m1", "channel": "mic", "t_ms": offset * 1000 // SR,
                       "pcm": encode_pcm_base64(audio[offset : offset + chunk])})
    server.handle({"type": "audio", "session_id": "m1", "channel": "mic", "t_ms": 4000})  # missing pcm
    server.handle({"type": "pause", "session_id": "m1", "paused": True})
    server.handle({"type": "audio", "session_id": "m1", "channel": "mic", "t_ms": 4000, "pcm": encode_pcm_base64(speech(3.0))})
    server.handle({"type": "pause", "session_id": "m1", "paused": False})
    server.handle({"type": "stop", "session_id": "m1"})
    stopped = sink.wait_for(lambda e: e["type"] == "stopped", timeout=10)
    assert stopped["session_id"] == "m1"
    segments = sink.of_type("segment")
    assert len(segments) == 1
    seg = segments[0]
    assert seg["session_id"] == "m1" and seg["channel"] == "mic" and seg["partial"] is False
    assert 0.2 <= seg["start"] < seg["end"] <= 3.6
    # vocabulary casing on the fake engine's "chunk 2.4s", plus the full stop a model that writes none gets
    assert re.fullmatch(r"Chunk 2\.[2-6]s\.", seg["text"])
    assert "avg_logprob" in seg and "no_speech_prob" in seg
    assert sink.events.index(seg) < sink.events.index(stopped)
    assert fake_engine.calls[0]["initial_prompt"] == "fundur nöfn og hugtök chunk"
    # After stop the session is gone.
    server.handle({"type": "stop", "session_id": "m1"})
    assert "unknown session" in sink.of_type("error")[-1]["message"]
    # Audio for an unknown session is reported once, then ignored quietly.
    for _ in range(3):
        server.handle({"type": "audio", "session_id": "ghost", "channel": "mic", "t_ms": 0, "pcm": "AAAA"})
    assert sum("ghost" in e["message"] for e in sink.of_type("error")) == 1


def test_load_model_flow_with_fake_download(server: Server, sink: RecordingSink, tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    loads = []

    def fake_load(path, *, model_id, device, compute_type, threads, on_attempt=None):
        loads.append((path, model_id, device, compute_type, threads))
        if on_attempt is not None:
            on_attempt("cpu", "int8")
        return FakeEngine.load(server.engine, path, model_id=model_id)

    def fake_download(model_id, repo, models_dir, emit):
        target = models.model_dir(models_dir, model_id)
        target.mkdir(parents=True)
        (target / "model.bin").write_bytes(b"x")
        emit.emit("progress", model_id=model_id, progress=1.0, downloaded_mb=1, total_mb=1)
        return target

    monkeypatch.setattr(server.engine, "load", fake_load)
    server._download = fake_download
    server.handle({"type": "load_model", "model_id": "aalto-large-v3-is", "repo": "x/y", "models_dir": str(tmp_path),
                   "device": "cpu", "compute_type": "auto", "threads": 2})
    sink.wait_for(lambda e: e["type"] == "model_loaded", timeout=5)
    types = [e["type"] for e in sink.events]
    assert types.index("progress") < types.index("model_downloaded") < types.index("model_loaded")
    assert any(e["type"] == "status" and e["state"] == "loading-model" for e in sink.events)
    # Which backend is being tried has to reach the app: loading a 3 GB model is slow enough that a message
    # which never changes reads as a freeze.
    assert any(
        e["type"] == "status" and e["state"] == "loading-model" and e.get("compute_type") == "int8"
        for e in sink.events
    ), "the attempted backend must be reported while loading"
    assert sink.of_type("status")[-1]["state"] == "ready"
    assert loads == [(str(tmp_path / "aalto-large-v3-is"), "aalto-large-v3-is", "cpu", "auto", 2)]
    assert sink.of_type("model_loaded")[0]["compute_type"] == "int8"
    server.handle({"type": "load_model", "model_id": "../evil", "repo": "x/y", "models_dir": str(tmp_path)})
    assert "invalid model_id" in sink.of_type("error")[-1]["message"]


def test_download_model_failure_is_reported(server: Server, sink: RecordingSink, tmp_path: Path):
    def failing(model_id, repo, models_dir, emit):
        raise RuntimeError("network down")

    server._download = failing
    server.handle({"type": "download_model", "model_id": "large-v3", "repo": "Systran/faster-whisper-large-v3", "models_dir": str(tmp_path)})
    err = sink.wait_for(lambda e: e["type"] == "error", timeout=5)
    assert "network down" in err["message"]
    assert sink.of_type("status")[-1]["state"] == "error"


def test_transcribe_file_flow(server: Server, sink: RecordingSink, tmp_path: Path):
    import soundfile as sf

    left = np.concatenate([silence(0.5), speech(2.0), silence(3.0)])
    right = np.concatenate([silence(3.0), speech(1.5, seed=3), silence(1.0)])
    path = tmp_path / "meeting.wav"
    stereo = np.repeat(np.stack([left, right], axis=1), 2, axis=0)  # naive 2x upsample
    sf.write(str(path), stereo, 32000)  # 32 kHz stereo: exercises resampling
    server.handle({"type": "transcribe_file", "request_id": "r1", "path": str(path), "language": "is",
                   "vocabulary": [], "channels_map": {"0": "mic", "1": "system"}})
    done = sink.wait_for(lambda e: e["type"] == "file_done", timeout=10)
    assert done["request_id"] == "r1" and done["duration"] == pytest.approx(5.5, abs=0.01)
    segments = sink.of_type("segment")
    assert [(s["channel"], s["request_id"]) for s in segments] == [("mic", "r1"), ("system", "r1")]
    assert segments[0]["start"] == pytest.approx(0.3, abs=0.2) and segments[0]["end"] == pytest.approx(2.7, abs=0.2)
    assert segments[1]["start"] == pytest.approx(2.8, abs=0.2) and segments[1]["end"] == pytest.approx(4.7, abs=0.2)
    # Mono mixdown without channels_map; missing file is an error, not a crash.
    server.handle({"type": "transcribe_file", "request_id": "r2", "path": str(path)})
    sink.wait_for(lambda e: e["type"] == "file_done" and e["request_id"] == "r2", timeout=10)
    assert {s["channel"] for s in sink.of_type("segment") if s["request_id"] == "r2"} == {"mic"}
    server.handle({"type": "transcribe_file", "request_id": "r3", "path": str(tmp_path / "missing.wav")})
    assert sink.of_type("error")[-1]["request_id"] == "r3"


def test_run_loop_handles_shutdown_and_eof(sink: RecordingSink, fake_engine: FakeEngine):
    stdin = io.StringIO('{"type": "hello"}\n\n{"type": "shutdown"}\n{"type": "hello"}\n')
    assert Server(stdin, sink, engine=fake_engine).run() == 0  # type: ignore[arg-type]
    assert [e["type"] for e in sink.events] == ["status", "ready"]
    sink2 = RecordingSink()
    assert Server(io.StringIO('{"type": "hello"}\n'), sink2, engine=fake_engine).run() == 0  # type: ignore[arg-type]
    assert [e["type"] for e in sink2.events] == ["status", "ready"]
