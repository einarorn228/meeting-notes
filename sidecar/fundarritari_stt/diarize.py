"""Offline speaker diarization of a recorded channel with sherpa-onnx (pyannote segmentation + speaker embeddings).

The app records remote participants as one mixed "system" channel; this module splits that channel into
speakers so every person in the meeting gets their own label.
"""

from __future__ import annotations

import logging
import os
import threading
from dataclasses import dataclass
from typing import Any, Callable, Dict, List, Optional

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


# Clusters with less audio than this have embeddings too noisy to compare (a 1 s "já" scored 0.15 against
# its own speaker's 80 s cluster); they are attached to the most similar reliable cluster instead.
MIN_RELIABLE_S = 4.0
# Two clusters whose whole-audio embeddings are at least this similar are one voice. Measured on real
# recordings: the same speaker split in two scored 0.86 and 0.75; the highest score between two different
# speakers was 0.62.
MERGE_SIMILARITY = 0.7
# How much of a cluster's audio (longest segments first) goes into its embedding.
CENTROID_AUDIO_S = 40.0

_extractor_lock = threading.Lock()
_extractors: dict[tuple[str, int], Any] = {}


def _extractor(emb: str, threads: int) -> Any:
    import sherpa_onnx

    with _extractor_lock:
        ex = _extractors.get((emb, threads))
        if ex is None:
            ex = sherpa_onnx.SpeakerEmbeddingExtractor(sherpa_onnx.SpeakerEmbeddingExtractorConfig(model=emb, num_threads=threads))
            _extractors.clear()
            _extractors[(emb, threads)] = ex
        return ex


def _embed(extractor: Any, audio: np.ndarray) -> np.ndarray:
    stream = extractor.create_stream()
    stream.accept_waveform(SAMPLE_RATE, audio)
    stream.input_finished()
    vec = np.asarray(extractor.compute(stream), dtype=np.float32)
    return vec / (np.linalg.norm(vec) + 1e-9)


def merge_speakers(
    audio: np.ndarray,
    segments: List[DiarSegment],
    embed: Callable[[np.ndarray], np.ndarray],
    *,
    num_speakers: int = -1,
    merge_similarity: float = MERGE_SIMILARITY,
    min_reliable_s: float = MIN_RELIABLE_S,
) -> List[DiarSegment]:
    """Merge clusters that are the same voice.

    The clustering step works on one embedding per short segment, and short segments embed badly, so one
    person in a call came back as seven "participants". Whole-cluster embeddings (up to 40 s of that
    cluster's audio in one go) are far more stable, and comparing *those* is what this does: tiny clusters
    are attached to the most similar reliable one, then the two most similar clusters are merged - and
    re-embedded - while they still look like one voice, or until ``num_speakers`` remain when the user said
    how many people were on the line.
    """
    if not segments:
        return segments
    clusters: Dict[int, List[DiarSegment]] = {}
    for s in segments:
        clusters.setdefault(s.speaker, []).append(s)
    if len(clusters) == 1:
        return segments

    def duration(k: int) -> float:
        return sum(s.end - s.start for s in clusters[k])

    def centroid(k: int) -> np.ndarray:
        chunks: List[np.ndarray] = []
        total = 0.0
        for s in sorted(clusters[k], key=lambda s: s.start - s.end):
            chunks.append(audio[int(s.start * SAMPLE_RATE) : int(s.end * SAMPLE_RATE)])
            total += s.end - s.start
            if total >= CENTROID_AUDIO_S:
                break
        return embed(np.concatenate(chunks))

    cents = {k: centroid(k) for k in clusters}

    def absorb(victim: int, into: int) -> None:
        clusters[into].extend(clusters.pop(victim))
        cents.pop(victim)
        cents[into] = centroid(into)

    # 1. Tiny clusters cannot be judged on their own embedding; give them to the nearest reliable voice.
    reliable = [k for k in clusters if duration(k) >= min_reliable_s]
    if reliable:
        for k in [k for k in clusters if k not in reliable]:
            best = max(reliable, key=lambda r: float(cents[k] @ cents[r]))
            log.info("speaker cluster %d (%.1f s) is too short to trust; attached to %d", k, duration(k), best)
            absorb(k, best)

    # 2. Merge the most similar pair while it still looks like one voice (or until the user's count).
    target = int(num_speakers) if num_speakers and num_speakers > 0 else 1
    while len(clusters) > target:
        keys = sorted(clusters)
        pair = max(((a, b) for i, a in enumerate(keys) for b in keys[i + 1 :]), key=lambda ab: float(cents[ab[0]] @ cents[ab[1]]))
        sim = float(cents[pair[0]] @ cents[pair[1]])
        if num_speakers <= 0 and sim < merge_similarity:
            break
        keep, drop = (pair if duration(pair[0]) >= duration(pair[1]) else (pair[1], pair[0]))
        log.info("merging speaker clusters %d and %d (similarity %.2f)", drop, keep, sim)
        absorb(drop, keep)

    merged: List[DiarSegment] = []
    for k, segs in clusters.items():
        merged.extend(DiarSegment(start=s.start, end=s.end, speaker=k) for s in segs)
    merged.sort(key=lambda s: s.start)
    return merged


def diarize_audio(
    audio: np.ndarray,
    seg: str,
    emb: str,
    *,
    threshold: float = 0.55,
    num_speakers: int = -1,
    threads: Optional[int] = None,
    merge: bool = True,
) -> List[DiarSegment]:
    """Diarizes 16 kHz mono float32 audio. Returns segments sorted by start time.

    Clustering always runs unconstrained (it over-splits, which is recoverable); ``num_speakers`` and the
    merge step then decide how many voices remain. See :func:`merge_speakers`.
    """
    threads = threads or min(4, os.cpu_count() or 2)
    sd = _build(seg, emb, float(threshold), -1, int(threads))
    if audio.dtype != np.float32:
        audio = audio.astype(np.float32)
    if len(audio) < 16000:  # < 1 s: nothing to split
        return []
    result = sd.process(audio).sort_by_start_time()
    segments = [DiarSegment(start=float(r.start), end=float(r.end), speaker=int(r.speaker)) for r in result]
    if not merge:
        return segments
    extractor = _extractor(emb, int(threads))
    return merge_speakers(audio, segments, lambda a: _embed(extractor, a), num_speakers=int(num_speakers))


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
