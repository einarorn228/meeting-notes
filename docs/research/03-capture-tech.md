# Research: capturing meeting audio on the desktop (Electron), Sept 2026

Verified versions: Electron 44.3.0 (Chromium 152), electron-builder 26.15, electron-vite 5, Azure Speech SDK 1.51.

## System audio loopback in Electron
- `session.setDisplayMediaRequestHandler(handler)` answering `{ video: source, audio: 'loopback' }` captures system
  audio (what the user hears from Teams/Zoom/Meet) without any virtual audio driver.
- **Windows:** supported since Electron 22 (WASAPI loopback). A video track must be requested (≥ 4×4 px, Electron 40
  regression with 0×0) and can be stopped right away.
- **macOS:** since Electron 39 Chromium uses the **Core Audio Tap API** on macOS 14.2+ (permission category "System
  Audio Recording Only", far less scary than screen recording). Requires `NSAudioCaptureUsageDescription` in Info.plist.
  If permission is missing the audio track is created in the `ended` state → the app detects this and shows help.
  Older macOS (13) uses ScreenCaptureKit and needs Screen & System Audio Recording permission.
- **Linux:** no first-class support; fallback is selecting the PulseAudio/PipeWire "Monitor of …" input device with
  getUserMedia (implemented in the app).
- Legacy `chromeMediaSource: 'desktop'` path is deprecated and crashes on Windows 11 — not used.

## What reference apps do
Hyprnote/anarlog (Rust: WASAPI loopback, Core Audio tap, Pulse monitor), Meetily (Tauri, WASAPI + Swift helper),
Granola (device-level capture, Me/Others by channel). All keep mic and system as separate streams.

## Local transcription integration
- **Chosen:** Python sidecar with faster-whisper (CTranslate2). The Icelandic models already exist in CT2 format;
  no ggml (whisper.cpp) conversion exists. faster-whisper bundles Silero VAD. CUDA optional.
- Realtime factor for large-class models: NVIDIA GPU 10–50× real time; Apple Silicon 1–2.6× (MLX/Metal);
  modern 8-core x86 CPU int8 ≈ 1–5×; thin laptops ≈ real time or slower → cloud engine recommended there.

## Streaming design (Whisper is not a streaming model)
Per channel: Silero VAD → cut on ≥ 600 ms silence or at 24 s → decode chunk → final segment. Optional partials by
re-decoding the growing chunk. Speaker = channel (mic → "Ég", system → "Aðrir"). Hallucination guards on silence.

## Cloud SDKs
- Azure: `microsoft-cognitiveservices-speech-sdk` in the main process, PushAudioInputStream PCM16 16 kHz,
  `SpeechRecognizer` or `ConversationTranscriber` (diarization), `PhraseListGrammar` for vocabulary.
- ElevenLabs: `wss://api.elevenlabs.io/v1/speech-to-text/realtime?model_id=scribe_v2_realtime&language_code=isl`;
  batch `POST /v1/speech-to-text` with `diarize=true`.
- OpenAI: `gpt-4o-transcribe-diarize` batch; Realtime transcription websocket.

## Packaging
electron-vite + electron-builder; sidecar binaries via `extraResources`, models downloaded to userData on first run;
macOS entitlements `com.apple.security.device.audio-input`, Info.plist microphone + audio capture usage strings.
