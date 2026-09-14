# Research: Icelandic speech recognition engines (Sept 2026)

Goal: find the speech-to-text engines that are *proven* to work well for Icelandic conversational speech.
Caveat: nearly all published Icelandic WER (word error rate) numbers are on read speech (Samrómur, Malrómur, FLEURS)
or parliamentary speech (Alþingi). Nobody publishes conversational/meeting WER, so we benchmarked ourselves (see below).

## Stock Whisper is not usable for Icelandic
Whisper paper, FLEURS Icelandic WER: tiny 113 %, small 72.6 %, medium 49.9 %, large-v2 38.2 % (only 16 h of Icelandic
in training). Whisper large-v3-turbo is not better. → Fine-tuned Icelandic models are mandatory.

## Open Icelandic Whisper fine-tunes (all usable locally with faster-whisper / CTranslate2)

| Model | Base | Training data | Samrómur | Malrómur | Alþingi | License |
|---|---|---|---|---|---|---|
| **Aalto-Speech-Synthesis/whisper-large-v3-Icelandic-finetuned-ct2** (Sept 2026) | large-v3 | Alþingi, Malrómur, Raddrómur, Samrómur, **Spjallrómur (conversations)** | – | **3.5** | **8.1** | Apache-2.0 |
| language-and-voice-lab/whisper-large-icelandic-30k-steps-1000h-ct2 (2023) | large (v1) | Samrómur + Malrómur + 514 h Alþingi + L2 | 8.5 | 5.1 | 8.3 | CC-BY-4.0 |
| language-and-voice-lab/whisper-large-icelandic-62640-steps-967h-ct2 (2023) | large (v1) | 967 h Samrómur read prompts only | 7.8 | 11.5 | 16.2 | CC-BY-4.0 |
| BuzzASR/icelandic (2026) | large-v3 | FLEURS + Common Voice | 21.4 FLEURS/CV | | | MIT |
| sam8000/whisper-large-v3-turbo-icelandic (2025) | large-v3-turbo | FLEURS | 13.7 FLEURS | | | MIT |
| mideind/kyutai-stt-1b-is-en (May 2026, streaming) | Kyutai STT 1B | open corpora | "work in progress, not production-grade" | | | – |

Sources: Hugging Face model cards; Samrómur Milljón paper (LREC-COLING 2024, https://aclanthology.org/2024.lrec-main.1246/).

### Our own benchmark (this container, 4 CPU cores, faster-whisper int8, 209 s of Spjallrómur conversations)
| Model | WER (lenient normalisation) | Real-time factor CPU int8 |
|---|---|---|
| Aalto large-v3 Icelandic | 22.8 % | 1.26 (i.e. 26 % slower than real time on 4 slow cores) |
| LVL large 62640-steps | see docs/research/benchmark.md | |

Observations: the fine-tuned models output **lowercase text without punctuation** and their in-segment timestamps are
unreliable, so the app cuts audio with its own VAD (≤ 25 s chunks), decodes with `without_timestamps=True` and restores
punctuation/casing with the LLM afterwards. Conversational WER around 20 % is expected for casual overlapping chat with
fillers; meeting speech is usually cleaner.

## Icelandic vendors
- **Tiro** (tiro.is): Kaldi-based Tiro Speech Core (Apache-2.0, gRPC, streaming, diarization), live captioning for
  Reykjavík City Council and RÚV. No public pricing or WER.
- **Miðeind Hreimur** (Málstaður): batch ASR with punctuation, diarization, timestamps; API at api.malstadur.is,
  from 2 990 ISK/user/month. Won Reykjavík City's 2025 comparison against Tiro (report confidential).

## Cloud engines with Icelandic
| Engine | Icelandic | Streaming | Diarization for Icelandic | Price |
|---|---|---|---|---|
| **Azure AI Speech** (is-IS) | yes | yes | **yes, real-time** (ConversationTranscriber) + fast transcription; MAI-Transcribe-2 preview | $1/h real-time |
| **ElevenLabs Scribe v2** | yes, "Excellent ≤5 % WER" tier (read speech) | v2 Realtime (WebSocket, no diarization) | batch, 32 speakers | $0.22/h batch |
| OpenAI gpt-4o-transcribe / -diarize, whisper-1 | yes (unverified quality) | realtime API | diarize model, batch | $0.006/min |
| Google Chirp 3 | yes (preview) | yes | no for is-IS | $0.016/min |
| AssemblyAI Universal-2 | yes | no | yes | $0.15/h |
| Deepgram, Speechmatics, Soniox, Voxtral, NVIDIA Parakeet/Canary | **no** | | | |

## Decisions
1. **Default local engine:** faster-whisper with the Aalto Whisper large-v3 Icelandic model (Apache-2.0, trained on
   conversations). Alternative: Reykjavík University 30k-steps model. Generic large-v3/turbo for English.
2. **Real-time cloud engine:** Azure AI Speech is-IS with real-time diarization and phrase lists (custom vocabulary).
3. **High-quality post-meeting pass:** ElevenLabs Scribe v2 (diarization) or OpenAI gpt-4o-transcribe-diarize.
4. Speaker attribution always starts from the capture channel (mic = me, system = others).
