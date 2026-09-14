# fundarritari-stt — speech-to-text sidecar

Python service used by the Fundarritari desktop app for **local, private** transcription with
[faster-whisper](https://github.com/SYSTRAN/faster-whisper) and Icelandic fine-tuned Whisper models, plus
offline speaker diarization with [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx).

The app talks to it over stdin/stdout with JSON lines (see `PROTOCOL.md`). You normally never run it yourself:
Fundarritari creates a virtualenv in its data folder and installs this package automatically
(or uses the PyInstaller build shipped with the installer).

## Run manually

```bash
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
python -m fundarritari_stt
{"type":"hello"}
{"type":"load_model","model_id":"aalto-large-v3-is","repo":"Aalto-Speech-Synthesis/whisper-large-v3-Icelandic-finetuned-ct2","models_dir":"/tmp/models","device":"auto","compute_type":"auto"}
{"type":"transcribe_file","request_id":"r1","path":"/path/to/audio.wav","language":"is","vocabulary":[]}
```

## Tests

```bash
pip install pytest jiwer
pytest -q                 # fast unit tests
pytest -q --run-slow      # also loads the real model (minutes on CPU)
```

## Build a standalone binary

`./build.sh` (macOS/Linux) or `.\build.ps1` (Windows) → `dist/fundarritari-stt/`. Copy that folder to
`resources/sidecar-bin/<win|mac|linux>/fundarritari-stt/` in the app repository before running electron-builder,
and the app will prefer it over a system Python.

## Models

| id | Hugging Face repo | notes |
|---|---|---|
| `aalto-large-v3-is` | Aalto-Speech-Synthesis/whisper-large-v3-Icelandic-finetuned-ct2 | default, best Icelandic |
| `lvl-large-is` | language-and-voice-lab/whisper-large-icelandic-30k-steps-1000h-ct2 | alternative |
| `large-v3-turbo` | deepdml/faster-whisper-large-v3-turbo-ct2 | multilingual, fast |
| `large-v3` | Systran/faster-whisper-large-v3 | multilingual |
| `diarization` | csukuangfj/sherpa-onnx-pyannote-segmentation-3-0 + csukuangfj/speaker-embedding-models | speaker diarization |
