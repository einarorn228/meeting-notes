"""Offline speaker diarization of a recorded channel with sherpa-onnx (pyannote segmentation + speaker embeddings).

The app records remote participants as one mixed "system" channel; this module splits that channel into
speakers so every person in the meeting gets their own label.
"""

from __future__ import annotations

import logging
import os
import threading
from dataclasses import dataclass
from typing import Any, List, Optional

import numpy as np

from .audio import SAMPLE_RATE, load_audio_file, resample
from .events import EventSink

log = logging.getLogger("fundarritari_stt.diarize")

SEGMENTATION_REPO = "csukuangfj/sherpa-onnx-pyannote-segmentation-3-0"
SEGMENTATION_FILE = "model.onnx"
EMBEDDING_REPO = "csukuangfj/speaker-embedding-models"
EMBEDDING_FILE = "3dspeaker_speech_campplus_sv_en_voxceleb_16k.onnx"
MODEL_ID = "diarization"


@dataclass
class DiarSegment:
    start: float
    end: float
    speaker: int


def load_audio(path: str, channel: Optional[int] = None) -> np.ndarray:
    """Loads one channel (or a mono mix-down) of an audio file as 16 kHz float32."""
    data, rate = load_audio_file(path)
    if data.ndim == 1:
        mono = data
    elif channel is not None and 0 <= channel < data.shape[1]:
        mono = data[:, channel]
    else:
        mono = data.mean(axis=1)
    mono = np.ascontiguousarray(mono, dtype=np.float32)
    if rate != SAMPLE_RATE:
        mono = resample(mono, rate, SAMPLE_RATE)
    return mono


def diarization_dir(models_dir: str) -> str:
    return os.path.join(models_dir, MODEL_ID)


def is_installed(models_dir: str) -> bool:
    d = diarization_dir(models_dir)
    return os.path.isfile(os.path.join(d, SEGMENTATION_FILE)) and os.path.isfile(os.path.join(d, EMBEDDING_FILE))


def ensure_models(models_dir: str, emit: Optional[EventSink] = None) -> tuple[str, str]:
    """Downloads the two ONNX models on first use. Returns (segmentation_path, embedding_path)."""
    d = diarization_dir(models_dir)
    os.makedirs(d, exist_ok=True)
    seg = os.path.join(d, SEGMENTATION_FILE)
    emb = os.path.join(d, EMBEDDING_FILE)
    if os.path.isfile(seg) and os.path.isfile(emb):
        return seg, emb
    from huggingface_hub import hf_hub_download

    if emit:
        emit.emit("status", state="downloading-model", model_id=MODEL_ID, message="Downloading speaker diarization models", progress=0.0)
    hf_hub_download(SEGMENTATION_REPO, SEGMENTATION_FILE, local_dir=d)
    if emit:
        emit.emit("progress", model_id=MODEL_ID, progress=0.2, downloaded_mb=6.0, total_mb=36.0)
    hf_hub_download(EMBEDDING_REPO, EMBEDDING_FILE, local_dir=d)
    if emit:
        emit.emit("progress", model_id=MODEL_ID, progress=1.0, downloaded_mb=36.0, total_mb=36.0)
    return seg, emb


_lock = threading.Lock()
_cache: dict[tuple[str, str, float, int], Any] = {}


def _build(seg: str, emb: str, threshold: float, num_speakers: int, threads: int) -> Any:
    import sherpa_onnx  # imported lazily: optional dependency

    key = (seg, emb, threshold, num_speakers)
    with _lock:
        sd = _cache.get(key)
        if sd is not None:
            return sd
        config = sherpa_onnx.OfflineSpeakerDiarizationConfig(
            segmentation=sherpa_onnx.OfflineSpeakerSegmentationModelConfig(
                pyannote=sherpa_onnx.OfflineSpeakerSegmentationPyannoteModelConfig(model=seg),
                num_threads=threads,
            ),
            embedding=sherpa_onnx.SpeakerEmbeddingExtractorConfig(model=emb, num_threads=threads),
            clustering=sherpa_onnx.FastClusteringConfig(num_clusters=num_speakers, threshold=threshold),
            min_duration_on=0.3,
            min_duration_off=0.5,
        )
        if not config.validate():
            raise RuntimeError("invalid diarization configuration (models missing?)")
        sd = sherpa_onnx.OfflineSpeakerDiarization(config)
        _cache.clear()
        _cache[key] = sd
        return sd


def diarize_audio(audio: np.ndarray, seg: str, emb: str, *, threshold: float = 0.55, num_speakers: int = -1, threads: Optional[int] = None) -> List[DiarSegment]:
    """Diarizes 16 kHz mono float32 audio. Returns segments sorted by start time."""
    threads = threads or min(4, os.cpu_count() or 2)
    sd = _build(seg, emb, float(threshold), int(num_speakers), int(threads))
    if audio.dtype != np.float32:
        audio = audio.astype(np.float32)
    if len(audio) < 16000:  # < 1 s: nothing to split
        return []
    result = sd.process(audio).sort_by_start_time()
    return [DiarSegment(start=float(r.start), end=float(r.end), speaker=int(r.speaker)) for r in result]


def diarize_file(
    request_id: str,
    path: str,
    *,
    models_dir: str,
    emit: EventSink,
    channel: Optional[int] = None,
    threshold: float = 0.55,
    num_speakers: int = -1,
) -> None:
    """Command handler: emits ``diarized`` (or ``error``)."""
    try:
        try:
            import sherpa_onnx  # noqa: F401
        except ImportError as exc:
            raise RuntimeError("sherpa-onnx is not installed (pip install sherpa-onnx)") from exc
        seg, emb = ensure_models(models_dir, emit)
        emit.emit("status", state="ready", model_id=MODEL_ID, message="Diarizing speakers")
        audio = load_audio(path, channel=channel)
        segments = diarize_audio(audio, seg, emb, threshold=threshold, num_speakers=num_speakers)
        speakers = sorted({s.speaker for s in segments})
        remap = {spk: i for i, spk in enumerate(speakers)}
        emit.emit(
            "diarized",
            request_id=request_id,
            segments=[{"start": round(s.start, 3), "end": round(s.end, 3), "speaker": remap[s.speaker]} for s in segments],
            num_speakers=len(speakers),
        )
    except Exception as exc:  # noqa: BLE001
        log.exception("diarization failed")
        emit.emit("error", request_id=request_id, message=f"diarization failed: {exc}", fatal=False)
