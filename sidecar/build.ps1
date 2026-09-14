# Builds a standalone sidecar binary with PyInstaller into dist\fundarritari-stt\ (Windows).
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot
py -3 -m venv .build-venv
.\.build-venv\Scripts\python.exe -m pip install --upgrade pip
.\.build-venv\Scripts\python.exe -m pip install -r requirements.txt pyinstaller
.\.build-venv\Scripts\pyinstaller.exe --noconfirm fundarritari-stt.spec
Write-Host "Built dist\fundarritari-stt"
