# Research: meeting note-taker apps (what works, what to copy)

Researched 2026-09-14. ~25 products compared: Otter, Fireflies, Fathom, tl;dv, Granola, Krisp, MeetGeek, Notta,
Tactiq, Fellow, Read.ai, HappyScribe, Claap, Teams native/Copilot, Zoom AI Companion, anarlog (ex-Hyprnote),
Meetily, MacWhisper, Vibe, Buzz, Whishper, Screenpipe, Amurex, Noty.

## How they capture audio

| Approach | Used by | Pros | Cons |
|---|---|---|---|
| Bot joins the call (Recall.ai etc.) | Otter, Fireflies, Fathom, tl;dv, MeetGeek, Read.ai, Fellow | Real speaker names from roster | Visible bot, hosts block it, consent lawsuits, no Slack huddles/in-person, vendor cost |
| Desktop system-audio + mic, no bot | Granola, Krisp, anarlog, Meetily, MacWhisper, Screenpipe, Vibe, Fireflies Desktop | Works with **any** app (Teams, Zoom, Meet, Slack, in person); no participant; can be fully local | Other side is one mixed channel; must be present with app open; silent-capture failures if device routing is wrong |
| Browser extension reading captions | Tactiq, Amurex, Noty | Names from captions | Web only; accuracy tied to platform captions |
| Platform APIs | Zoom RTMS, MS Graph transcripts | Per-participant names | Zoom only / tenant admin consent, Teams has no RTMS equivalent |

**Chosen approach: desktop system-audio + microphone capture (bot-less), two separate tracks.**

OS APIs used by bot-less apps: Windows WASAPI loopback (no permission prompt), macOS ScreenCaptureKit
(needs "Screen & System Audio Recording") or Core Audio process taps (macOS 14.4+), Linux PipeWire monitors.

Pipeline lessons (Recall.ai engineers, Meetily release notes, Granola docs):
- Keep mic and system audio as **separate tracks**; "Mic = me, system = others" gives deterministic speaker labels.
- Bluetooth headsets are the #1 cause of broken captures; warn users and show live level meters.
- Whisper-specific issues: repeated-phrase hallucinations on silence, language drift mid-meeting → lock language per meeting, VAD-gate audio.
- Meeting detection: calendar events + "meeting app running / mic in use" with a notification "Take notes?".

## Features users consistently praise
1. Live transcript panel during the call.
2. Notepad + AI enhancement (Granola): type sparse notes, AI merges them with the transcript afterwards.
3. Click-to-seek audio playback synced to the transcript (its absence is Granola's most cited weakness).
4. Speaker labels, at least Me/Others by channel, with inline rename.
5. Summary templates per meeting type + action items with owners + decisions.
6. Calendar integration and auto-detected meeting start.
7. Ask/chat over one meeting and across meetings.
8. Highlights/bookmarks during recording.
9. Cross-meeting search.
10. Export: Markdown, DOCX, PDF, SRT, JSON.
11. Editable transcript, custom vocabulary (names, jargon).
12. Local-first storage, bring-your-own model/API provider cards.
13. Tray presence with notifications.
14. Language handling: default language, per-meeting override, re-transcribe later.
15. Free unlimited local use.

## Complaints to design against
Silent recording failures with no alert; Bluetooth routing; poor non-English accuracy; no audio playback;
everyone collapsed into "Them"; bots annoying participants and consent problems (GDPR in Europe);
paywalls; lock-in with no Markdown export; training on user data; Whisper hallucinations on silence.

## Icelandic specifically
- Products with Icelandic transcription: Fireflies, Fellow, Notta, HappyScribe, Claap, and **Microsoft Teams native transcription** ("Icelandic (Iceland)"). Not supported: Otter, Fathom, tl;dv, Granola, Krisp real-time, Zoom AI Companion, Teams Copilot AI features.
- Icelandic ASR: Reykjavik University Language and Voice Lab fine-tuned Whisper models, Aalto University 2026 fine-tune of Whisper large-v3 on conversational Icelandic (Spjallrómur), Tiro Speech Core (Kaldi), Azure Speech is-IS (real-time), ElevenLabs Scribe (Icelandic), AssemblyAI (Icelandic).

## Decisions taken for Fundarritari
Must-have (implemented): bot-less two-track capture, Me/Others labels with rename, Icelandic-first engines
(local fine-tuned Whisper + cloud options), per-meeting language lock, custom vocabulary, audio kept + click-to-seek,
re-transcription, calendar (ICS) + app detection notifications, capture health meters + silent-channel warning,
live transcript + notes, Icelandic summary templates (fundargerð), local-first JSON/WAV storage, search,
export MD/DOCX/PDF/SRT/JSON, tray, hotkeys, permissions onboarding, consent notice text.
