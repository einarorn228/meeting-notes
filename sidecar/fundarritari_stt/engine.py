"""Model loading and transcription of short (<= 30 s) audio chunks with faster-whisper."""

from __future__ import annotations

import logging
import os
import time
from dataclasses import dataclass
from typing import Optional, Protocol

import numpy as np

log = logging.getLogger("fundarritari_stt.engine")

DEVICES = ("auto", "cpu", "cuda")
COMPUTE_TYPES = ("auto", "int8", "float16", "float32")


class EngineNotLoaded(RuntimeError):
    """Raised when transcription is requested before a model was loaded."""


@dataclass
class TranscriptionResult:
    text: str
    avg_logprob: float
    no_speech_prob: float
    language: Optional[str] = None


@dataclass
class LoadInfo:
    model_id: str
    device: str
    compute_type: str
    load_seconds: float


class Transcriber(Protocol):
    """The subset of the engine that streaming/file transcription depend on (mockable in tests)."""

    def transcribe(
        self,
        audio: np.ndarray,
        *,
        language: Optional[str],
        initial_prompt: Optional[str],
        beam_size: int = 5,
    ) -> TranscriptionResult: ...


def cuda_available() -> bool:
    try:
        import ctranslate2

        return int(ctranslate2.get_cuda_device_count()) > 0
    except Exception:  # noqa: BLE001 - missing/broken CUDA runtime simply means "no cuda"
        return False


def resolve_device(device: str) -> str:
    if device not in DEVICES:
        raise ValueError(f"unknown device {device!r}; expected one of {DEVICES}")
    if device == "auto":
        return "cuda" if cuda_available() else "cpu"
    return device


def resolve_compute_type(compute_type: str, device: str) -> str:
    if compute_type not in COMPUTE_TYPES:
        raise ValueError(f"unknown compute_type {compute_type!r}; expected one of {COMPUTE_TYPES}")
    if compute_type == "auto":
        return "float16" if device == "cuda" else "int8"
    return compute_type


def default_threads() -> int:
    return max(1, min(8, os.cpu_count() or 4))


def normalize_language(language: Optional[str]) -> Optional[str]:
    """``auto``/empty means "let Whisper detect" (None for faster-whisper)."""
    if not language or language == "auto":
        return None
    return language


class WhisperEngine:
    """Owns one faster-whisper model. ``transcribe`` must be called from a single thread at a time."""

    def __init__(self) -> None:
        self.model = None
        self.model_id: Optional[str] = None
        self.model_path: Optional[str] = None
        self.device: Optional[str] = None
        self.compute_type: Optional[str] = None
        self.threads: Optional[int] = None

    @property
    def loaded(self) -> bool:
        return self.model is not None

    def load(
        self,
        model_path: str,
        *,
        model_id: str,
        device: str = "auto",
        compute_type: str = "auto",
        threads: Optional[int] = None,
    ) -> LoadInfo:
        from faster_whisper import WhisperModel

        resolved_device = resolve_device(device)
        resolved_compute = resolve_compute_type(compute_type, resolved_device)
        cpu_threads = int(threads) if threads else default_threads()
        log.info(
            "loading model %s from %s (device=%s, compute_type=%s, threads=%d)",
            model_id, model_path, resolved_device, resolved_compute, cpu_threads,
        )
        started = time.perf_counter()
        model = WhisperModel(
            model_path,
            device=resolved_device,
            compute_type=resolved_compute,
            cpu_threads=cpu_threads,
            local_files_only=True,
        )
        elapsed = time.perf_counter() - started
        # Replace the previous model (if any) only after the new one loaded successfully.
        self.model = model
        self.model_id = model_id
        self.model_path = model_path
        self.device = resolved_device
        self.compute_type = resolved_compute
        self.threads = cpu_threads
        log.info("model %s loaded in %.1f s", model_id, elapsed)
        return LoadInfo(model_id=model_id, device=resolved_device, compute_type=resolved_compute, load_seconds=elapsed)

    def unload(self) -> None:
        self.model = None
        self.model_id = None

    def transcribe(
        self,
        audio: np.ndarray,
        *,
        language: Optional[str],
        initial_prompt: Optional[str],
        beam_size: int = 5,
    ) -> TranscriptionResult:
        """Transcribe one VAD-cut chunk (<= 30 s). Timestamps are deliberately not requested:
        the Icelandic fine-tunes produce unreliable ones, so callers use their own VAD timing."""
        if self.model is None:
            raise EngineNotLoaded("no model loaded")
        audio = np.ascontiguousarray(np.asarray(audio, dtype=np.float32))
        if audio.size == 0:
            return TranscriptionResult(text="", avg_logprob=0.0, no_speech_prob=1.0)
        segments, info = self.model.transcribe(
            audio,
            language=normalize_language(language),
            beam_size=beam_size,
            without_timestamps=True,
            condition_on_previous_text=False,
            initial_prompt=initial_prompt or None,
            vad_filter=False,
        )
        texts: list[str] = []
        weighted_logprob = 0.0
        weight = 0
        no_speech = 0.0
        for seg in segments:
            text = seg.text.strip()
            if text:
                texts.append(text)
            n_tokens = max(1, len(seg.tokens))
            weighted_logprob += float(seg.avg_logprob) * n_tokens
            weight += n_tokens
            no_speech = max(no_speech, float(seg.no_speech_prob))
        if weight == 0:
            return TranscriptionResult(text="", avg_logprob=0.0, no_speech_prob=1.0, language=info.language)
        return TranscriptionResult(
            text=" ".join(texts),
            avg_logprob=weighted_logprob / weight,
            no_speech_prob=no_speech,
            language=info.language,
        )
