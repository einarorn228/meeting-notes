"""Compute-type selection must follow the hardware, not a guess.

A tester's PC reported a CUDA device but rejected float16 with "Requested float16 compute type, but the
target device or backend do not support efficient float16 computation", leaving the app unable to load any
model. These tests pin the two defences: never pick an unsupported type, and fall back if a load still fails.
"""

from __future__ import annotations

import pytest

from fundarritari_stt import engine

CPU_ONLY = {"float32", "int16", "int8", "int8_float32"}


@pytest.fixture
def cpu_support(monkeypatch):
    monkeypatch.setattr(engine, "supported_compute_types", lambda device: CPU_ONLY)


def test_auto_never_picks_an_unsupported_type(cpu_support):
    assert engine.resolve_compute_type("auto", "cpu") == "int8"
    # Even when the device claims to be CUDA, float16 is only chosen if it is actually supported.
    assert engine.resolve_compute_type("auto", "cuda") != "float16"


def test_explicit_float16_falls_back_when_unsupported(cpu_support):
    assert engine.resolve_compute_type("float16", "cpu") in CPU_ONLY


def test_explicit_type_is_honoured_when_supported(monkeypatch):
    monkeypatch.setattr(engine, "supported_compute_types", lambda device: CPU_ONLY | {"float16"})
    assert engine.resolve_compute_type("float16", "cuda") == "float16"


def test_unknown_compute_type_is_rejected():
    with pytest.raises(ValueError):
        engine.resolve_compute_type("bfloat16", "cpu")


def test_candidates_always_end_up_at_cpu_int8(cpu_support):
    for device, compute in (("cuda", "float16"), ("cpu", "int8"), ("cuda", "int8")):
        candidates = engine._load_candidates(device, compute)
        assert candidates[0] == (device, compute)
        assert ("cpu", "int8") in candidates
        assert len(candidates) == len(set(candidates)), "candidates must not repeat"


class _Info:
    language = "is"


def _fake_model_class(attempted: list, fail_construct=(), broken_devices=()):
    """A stand-in for WhisperModel that can fail at construction, or at inference on whole devices.

    A missing CUDA library breaks every compute type on that device, not just one - that is what
    ``broken_devices`` models.
    """

    class FakeModel:
        def __init__(self, path, *, device, compute_type, cpu_threads, local_files_only):
            attempted.append((device, compute_type))
            self.device = device
            self.compute_type = compute_type
            if (device, compute_type) in fail_construct:
                raise ValueError(
                    "Requested float16 compute type, but the target device or backend do not support "
                    "efficient float16 computation."
                )

        def transcribe(self, audio, **kwargs):
            if self.device in broken_devices:
                raise RuntimeError("Library cublas64_12.dll is not found or cannot be loaded")
            return iter(()), _Info()

    return FakeModel


def test_load_falls_back_to_a_working_combination(monkeypatch, tmp_path):
    """The first combination raising must not fail the load; the next working one wins."""
    import faster_whisper

    attempted: list[tuple[str, str]] = []
    monkeypatch.setattr(faster_whisper, "WhisperModel", _fake_model_class(attempted, fail_construct={("cuda", "float16")}))
    monkeypatch.setattr(engine, "supported_compute_types", lambda device: CPU_ONLY | {"float16"})
    monkeypatch.setattr(engine, "cuda_available", lambda: True)

    info = engine.WhisperEngine().load(str(tmp_path), model_id="m", device="auto", compute_type="auto")

    assert attempted[0] == ("cuda", "float16"), "the preferred combination is still tried first"
    assert info.compute_type != "float16"
    assert (info.device, info.compute_type) == attempted[-1]


def test_load_rejects_a_backend_that_only_fails_at_compute_time(monkeypatch, tmp_path):
    """The cublas64_12.dll case: the model constructs on CUDA and dies on the first real segment.

    Without an inference at load time this passed validation and every segment of the meeting then failed.
    """
    import faster_whisper

    attempted: list[tuple[str, str]] = []
    monkeypatch.setattr(faster_whisper, "WhisperModel", _fake_model_class(attempted, broken_devices={"cuda"}))
    monkeypatch.setattr(engine, "supported_compute_types", lambda device: CPU_ONLY | {"float16"})
    monkeypatch.setattr(engine, "cuda_available", lambda: True)

    info = engine.WhisperEngine().load(str(tmp_path), model_id="m", device="auto", compute_type="auto")

    assert ("cuda", "float16") in attempted, "CUDA is still attempted first"
    assert info.device == "cpu", "a GPU that cannot actually compute must not be kept"


def test_runtime_failure_falls_back_to_cpu_instead_of_losing_the_meeting(monkeypatch, tmp_path):
    """A backend that breaks only after a clean load must cost one segment, not every remaining one."""
    import faster_whisper
    import numpy as np

    attempted: list = []
    FakeModel = _fake_model_class(attempted)
    probe_samples = engine.SAMPLE_RATE // 2

    class BreaksAfterProbe(FakeModel):
        """Passes the load-time probe, then fails on real audio - the worst case for the user."""

        def transcribe(self, audio, **kwargs):
            if self.device == "cuda" and audio.size > probe_samples:
                raise RuntimeError("Library cublas64_12.dll is not found or cannot be loaded")
            return iter(()), _Info()

    monkeypatch.setattr(faster_whisper, "WhisperModel", BreaksAfterProbe)
    monkeypatch.setattr(engine, "supported_compute_types", lambda device: CPU_ONLY | {"float16"})
    monkeypatch.setattr(engine, "cuda_available", lambda: True)

    eng = engine.WhisperEngine()
    eng.load(str(tmp_path), model_id="m", device="auto", compute_type="auto")
    assert eng.device == "cuda", "the probe passed, so CUDA is in use"

    result = eng.transcribe(np.zeros(engine.SAMPLE_RATE, dtype=np.float32), language="is", initial_prompt=None)

    assert result.text == ""
    assert eng.device == "cpu", "the engine reloaded on CPU rather than failing the segment"


def test_load_raises_with_every_failure_listed(monkeypatch, tmp_path):
    import faster_whisper

    class AlwaysFails:
        def __init__(self, *a, **k):
            raise RuntimeError("no backend")

    monkeypatch.setattr(faster_whisper, "WhisperModel", AlwaysFails)
    monkeypatch.setattr(engine, "supported_compute_types", lambda device: CPU_ONLY)

    with pytest.raises(RuntimeError, match="no backend"):
        engine.WhisperEngine().load(str(tmp_path), model_id="m", device="cpu", compute_type="auto")
