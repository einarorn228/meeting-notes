# -*- mode: python ; coding: utf-8 -*-
# PyInstaller spec for the Fundarritari speech-to-text sidecar (onedir build).
# Build:  pyinstaller fundarritari-stt.spec   (run from the sidecar/ directory inside a venv with requirements installed)
from PyInstaller.utils.hooks import collect_all, collect_submodules

datas, binaries, hiddenimports = [], [], []
for pkg in ("faster_whisper", "ctranslate2", "onnxruntime", "tokenizers", "huggingface_hub", "sherpa_onnx", "av"):
    try:
        d, b, h = collect_all(pkg)
        datas += d
        binaries += b
        hiddenimports += h
    except Exception:  # optional packages
        pass
hiddenimports += collect_submodules("fundarritari_stt")

a = Analysis(
    # Must be the wrapper, not fundarritari_stt/__main__.py: PyInstaller runs the analysed script without a
    # package context, so the package module's relative imports would fail at startup. See sidecar_main.py.
    ["sidecar_main.py"],
    pathex=["."],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    runtime_hooks=[],
    excludes=["torch", "torchaudio", "tkinter", "matplotlib"],
    noarchive=False,
)
pyz = PYZ(a.pure)
exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="fundarritari-stt",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=True,
    disable_windowed_traceback=False,
)
coll = COLLECT(exe, a.binaries, a.datas, strip=False, upx=False, name="fundarritari-stt")
