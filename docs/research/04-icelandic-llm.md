# Research: LLMs and NLP tools for Icelandic meeting notes (Sept 2026)

## Which LLMs write the best Icelandic?

Main source: Miðeind's human-verified **Icelandic LLM Leaderboard** (https://huggingface.co/spaces/mideind/icelandic-llm-leaderboard),
v2 generated 2026-09-11 (knowledge + language proficiency: generative quality, grammar correction, case marking, idioms).

| Model | Avg | Language proficiency | Grammar (GEC) | Case marking |
|---|---|---|---|---|
| GPT-6 Astra | 65.7 | 83.1 | 81.2 | 96.6 |
| Claude Fable 5.1 | 64.6 | 81.0 | 81.7 | 96.2 |
| **Claude Opus 5** | 63.8 | **81.8** | **83.0** | **99.1** |
| Gemini 3.1 Pro | 62.2 | 78.6 | 68.8 | 97.8 |
| GPT-5.6 Sol | 60.7 | 77.7 | 70.6 | 95.3 |
| Claude Sonnet 5 | 50.6 | 69.4 | 57.8 | 89.1 |
| GPT-5.6 Terra | 49.0 | 65.6 | 58.3 | 75.0 |
| Gemma 4 31B (open) | 20.1 | 25.4 | 19.7 | 16.6 |
| Claude Haiku 4.5 | 15.0 | 20.1 | 11.5 | 7.8 |

v1 leaderboard (94 models) for open weights: DeepSeek V4 Pro 79.2 (server-only), Gemma 4 31B 71.2, Mistral Large 3 69.0,
Gemma 4 26B-A4B 67.1, Llama 3.3 70B 58.6, Gemma 3 12B 53.7, Llama 3.1 8B 36.2.

Other evidence: Icelandic Linguistic Benchmark (NoDaLiDa 2025), WMT25 Miðeind system paper, "Who Benchmarks the
Benchmarks?" (LREC 2026: EuroEval's Icelandic sets are flawed; trust Miðeind), OpenAI–Iceland 2023 RLHF partnership,
Anthropic–Iceland education pilot (Nov 2025).

**Decision:** default cloud model `claude-opus-5` (best grammar/inflection, $5/$25 per 1M tokens, ~$0.16 per
1-hour meeting). Alternatives: `claude-fable-5-1`, OpenAI `gpt-5.6-sol` / `gpt-6-astra`. Never route Icelandic to
Haiku or small models. Offline: Ollama `gemma4:31b` (best open model that fits a workstation), `gemma4:26b`,
`gemma4:12b` as the floor; expect clearly worse Icelandic than cloud.

## Icelandic NLP tools (pip)
- `reynir-correct` (GreynirCorrect) spelling + grammar correction; `tokenizer` (Miðeind) sentence splitting;
  `islenska` (BÍN) inflections. Punctuation-prediction (icelandic-lt) is unmaintained → do punctuation via LLM.
- No inverse text normalisation package for Icelandic → numbers/dates handled in the LLM cleanup pass.

## Prompting rules used in the app
- Pin the output language: "Skrifaðu eingöngu á vandaðri íslensku"; forbid English/Danish/Norwegian drift.
- Low temperature (0–0.3), one short Icelandic example, simple instructions, Icelandic headings verbatim.
- Action items in a fixed frame to avoid declension errors: Verkefni (nafnháttur) · Ábyrgð (nefnifall) · Frestur.
- Pass attendee names and vocabulary so ASR-mangled names are normalised.
- Cleanup pass: "Lagaðu greinarmerki og hástafi, tölur með tölustöfum, fjarlægðu hikorð (sko, hérna, þú veist), breyttu ekki merkingu."

## Fundargerð conventions (Ríkisendurskoðun guide, Alþingi rules, Rauði krossinn template)
Fundarefni · Dagsetning og staður · Mættir / Fjarverandi · Samantekt · Helstu atriði · Ákvarðanir ·
Aðgerðir (Verkefni | Ábyrgð | Frestur) · Næstu skref · Önnur mál.
