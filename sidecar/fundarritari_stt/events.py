"""Thread-safe JSON-lines event output (stdout) and stderr logging."""

from __future__ import annotations

import json
import logging
import sys
import threading
from typing import Any, Protocol, TextIO

log = logging.getLogger("fundarritari_stt")


class EventSink(Protocol):
    """Anything that can emit protocol events (the real writer, or a test recorder)."""

    def emit(self, event_type: str, **fields: Any) -> None: ...


def _json_default(value: Any) -> Any:
    """Make numpy scalars and other odd values JSON serialisable."""
    item = getattr(value, "item", None)
    if callable(item):
        return item()
    if isinstance(value, (set, frozenset, tuple)):
        return list(value)
    return str(value)


class EventWriter:
    """Writes one JSON object per line to ``stream`` and flushes after every event.

    Only this class may write to stdout; everything else logs to stderr.
    """

    def __init__(self, stream: TextIO | None = None) -> None:
        self._stream = stream if stream is not None else sys.stdout
        self._lock = threading.Lock()

    def emit(self, event_type: str, **fields: Any) -> None:
        event = {"type": event_type, **fields}
        try:
            line = json.dumps(event, ensure_ascii=False, default=_json_default)
        except (TypeError, ValueError) as exc:  # should not happen, but never crash on output
            line = json.dumps({"type": "error", "message": f"unserialisable event: {exc}", "fatal": False})
        with self._lock:
            try:
                self._stream.write(line + "\n")
            except UnicodeEncodeError:
                # Non UTF-8 console: fall back to ASCII-escaped JSON, which is still valid JSON.
                self._stream.write(json.dumps(event, ensure_ascii=True, default=_json_default) + "\n")
            self._stream.flush()

    def log(self, level: str, message: str) -> None:
        """Emit a ``log`` event and mirror it to stderr."""
        log.log(logging.getLevelName(level.upper()) if isinstance(level, str) else logging.INFO, message)
        self.emit("log", level=level, message=message)


def configure_stderr_logging(level: int = logging.INFO) -> None:
    logging.basicConfig(
        stream=sys.stderr,
        level=level,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
