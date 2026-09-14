"""Guards the PyInstaller entry point.

PyInstaller executes the analysed script as a top-level ``__main__`` with no package context. Pointing the
spec at ``fundarritari_stt/__main__.py`` therefore produced a binary that died on startup with
``ImportError: attempted relative import with no known parent package`` -- which reached the app only as
"sidecar exited". This test runs whatever the spec analyses the same way PyInstaller will.
"""

from __future__ import annotations

import re
import subprocess
import sys
from pathlib import Path

SIDECAR = Path(__file__).resolve().parents[1]
SPEC = SIDECAR / "fundarritari-stt.spec"


def spec_entry_script() -> Path:
    text = SPEC.read_text(encoding="utf-8")
    body = text[text.index("Analysis(") :]
    match = re.search(r"\[\s*(?:#[^\n]*\n\s*)*[\"']([^\"']+)[\"']", body)
    assert match, "could not find the analysed script in the PyInstaller spec"
    return SIDECAR / match.group(1)


def test_pyinstaller_entry_script_runs_standalone() -> None:
    script = spec_entry_script()
    assert script.is_file(), f"{script} does not exist"
    result = subprocess.run(
        [sys.executable, str(script), "--version"],
        cwd=SIDECAR,
        capture_output=True,
        text=True,
    )
    assert result.returncode == 0, f"entry script failed as a top-level script:\n{result.stderr}"
