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
