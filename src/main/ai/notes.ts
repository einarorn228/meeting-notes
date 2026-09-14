import { dateIs, dateTimeIs } from '../../shared/dates'
import type { ActionItem, ChatMessage, Meeting, Summary } from '../../shared/types'
import { getSettings } from '../settings'
import { allMeetings, loadMeeting, saveMeeting, transcriptText } from '../store'
import { complete } from './llm'
import { chatSystemPrompt, punctuateSystemPrompt, summarySystemPrompt, summaryUserPrompt, transcriptForPrompt } from './prompts'
import { getTemplate } from './templates'

export type ProgressFn = (stage: string, progress?: number) => void

export function parseSummary(markdown: string): Pick<Summary, 'title' | 'keyPoints' | 'decisions' | 'actionItems'> {
  const lines = markdown.split(/\r?\n/)
  let title: string | undefined
  let section = ''
  const keyPoints: string[] = []
  const decisions: string[] = []
  const actionItems: ActionItem[] = []
  for (const raw of lines) {
    const line = raw.trim()
    if (!title && /^#\s+/.test(line)) {
      title = line.replace(/^#\s+/, '').trim()
      continue
    }
    const h = line.match(/^##+\s+(.*)$/)
    if (h) {
      section = h[1].toLowerCase()
      continue
    }
    const bullet = line.match(/^[-*]\s+(?:\[[ xX]\]\s*)?(.*)$/)
    if (!bullet) continue
    const text = bullet[1].trim()
    if (!text || /^(ekkert|none)\.?$/i.test(text)) continue
    if (/aðgerð|action|verkefni|eftirfylgni/.test(section)) {
      const done = /^\s*[-*]\s+\[[xX]\]/.test(line)
      const parts = text.split(/\s+[—–-]\s+/)
      const item: ActionItem = { text: parts[0].trim(), done }
      for (const p of parts.slice(1)) {
        const m = p.match(/^(ábyrgð|owner|ábyrgðaraðili)\s*:\s*(.*)$/i)
        const d = p.match(/^(frestur|due|skilafrestur)\s*:\s*(.*)$/i)
        if (m) item.owner = m[2].trim()
        else if (d) item.due = d[2].trim()
      }
      actionItems.push(item)
    } else if (/ákvarð|decision|afgreiðsl/.test(section)) {
      decisions.push(text)
    } else if (/helstu|key|atriði|samantekt|summary/.test(section)) {
      keyPoints.push(text)
    }
  }
  return { title, keyPoints, decisions, actionItems }
}

export async function summarizeMeeting(meetingId: string, templateId: string | undefined, progress: ProgressFn): Promise<Summary> {
  const m = loadMeeting(meetingId)
  if (!m) throw new Error('Fundur fannst ekki')
  if (m.segments.filter((s) => !s.partial).length === 0) throw new Error('Engin uppskrift til að draga saman')
  const s = getSettings()
  const tpl = getTemplate(templateId ?? s.llm.summaryTemplateId)
  const lang = m.language === 'auto' ? 'is' : m.language
  progress('summary', 0.1)
  const res = await complete(summarySystemPrompt(lang), [{ role: 'user', content: summaryUserPrompt(m, tpl, lang, s.vocabulary) }], { maxTokens: 6000, temperature: 0.2 })
  progress('summary', 0.9)
  const parsed = parseSummary(res.text)
  const summary: Summary = { templateId: tpl.id, language: lang, generatedAt: new Date().toISOString(), provider: res.provider, model: res.model, markdown: res.text.trim(), ...parsed }
  const latest = loadMeeting(meetingId) ?? m
  const patch: Partial<Meeting> = { summary }
  if (parsed.title && /^Fundur \d/.test(latest.title)) patch.title = parsed.title
  saveMeeting({ ...latest, ...patch })
  progress('summary', 1)
  return summary
}

/** Restores punctuation and casing on the transcript (the Icelandic models write lowercase without punctuation). */
export async function punctuateMeeting(meetingId: string, progress: ProgressFn): Promise<Meeting> {
  let m = loadMeeting(meetingId)
  if (!m) throw new Error('Fundur fannst ekki')
  const lang = m.language === 'auto' ? 'is' : m.language
  const vocab = getSettings().vocabulary
  const segs = m.segments.filter((x) => !x.partial)
  const batchSize = 40
  for (let i = 0; i < segs.length; i += batchSize) {
    const batch = segs.slice(i, i + batchSize)
    progress('punctuate', i / segs.length)
    const user = (vocab.length ? `Orðalisti: ${vocab.join(', ')}\n\n` : '') + 'Línur:\n' + batch.map((x) => x.text.replace(/\s+/g, ' ').trim()).join('\n')
    const res = await complete(punctuateSystemPrompt(lang), [{ role: 'user', content: user }], { maxTokens: 8000, temperature: 0 })
    const arr = extractJsonArray(res.text)
    if (!arr || arr.length !== batch.length) {
      // fall back: try line split
      const lines = res.text.split(/\r?\n/).filter((l) => l.trim())
      if (lines.length === batch.length) lines.forEach((l, j) => (batch[j].text = l.trim()))
      continue
    }
    arr.forEach((t, j) => {
      if (typeof t === 'string' && t.trim()) batch[j].text = t.trim()
    })
    m = loadMeeting(meetingId) ?? m
    const byId = new Map(batch.map((b) => [b.id, b.text]))
    m.segments = m.segments.map((x) => (byId.has(x.id) ? { ...x, text: byId.get(x.id)! } : x))
    saveMeeting(m)
  }
  m = loadMeeting(meetingId) ?? m
  m.punctuated = true
  saveMeeting(m)
  progress('punctuate', 1)
  return m
}

function extractJsonArray(text: string): unknown[] | null {
  const start = text.indexOf('[')
  const end = text.lastIndexOf(']')
  if (start < 0 || end <= start) return null
  try {
    const v = JSON.parse(text.slice(start, end + 1))
    return Array.isArray(v) ? v : null
  } catch {
    return null
  }
}

export async function chatWithMeeting(meetingId: string, message: string): Promise<string> {
  const m = loadMeeting(meetingId)
  if (!m) throw new Error('Fundur fannst ekki')
  const lang = m.language === 'auto' ? 'is' : m.language
  const history = m.chat.slice(-10).map((c) => ({ role: c.role, content: c.content }))
  const res = await complete(chatSystemPrompt(lang, m), [...history, { role: 'user', content: message }], { maxTokens: 2000, temperature: 0.2 })
  const now = new Date().toISOString()
  const msgs: ChatMessage[] = [...m.chat, { role: 'user', content: message, at: now }, { role: 'assistant', content: res.text.trim(), at: now }]
  saveMeeting({ ...(loadMeeting(meetingId) ?? m), chat: msgs })
  return res.text.trim()
}

export async function chatWithAllMeetings(message: string): Promise<string> {
  const s = getSettings()
  const lang = s.language === 'auto' ? 'is' : s.language
  const meetings = allMeetings().slice(0, 60)
  // Build a compact corpus: summaries where available, otherwise the first part of the transcript.
  let corpus = ''
  for (const m of meetings) {
    const body = m.summary?.markdown ?? transcriptText(m.segments).slice(0, 4000)
    const block = `### ${m.title} (${dateIs(new Date(m.createdAt))}, id ${m.id})\n${body}\n\n`
    if (corpus.length + block.length > 300000) break
    corpus += block
  }
  if (!corpus) throw new Error('Engir fundir til að leita í')
  const system = chatSystemPrompt(lang, null) + (lang === 'is' ? '\n\nHér eru allir fundir notandans (samantektir eða uppskriftir). Vísaðu í titil og dagsetningu fundar í svörum.\n\n' : '\n\nAll of the user\'s meetings follow. Cite meeting title and date.\n\n') + corpus
  const res = await complete(system, [{ role: 'user', content: message }], { maxTokens: 2000, temperature: 0.2 })
  return res.text.trim()
}

export function meetingTranscriptForExport(m: Meeting): string {
  return transcriptForPrompt(m)
}
