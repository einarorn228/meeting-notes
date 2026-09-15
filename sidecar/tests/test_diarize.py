import json
import os
import subprocess
import sys

import numpy as np
import pytest
import soundfile as sf

from fundarritari_stt import diarize
from fundarritari_stt.events import EventSink

SCRATCH = "/tmp/claude-0/-home-user-meeting-notes/1031bbf8-a539-5709-8da0-302467da0298/scratchpad"


class Sink(EventSink):
    def __init__(self):
        self.events = []

    def emit(self, type, **fields):  # noqa: A002
        self.events.append({"type": type, **fields})


def test_diarize_file_reports_missing_sherpa(monkeypatch, tmp_path):
    import builtins

    real_import = builtins.__import__

    def fake_import(name, *a, **k):
        if name == "sherpa_onnx":
            raise ImportError("no sherpa")
        return real_import(name, *a, **k)

    monkeypatch.setattr(builtins, "__import__", fake_import)
    wav = tmp_path / "a.wav"
    sf.write(wav, np.zeros(16000, dtype=np.float32), 16000)
    sink = Sink()
    diarize.diarize_file("r1", str(wav), models_dir=str(tmp_path), emit=sink)
    assert sink.events[-1]["type"] == "error"
    assert "sherpa-onnx" in sink.events[-1]["message"]


@pytest.mark.slow
def test_diarize_real_models_split_two_speakers(tmp_path):
    pytest.importorskip("sherpa_onnx")
    src = os.path.join(SCRATCH, "diar")
    if not os.path.isdir(src):
        pytest.skip("diarization models not downloaded")
    models_dir = tmp_path / "models"
    d = models_dir / "diarization"
    d.mkdir(parents=True)
    os.symlink(os.path.join(src, "segmentation", "model.onnx"), d / diarize.SEGMENTATION_FILE)
    os.symlink(os.path.join(src, "embedding", diarize.EMBEDDING_FILE), d / diarize.EMBEDDING_FILE)
    audio, sr = sf.read(os.path.join(SCRATCH, "test_is.wav"), dtype="float32")
    audio = audio[: sr * 60]
    wav = tmp_path / "in.wav"
    sf.write(wav, np.stack([np.zeros_like(audio), audio], axis=1), sr)  # stereo: right = system
    sink = Sink()
    diarize.diarize_file("r2", str(wav), models_dir=str(models_dir), emit=sink, channel=1)
    ev = sink.events[-1]
    assert ev["type"] == "diarized", ev
    assert ev["num_speakers"] >= 2
    assert all(0 <= s["start"] < s["end"] <= 61 for s in ev["segments"])
    ids = {s["speaker"] for s in ev["segments"]}
    assert ids == set(range(ev["num_speakers"]))


# ---- merging clusters that are one voice (no models needed: embeddings are faked) -------------------


def _seg(start, end, speaker):
    return diarize.DiarSegment(start=start, end=end, speaker=speaker)


def _fake_embed(voice_of_time):
    """An embedding that depends only on which true voice is speaking at the audio's position.

    The audio handed in is a slice, so the fake looks at its length parity trick instead: callers build
    audio where sample value == true voice id, and the embedding is a one-hot of the dominant value plus a
    little noise so similar-but-not-identical clusters still score high.
    """

    def embed(audio):
        voice = int(round(float(np.median(audio))))
        vec = np.zeros(4, dtype=np.float32)
        vec[voice] = 1.0
        vec[(voice + 1) % 4] = 0.1  # off-axis noise so cross-voice similarity is small but non-zero
        return vec / np.linalg.norm(vec)

    return embed


def _audio_with_voices(intervals, total_s=60):
    """Mono audio whose sample values encode the true voice id per interval."""
    audio = np.zeros(16000 * total_s, dtype=np.float32)
    for start, end, voice in intervals:
        audio[int(start * 16000) : int(end * 16000)] = voice
    return audio


def test_merge_joins_clusters_of_the_same_voice_and_keeps_different_ones():
    """The tester's 2-person call came out as 7 participants: one voice split across many clusters."""
    truth = [(0, 10, 0), (12, 22, 1), (24, 34, 0), (36, 46, 1), (48, 58, 0)]
    audio = _audio_with_voices(truth)
    # Clustering split voice 0 into clusters 0/2/4 and voice 1 into 1/3.
    raw = [_seg(0, 10, 0), _seg(12, 22, 1), _seg(24, 34, 2), _seg(36, 46, 3), _seg(48, 58, 4)]

    merged = diarize.merge_speakers(audio, raw, _fake_embed(None))

    labels = {s.speaker for s in merged}
    assert len(labels) == 2, merged
    voice0 = {s.speaker for s in merged if s.start in (0, 24, 48)}
    voice1 = {s.speaker for s in merged if s.start in (12, 36)}
    assert len(voice0) == 1 and len(voice1) == 1 and voice0 != voice1
    assert [s.start for s in merged] == sorted(s.start for s in merged), "segments stay in time order"


def test_tiny_clusters_are_attached_to_a_reliable_voice_instead_of_becoming_participants():
    """A one-second 'já' embeds as noise; it must join an existing voice, never stand alone."""
    audio = _audio_with_voices([(0, 20, 0), (21, 22, 0), (30, 50, 1)])
    raw = [_seg(0, 20, 0), _seg(21, 22, 7), _seg(30, 50, 1)]

    merged = diarize.merge_speakers(audio, raw, _fake_embed(None), merge_similarity=0.99)

    assert {s.speaker for s in merged} == {0, 1}
    tiny = next(s for s in merged if s.start == 21)
    assert tiny.speaker == 0, "attached to the most similar reliable cluster"


def test_a_given_participant_count_is_honoured():
    audio = _audio_with_voices([(0, 10, 0), (12, 22, 1), (24, 34, 2), (36, 46, 3)])
    raw = [_seg(0, 10, 0), _seg(12, 22, 1), _seg(24, 34, 2), _seg(36, 46, 3)]
    embed = _fake_embed(None)

    assert len({s.speaker for s in diarize.merge_speakers(audio, raw, embed, num_speakers=1)}) == 1
    assert len({s.speaker for s in diarize.merge_speakers(audio, raw, embed, num_speakers=2)}) == 2
    # Asking for more voices than were found never invents any.
    assert len({s.speaker for s in diarize.merge_speakers(audio, raw, embed, num_speakers=9)}) == 4


def test_merge_leaves_single_cluster_and_empty_input_alone():
    assert diarize.merge_speakers(np.zeros(16000), [], _fake_embed(None)) == []
    one = [_seg(0, 5, 3), _seg(6, 9, 3)]
    assert diarize.merge_speakers(_audio_with_voices([(0, 9, 0)], 10), one, _fake_embed(None)) is one
