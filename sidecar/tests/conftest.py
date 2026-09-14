"""Shared fixtures: a fake engine, an event recorder and synthetic audio."""

from __future__ import annotations

import functools
import os
import threading
import time
from pathlib import Path
from typing import Any, Callable, List, Optional

import numpy as np
import pytest

from fundarritari_stt.engine import TranscriptionResult

SR = 16000
SCRATCH = Path(os.environ.get("FUNDARRITARI_SCRATCH", "/tmp/claude-0/-home-user-meeting-notes/1031bbf8-a539-5709-8da0-302467da0298/scratchpad"))


def pytest_addoption(parser: pytest.Parser) -> None:
    parser.addoption("--run-slow", action="store_true", default=False, help="run tests that load the real model")


def pytest_configure(config: pytest.Config) -> None:
    config.addinivalue_line("markers", "slow: loads the real Whisper model (minutes on CPU)")


def pytest_collection_modifyitems(config: pytest.Config, items: List[pytest.Item]) -> None:
    if config.getoption("--run-slow"):
        return
    skip = pytest.mark.skip(reason="needs --run-slow")
    for item in items:
        if "slow" in item.keywords:
            item.add_marker(skip)


class RecordingSink:
    """Collects emitted events (thread-safe) and lets tests wait for a given event type."""

    def __init__(self) -> None:
        self.events: List[dict] = []
        self._cond = threading.Condition()

    def emit(self, event_type: str, **fields: Any) -> None:
        with self._cond:
            self.events.append({"type": event_type, **fields})
            self._cond.notify_all()

    def of_type(self, event_type: str) -> List[dict]:
        with self._cond:
            return [e for e in self.events if e["type"] == event_type]

    def wait_for(self, predicate: Callable[[dict], bool], timeout: float = 10.0) -> dict:
        deadline = time.monotonic() + timeout
        with self._cond:
            while True:
                for event in self.events:
                    if predicate(event):
                        return event
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise AssertionError(f"timed out waiting for event; got {self.events}")
                self._cond.wait(remaining)


class FakeEngine:
    """Deterministic stand-in for WhisperEngine: text encodes the chunk length."""

    def __init__(self, text_fn: Optional[Callable[[np.ndarray], str]] = None, delay: float = 0.0) -> None:
        self.calls: List[dict] = []
        self.text_fn = text_fn or (lambda audio: f"chunk {len(audio) / SR:.1f}s")
        self.delay = delay
        self.avg_logprob = -0.3
        self.no_speech_prob = 0.05
        self.model_id: Optional[str] = "fake"
        self.device: Optional[str] = "cpu"
        self.loaded = True

    def load(self, model_path: str, *, model_id: str, device: str = "auto", compute_type: str = "auto", threads=None):
        from fundarritari_stt.engine import LoadInfo

        self.model_id = model_id
        return LoadInfo(model_id=model_id, device="cpu", compute_type="int8", load_seconds=0.01)

    def transcribe(self, audio: np.ndarray, *, language: Optional[str], initial_prompt: Optional[str], beam_size: int = 5) -> TranscriptionResult:
        self.calls.append({"seconds": len(audio) / SR, "language": language, "initial_prompt": initial_prompt, "beam_size": beam_size})
        if self.delay:
            time.sleep(self.delay)
        return TranscriptionResult(text=self.text_fn(audio), avg_logprob=self.avg_logprob, no_speech_prob=self.no_speech_prob)


def _resonator(x: np.ndarray, centre_hz: float, bandwidth_hz: float) -> np.ndarray:
    """Second-order IIR formant resonator."""
    r = np.exp(-np.pi * bandwidth_hz / SR)
    theta = 2 * np.pi * centre_hz / SR
    a1, a2 = -2 * r * np.cos(theta), r * r
    try:
        from scipy.signal import lfilter  # type: ignore[import-not-found]

        return lfilter([1.0], [1.0, a1, a2], x) * (1 - r)
    except ImportError:
        y = np.zeros_like(x)
        y1 = y2 = 0.0
        for i, v in enumerate(x):
            y[i] = v - a1 * y1 - a2 * y2
            y2, y1 = y1, y[i]
        return y * (1 - r)


@functools.lru_cache(maxsize=16)
def speech(seconds: float, seed: int = 0) -> np.ndarray:
    """Synthetic babble: random syllables (a harmonic glottal source with pitch drift, shaped by two
    formant resonators, with short gaps in between). Silero VAD classifies it as speech, while
    white noise (see :func:`noise`) is rejected. Not intelligible, just VAD-friendly."""
    rng = np.random.default_rng(seed)
    out = np.zeros(int(seconds * SR), dtype=np.float32)
    pos = 0
    while pos < len(out):
        n = min(int(rng.uniform(0.12, 0.28) * SR), len(out) - pos)
        t = np.arange(n) / SR
        f0 = rng.uniform(90, 220) * (1 + 0.15 * np.sin(2 * np.pi * rng.uniform(1, 4) * t + rng.uniform(0, 6)))
        phase = np.cumsum(2 * np.pi * f0 / SR)
        source = sum(np.sin(k * phase) / k for k in range(1, 25)) + rng.standard_normal(n) * 0.1
        y = _resonator(source, rng.uniform(300, 900), 100)
        y = _resonator(y, rng.uniform(1000, 2400), 150)
        y = y * np.hanning(n) ** 0.5
        out[pos : pos + n] = y / (np.max(np.abs(y)) + 1e-9) * rng.uniform(0.3, 0.6)
        pos += n + int(rng.uniform(0.0, 0.06) * SR)
    out.setflags(write=False)
    return out


def noise(seconds: float, seed: int = 0, level: float = 0.3) -> np.ndarray:
    return (np.random.default_rng(seed).standard_normal(int(seconds * SR)) * level).astype(np.float32)


def silence(seconds: float) -> np.ndarray:
    return np.zeros(int(seconds * SR), dtype=np.float32)


@pytest.fixture
def sink() -> RecordingSink:
    return RecordingSink()


@pytest.fixture
def fake_engine() -> FakeEngine:
    return FakeEngine()
