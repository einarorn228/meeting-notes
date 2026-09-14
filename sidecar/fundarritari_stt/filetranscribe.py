"""Offline transcription of audio files with the same VAD-chunk approach as live streaming."""

from __future__ import annotations

import logging
from typing import Dict, List, Mapping, Optional, Sequence, Tuple

import numpy as np

from .audio import SAMPLE_RATE, AudioLoadError, load_audio_file, resample
from .engine import Transcriber
from .events import EventSink
from .postprocess import finalize_text
from .streaming import StreamingOptions, detect_regions
from .vocab import build_initial_prompt, normalize_vocabulary

log = logging.getLogger("fundarritari_stt.filetranscribe")


def chunk_speech(audio: np.ndarray, opts: StreamingOptions) -> List[Tuple[int, int]]:
    """Speech chunks (start, end in samples) of at most ``max_segment_s`` with ``pad_ms`` padding."""
    pad = opts.samples(opts.pad_ms / 1000.0)
    chunks: List[Tuple[int, int]] = []
    for region in detect_regions(audio, opts):
        start = max(0, region.start - pad)
        end = min(len(audio), region.end + pad)
        if end > start:
            chunks.append((start, end))
    return chunks


def split_channels(
    data: np.ndarray, channels_map: Optional[Mapping[str, str]]
) -> Dict[str, np.ndarray]:
    """Map file channels to protocol channel names.

    With a ``channels_map`` such as ``{"0": "mic", "1": "system"}`` each listed channel is kept
    separate; otherwise the file is mixed down to mono and reported as channel ``mic``.
    """
    if data.ndim == 1:
        data = data[:, None]
    n_channels = data.shape[1]
    if channels_map:
        selected: Dict[str, np.ndarray] = {}
        for index_str, name in channels_map.items():
            try:
                index = int(index_str)
            except (TypeError, ValueError):
                raise ValueError(f"invalid channel index {index_str!r} in channels_map") from None
            if not 0 <= index < n_channels:
                log.warning("channels_map refers to channel %d but the file has %d", index, n_channels)
                continue
            selected[str(name)] = data[:, index]
        if selected:
            return selected
    return {"mic": data.mean(axis=1) if n_channels > 1 else data[:, 0]}


def transcribe_file(
    request_id: str,
    path: str,
    *,
    engine: Transcriber,
    emit: EventSink,
    language: Optional[str] = "is",
    vocabulary: Optional[Sequence[object]] = None,
    channels_map: Optional[Mapping[str, str]] = None,
    punctuated: bool = True,
    opts: StreamingOptions = StreamingOptions(),
) -> float:
    """Transcribe ``path`` and emit ``segment`` events followed by ``file_done``. Returns the duration."""
    try:
        data, rate = load_audio_file(path)
    except AudioLoadError as exc:
        raise RuntimeError(str(exc)) from exc
    duration = data.shape[0] / float(rate)
    vocab = normalize_vocabulary(vocabulary)
    prompt = build_initial_prompt(vocab, language, punctuated)
    channels = split_channels(data, channels_map)
    del data
    log.info("transcribing %s: %.1f s, channels %s", path, duration, list(channels))

    for channel, mono in channels.items():
        audio = resample(mono, rate, SAMPLE_RATE)
        chunks = chunk_speech(audio, opts)
        for index, (start, end) in enumerate(chunks):
            result = engine.transcribe(
                audio[start:end], language=language, initial_prompt=prompt, beam_size=opts.beam_size
            )
            text = finalize_text(result.text, result.avg_logprob, result.no_speech_prob, vocab)
            if text is None:
                continue
            emit.emit(
                "segment",
                request_id=request_id,
                channel=channel,
                start=round(start / SAMPLE_RATE, 3),
                end=round(end / SAMPLE_RATE, 3),
                text=text,
                partial=False,
                avg_logprob=round(float(result.avg_logprob), 4),
                no_speech_prob=round(float(result.no_speech_prob), 4),
            )
            if (index + 1) % 10 == 0:
                log.info("%s/%s: %d/%d chunks", request_id, channel, index + 1, len(chunks))
    emit.emit("file_done", request_id=request_id, duration=round(duration, 3))
    return duration
