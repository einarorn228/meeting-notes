#!/usr/bin/env bash
# Builds a standalone sidecar binary with PyInstaller into dist/fundarritari-stt/ (macOS/Linux).
set -euo pipefail
cd "$(dirname "$0")"
python3 -m venv .build-venv
source .build-venv/bin/activate
python -m pip install --upgrade pip
python -m pip install -r requirements.txt pyinstaller
pyinstaller --noconfirm fundarritari-stt.spec
echo "Built dist/fundarritari-stt"
