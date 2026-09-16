# Fundarritari – architecture

```
src/
  shared/types.ts          data model, settings, model catalogue, main→renderer event names (single contract)
  preload/index.ts         window.fundarritari API (contextBridge)
  main/
    index.ts               app lifecycle, window, tray, hotkeys, display-media (system audio loopback) handler,
                           fundarritari-audio:// protocol for playback, meeting/calendar notifications
    ipc.ts                 all IPC handlers; start/stop recording; post-processing pipeline
    session.ts             RecordingSession: PCM in → stereo WAV + engine, capture-health, live segments
    wav.ts                 streaming stereo WAV writer (left = mic, right = system); header lengths kept current
                           so a recording cut short by a crash is still a playable file
    store.ts               local-first storage: data/meetings/<id>/meeting.json + audio.wav, search,
                           startup recovery of meetings the app never finished
    settings.ts            settings.json with deep-merge defaults
    diarize.ts             speaker diarization of the system channel (via sidecar) → Þátttakandi 1..n
    transcription/
      types.ts             TranscriptionEngine interface (pushAudio per channel, segments with timestamps)
      local.ts + sidecar.ts   faster-whisper Python sidecar (install venv, download models, JSON-lines protocol)
      azure.ts             Azure AI Speech real-time (is-IS), ConversationTranscriber diarization, phrase lists
      elevenlabs.ts / openai.ts  cloud file APIs fed by the energy segmenter (chunked.ts + segmenter.ts)
    ai/
      llm.ts               Anthropic / OpenAI / Ollama
      prompts.ts           Icelandic prompts (fundargerð, punctuation restoration, chat)
      templates.ts         summary templates
      notes.ts             summarize, punctuate, chat, parse action items
    detect/apps.ts         meeting-app detection by process list (+ window titles on Windows)
    detect/calendar.ts     ICS calendar polling and reminders
    export.ts              Markdown, text, SRT, DOCX, HTML→PDF
  renderer/src/
    audio/capture.ts       getUserMedia (mic) + getDisplayMedia loopback (system) → AudioWorklet → PCM16 16 kHz;
                           one clock for both channels, and a channel whose device vanishes is reopened
    hooks/useRecordingController.tsx  owns capture handle + main session lifecycle
    pages/                 Home, Recording, MeetingDetail, Settings, Search, Onboarding
    i18n/                  Icelandic (default) and English dictionaries
sidecar/fundarritari_stt/  Python: faster-whisper streaming with Silero VAD, file transcription, diarization
```

## Recording pipeline
1. Renderer captures two MediaStreams. The main process answers `getDisplayMedia` with `audio: 'loopback'`
   (WASAPI on Windows, Core Audio taps on macOS 14.2+, PulseAudio monitor on Linux) and a throwaway screen video
   track that is stopped immediately.
2. An AudioWorklet in a 16 kHz AudioContext emits 100 ms PCM16 frames per channel with sample-accurate timestamps;
   they go to the main process over IPC (`audio:chunk`).
3. `RecordingSession` writes the stereo WAV and feeds the engine. The local engine streams base64 PCM to the
   Python sidecar, which runs Silero VAD per channel, cuts speech on ≥ 600 ms silence (max 24 s), decodes each
   chunk with the Icelandic Whisper model (`without_timestamps=True`, vocabulary prompt), guards against
   hallucinations, and returns final segments (and optional partials).
4. Segments are merged by start time; speaker = `me` (mic) or `others` (system); the UI shows them live.
5. On stop: diarization of the system channel (sherpa-onnx pyannote segmentation + speaker embeddings) assigns
   `spk1..n` labels, the LLM restores punctuation/casing (the Icelandic models write lowercase), and the
   summary template produces the fundargerð. Each step broadcasts `ai:progress`.

## Why these choices
See `docs/research/*.md`. In short: stock Whisper is unusable for Icelandic (38 % WER); the Aalto fine-tune is the
best open model and is trained on conversational data; Azure is the only cloud with Icelandic real-time
diarization; Claude Opus 5 has the best Icelandic grammar/inflection scores on Miðeind's leaderboard.
