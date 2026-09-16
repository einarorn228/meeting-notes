# Fundarritari

**Fundarritari** er forrit fyrir tölvuna þína (Windows, macOS, Linux) sem skrifar niður allt sem sagt er á fundum
– á **íslensku** – hvort sem fundurinn fer fram í **Microsoft Teams**, Zoom, Google Meet, Slack, Webex eða hvaða
forriti sem er. Enginn „bot“ bætist við fundinn: forritið tekur upp hljóðnemann þinn og hljóðið sem þú heyrir úr
fundarforritinu og skrifar hvort tveggja upp í rauntíma.

*Fundarritari is a desktop meeting transcriber built Icelandic-first. English documentation is further down.*

## Helstu eiginleikar

- **Virkar með öllum fundarforritum** – kerfishljóð + hljóðnemi, engin viðbót í fundinum (Teams, Zoom, Meet, Slack, Webex, Discord, FaceTime, í eigin persónu).
- **Íslensk talgreining sem er sannreynd** – sjálfgefið keyrir fínstillt íslenskt Whisper large-v3 líkan (Aalto-háskóli 2026, þjálfað á Alþingi, Samrómi, Malrómi og *samtölum* úr Spjallrómi) alfarið á tölvunni þinni. Einnig má velja Azure AI Speech (is-IS í rauntíma), ElevenLabs Scribe v2 eða OpenAI.
- **Allir þátttakendur skráðir** – „Ég“ (hljóðnemi) og hver hinna þátttakendanna fær eigið merki (Þátttakandi 1, 2, 3 …) með ræðumannagreiningu; nöfn má laga með einum smelli. Með Azure fæst aðgreining ræðumanna í rauntíma.
- **Uppskrift í beinni** með tímastimplum, glósur á meðan fundinum stendur, „Merkja stað“ flýtilykill.
- **Þolir truflanir** – heyrnartól sem detta út eða tölva sem sofnar stöðva ekki fundinn: rásin er opnuð aftur og
  það sem tapaðist verður þögn á réttum stað. Hrynji forritið eða slokkni á tölvunni varðveitist hljóðið sem náðist
  og hægt er að ljúka uppskriftinni eftir á.
- **Fundargerð með gervigreind** á vandaðri íslensku: samantekt, helstu atriði, ákvarðanir, aðgerðir með ábyrgð og fresti – sniðmát fyrir stöðufundi, viðskiptavinafundi, stjórnarfundi, viðtöl o.fl. (Claude Opus 5 sjálfgefið – efst á íslenska máltæknilistanum í málfræði og beygingum; einnig OpenAI eða Ollama án nettengingar).
- **Greinarmerki og hástafir lagaðir sjálfkrafa** eftir staðbundna talgreiningu.
- **Spjall við fundinn** („Hvað var ákveðið um…?“) og leit í öllum fundum.
- **Hljóðið er alltaf geymt** – smelltu á setningu til að spila hana, endurritaðu síðar með öðrum talgreini.
- **Fundagreining** – tilkynning þegar Teams/Zoom/Meet er í notkun og þegar fundur í dagatalinu (ICS) er að byrja.
- **Heilbrigði upptöku** – mælar fyrir hljóðnema og kerfishljóð, viðvörun ef fundarhljóðið berst ekki (algengt með Bluetooth-heyrnartólum).
- **Útflutningur**: Markdown, Word (.docx), PDF, SRT, texti, JSON. Allt geymt staðbundið á tölvunni.
- **Orðaforði** – nöfn og fagorð sem talgreinirinn og gervigreindin skrifa rétt. Þegar ræðumaður er nefndur eru
  nöfnin úr fundarboðinu og af fyrri fundum í boði með einum smelli.
- Kerfisbakki, flýtilyklar (⌘/Ctrl+Shift+R hefja/stöðva, ⌘/Ctrl+Shift+H merkja stað), tilkynningatexti um upptöku fyrir þátttakendur.

## Uppsetning

### Tilbúnir pakkar
GitHub Actions byggir uppsetningarskrár fyrir Windows (`.exe`), macOS (`.dmg`) og Linux (`.AppImage`/`.deb`) við hvert
„push“ og gefur út undir *Releases* þegar merki (`v*`) er ýtt. Sæktu pakkann fyrir þitt stýrikerfi.

### Keyra úr kóða

```bash
npm install
npm run dev          # þróunarútgáfa
npm run dist:win     # eða dist:mac / dist:linux -> release/
```

### Staðbundin talgreining (sjálfgefið)
Forritið þarf **Python 3.10+** ([python.org](https://www.python.org/downloads/), hakaðu við *Add Python to PATH* á
Windows). Við fyrstu notkun býr Fundarritari til einangrað Python-umhverfi, sækir `faster-whisper` og íslenska
líkanið (~3 GB) í gagnamöppuna sína. Þetta gerist sjálfkrafa; fylgstu með í *Stillingar → Talgreining*.
Pakkar úr CI innihalda forbyggða þjónustu (PyInstaller) og þurfa þá ekki Python.

Vélbúnaður: large-líkanið er ~1× rauntími á 4–8 kjarna örgjörva (int8), miklu hraðara með NVIDIA skjákorti
(veldu *CUDA* í stillingum) eða Apple Silicon. Á hægum fartölvum er Azure Speech besti kosturinn.

### Skýjaþjónustur (valfrjálst)
| Þjónusta | Til hvers | Lykill |
|---|---|---|
| Anthropic Claude | fundargerðir, greinarmerki, spjall (mælt með) | console.anthropic.com |
| OpenAI | sama, og talgreining | platform.openai.com |
| Ollama | fundargerðir án nettengingar (`ollama pull gemma4:12b`) | – |
| Azure AI Speech | íslensk talgreining í rauntíma með ræðumannaaðgreiningu (~1 USD/klst.) | portal.azure.com |
| ElevenLabs | íslensk talgreining eftir upptöku | elevenlabs.io |

## Kerfishljóð eftir stýrikerfi
- **Windows 10/11**: virkar sjálfkrafa (WASAPI loopback), engin heimild.
- **macOS 14.2+**: forritið biður um heimildina *System Audio Recording* (Kerfisstillingar → Persónuvernd og öryggi). macOS 13 notar *Screen & System Audio Recording*.
- **Linux**: PulseAudio/PipeWire „Monitor“-inntak.

Ráð: notaðu heyrnartól svo rödd hinna leki ekki inn í hljóðnemann þinn.

## Hvernig þetta virkar
```
Teams/Zoom/Meet ─ kerfishljóð ─┐                              ┌─ faster-whisper (íslenskt Whisper large-v3)  ─┐
                               ├─ Electron (2 rásir, 16 kHz) ─┤─ Azure / ElevenLabs / OpenAI                  ├─ uppskrift ─ ræðumannagreining ─ greinarmerki ─ fundargerð (Claude)
Hljóðnemi ─────────────────────┘        │                     └───────────────────────────────────────────────┘
                                        └─ audio.wav (vinstri = ég, hægri = aðrir) + meeting.json á tölvunni
```
Sjá `docs/ARCHITECTURE.md` og rannsóknina í `docs/research/` (talgreinar fyrir íslensku, samkeppnisforrit,
tæknival, íslensk mállíkön) – allar ákvarðanir eru rökstuddar þar.

## Þróun
```bash
npm run typecheck && npm test            # TypeScript + vitest
cd sidecar && pip install -r requirements.txt pytest jiwer && pytest -q
```
Gögn eru geymd í `%APPDATA%/fundarritari/data` (Windows), `~/Library/Application Support/fundarritari/data` (macOS)
eða `~/.config/fundarritari/data` (Linux): ein mappa á fund með `meeting.json` og `audio.wav`.

---

## English

Fundarritari (“minute-taker”) is a bot-free desktop meeting transcriber for Windows, macOS and Linux, built for
Icelandic. It captures your microphone and the system audio of any meeting app (Microsoft Teams first, but also
Zoom, Google Meet, Slack huddles, Webex …) as two separate tracks, transcribes them live with an Icelandic
fine-tuned Whisper large-v3 model running locally (or Azure AI Speech / ElevenLabs / OpenAI in the cloud),
separates the remote participants into individual speakers with offline diarization, restores punctuation, and
writes Icelandic meeting minutes (summary, decisions, action items with owners) with Claude, OpenAI or a local
Ollama model. Everything is stored locally; export to Markdown, Word, PDF, SRT, text or JSON. Interruptions are survivable: a
capture device that disappears mid-meeting is reopened, a machine that sleeps leaves a gap rather than a shifted
transcript, and a recording cut short by a crash stays a playable file the transcript can be finished from.

Research behind the engine choices (Icelandic ASR benchmarks, competitor feature analysis, capture technology,
Icelandic LLM leaderboard) is in `docs/research/`. Build: `npm install && npm run dist:win|mac|linux`. Local
transcription requires Python 3.10+ unless you use the CI-built installer, which bundles the sidecar.

MIT licensed.
