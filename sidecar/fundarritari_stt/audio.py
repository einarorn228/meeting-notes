"""Audio helpers: PCM decoding, resampling and reading audio files."""

from __future__ import annotations

import base64
from pathlib import Path
from typing import Tuple

import numpy as np

SAMPLE_RATE = 16000


class AudioLoadError(Exception):
    """Raised when an audio file cannot be decoded."""


def pcm16_to_float32(data: bytes) -> np.ndarray:
    """Convert little-endian PCM16 bytes to float32 in [-1, 1]. Trailing odd byte is ignored."""
    usable = len(data) - (len(data) % 2)
    if usable <= 0:
        return np.zeros(0, dtype=np.float32)
    samples = np.frombuffer(data, dtype="<i2", count=usable // 2)
    return samples.astype(np.float32) / 32768.0


def decode_pcm_base64(pcm_b64: str) -> np.ndarray:
    """Decode a base64 PCM16 payload from an ``audio`` command."""
    return pcm16_to_float32(base64.b64decode(pcm_b64))


def encode_pcm_base64(audio: np.ndarray) -> str:
    """Inverse of :func:`decode_pcm_base64` (used by tests and tools)."""
    clipped = np.clip(np.asarray(audio, dtype=np.float32), -1.0, 1.0)
    return base64.b64encode((clipped * 32767.0).astype("<i2").tobytes()).decode("ascii")


def resample(audio: np.ndarray, src_rate: int, dst_rate: int = SAMPLE_RATE) -> np.ndarray:
    """Resample mono float32 audio. Uses resampy when installed, else linear interpolation."""
    audio = np.asarray(audio, dtype=np.float32)
    if src_rate == dst_rate or audio.size == 0:
        return audio
    try:
        import resampy  # type: ignore[import-not-found]

        return resampy.resample(audio, src_rate, dst_rate, filter="kaiser_fast").astype(np.float32)
    except ImportError:
        pass
    n_out = int(round(len(audio) * dst_rate / src_rate))
    src_positions = np.arange(len(audio), dtype=np.float64)
    dst_positions = np.linspace(0.0, len(audio) - 1, num=n_out, dtype=np.float64)
    return np.interp(dst_positions, src_positions, audio).astype(np.float32)


def _load_with_soundfile(path: Path) -> Tuple[np.ndarray, int]:
    import soundfile as sf

    data, rate = sf.read(str(path), dtype="float32", always_2d=True)
    return data, int(rate)


def _load_with_pyav(path: Path) -> Tuple[np.ndarray, int]:
    import av  # type: ignore[import-not-found]

    with av.open(str(path)) as container:
        if not container.streams.audio:
            raise AudioLoadError(f"Engin hljóðrás í {path}")
        stream = container.streams.audio[0]
        rate = int(stream.rate or SAMPLE_RATE)
        channels = int(getattr(stream, "channels", 0) or 1)
        layout = "stereo" if channels >= 2 else "mono"
        resampler = av.AudioResampler(format="fltp", layout=layout, rate=rate)
        blocks = []
        for frame in container.decode(stream):
            for out in resampler.resample(frame):
                blocks.append(out.to_ndarray())
        for out in resampler.resample(None):
            blocks.append(out.to_ndarray())
    if not blocks:
        raise AudioLoadError(f"Ekkert lesanlegt hljóð í {path}")
    planar = np.concatenate(blocks, axis=1)  # (channels, samples)
    return planar.T.astype(np.float32, copy=False), rate


def load_audio_file(path: str | Path) -> Tuple[np.ndarray, int]:
    """Read an audio file as a float32 array of shape (samples, channels) plus its sample rate.

    Tries soundfile first (WAV/FLAC/OGG), then PyAV for everything else (mp3, m4a, webm, ...).
    """
    p = Path(path)
    if not p.is_file():
        raise AudioLoadError(f"Skráin fannst ekki: {p}")
    errors = []
    try:
        return _load_with_soundfile(p)
    except Exception as exc:  # noqa: BLE001 - any decoder failure falls through to PyAV
        errors.append(f"soundfile: {exc}")
    try:
        return _load_with_pyav(p)
    except ImportError:
        errors.append("av: PyAV not installed")
    except Exception as exc:  # noqa: BLE001
        errors.append(f"av: {exc}")
    raise AudioLoadError(f"Ekki tókst að lesa hljóðskrána {p.name} ({'; '.join(errors)})")
