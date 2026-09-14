"""Model loading and transcription of short (<= 30 s) audio chunks with faster-whisper."""

from __future__ import annotations

import logging
import os
import time
from dataclasses import dataclass
from typing import Callable, Optional, Protocol

import numpy as np

log = logging.getLogger("fundarritari_stt.engine")

SAMPLE_RATE = 16000

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


def supported_compute_types(device: str) -> set:
    """What CTranslate2 will actually run on this machine. Empty set = could not ask."""
    try:
        import ctranslate2

        return set(ctranslate2.get_supported_compute_types(device))
    except Exception:  # noqa: BLE001 - an unavailable backend just means "we cannot tell"
        return set()


# Preference order per device. float16 needs a GPU of compute capability >= 7.0; older cards and every CPU
# reject it with "Requested float16 compute type, but the target device or backend do not support efficient
# float16 computation", so the type is never assumed - it is checked first.
_PREFERRED = {
    "cuda": ("float16", "int8_float16", "int8", "float32"),
    "cpu": ("int8", "int8_float32", "float32"),
}


def resolve_compute_type(compute_type: str, device: str) -> str:
    if compute_type not in COMPUTE_TYPES:
        raise ValueError(f"unknown compute_type {compute_type!r}; expected one of {COMPUTE_TYPES}")
    preferred = _PREFERRED.get(device, _PREFERRED["cpu"])
    supported = supported_compute_types(device)
    if compute_type != "auto":
        if not supported or compute_type in supported:
            return compute_type
        fallback = next((c for c in preferred if c in supported), "int8")
        log.warning("compute type %s is not supported on %s; using %s instead", compute_type, device, fallback)
        return fallback
    if not supported:
        return preferred[0]
    return next((c for c in preferred if c in supported), "int8")


def _probe(model) -> None:
    """Run one tiny forward pass so a backend that only fails at compute time fails here instead.

    Deliberately *not* a full transcribe. Whisper fed silence decodes to the token limit and then repeats the
    whole thing at every fallback temperature: measured at 52 s for ``small`` and minutes for ``large-v3``, per
    candidate, which made loading look like it had hung. Detecting the language runs the encoder and one
    decoder step - the same cuBLAS path that fails when the CUDA runtime is missing - in about a second.
    """
    audio = np.zeros(SAMPLE_RATE // 2, dtype=np.float32)
    detect = getattr(model, "detect_language", None)
    if callable(detect):
        detect(audio)
        return
    # Older faster-whisper builds have no detect_language; the encoder alone still exercises the GPU.
    encode = getattr(model, "encode", None)
    extractor = getattr(model, "feature_extractor", None)
    if callable(encode) and extractor is not None:
        features = extractor(audio)
        encode(features[..., : extractor.nb_max_frames])


# A missing CUDA library breaks every compute type on the device, so the remaining ones are not worth the
# minutes it takes to load a multi-gigabyte model again. An unsupported compute type says nothing about the
# device, so its wording ("...do not support efficient float16 computation") deliberately matches nothing here.
_DEVICE_FAILURE_MARKERS = ("cublas", "cudnn", "cuda", "libcu", "no kernel image", "gpu")


def _is_device_failure(exc: BaseException) -> bool:
    message = str(exc).lower()
    return any(marker in message for marker in _DEVICE_FAILURE_MARKERS)


def _load_candidates(device: str, compute_type: str) -> list:
    """The requested combination first, then progressively safer ones, ending at CPU int8."""
    candidates = [(device, compute_type)]
    if device == "cuda":
        for fallback in ("int8_float16", "int8"):
            if fallback in supported_compute_types("cuda"):
                candidates.append(("cuda", fallback))
    for cpu_compute in ("int8", "float32"):
        candidates.append(("cpu", cpu_compute))
    seen = set()
    return [c for c in candidates if not (c in seen or seen.add(c))]


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
        # Set once the engine has already fallen back at runtime, so it cannot loop reloading.
        self._degraded = False

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
        on_attempt: Optional[Callable[[str, str], None]] = None,
    ) -> LoadInfo:
        """Load ``model_id``, falling back through safer backends. ``on_attempt`` is called with the device and
        compute type before each try, so the app can show which one is being loaded instead of a mute spinner."""
        from faster_whisper import WhisperModel

        resolved_device = resolve_device(device)
        resolved_compute = resolve_compute_type(compute_type, resolved_device)
        cpu_threads = int(threads) if threads else default_threads()
        log.info(
            "loading model %s from %s (device=%s, compute_type=%s, threads=%d)",
            model_id, model_path, resolved_device, resolved_compute, cpu_threads,
        )
        started = time.perf_counter()
        model = None
        errors: list[str] = []
        # Capability queries do not catch everything: a CUDA build can pass the compute-type check and then
        # fail on a missing cuDNN at load time. So try the plan, then progressively safer combinations, and
        # only give up once plain CPU int8 - which every machine can run - has also failed.
        unusable_devices: set = set()
        for try_device, try_compute in _load_candidates(resolved_device, resolved_compute):
            if try_device in unusable_devices:
                continue
            if on_attempt is not None:
                on_attempt(try_device, try_compute)
            try:
                candidate = WhisperModel(
                    model_path,
                    device=try_device,
                    compute_type=try_compute,
                    cpu_threads=cpu_threads,
                    local_files_only=True,
                )
                # Constructing the model proves almost nothing: on a machine with an NVIDIA GPU but no CUDA
                # runtime it succeeds, and the first real segment then dies with "Library cublas64_12.dll is
                # not found or cannot be loaded". So run one throwaway inference here, while there is still
                # somewhere to fall back to, instead of discovering it mid-meeting.
                _probe(candidate)
                model = candidate
            except Exception as exc:  # noqa: BLE001 - any backend failure is worth falling back from
                errors.append(f"{try_device}/{try_compute}: {exc}")
                log.warning("could not load %s on %s/%s: %s", model_id, try_device, try_compute, exc)
                if try_device != "cpu" and _is_device_failure(exc):
                    # Its CUDA runtime is broken, not just this precision. Reloading gigabytes to watch the
                    # same library fail again only makes the user wait longer.
                    log.warning("%s is unusable on this machine; skipping its remaining compute types", try_device)
                    unusable_devices.add(try_device)
                continue
            if (try_device, try_compute) != (resolved_device, resolved_compute):
                log.info("fell back to %s/%s for %s", try_device, try_compute, model_id)
            resolved_device, resolved_compute = try_device, try_compute
            break
        if model is None:
            raise RuntimeError("Tókst ekki að hlaða talgreiningarlíkani. " + " | ".join(errors))
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
        try:
            return self._run(audio, language=language, initial_prompt=initial_prompt, beam_size=beam_size)
        except Exception as exc:  # noqa: BLE001 - a dying backend must not cost the user the whole meeting
            if self._degraded or self.device == "cpu" or self.model_path is None:
                raise
            # The backend broke after loading cleanly. Rather than failing every remaining segment, drop to
            # CPU once and carry on: slower, but the meeting still gets transcribed.
            log.warning("transcription failed on %s/%s (%s); falling back to cpu/int8", self.device, self.compute_type, exc)
            self._degraded = True
            self.load(self.model_path, model_id=self.model_id or "", device="cpu", compute_type="int8", threads=self.threads)
            return self._run(audio, language=language, initial_prompt=initial_prompt, beam_size=beam_size)

    def _run(
        self,
        audio: np.ndarray,
        *,
        language: Optional[str],
        initial_prompt: Optional[str],
        beam_size: int,
    ) -> TranscriptionResult:
        assert self.model is not None
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
