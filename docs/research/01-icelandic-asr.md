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
   conversations). Alternative: Reykjavík University 30k-steps model. Generic large-v3/turbo for a meeting held in
   English - but not for a mixed one: Whisper decodes one language per cut, so English inside an Icelandic sentence
   is not a model choice (measured in docs/research/05-measurements.md). That repair belongs to the AI text pass.
2. **Real-time cloud engine:** Azure AI Speech is-IS with real-time diarization and phrase lists (custom vocabulary).
3. **High-quality post-meeting pass:** ElevenLabs Scribe v2 (diarization) or OpenAI gpt-4o-transcribe-diarize.
4. Speaker attribution always starts from the capture channel (mic = me, system = others).

## Could the model be trained on the user's own meetings? (Sept 2026)

The honest answer is "not the shipping model, not today", for reasons that are worth writing down:

- **There is no trainable checkpoint of the shipping model.** Aalto publishes only the CTranslate2 conversion
  (`model.bin`, float16, 3.1 GB); fine-tuning needs the Transformers weights, and the converter only goes the
  other way. The format is documented and the weights are unquantised, so a reverse conversion is possible in
  principle, but nobody maintains one. The practical route is asking Aalto for the Transformers checkpoint.
- **The models that do have trainable weights are far worse on conversation.** The corpus authors' own
  measurement of the RU 30k-steps model on the Spjallrómur test set is 41.7 % WER (dev 39.1 %); the Aalto model
  gets 22 % on the same kind of speech in this app (`05-measurements.md`). Starting again from
  `openai/whisper-large-v3` means redoing Aalto's job: 1,000+ hours of Icelandic and days of GPU time.
- **What a fine-tune on own data would take, once a checkpoint exists:** 5–20 hours of the user's own recordings
  with corrected transcripts; a rented 24 GB GPU (an RTX 4090 is $0.35–0.70/h) for LoRA - whisper-large trains
  in under 10 GB with int8 weights and LoRA adapters, and a 12-hour dataset for 3 epochs took 6–8 hours on a
  small GPU in the PEFT write-up; a held-out set of the user's own meetings to prove it got better rather than
  worse; and `ct2-transformers-converter` to get back to faster-whisper. The literature on domain adaptation
  puts 10–50 hours of in-domain audio at a 20–40 % relative WER reduction; a 49-hour LoRA of stock large-v3 on
  Raddrómur podcasts moved Samrómur WER by one point. Rúnarsson's RU thesis (2025) did full fine-tuning of
  Whisper small and large on Spjallrómur-clean and is the closest published precedent (the PDF sits behind a
  captcha on Skemman, so its numbers are not quoted here).
- **What the app does instead, today:** it learns from the user's corrections (`src/main/corrections.ts`): a
  mishearing the user has fixed twice is fixed automatically from then on, and every correction goes to the AI
  pass as an example. Together with the kept audio, those corrected lines are exactly the (audio, text) pairs a
  future fine-tune would train on - so nothing done now is wasted if a checkpoint appears.

Sources: Aalto model card and file list (huggingface.co/Aalto-Speech-Synthesis/whisper-large-v3-Icelandic-finetuned-ct2);
Spjallrómur results (github.com/icelandic-lt/spjallromur, `results/asr/`); PEFT+INT8 Whisper training
(github.com/openai/whisper/discussions/988); jonasaise/whisper-large-v3-lora-is model card; Diabolocom,
"Everything you need to know about fine-tuning an ASR"; Rúnarsson, "Analyzing Icelandic Conversation using
State-of-the-Art ASR models", RU 2025 (skemman.is/handle/1946/50888).
