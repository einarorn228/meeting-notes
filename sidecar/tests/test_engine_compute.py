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


def test_load_falls_back_to_a_working_combination(monkeypatch, tmp_path):
    """The first combination raising must not fail the load; the next working one wins."""
    import faster_whisper

    attempted: list[tuple[str, str]] = []

    class FakeModel:
        def __init__(self, path, *, device, compute_type, cpu_threads, local_files_only):
            attempted.append((device, compute_type))
            if compute_type == "float16":
                raise ValueError("Requested float16 compute type, but the target device or backend do not support efficient float16 computation.")

    monkeypatch.setattr(faster_whisper, "WhisperModel", FakeModel)
    monkeypatch.setattr(engine, "supported_compute_types", lambda device: CPU_ONLY | {"float16"})
    monkeypatch.setattr(engine, "cuda_available", lambda: True)

    info = engine.WhisperEngine().load(str(tmp_path), model_id="m", device="auto", compute_type="auto")

    assert attempted[0] == ("cuda", "float16"), "the preferred combination is still tried first"
    assert info.compute_type != "float16"
    assert (info.device, info.compute_type) == attempted[-1]


def test_load_raises_with_every_failure_listed(monkeypatch, tmp_path):
    import faster_whisper

    class AlwaysFails:
        def __init__(self, *a, **k):
            raise RuntimeError("no backend")

    monkeypatch.setattr(faster_whisper, "WhisperModel", AlwaysFails)
    monkeypatch.setattr(engine, "supported_compute_types", lambda device: CPU_ONLY)

    with pytest.raises(RuntimeError, match="no backend"):
        engine.WhisperEngine().load(str(tmp_path), model_id="m", device="cpu", compute_type="auto")
