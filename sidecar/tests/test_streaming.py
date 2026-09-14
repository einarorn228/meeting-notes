"""VAD segmentation logic with synthetic audio (real Silero VAD, no Whisper model)."""

from __future__ import annotations

from typing import List

import numpy as np
import pytest

from fundarritari_stt.streaming import ChannelStream, Cut, StreamingOptions, StreamingSession, TranscriptionWorker, detect_regions

from .conftest import SR, FakeEngine, RecordingSink, noise, silence, speech

OPTS = StreamingOptions()
CHUNK = int(0.1 * SR)  # 100 ms, as the Electron app sends it


def feed_all(stream: ChannelStream, audio: np.ndarray, start_ms: int = 0) -> List[Cut]:
    cuts: List[Cut] = []
    for offset in range(0, len(audio), CHUNK):
        t_ms = start_ms + offset * 1000 // SR
        cuts.extend(stream.feed(t_ms, audio[offset : offset + CHUNK]))
    return cuts


def test_detect_regions_marks_closed_and_open():
    audio = np.concatenate([silence(1.0), speech(2.0), silence(2.0), speech(1.5)])
    regions = detect_regions(audio, OPTS)
    assert len(regions) == 2
    assert regions[0].closed and not regions[1].closed
    assert regions[0].start / SR == pytest.approx(1.0, abs=0.15)
    assert regions[0].end / SR == pytest.approx(3.0, abs=0.15)
    assert regions[1].end == len(audio)
    assert detect_regions(silence(0.05), OPTS) == []


def test_noise_bursts_are_not_speech():
    audio = np.concatenate([silence(1.0), noise(2.0), silence(2.0)])
    assert detect_regions(audio, OPTS) == []
    stream = ChannelStream(OPTS)
    assert feed_all(stream, audio) == []
    assert stream.flush() == []


def test_two_utterances_are_cut_with_absolute_timestamps_and_padding():
    audio = np.concatenate([silence(1.0), speech(2.0), silence(1.5), speech(3.0, seed=1), silence(1.0)])
    stream = ChannelStream(OPTS)
    cuts = feed_all(stream, audio)
    finals = [c for c in cuts if c.kind == "final"]
    assert len(finals) == 2
    first, second = finals
    assert first.start == pytest.approx(0.8, abs=0.2)  # 1.0 s onset minus 200 ms padding
    assert first.end == pytest.approx(3.2, abs=0.2)
    assert second.start == pytest.approx(4.3, abs=0.2)
    assert second.end == pytest.approx(7.7, abs=0.2)
    assert first.end <= second.start
    for cut in finals:
        assert len(cut.audio) == pytest.approx((cut.end - cut.start) * SR, abs=1)
    # Everything is done: the trailing silence leaves nothing to flush and only a short tail is kept.
    assert stream.flush() == []
    assert stream.buffered_seconds <= OPTS.keep_tail_s + 0.5


def test_flush_cuts_the_open_region():
    stream = ChannelStream(OPTS)
    cuts = feed_all(stream, np.concatenate([silence(0.5), speech(2.0)]))
    assert cuts == []  # speech is still going on: nothing has been cut
    flushed = stream.flush()
    assert len(flushed) == 1 and flushed[0].kind == "final"
    assert flushed[0].start == pytest.approx(0.3, abs=0.2)
    assert flushed[0].end == pytest.approx(2.5, abs=0.1)
    assert stream.buffered_seconds == 0


def test_long_speech_is_split_at_max_segment():
    stream = ChannelStream(OPTS)
    cuts = feed_all(stream, np.concatenate([speech(30.0), silence(1.0)]))
    finals = [c for c in cuts if c.kind == "final"]
    assert len(finals) == 2
    assert finals[0].start == pytest.approx(0.0, abs=0.05)
    assert OPTS.max_segment_s - 1.0 <= finals[0].end - finals[0].start <= OPTS.max_segment_s + 0.5
    assert finals[1].start == pytest.approx(finals[0].end, abs=0.5)
    assert finals[1].end == pytest.approx(30.2, abs=0.3)
    assert stream.buffered_seconds <= OPTS.keep_tail_s + 0.5


def test_buffer_stays_bounded_during_silence():
    stream = ChannelStream(OPTS)
    feed_all(stream, silence(60.0))
    assert stream.buffered_seconds <= OPTS.keep_tail_s + OPTS.vad_interval_s


def test_gap_in_timestamps_flushes_and_restarts_clock():
    stream = ChannelStream(OPTS)
    cuts = feed_all(stream, np.concatenate([silence(0.5), speech(2.0)]), start_ms=0)
    assert cuts == []
    # 10 s later (e.g. after pause/resume) more audio arrives with a matching t_ms.
    cuts = feed_all(stream, np.concatenate([speech(1.0, seed=2), silence(1.5)]), start_ms=12_500)
    finals = [c for c in cuts if c.kind == "final"]
    assert len(finals) == 2
    assert finals[0].end == pytest.approx(2.5, abs=0.1)
    assert finals[1].start == pytest.approx(12.5, abs=0.25)
    assert finals[1].end == pytest.approx(13.7, abs=0.25)


def test_partials_after_six_seconds_every_four_seconds():
    stream = ChannelStream(OPTS, partials=True)
    cuts = feed_all(stream, np.concatenate([silence(0.5), speech(15.0), silence(1.0)]))
    partials = [c for c in cuts if c.kind == "partial"]
    finals = [c for c in cuts if c.kind == "final"]
    assert len(finals) == 1
    assert [round(p.end) for p in partials] == [7, 11, 15]
    assert all(p.start == pytest.approx(finals[0].start, abs=0.2) for p in partials)
    assert all(len(p.audio) > 6 * SR for p in partials)
    # Without partials nothing but finals is produced.
    plain = ChannelStream(OPTS, partials=False)
    assert all(c.kind == "final" for c in feed_all(plain, np.concatenate([silence(0.5), speech(15.0), silence(1.0)])))


def test_session_emits_segments_partials_and_stopped_in_order(sink: RecordingSink):
    engine = FakeEngine(delay=0.05)
    worker = TranscriptionWorker(sink).start()
    try:
        session = StreamingSession(
            "s1", language="is", channels=["mic", "system"], vocabulary=["Chunk"], partials=True,
            punctuated=False, engine=engine, worker=worker, emit=sink,
        )
        audio = np.concatenate([silence(0.5), speech(8.0), silence(1.0)])
        for offset in range(0, len(audio), CHUNK):
            session.feed("mic", offset * 1000 // SR, audio[offset : offset + CHUNK])
        session.feed("system", 0, silence(2.0))
        session.stop()
        sink.wait_for(lambda e: e["type"] == "stopped", timeout=10)
    finally:
        worker.stop()
    types = [e["type"] for e in sink.events]
    assert types[-1] == "stopped"
    segments = sink.of_type("segment")
    assert len(segments) == 1 and segments[0]["channel"] == "mic" and segments[0]["session_id"] == "s1"
    assert segments[0]["partial"] is False
    assert segments[0]["text"].startswith("Chunk ")  # vocabulary casing applied
    assert 0.0 <= segments[0]["start"] < segments[0]["end"] <= 9.5
    partials = sink.of_type("partial")
    assert len(partials) == 1 and partials[0]["channel"] == "mic" and "start" in partials[0]
    assert engine.calls[0]["initial_prompt"] == "fundur nöfn og hugtök chunk"
    assert engine.calls[0]["language"] == "is"


def test_stale_partials_are_skipped_and_stop_waits_for_worker(sink: RecordingSink):
    engine = FakeEngine(delay=0.6)
    worker = TranscriptionWorker(sink).start()
    try:
        session = StreamingSession("s2", language="is", channels=["mic"], vocabulary=[], partials=True,
                                   punctuated=False, engine=engine, worker=worker, emit=sink)
        # Feed everything at once: partial cuts and the final cut land in the queue back to back,
        # so by the time the partial job runs its region is already finalised.
        audio = np.concatenate([silence(0.5), speech(7.0), silence(1.0)])
        for offset in range(0, len(audio), CHUNK):
            session.feed("mic", offset * 1000 // SR, audio[offset : offset + CHUNK])
        session.stop()
        session.feed("mic", 9000, speech(1.0))  # ignored after stop
        sink.wait_for(lambda e: e["type"] == "stopped", timeout=10)
    finally:
        worker.stop()
    assert sink.of_type("partial") == []
    assert len(sink.of_type("segment")) == 1
    assert [e["type"] for e in sink.events][-1] == "stopped"


def test_hallucinated_segments_are_dropped(sink: RecordingSink):
    engine = FakeEngine(text_fn=lambda audio: "já já já já já já")
    worker = TranscriptionWorker(sink).start()
    try:
        session = StreamingSession("s3", language="is", channels=["mic"], vocabulary=[], partials=False,
                                   punctuated=False, engine=engine, worker=worker, emit=sink)
        session.feed("mic", 0, np.concatenate([silence(0.5), speech(2.0), silence(1.0)]))
        session.stop()
        sink.wait_for(lambda e: e["type"] == "stopped", timeout=10)
        assert sink.of_type("segment") == []
        engine.text_fn = lambda audio: "eitthvað"
        engine.no_speech_prob, engine.avg_logprob = 0.95, -1.4
        session = StreamingSession("s4", language="is", channels=["mic"], vocabulary=[], partials=False,
                                   punctuated=False, engine=engine, worker=worker, emit=sink)
        session.feed("mic", 0, np.concatenate([silence(0.5), speech(2.0), silence(1.0)]))
        session.stop()
        sink.wait_for(lambda e: e["type"] == "stopped" and e["session_id"] == "s4", timeout=10)
        assert sink.of_type("segment") == []
    finally:
        worker.stop()


def test_worker_reports_job_errors_and_keeps_running(sink: RecordingSink):
    class Broken(FakeEngine):
        def transcribe(self, audio, **kwargs):
            raise RuntimeError("boom")

    worker = TranscriptionWorker(sink).start()
    try:
        session = StreamingSession("s5", language="is", channels=["mic"], vocabulary=[], partials=False,
                                   punctuated=False, engine=Broken(), worker=worker, emit=sink)
        session.feed("mic", 0, np.concatenate([silence(0.5), speech(2.0), silence(1.0)]))
        session.stop()
        sink.wait_for(lambda e: e["type"] == "stopped", timeout=10)
    finally:
        worker.stop()
    errors = sink.of_type("error")
    assert len(errors) == 1 and "boom" in errors[0]["message"] and errors[0]["session_id"] == "s5"
    assert errors[0]["fatal"] is False
