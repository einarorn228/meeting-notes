"""VAD-driven streaming transcription (see PROTOCOL.md, "Streaming algorithm").

Per channel a :class:`ChannelStream` keeps a rolling float32 buffer. Every ``vad_interval_s`` of
new audio Silero VAD runs on the buffer (on the ingest thread). Speech regions that ended at least
``min_silence_ms`` before the end of the buffer, or that exceed ``max_segment_s``, are cut (with
``pad_ms`` padding) and handed to the single :class:`TranscriptionWorker` thread. Non-speech audio
is discarded, which keeps memory bounded and starves Whisper of the silence it likes to hallucinate on.
"""

from __future__ import annotations

import logging
import queue
import threading
import time
from dataclasses import dataclass, field
from typing import Callable, Dict, List, Literal, Optional, Sequence

import numpy as np

from .audio import SAMPLE_RATE, decode_pcm_base64
from .engine import Transcriber
from .events import EventSink
from .postprocess import finalize_text
from .vocab import build_initial_prompt, normalize_vocabulary

log = logging.getLogger("fundarritari_stt.streaming")


@dataclass(frozen=True)
class StreamingOptions:
    sample_rate: int = SAMPLE_RATE
    vad_interval_s: float = 0.5
    min_silence_ms: int = 600
    max_segment_s: float = 24.0
    pad_ms: int = 200
    min_speech_ms: int = 250
    vad_threshold: float = 0.5
    partial_after_s: float = 6.0
    partial_interval_s: float = 4.0
    keep_tail_s: float = 1.0
    gap_tolerance_ms: int = 250
    vad_lead_in_s: float = 0.3
    beam_size: int = 5

    def samples(self, seconds: float) -> int:
        return int(round(seconds * self.sample_rate))


@dataclass
class SpeechRegion:
    """A speech region in buffer-relative samples. ``closed`` means silence followed it."""

    start: int
    end: int
    closed: bool


@dataclass
class Cut:
    """Audio handed to the transcription worker, with absolute session timestamps in seconds."""

    kind: Literal["final", "partial"]
    start: float
    end: float
    audio: np.ndarray


VadFunction = Callable[[np.ndarray, StreamingOptions], List[SpeechRegion]]


def detect_regions(audio: np.ndarray, opts: StreamingOptions) -> List[SpeechRegion]:
    """Run Silero VAD over ``audio`` and mark which regions have ended.

    The VAD itself enforces ``min_silence_ms`` before closing a region and splits regions longer
    than ``max_segment_s`` at the last short pause; only the trailing region can be open.

    Silero's recurrent state calibrates on the first frames it sees, and a buffer that starts in
    the middle of speech (e.g. right after a max-length split) is detected far less reliably, so a
    short run of digital silence is prepended and subtracted from the returned offsets again.
    """
    from faster_whisper.vad import VadOptions, get_speech_timestamps

    n = len(audio)
    if n < 1024:  # two VAD windows
        return []
    lead_in = opts.samples(opts.vad_lead_in_s)
    if lead_in > 0:
        audio = np.concatenate([np.zeros(lead_in, dtype=np.float32), np.asarray(audio, dtype=np.float32)])
    vad_options = VadOptions(
        threshold=opts.vad_threshold,
        min_speech_duration_ms=opts.min_speech_ms,
        max_speech_duration_s=opts.max_segment_s,
        min_silence_duration_ms=opts.min_silence_ms,
        speech_pad_ms=0,
    )
    timestamps = get_speech_timestamps(np.asarray(audio, dtype=np.float32), vad_options, opts.sample_rate)
    min_silence = opts.samples(opts.min_silence_ms / 1000.0)
    regions: List[SpeechRegion] = []
    for index, ts in enumerate(timestamps):
        start = max(0, int(ts["start"]) - lead_in)
        end = min(n, int(ts["end"]) - lead_in)
        if end <= start:
            continue
        closed = index < len(timestamps) - 1 or (n - end) >= min_silence
        regions.append(SpeechRegion(start=start, end=end, closed=closed))
    return regions


class ChannelStream:
    """Rolling audio buffer for one channel; turns incoming PCM into :class:`Cut` objects."""

    def __init__(self, opts: StreamingOptions, *, partials: bool = False, vad: VadFunction = detect_regions) -> None:
        self.opts = opts
        self.partials = partials
        self._vad = vad
        self._chunks: List[np.ndarray] = []
        self._buffered = 0  # samples currently held in _chunks
        self._buffer_start = 0  # absolute sample index of the first buffered sample
        self._since_vad = 0
        self._last_partial_end: Optional[int] = None  # absolute sample index of the last partial cut
        self.total_samples = 0

    # -- public API ---------------------------------------------------------------------------

    @property
    def buffered_seconds(self) -> float:
        return self._buffered / self.opts.sample_rate

    def feed(self, t_ms: Optional[int], samples: np.ndarray) -> List[Cut]:
        """Append audio that starts at session time ``t_ms`` and return any cuts that became ready."""
        samples = np.asarray(samples, dtype=np.float32)
        if samples.size == 0:
            return []
        cuts: List[Cut] = []
        if t_ms is not None:
            start_sample = int(round(t_ms * self.opts.sample_rate / 1000.0))
            if self._buffered == 0:
                self._buffer_start = start_sample
            else:
                expected = self._buffer_start + self._buffered
                gap_ms = (start_sample - expected) * 1000.0 / self.opts.sample_rate
                if gap_ms > self.opts.gap_tolerance_ms:
                    # A hole in the audio (e.g. after pause/resume): finish what we have and restart.
                    log.debug("audio gap of %.0f ms, flushing buffer", gap_ms)
                    cuts.extend(self.flush())
                    self._buffer_start = start_sample
        self._chunks.append(samples)
        self._buffered += len(samples)
        self._since_vad += len(samples)
        self.total_samples += len(samples)
        if self._since_vad >= self.opts.samples(self.opts.vad_interval_s):
            self._since_vad = 0
            cuts.extend(self._run_vad())
        return cuts

    def flush(self) -> List[Cut]:
        """Cut every speech region left in the buffer (used on stop and on audio gaps)."""
        audio = self._audio()
        cuts = [self._cut("final", audio, region) for region in self._vad(audio, self.opts)]
        self._reset_buffer(audio, len(audio))
        self._last_partial_end = None
        self._since_vad = 0
        return cuts

    # -- internals ----------------------------------------------------------------------------

    def _audio(self) -> np.ndarray:
        if len(self._chunks) == 1:
            return self._chunks[0]
        audio = np.concatenate(self._chunks) if self._chunks else np.zeros(0, dtype=np.float32)
        self._chunks = [audio] if len(audio) else []
        return audio

    def _run_vad(self) -> List[Cut]:
        audio = self._audio()
        regions = self._vad(audio, self.opts)
        max_segment = self.opts.samples(self.opts.max_segment_s)
        cuts: List[Cut] = []
        consumed = 0
        open_region: Optional[SpeechRegion] = None
        for region in regions:
            if region.closed or (region.end - region.start) >= max_segment:
                cuts.append(self._cut("final", audio, region))
                consumed = region.end
            else:
                open_region = region
        if cuts:
            self._last_partial_end = None
        if open_region is None:
            keep_from = max(consumed, len(audio) - self.opts.samples(self.opts.keep_tail_s))
        else:
            keep_from = consumed  # never trim inside speech that is still going on
            partial = self._maybe_partial(audio, open_region)
            if partial is not None:
                cuts.append(partial)
        self._reset_buffer(audio, keep_from)
        return cuts

    def _maybe_partial(self, audio: np.ndarray, region: SpeechRegion) -> Optional[Cut]:
        if not self.partials:
            return None
        if (region.end - region.start) < self.opts.samples(self.opts.partial_after_s):
            return None
        abs_end = self._buffer_start + region.end
        if self._last_partial_end is not None and (abs_end - self._last_partial_end) < self.opts.samples(
            self.opts.partial_interval_s
        ):
            return None
        self._last_partial_end = abs_end
        return self._cut("partial", audio, region)

    def _cut(self, kind: Literal["final", "partial"], audio: np.ndarray, region: SpeechRegion) -> Cut:
        pad = self.opts.samples(self.opts.pad_ms / 1000.0)
        start = max(0, region.start - pad)
        end = min(len(audio), region.end + pad)
        rate = float(self.opts.sample_rate)
        return Cut(
            kind=kind,
            start=(self._buffer_start + start) / rate,
            end=(self._buffer_start + end) / rate,
            audio=np.array(audio[start:end], dtype=np.float32, copy=True),
        )

    def _reset_buffer(self, audio: np.ndarray, keep_from: int) -> None:
        keep_from = max(0, min(keep_from, len(audio)))
        remaining = audio[keep_from:]
        self._chunks = [remaining] if len(remaining) else []
        self._buffered = len(remaining)
        self._buffer_start += keep_from


@dataclass
class Job:
    """One unit of work for the worker thread."""

    run: Callable[[], None]
    description: str = ""
    session_id: Optional[str] = None
    request_id: Optional[str] = None


class TranscriptionWorker:
    """Single background thread that owns all calls into the model, in FIFO order."""

    QUEUE_WARN_DEPTH = 20

    def __init__(self, emit: EventSink) -> None:
        self._emit = emit
        self._queue: "queue.Queue[Optional[Job]]" = queue.Queue()
        self._thread = threading.Thread(target=self._loop, name="stt-worker", daemon=True)
        self._stopping = threading.Event()
        self._warned_depth = False

    def start(self) -> "TranscriptionWorker":
        self._thread.start()
        return self

    @property
    def alive(self) -> bool:
        return self._thread.is_alive()

    def submit(self, job: Job) -> None:
        if self._stopping.is_set():
            return
        self._queue.put(job)
        depth = self._queue.qsize()
        if depth > self.QUEUE_WARN_DEPTH and not self._warned_depth:
            self._warned_depth = True
            log.warning("transcription backlog: %d jobs queued (machine too slow for real time?)", depth)
        elif depth <= self.QUEUE_WARN_DEPTH // 2:
            self._warned_depth = False

    def pending(self) -> int:
        """Jobs submitted but not yet finished."""
        return int(self._queue.unfinished_tasks)

    def wait_idle(self, timeout: Optional[float] = None) -> bool:
        """Block until every submitted job has finished. Returns False on timeout."""
        deadline = None if timeout is None else time.monotonic() + timeout
        while self._queue.unfinished_tasks:
            if deadline is not None and time.monotonic() >= deadline:
                return False
            time.sleep(0.02)
        return True

    def stop(self, timeout: float = 2.0) -> bool:
        """Ask the thread to finish and wait up to ``timeout`` seconds. Returns True if it exited."""
        self._stopping.set()
        self._queue.put(None)
        self._thread.join(timeout)
        return not self._thread.is_alive()

    def _loop(self) -> None:
        while True:
            job = self._queue.get()
            try:
                if job is None:
                    return
                if self._stopping.is_set():
                    continue
                job.run()
            except Exception as exc:  # noqa: BLE001 - a failing job must never kill the worker
                log.exception("job failed: %s", job.description if job else "")
                fields = {"message": f"{job.description}: {exc}" if job and job.description else str(exc), "fatal": False}
                if job and job.session_id:
                    fields["session_id"] = job.session_id
                if job and job.request_id:
                    fields["request_id"] = job.request_id
                self._emit.emit("error", **fields)
            finally:
                self._queue.task_done()


@dataclass
class _ChannelState:
    stream: ChannelStream
    generation: int = 0  # bumped on every final cut; partials from older generations are skipped
    partial_pending: bool = False
    lock: threading.Lock = field(default_factory=threading.Lock)


class StreamingSession:
    """One ``start`` ... ``stop`` session: VAD on the caller's thread, transcription on the worker."""

    def __init__(
        self,
        session_id: str,
        *,
        language: Optional[str],
        channels: Sequence[str],
        vocabulary: Optional[Sequence[object]],
        partials: bool,
        punctuated: bool,
        engine: Transcriber,
        worker: TranscriptionWorker,
        emit: EventSink,
        opts: StreamingOptions = StreamingOptions(),
        on_stopped: Optional[Callable[[str], None]] = None,
    ) -> None:
        self.session_id = session_id
        self.language = language
        self.partials = partials
        self.opts = opts
        self._engine = engine
        self._worker = worker
        self._emit = emit
        self._on_stopped = on_stopped
        self.vocabulary = normalize_vocabulary(vocabulary)
        self.initial_prompt = build_initial_prompt(self.vocabulary, language, punctuated)
        self.paused = False
        self.stopping = False
        self._channels: Dict[str, _ChannelState] = {}
        for channel in channels or ("mic",):
            self._channel(str(channel))

    def _channel(self, name: str) -> _ChannelState:
        state = self._channels.get(name)
        if state is None:
            state = _ChannelState(stream=ChannelStream(self.opts, partials=self.partials))
            self._channels[name] = state
        return state

    @property
    def channels(self) -> List[str]:
        return list(self._channels)

    def feed_base64(self, channel: str, t_ms: Optional[int], pcm_b64: str) -> None:
        self.feed(channel, t_ms, decode_pcm_base64(pcm_b64))

    def feed(self, channel: str, t_ms: Optional[int], samples: np.ndarray) -> None:
        if self.paused or self.stopping:
            return
        state = self._channel(channel)
        self._dispatch(channel, state, state.stream.feed(t_ms, samples))

    def pause(self, paused: bool) -> None:
        self.paused = bool(paused)

    def stop(self) -> None:
        """Flush every channel and queue the ``stopped`` event behind all pending transcriptions."""
        if self.stopping:
            return
        self.stopping = True
        for channel, state in self._channels.items():
            self._dispatch(channel, state, state.stream.flush())
        self._worker.submit(Job(run=self._finish, description="stop", session_id=self.session_id))
        self._report_drain()

    def _report_drain(self) -> None:
        """Emit the shrinking backlog while the queue drains.

        Stopping a long meeting can leave minutes of queued audio. Without this the app shows a spinner and
        no other sign of life, which is indistinguishable from a hang.
        """

        def run() -> None:
            last = -1
            while True:
                pending = self._worker.pending()
                if pending <= 0:
                    return
                if pending != last:
                    last = pending
                    self._emit.emit("finishing", session_id=self.session_id, pending=pending)
                time.sleep(1.0)

        threading.Thread(target=run, name="stt-drain-progress", daemon=True).start()

    # -- internals ----------------------------------------------------------------------------

    def _dispatch(self, channel: str, state: _ChannelState, cuts: List[Cut]) -> None:
        for cut in cuts:
            if cut.kind == "final":
                with state.lock:
                    state.generation += 1
                self._worker.submit(
                    Job(
                        run=lambda cut=cut, channel=channel: self._transcribe_final(channel, cut),
                        description=f"segment {channel} {cut.start:.2f}-{cut.end:.2f}",
                        session_id=self.session_id,
                    )
                )
            else:
                with state.lock:
                    if state.partial_pending:
                        continue  # one in-flight partial per channel is enough
                    state.partial_pending = True
                    generation = state.generation
                self._worker.submit(
                    Job(
                        run=lambda cut=cut, channel=channel, state=state, generation=generation: self._transcribe_partial(
                            channel, state, generation, cut
                        ),
                        description=f"partial {channel} {cut.start:.2f}",
                        session_id=self.session_id,
                    )
                )

    def _transcribe(self, cut: Cut) -> tuple[Optional[str], float, float]:
        result = self._engine.transcribe(
            cut.audio, language=self.language, initial_prompt=self.initial_prompt, beam_size=self.opts.beam_size
        )
        text = finalize_text(result.text, result.avg_logprob, result.no_speech_prob, self.vocabulary)
        return text, float(result.avg_logprob), float(result.no_speech_prob)

    def _transcribe_final(self, channel: str, cut: Cut) -> None:
        text, avg_logprob, no_speech_prob = self._transcribe(cut)
        if text is None:
            log.debug("dropped segment %s %.2f-%.2f", channel, cut.start, cut.end)
            return
        self._emit.emit(
            "segment",
            session_id=self.session_id,
            channel=channel,
            start=round(cut.start, 3),
            end=round(cut.end, 3),
            text=text,
            partial=False,
            avg_logprob=round(avg_logprob, 4),
            no_speech_prob=round(no_speech_prob, 4),
        )

    def _transcribe_partial(self, channel: str, state: _ChannelState, generation: int, cut: Cut) -> None:
        try:
            with state.lock:
                stale = state.generation != generation or self.stopping
            if stale:
                return  # the region was finalised meanwhile; a final segment is on its way
            text, _, _ = self._transcribe(cut)
            with state.lock:
                stale = state.generation != generation or self.stopping
            if text is None or stale:
                return
            self._emit.emit("partial", session_id=self.session_id, channel=channel, start=round(cut.start, 3), text=text)
        finally:
            with state.lock:
                state.partial_pending = False

    def _finish(self) -> None:
        self._emit.emit("stopped", session_id=self.session_id)
        if self._on_stopped is not None:
            self._on_stopped(self.session_id)
