# Fundarritari STT sidecar protocol (stdio, JSON lines)

The Electron main process spawns `python -m fundarritari_stt` (or the PyInstaller binary
`fundarritari-stt`). Each line on stdin is one JSON object (a *command*); each line on stdout is one JSON
object (an *event*). stderr is free-form logging. Audio is PCM16 little-endian mono 16 kHz, base64 encoded.

## Commands (stdin)

| type | fields | meaning |
|---|---|---|
| `hello` | – | reply with `ready` info (version, device availability) |
| `list_models` | `models_dir` | reply `models` with installed model ids |
| `download_model` | `model_id`, `repo`, `models_dir` | download (huggingface_hub snapshot) with `progress` events, then `model_downloaded` |
| `load_model` | `model_id`, `repo`, `models_dir`, `device` (`auto|cpu|cuda`), `compute_type` (`auto|int8|float16|float32`), `threads` (int, optional) | load model (download if missing); emits `status` `loading-model`, then `model_loaded` |
| `start` | `session_id`, `language` (`is`, `en`, `auto`), `channels` (`["mic","system"]`), `vocabulary` (list of strings), `partials` (bool), `punctuated` (bool: model writes punctuation itself) | begin a streaming session |
| `audio` | `session_id`, `channel`, `t_ms` (int, ms since session start of the first sample), `pcm` (base64 PCM16) | audio chunk (typically 100 ms) |
| `pause` | `session_id`, `paused` (bool) | pause/resume; while paused audio chunks are ignored |
| `stop` | `session_id` | flush: transcribe remaining speech in every channel, emit final `segment`s, then `stopped` |
| `transcribe_file` | `request_id`, `path`, `language`, `vocabulary`, `channels_map` (optional: `{"0":"mic","1":"system"}` for stereo files) | offline transcription of a WAV/any file, emits `segment`s with `request_id`, then `file_done` |
| `shutdown` | – | exit |

## Events (stdout)

| type | fields |
|---|---|
| `ready` | `version`, `cuda` (bool), `python`, `faster_whisper` |
| `status` | `state` (`idle|loading-model|downloading-model|ready|error`), `message`, `progress` (0..1, optional), `model_id`, `device` |
| `progress` | `model_id`, `progress` (0..1), `downloaded_mb`, `total_mb` |
| `models` | `installed` (list of ids) |
| `model_downloaded` | `model_id` |
| `model_loaded` | `model_id`, `device`, `compute_type`, `load_seconds` |
| `pending` | `session_id`, `channel`, `seg_id`, `start` (s), `end` (s), `queue` (jobs waiting) - a cut was queued; its text follows in a `segment` with the same `seg_id` |
| `segment` | `session_id` or `request_id`, `channel`, `seg_id` (streaming only), `start` (s), `end` (s), `text` (empty = nothing was said, closes the `pending`), `partial` (bool), `avg_logprob`, `no_speech_prob` |
| `partial` | `session_id`, `channel`, `start`, `text` |
| `stopped` | `session_id` |
| `file_done` | `request_id`, `duration` |
| `error` | `message`, `session_id`/`request_id` (optional), `fatal` (bool) |
| `log` | `level`, `message` |

## Streaming algorithm

Per channel: keep a rolling buffer of float32 audio. Every ~500 ms of new audio run Silero VAD
(`faster_whisper.vad.get_speech_timestamps`) on the buffer. When a speech region has ended at least
`min_silence_ms` (600 ms) before the end of the buffer, or the current speech region exceeds `max_segment_s` (24 s),
cut the region (with 200 ms padding), transcribe it with `model.transcribe(audio, language=..., beam_size=5,
without_timestamps=True, condition_on_previous_text=False, initial_prompt=<vocabulary prompt>,
vad_filter=False)` and emit one `segment` with absolute timestamps (session time). Non-speech audio is discarded,
which also avoids Whisper hallucinations on silence. If `partials` is on and speech has been ongoing for more than
6 s, emit a `partial` with the transcription of the ongoing region at most every 4 s. Transcription runs on a single
worker thread; VAD runs on the ingest thread. The Icelandic fine-tuned models emit lowercase text without
punctuation and unreliable in-segment timestamps, hence `without_timestamps=True` and VAD-driven segment timing.

Every queued cut is announced with a `pending` event carrying a `seg_id` before it is transcribed, and exactly
one `segment` with that `seg_id` follows - with empty text if nothing usable was said or the job failed. A client
can therefore show a placeholder from the moment someone stops speaking, which matters because transcription of a
large model on a CPU takes several times longer than the speech itself.

Hallucination guards: drop segments whose `no_speech_prob` > 0.85 and `avg_logprob` < -1.0, drop segments
consisting of the same token repeated > 4 times, drop empty text.

## Speaker diarization (added)

| command | fields | reply |
|---|---|---|
| `diarize_file` | `request_id`, `path` (WAV/any audio), `channel` (int index for multi-channel files, or null to mix down), `models_dir`, `threshold` (float, default 0.55; larger = fewer speakers), `num_speakers` (int, optional, -1 = auto) | `diarized` with `request_id`, `segments` (list of `{start, end, speaker}` with 0-based integer speaker ids), `num_speakers` |

Uses sherpa-onnx offline speaker diarization (pyannote segmentation 3.0 + 3D-Speaker CAM++ VoxCeleb embeddings).
The two ONNX models (~36 MB) are downloaded from Hugging Face into `<models_dir>/diarization/` on first use
(`progress` events, `model_id` = `diarization`). If sherpa-onnx is not installed an `error` event is returned.
