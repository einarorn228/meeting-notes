"""The stdio protocol loop: JSON-lines commands in, JSON-lines events out (see PROTOCOL.md)."""

from __future__ import annotations

import json
import logging
import os
import platform
import sys
import threading
from typing import Any, Callable, Dict, Optional, TextIO

from . import __version__, models
from .engine import WhisperEngine, cuda_available
from .events import EventSink
from .filetranscribe import transcribe_file
from .diarize import diarize_file
from .streaming import Job, StreamingOptions, StreamingSession, TranscriptionWorker

log = logging.getLogger("fundarritari_stt.server")


class CommandError(Exception):
    """A malformed or inapplicable command; reported as a non-fatal ``error`` event."""


def _require(cmd: Dict[str, Any], field: str, kind: type | tuple = str) -> Any:
    value = cmd.get(field)
    if value is None or (kind is not object and not isinstance(value, kind)) or (kind is str and not value):
        raise CommandError(f"'{cmd.get('type')}' requires field '{field}'")
    return value


class Server:
    """Dispatches commands. Cheap commands run on the reader thread; model work goes to the worker."""

    def __init__(
        self,
        stdin: TextIO,
        emit: EventSink,
        *,
        engine: Optional[WhisperEngine] = None,
        worker: Optional[TranscriptionWorker] = None,
        opts: StreamingOptions = StreamingOptions(),
        download_fn: Callable[..., Any] = models.download_model,
    ) -> None:
        self._stdin = stdin
        self._emit = emit
        self.engine = engine if engine is not None else WhisperEngine()
        self.worker = worker if worker is not None else TranscriptionWorker(emit).start()
        self.opts = opts
        self._download = download_fn
        self._sessions: Dict[str, StreamingSession] = {}
        self._sessions_lock = threading.Lock()
        self._unknown_sessions_warned: set[str] = set()
        self._shutdown = threading.Event()
        self._handlers: Dict[str, Callable[[Dict[str, Any]], None]] = {
            "hello": self.cmd_hello,
            "list_models": self.cmd_list_models,
            "download_model": self.cmd_download_model,
            "load_model": self.cmd_load_model,
            "start": self.cmd_start,
            "audio": self.cmd_audio,
            "pause": self.cmd_pause,
            "stop": self.cmd_stop,
            "transcribe_file": self.cmd_transcribe_file,
            "diarize_file": self.cmd_diarize_file,
            "shutdown": self.cmd_shutdown,
        }

    # -- main loop ----------------------------------------------------------------------------

    def run(self) -> int:
        """Read commands until ``shutdown`` or EOF. Returns the process exit code."""
        self._emit.emit("status", state="idle", message="sidecar started")
        while not self._shutdown.is_set():
            try:
                line = self._stdin.readline()
            except (OSError, ValueError) as exc:
                log.error("stdin read failed: %s", exc)
                break
            if line == "":
                log.info("stdin closed, shutting down")
                break
            self.handle_line(line)
        self.close()
        return 0

    def handle_line(self, line: str) -> None:
        line = line.strip()
        if not line:
            return
        try:
            cmd = json.loads(line)
        except json.JSONDecodeError as exc:
            self._error(f"invalid JSON command: {exc.msg}")
            return
        if not isinstance(cmd, dict):
            self._error("command must be a JSON object")
            return
        self.handle(cmd)

    def handle(self, cmd: Dict[str, Any]) -> None:
        """Dispatch one parsed command; never raises."""
        cmd_type = cmd.get("type")
        handler = self._handlers.get(cmd_type) if isinstance(cmd_type, str) else None
        if handler is None:
            self._error(f"unknown command type {cmd_type!r}")
            return
        try:
            handler(cmd)
        except CommandError as exc:
            self._error(str(exc), session_id=cmd.get("session_id"), request_id=cmd.get("request_id"))
        except Exception as exc:  # noqa: BLE001 - a broken command must never take the process down
            log.exception("command %s failed", cmd_type)
            self._error(f"{cmd_type}: {exc}", session_id=cmd.get("session_id"), request_id=cmd.get("request_id"))

    def close(self) -> None:
        """Stop the worker and abandon the sessions (the app sends ``stop`` before ``shutdown``)."""
        with self._sessions_lock:
            self._sessions.clear()
        if not self.worker.stop(timeout=3.0):
            log.warning("worker still busy at shutdown; exiting anyway")

    # -- helpers ------------------------------------------------------------------------------

    def _error(self, message: str, *, fatal: bool = False, **ids: Any) -> None:
        log.error(message)
        fields = {key: value for key, value in ids.items() if value}
        self._emit.emit("error", message=message, fatal=fatal, **fields)

    def _status(self, state: str, message: str = "", **extra: Any) -> None:
        fields: Dict[str, Any] = {"state": state, "message": message}
        if self.engine.model_id:
            fields.setdefault("model_id", self.engine.model_id)
        if self.engine.device:
            fields.setdefault("device", self.engine.device)
        fields.update(extra)
        self._emit.emit("status", **fields)

    def _idle_or_ready(self) -> str:
        return "ready" if self.engine.loaded else "idle"

    def _session(self, cmd: Dict[str, Any]) -> StreamingSession:
        session_id = _require(cmd, "session_id")
        with self._sessions_lock:
            session = self._sessions.get(session_id)
        if session is None:
            raise CommandError(f"unknown session {session_id!r}")
        return session

    def _forget_session(self, session_id: str) -> None:
        with self._sessions_lock:
            self._sessions.pop(session_id, None)

    # -- commands -----------------------------------------------------------------------------

    def cmd_hello(self, cmd: Dict[str, Any]) -> None:
        try:
            import faster_whisper

            fw_version = getattr(faster_whisper, "__version__", "unknown")
        except Exception:  # noqa: BLE001
            fw_version = "missing"
        self._emit.emit(
            "ready",
            version=__version__,
            cuda=cuda_available(),
            python=platform.python_version(),
            faster_whisper=fw_version,
        )

    def cmd_list_models(self, cmd: Dict[str, Any]) -> None:
        models_dir = _require(cmd, "models_dir")
        self._emit.emit("models", installed=models.list_installed(models_dir))

    def cmd_download_model(self, cmd: Dict[str, Any]) -> None:
        model_id = _require(cmd, "model_id")
        repo = _require(cmd, "repo")
        models_dir = _require(cmd, "models_dir")
        models.model_dir(models_dir, model_id)  # validates the id early

        def run() -> None:
            try:
                self._download(model_id, repo, models_dir, self._emit)
                self._emit.emit("model_downloaded", model_id=model_id)
                self._status(self._idle_or_ready(), f"{model_id} downloaded")
            except Exception as exc:  # noqa: BLE001
                log.exception("download of %s failed", model_id)
                self._status("error", str(exc), model_id=model_id)
                self._error(f"download of {model_id} failed: {exc}")

        threading.Thread(target=run, name=f"download-{model_id}", daemon=True).start()

    def cmd_load_model(self, cmd: Dict[str, Any]) -> None:
        model_id = _require(cmd, "model_id")
        repo = _require(cmd, "repo")
        models_dir = _require(cmd, "models_dir")
        device = cmd.get("device") or "auto"
        compute_type = cmd.get("compute_type") or "auto"
        threads = cmd.get("threads")
        if threads is not None and (not isinstance(threads, int) or threads <= 0):
            raise CommandError("'threads' must be a positive integer")
        path = models.model_dir(models_dir, model_id)

        def run() -> None:
            try:
                if not models.is_installed(path):
                    self._download(model_id, repo, models_dir, self._emit)
                    self._emit.emit("model_downloaded", model_id=model_id)
                self._status("loading-model", f"Loading {model_id}", model_id=model_id)
                info = self.engine.load(
                    str(path), model_id=model_id, device=device, compute_type=compute_type, threads=threads
                )
                self._emit.emit(
                    "model_loaded",
                    model_id=info.model_id,
                    device=info.device,
                    compute_type=info.compute_type,
                    load_seconds=round(info.load_seconds, 2),
                )
                self._status("ready", f"{model_id} ready on {info.device}")
            except Exception as exc:  # noqa: BLE001
                log.exception("loading %s failed", model_id)
                self._status("error", str(exc), model_id=model_id)
                self._error(f"loading {model_id} failed: {exc}")

        self.worker.submit(Job(run=run, description=f"load_model {model_id}"))

    def cmd_start(self, cmd: Dict[str, Any]) -> None:
        session_id = _require(cmd, "session_id")
        channels = cmd.get("channels") or ["mic"]
        if not isinstance(channels, list) or not all(isinstance(c, str) and c for c in channels):
            raise CommandError("'channels' must be a list of channel names")
        vocabulary = cmd.get("vocabulary") or []
        if not isinstance(vocabulary, list):
            raise CommandError("'vocabulary' must be a list of strings")
        language = cmd.get("language") or "is"
        punctuated = cmd.get("punctuated")
        if punctuated is None:
            punctuated = models.is_punctuated(self.engine.model_id)
        with self._sessions_lock:
            if session_id in self._sessions:
                raise CommandError(f"session {session_id!r} already running")
            self._sessions[session_id] = StreamingSession(
                session_id,
                language=language,
                channels=channels,
                vocabulary=vocabulary,
                partials=bool(cmd.get("partials", False)),
                punctuated=bool(punctuated),
                engine=self.engine,
                worker=self.worker,
                emit=self._emit,
                opts=self.opts,
                on_stopped=self._forget_session,
            )
        self._unknown_sessions_warned.discard(session_id)
        if not self.engine.loaded:
            log.warning("session %s started before a model was loaded; audio will queue behind load_model", session_id)
        log.info("session %s started (language=%s, channels=%s, partials=%s)", session_id, language, channels, cmd.get("partials"))

    def cmd_audio(self, cmd: Dict[str, Any]) -> None:
        session_id = cmd.get("session_id")
        with self._sessions_lock:
            session = self._sessions.get(session_id) if isinstance(session_id, str) else None
        if session is None:
            # Chunks arrive ~10x per second; complain once per session instead of flooding.
            if isinstance(session_id, str) and session_id not in self._unknown_sessions_warned:
                self._unknown_sessions_warned.add(session_id)
                self._error(f"audio for unknown session {session_id!r} (ignored)", session_id=session_id)
            return
        channel = cmd.get("channel") or "mic"
        pcm = cmd.get("pcm")
        if not isinstance(pcm, str):
            raise CommandError("'audio' requires base64 field 'pcm'")
        t_ms = cmd.get("t_ms")
        if t_ms is not None and not isinstance(t_ms, (int, float)):
            raise CommandError("'t_ms' must be a number")
        session.feed_base64(str(channel), None if t_ms is None else int(t_ms), pcm)

    def cmd_pause(self, cmd: Dict[str, Any]) -> None:
        self._session(cmd).pause(bool(cmd.get("paused", True)))

    def cmd_stop(self, cmd: Dict[str, Any]) -> None:
        session = self._session(cmd)
        log.info("stopping session %s", session.session_id)
        session.stop()

    def cmd_transcribe_file(self, cmd: Dict[str, Any]) -> None:
        request_id = _require(cmd, "request_id")
        path = _require(cmd, "path")
        if not os.path.isfile(path):
            raise CommandError(f"file not found: {path}")
        channels_map = cmd.get("channels_map")
        if channels_map is not None and not isinstance(channels_map, dict):
            raise CommandError("'channels_map' must be an object like {\"0\": \"mic\", \"1\": \"system\"}")
        vocabulary = cmd.get("vocabulary") or []
        language = cmd.get("language") or "is"
        punctuated = cmd.get("punctuated")

        def run() -> None:
            transcribe_file(
                request_id,
                path,
                engine=self.engine,
                emit=self._emit,
                language=language,
                vocabulary=vocabulary,
                channels_map=channels_map,
                punctuated=bool(models.is_punctuated(self.engine.model_id) if punctuated is None else punctuated),
                opts=self.opts,
            )

        self.worker.submit(Job(run=run, description=f"transcribe_file {request_id}", request_id=request_id))

    def cmd_diarize_file(self, cmd: Dict[str, Any]) -> None:
        request_id = _require(cmd, "request_id")
        path = _require(cmd, "path")
        models_dir = _require(cmd, "models_dir")
        if not os.path.isfile(path):
            raise CommandError(f"file not found: {path}")
        channel = cmd.get("channel")
        if channel is not None and not isinstance(channel, int):
            raise CommandError("'channel' must be an integer index or null")
        threshold = float(cmd.get("threshold") or 0.55)
        num_speakers = int(cmd.get("num_speakers") or -1)

        def run() -> None:
            diarize_file(
                request_id,
                path,
                models_dir=models_dir,
                emit=self._emit,
                channel=channel,
                threshold=threshold,
                num_speakers=num_speakers,
            )

        threading.Thread(target=run, name=f"diarize-{request_id}", daemon=True).start()

    def cmd_shutdown(self, cmd: Dict[str, Any]) -> None:
        log.info("shutdown requested")
        self._shutdown.set()


def serve(stdin: Optional[TextIO] = None, stdout: Optional[TextIO] = None) -> int:
    """Run a server on real stdio with UTF-8 streams. Returns the exit code."""
    from .events import EventWriter

    in_stream = stdin if stdin is not None else sys.stdin
    out_stream = stdout if stdout is not None else sys.stdout
    for stream in (in_stream, out_stream):
        reconfigure = getattr(stream, "reconfigure", None)
        if callable(reconfigure):
            try:
                reconfigure(encoding="utf-8", errors="replace")
            except (ValueError, OSError):
                pass
    return Server(in_stream, EventWriter(out_stream)).run()
