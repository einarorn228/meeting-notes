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


def _noisy_embed(reliable_s=20.0, seed=0):
    """Like ``_fake_embed``, but short audio embeds badly - which is the whole reason clusters split.

    Real embeddings need seconds of speech to be stable: measured on a long Icelandic recording, 5-15 s
    fragments of the main speaker scored 0.4-0.6 against that speaker's own 100 s cluster, well under the
    0.7 that counts as one voice. This fake reproduces that: the less audio, the more the vector drifts.
    """
    rng = np.random.default_rng(seed)

    def embed(audio):
        voice = int(round(float(np.median(audio))))
        seconds = len(audio) / 16000
        vec = np.zeros(8, dtype=np.float32)
        vec[voice] = 1.0
        drift = max(0.0, 1.0 - seconds / reliable_s)  # 0 for long clusters, ~1 for a one-second fragment
        vec[4:] = rng.normal(0, 1, 4).astype(np.float32) * drift
        return vec / np.linalg.norm(vec)

    return embed


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


def test_a_long_meeting_with_one_voice_does_not_become_a_crowd():
    """The failure this guards against, measured on real audio.

    Clustering a long recording leaves a tail of 5-15 second fragments of the main speaker. Their embeddings
    are too noisy to reach the merge threshold, so with a 4-second reliability floor each one survived as its
    own "participant": 40 minutes of a single voice came back as 5 speakers, and a 40-minute two-person call
    as 20 to 40 of them.
    """
    # One voice: two long stretches plus a tail of fragments, as the clustering leaves them.
    truth = [(0, 300, 0), (310, 600, 0)] + [(610 + i * 20, 610 + i * 20 + 8, 0) for i in range(12)]
    audio = _audio_with_voices(truth, total_s=900)
    raw = [_seg(0, 300, 0), _seg(310, 600, 1)] + [_seg(610 + i * 20, 610 + i * 20 + 8, 2 + i) for i in range(12)]

    merged = diarize.merge_speakers(audio, raw, _noisy_embed())

    assert len({s.speaker for s in merged}) == 1, sorted({s.speaker for s in merged})
    assert len(merged) == len(raw), "every segment is kept, only its label changes"


def test_a_brief_speaker_survives_when_the_user_says_how_many_there_were():
    """Folding short clusters in is what stops the crowd - but not past the count the user gave."""
    audio = _audio_with_voices([(0, 300, 0), (305, 313, 1)], total_s=320)
    raw = [_seg(0, 300, 0), _seg(305, 313, 1)]  # the second voice spoke for 8 s, below the reliability floor

    alone = diarize.merge_speakers(audio, list(raw), _fake_embed(None))
    assert len({s.speaker for s in alone}) == 1, "without a count, a brief voice joins the one it resembles"

    told = diarize.merge_speakers(audio, list(raw), _fake_embed(None), num_speakers=2)
    assert len({s.speaker for s in told}) == 2, "with a count, the brief voice keeps its own label"


def test_a_short_recording_with_only_brief_clusters_is_still_one_voice():
    """On a short call nothing reaches the reliability floor, and the step must not simply give up.

    Measured on the tester's own 3-minute recording, whose clusters were all a second or two: with no anchor
    to attach them to, the same voice came back as 18 "participants". The longest cluster is the anchor when
    nothing else qualifies.
    """
    # Cut lengths as the voice detector really produces them: a few longer turns, many short interjections.
    lengths = [7.0, 5.5, 4.0, 3.0, 2.5, 2.0, 2.0, 1.5, 1.5, 1.2, 1.0, 1.0, 0.8, 0.8, 0.6, 0.6, 0.5, 0.5]
    truth, raw, t = [], [], 0.0
    for i, length in enumerate(lengths):
        truth.append((t, t + length, 0))
        raw.append(_seg(t, t + length, i))
        t += length + 4.0
    audio = _audio_with_voices(truth, total_s=int(t) + 5)

    merged = diarize.merge_speakers(audio, raw, _noisy_embed(seed=3))

    assert len({s.speaker for s in merged}) == 1, sorted({s.speaker for s in merged})


def test_two_voices_are_kept_apart_even_when_neither_talks_for_long():
    """The anchor rule must not fuse people: clusters of comparable length are all anchors."""
    audio = _audio_with_voices([(0, 10, 0), (12, 22, 1), (24, 34, 0), (36, 46, 1)])
    raw = [_seg(0, 10, 0), _seg(12, 22, 1), _seg(24, 34, 2), _seg(36, 46, 3)]

    merged = diarize.merge_speakers(audio, raw, _fake_embed(None))

    assert len({s.speaker for s in merged}) == 2, merged
