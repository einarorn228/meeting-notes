#!/usr/bin/env python3
"""Smoke-tests a built sidecar binary: does it start and answer `hello`?

CI builds the sidecar with PyInstaller on three platforms and ships it inside the installer. A binary that
crashes on startup (a missing hidden import, a bad entry point) still *builds* fine, and the failure reaches
the user only as "sidecar exited" long after release. So: spawn the real binary, speak the real protocol,
and fail the build if it does not reply.

With --full it also downloads the tiny Whisper model and transcribes a generated WAV, which exercises the
CTranslate2 and huggingface_hub native code paths -- the parts most likely to be mis-bundled per platform.

Usage: python scripts/smoke-sidecar.py <path-to-binary> [--full] [--timeout 120]
"""

from __future__ import annotations

import argparse
import json
import math
import queue
import struct
import subprocess
import sys
import tempfile
import threading
import time
import wave
from pathlib import Path


def write_test_wav(path: Path, seconds: float = 3.0, rate: int = 16000) -> None:
    """A quiet tone. The transcript is meaningless; what matters is that decoding runs and returns."""
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        frames = bytearray()
        for i in range(int(seconds * rate)):
            frames += struct.pack("<h", int(2000 * math.sin(2 * math.pi * 220 * i / rate)))
        w.writeframes(bytes(frames))


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("binary", type=Path)
    ap.add_argument("--timeout", type=float, default=120.0, help="seconds to wait for the ready event")
    ap.add_argument("--full", action="store_true", help="also download the tiny model and transcribe a WAV")
    args = ap.parse_args()

    if not args.binary.exists():
        print(f"FAIL: no binary at {args.binary}", file=sys.stderr)
        return 1

    # Absolute, because cwd= below is applied before the program name is resolved.
    binary = args.binary.resolve()
    proc = subprocess.Popen(
        [str(binary)],
        cwd=str(binary.parent),
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",
        errors="replace",
        bufsize=1,
    )

    errors: list[str] = []

    def drain_stderr() -> None:
        assert proc.stderr is not None
        for line in proc.stderr:
            errors.append(line.rstrip())

    threading.Thread(target=drain_stderr, daemon=True).start()

    events: "queue.Queue[dict]" = queue.Queue()

    def read_stdout() -> None:
        assert proc.stdout is not None
        for line in proc.stdout:
            line = line.strip()
            if not line:
                continue
            try:
                events.put(json.loads(line))
            except json.JSONDecodeError:
                print(f"  stdout (not JSON): {line[:200]}")

    threading.Thread(target=read_stdout, daemon=True).start()

    def fail(reason: str) -> int:
        print(f"FAIL: {reason}", file=sys.stderr)
        code = proc.poll()
        if code is not None:
            print(f"  process exited with code {code}", file=sys.stderr)
        if errors:
            print("  stderr:", file=sys.stderr)
            for line in errors[-40:]:
                print(f"    {line}", file=sys.stderr)
        proc.kill()
        return 1

    def send(cmd: dict) -> None:
        assert proc.stdin is not None
        proc.stdin.write(json.dumps(cmd) + "\n")
        proc.stdin.flush()

    def await_event(kind: str, timeout: float) -> dict | None:
        """Consumes events until `kind` arrives; an `error` event or a dead process ends the wait."""
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            try:
                event = events.get(timeout=1.0)
            except queue.Empty:
                if proc.poll() is not None:
                    return None
                continue
            kind_seen = event.get("type")
            if kind_seen not in ("progress", "status"):
                print(f"  event: {kind_seen}")
            if kind_seen == kind:
                return event
            if kind_seen == "error":
                print(f"  error event: {event.get('message')}", file=sys.stderr)
                return None
        return None

    send({"type": "hello"})
    ready = await_event("ready", args.timeout)
    if not ready:
        return fail("no `ready` event" + (" (process died)" if proc.poll() is not None else " within the timeout"))

    print(f"OK: sidecar ready (faster-whisper {ready.get('faster_whisper')}, cuda={ready.get('cuda')})")

    if args.full:
        work = Path(tempfile.mkdtemp(prefix="fundarritari-smoke-"))
        send({"type": "load_model", "model_id": "smoke-tiny", "repo": "Systran/faster-whisper-tiny",
              "models_dir": str(work), "device": "cpu", "compute_type": "int8"})
        if not await_event("model_loaded", 900):
            return fail("model download/load did not finish")
        print("OK: tiny model downloaded and loaded")

        wav = work / "tone.wav"
        write_test_wav(wav)
        send({"type": "transcribe_file", "request_id": "smoke", "path": str(wav), "language": "is"})
        if not await_event("file_done", 300):
            return fail("transcribe_file did not finish")
        print("OK: file transcription completed")

    try:
        proc.stdin.write(json.dumps({"type": "shutdown"}) + "\n")
        proc.stdin.flush()
        proc.wait(timeout=20)
    except Exception:
        proc.kill()
    return 0


if __name__ == "__main__":
    sys.exit(main())
