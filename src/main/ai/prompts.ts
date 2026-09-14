/**
 * Prompts for Icelandic meeting notes. Findings from research (Miðeind leaderboard, language-confusion papers):
 * pin the output language, forbid drift into English/Danish/Norwegian, give headings verbatim, use low temperature,
 * fixed frames for action items to avoid declension errors, and pass names/vocabulary for normalisation.
 */
import type { Meeting, SummaryTemplate } from '../../shared/types'
import { formatTime } from '../store'

export function languageName(lang: string): string {
  return { is: 'íslensku', en: 'ensku', da: 'dönsku', no: 'norsku', sv: 'sænsku', de: 'þýsku' }[lang] ?? lang
}

export function transcriptForPrompt(m: Meeting, maxChars = 350000): string {
  const lines = m.segments.filter((s) => !s.partial).map((s) => `[${formatTime(s.start)}] ${m.speakerNames[s.speaker] ?? s.speaker}: ${s.text}`)
  let text = lines.join('\n')
  if (text.length > maxChars) text = text.slice(0, maxChars) + '\n[... uppskrift stytt ...]'
  return text
}

function isIcelandic(lang: string): boolean {
  return lang === 'is' || lang === 'auto'
}

export function summarySystemPrompt(lang: string): string {
  if (isIcelandic(lang)) {
    return [
      'Þú ert reyndur íslenskur fundarritari. Þú skrifar vandaðar, hnitmiðaðar fundargerðir á lýtalausri íslensku.',
      'Reglur:',
      '- Skrifaðu EINGÖNGU á íslensku. Engin ensk, dönsk eða norsk orð nema um sé að ræða nöfn á vörum eða fyrirtækjum. Notaðu íslensk fagorð.',
      '- Notaðu rétta beygingu og stafsetningu. Nöfn fólks skulu vera í nefnifalli í ábyrgðardálkum.',
      '- Uppskriftin kemur úr sjálfvirkri talgreiningu og getur innihaldið villur, hikorð og rangt rituð nöfn. Leiðréttu augljósar talgreiningarvillur út frá samhengi og orðalistanum, en bættu aldrei við efni sem ekki kom fram.',
      '- Vertu hlutlægur. Eignaðu ekki fólki skoðanir sem það hafði ekki. Ef eitthvað er óljóst, segðu að það hafi verið óljóst.',
      '- Skrifaðu tölur með tölustöfum, dagsetningar á forminu 14. september 2026, upphæðir með kr.',
      '- Skilaðu Markdown-sniði með nákvæmlega þeim fyrirsögnum (## ...) sem beðið er um, í þeirri röð. Slepptu kafla aðeins ef ekkert efni á við, og skrifaðu þá „Ekkert.“ undir fyrirsögnina.',
      '- Aðgerðir: hver aðgerð á einni línu á forminu „- [ ] Verkefni (nafnháttur) — Ábyrgð: Nafn — Frestur: dagsetning eða „ekki tilgreint““.',
      '- Ákvarðanir: ein ákvörðun í hverjum punkti, skýrt orðuð í þátíð („Ákveðið var að ...“).'
    ].join('\n')
  }
  return [
    'You are an experienced minute-taker. You write accurate, concise meeting minutes.',
    `Write ONLY in ${languageName(lang) === lang ? lang : lang === 'en' ? 'English' : lang}.`,
    'The transcript comes from automatic speech recognition and may contain errors, fillers and misspelled names; correct obvious errors from context and the vocabulary list, but never invent content.',
    'Be objective. Return Markdown with exactly the requested ## headings in order. Under a heading with no content write "None."',
    'Action items: one per line as "- [ ] Task — Owner: Name — Due: date or not specified".'
  ].join('\n')
}

export function summaryUserPrompt(m: Meeting, tpl: SummaryTemplate, lang: string, vocabulary: string[]): string {
  const ic = isIcelandic(lang)
  const sections = ic ? tpl.sections.is : tpl.sections.en
  const parts: string[] = []
  parts.push(ic ? `Fundur: ${m.title}` : `Meeting: ${m.title}`)
  parts.push(ic ? `Dagsetning: ${new Date(m.createdAt).toLocaleString('is-IS')}` : `Date: ${new Date(m.createdAt).toLocaleString('en-GB')}`)
  parts.push(ic ? `Lengd: ${formatTime(m.durationSec)}` : `Duration: ${formatTime(m.durationSec)}`)
  if (m.participants.length) parts.push((ic ? 'Þátttakendur: ' : 'Participants: ') + m.participants.join(', '))
  if (vocabulary.length) parts.push((ic ? 'Orðalisti (rétt rituð nöfn og hugtök): ' : 'Vocabulary (correct spellings): ') + vocabulary.join(', '))
  if (m.notes.trim()) parts.push((ic ? 'Glósur fundarritara (mikilvægar, fléttaðu þær inn):\n' : "Note-taker's own notes (important, weave them in):\n") + m.notes.trim())
  if (m.highlights.length) parts.push((ic ? 'Merktir staðir í upptöku: ' : 'Marked moments: ') + m.highlights.map((h) => `${formatTime(h.time)}${h.note ? ' ' + h.note : ''}`).join('; '))
  parts.push('')
  parts.push(ic ? tpl.instructions.is : tpl.instructions.en)
  parts.push('')
  parts.push((ic ? 'Fyrirsagnir sem á að nota, í þessari röð:\n' : 'Headings to use, in this order:\n') + sections.map((s) => `## ${s}`).join('\n'))
  parts.push('')
  parts.push(ic ? 'Byrjaðu á einni línu með titli fundarins sem „# Titill“ (stuttur, lýsandi titill á íslensku).' : 'Start with a single line "# Title" (a short descriptive title).')
  parts.push('')
  parts.push(ic ? 'Uppskrift fundar (ræðumaður „Ég“ er notandi forritsins, „Aðrir“ eru hinir þátttakendurnir):' : 'Transcript ("Ég" = the app user, "Aðrir" = other participants):')
  parts.push('---')
  parts.push(transcriptForPrompt(m))
  parts.push('---')
  parts.push(ic ? 'Skrifaðu nú fundargerðina.' : 'Now write the minutes.')
  return parts.join('\n')
}

export function punctuateSystemPrompt(lang: string): string {
  if (isIcelandic(lang)) {
    return [
      'Þú lagar sjálfvirka uppskrift af íslensku tali. Textinn kemur frá talgreini sem skrifar allt með lágstöfum og án greinarmerkja.',
      'Verkefni: settu inn greinarmerki og hástafi (upphaf setninga, sérnöfn, staðanöfn, fyrirtækjanöfn), skrifaðu tölur með tölustöfum þar sem það á við og lagaðu augljós rangt rituð orð út frá samhengi og orðalista.',
      'Fjarlægðu ENGIN orð nema endurtekin hikorð (sko, hérna, þú veist, ha) þegar þau bæta engu við. Breyttu EKKI merkingu, bættu engu við, þýddu ekki.',
      'Skilaðu textanum EINGÖNGU sem JSON-fylki af strengjum, einum streng fyrir hverja innsenda línu, í sömu röð og með sama fjölda. Ekkert annað.'
    ].join('\n')
  }
  return [
    'You fix automatic speech-recognition transcripts. The text is lowercase without punctuation.',
    'Add punctuation and capitalisation, write numbers as digits, fix obviously misrecognised words from context and the vocabulary. Remove nothing except repeated fillers. Do not change meaning, do not add or translate.',
    'Return ONLY a JSON array of strings, one per input line, same order and count.'
  ].join('\n')
}

export function chatSystemPrompt(lang: string, m: Meeting | null): string {
  const base = isIcelandic(lang)
    ? 'Þú ert aðstoðarmaður sem svarar spurningum um fundi út frá uppskriftum þeirra. Svaraðu á íslensku, stutt og skýrt, og vísaðu í tímastimpil [mm:ss] og ræðumann þegar það á við. Ef svarið kemur ekki fram í uppskriftinni, segðu það hreinskilnislega.'
    : 'You answer questions about meetings from their transcripts. Answer concisely, cite [mm:ss] timestamps and speakers when relevant. If the transcript does not contain the answer, say so.'
  if (!m) return base
  return `${base}\n\nFundur: ${m.title} (${new Date(m.createdAt).toLocaleString('is-IS')})\n${m.summary ? 'Samantekt:\n' + m.summary.markdown + '\n\n' : ''}Uppskrift:\n${transcriptForPrompt(m)}`
}
