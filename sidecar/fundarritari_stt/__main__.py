"""Entry point: ``python -m fundarritari_stt`` (or the ``fundarritari-stt`` console script)."""

from __future__ import annotations

import argparse
import logging
import os
import sys
import threading

from . import __version__
from .events import configure_stderr_logging


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="fundarritari-stt", description="Fundarritari speech-to-text sidecar")
    parser.add_argument("--version", action="version", version=f"fundarritari-stt {__version__}")
    parser.add_argument("--log-level", default=os.environ.get("FUNDARRITARI_LOG_LEVEL", "INFO"))
    args = parser.parse_args(argv)
    configure_stderr_logging(getattr(logging, str(args.log_level).upper(), logging.INFO))

    from .server import serve

    code = serve()
    sys.stdout.flush()
    sys.stderr.flush()
    if any(t.is_alive() and t.daemon and t is not threading.current_thread() for t in threading.enumerate()):
        # A transcription is still running inside CTranslate2; a hard exit avoids interpreter
        # teardown racing with the native thread.
        os._exit(code)
    return code


if __name__ == "__main__":
    sys.exit(main())
