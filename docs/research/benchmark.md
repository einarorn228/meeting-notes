# Local benchmark (this build environment)

Environment: 4 vCPU x86-64, no GPU, faster-whisper 1.2.1, CTranslate2 4.8.2, int8, beam 5, VAD filter on.
Audio: 209 s built from 12 longest utterances of the Spjallrómur conversational corpus (shard 0), 0.5 s gaps.
WER computed with jiwer after lowercasing and stripping punctuation.

| Model | WER | Time | RTF |
|---|---|---|---|
| Aalto-Speech-Synthesis/whisper-large-v3-Icelandic-finetuned-ct2 | **22.8 %** | 263 s | 1.26 |
| language-and-voice-lab/whisper-large-icelandic-62640-steps-967h-ct2 | 62.4 % | 150 s | 0.72 |

Notes
- The 62640-step model was trained on read prompts only and collapses on casual conversation (confirms the
  Samrómur Milljón paper: 2× worse on Alþingi than the 30k-steps model, which is why the app ships the 30k model
  as the alternative instead).
- Both Icelandic fine-tunes output lowercase text without punctuation; in-segment timestamps of the Aalto model are
  unreliable, so the app relies on its own VAD segmentation for timing.
- Speaker diarization (sherpa-onnx, pyannote segmentation 3.0 + CAM++ VoxCeleb embeddings): 16 s for the same
  209 s file on CPU.
- Sidecar integration test (`pytest --run-slow`): streaming protocol on the first 40 s produced monotonic segments.
