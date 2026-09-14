import { dateIs, dateTimeIs } from '../shared/dates'
import { writeFileSync } from 'node:fs'
import { Document, HeadingLevel, Packer, Paragraph, TextRun } from 'docx'
import type { Meeting } from '../shared/types'
import { formatTime } from './store'

function speaker(m: Meeting, id: string): string {
  return m.speakerNames[id] ?? id
}

export function toMarkdown(m: Meeting): string {
  const out: string[] = []
  out.push(`# ${m.title}`)
  out.push('')
  out.push(`- Dagsetning: ${dateTimeIs(new Date(m.createdAt))}`)
  out.push(`- Lengd: ${formatTime(m.durationSec)}`)
  if (m.app) out.push(`- Forrit: ${m.app}`)
  if (m.participants.length) out.push(`- Þátttakendur: ${m.participants.join(', ')}`)
  if (m.tags.length) out.push(`- Merki: ${m.tags.join(', ')}`)
  out.push('')
  if (m.summary) {
    out.push(m.summary.markdown.replace(/^#\s.*\n?/, '').trim())
    out.push('')
  }
  if (m.notes.trim()) {
    out.push('## Glósur')
    out.push('')
    out.push(m.notes.trim())
    out.push('')
  }
  if (m.highlights.length) {
    out.push('## Merktir staðir')
    out.push('')
    for (const h of m.highlights) out.push(`- [${formatTime(h.time)}] ${h.note}`)
    out.push('')
  }
  out.push('## Uppskrift')
  out.push('')
  for (const s of m.segments.filter((x) => !x.partial)) out.push(`**[${formatTime(s.start)}] ${speaker(m, s.speaker)}:** ${s.text}`)
  out.push('')
  return out.join('\n')
}

export function toText(m: Meeting): string {
  const lines = [m.title, dateTimeIs(new Date(m.createdAt)), '']
  if (m.summary) lines.push(m.summary.markdown.replace(/[#*_`]/g, ''), '')
  lines.push('UPPSKRIFT', '')
  for (const s of m.segments.filter((x) => !x.partial)) lines.push(`[${formatTime(s.start)}] ${speaker(m, s.speaker)}: ${s.text}`)
  return lines.join('\n')
}

function srtTime(sec: number): string {
  const ms = Math.round(sec * 1000)
  const h = Math.floor(ms / 3600000)
  const mi = Math.floor((ms % 3600000) / 60000)
  const s = Math.floor((ms % 60000) / 1000)
  const r = ms % 1000
  const p = (n: number, w = 2): string => n.toString().padStart(w, '0')
  return `${p(h)}:${p(mi)}:${p(s)},${p(r, 3)}`
}

export function toSrt(m: Meeting): string {
  const segs = m.segments.filter((x) => !x.partial)
  return segs.map((s, i) => `${i + 1}\n${srtTime(s.start)} --> ${srtTime(Math.max(s.end, s.start + 0.5))}\n${speaker(m, s.speaker)}: ${s.text}\n`).join('\n')
}

export function toJson(m: Meeting): string {
  return JSON.stringify(m, null, 2)
}

/** Minimal markdown → docx paragraphs (headings, bullets, bold). */
function mdToParagraphs(md: string): Paragraph[] {
  const paras: Paragraph[] = []
  for (const raw of md.split(/\r?\n/)) {
    const line = raw.trimEnd()
    if (!line.trim()) continue
    const h = line.match(/^(#{1,3})\s+(.*)$/)
    if (h) {
      const level = h[1].length === 1 ? HeadingLevel.HEADING_1 : h[1].length === 2 ? HeadingLevel.HEADING_2 : HeadingLevel.HEADING_3
      paras.push(new Paragraph({ text: h[2], heading: level }))
      continue
    }
    const b = line.match(/^\s*[-*]\s+(?:\[([ xX])\]\s*)?(.*)$/)
    const runs = (text: string): TextRun[] =>
      text.split(/(\*\*[^*]+\*\*)/).filter(Boolean).map((part) => (part.startsWith('**') ? new TextRun({ text: part.slice(2, -2), bold: true }) : new TextRun(part)))
    if (b) {
      const prefix = b[1] ? (b[1] === ' ' ? '☐ ' : '☑ ') : ''
      paras.push(new Paragraph({ children: [new TextRun(prefix), ...runs(b[2])], bullet: { level: 0 } }))
      continue
    }
    paras.push(new Paragraph({ children: runs(line) }))
  }
  return paras
}

export async function toDocx(m: Meeting): Promise<Buffer> {
  const children: Paragraph[] = [new Paragraph({ text: m.title, heading: HeadingLevel.TITLE })]
  children.push(new Paragraph(`${dateTimeIs(new Date(m.createdAt))} · ${formatTime(m.durationSec)}${m.participants.length ? ' · ' + m.participants.join(', ') : ''}`))
  if (m.summary) children.push(...mdToParagraphs(m.summary.markdown.replace(/^#\s.*\n?/, '')))
  if (m.notes.trim()) {
    children.push(new Paragraph({ text: 'Glósur', heading: HeadingLevel.HEADING_2 }))
    children.push(...mdToParagraphs(m.notes))
  }
  children.push(new Paragraph({ text: 'Uppskrift', heading: HeadingLevel.HEADING_2 }))
  for (const s of m.segments.filter((x) => !x.partial)) {
    children.push(new Paragraph({ children: [new TextRun({ text: `[${formatTime(s.start)}] ${speaker(m, s.speaker)}: `, bold: true }), new TextRun(s.text)] }))
  }
  const doc = new Document({ creator: 'Fundarritari', title: m.title, sections: [{ children }] })
  return Packer.toBuffer(doc)
}

export function toHtml(m: Meeting): string {
  const esc = (s: string): string => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!)
  const mdHtml = (md: string): string =>
    md
      .split(/\r?\n/)
      .map((l) => {
        const h = l.match(/^(#{1,3})\s+(.*)$/)
        if (h) return `<h${h[1].length + 1}>${esc(h[2])}</h${h[1].length + 1}>`
        const b = l.match(/^\s*[-*]\s+(?:\[[ xX]\]\s*)?(.*)$/)
        if (b) return `<li>${esc(b[1]).replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')}</li>`
        return l.trim() ? `<p>${esc(l).replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')}</p>` : ''
      })
      .join('\n')
  const transcript = m.segments.filter((x) => !x.partial).map((s) => `<p><b>[${formatTime(s.start)}] ${esc(speaker(m, s.speaker))}:</b> ${esc(s.text)}</p>`).join('\n')
  return `<!doctype html><html lang="is"><head><meta charset="utf-8"><title>${esc(m.title)}</title>
<style>body{font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:800px;margin:40px auto;line-height:1.5;color:#111}h1{font-size:24px}h2{font-size:18px;margin-top:24px;border-bottom:1px solid #ddd}li{margin:2px 0}p{margin:6px 0}.meta{color:#555}</style></head><body>
<h1>${esc(m.title)}</h1><p class="meta">${dateTimeIs(new Date(m.createdAt))} · ${formatTime(m.durationSec)}</p>
${m.summary ? mdHtml(m.summary.markdown.replace(/^#\s.*\n?/, '')) : ''}
${m.notes.trim() ? `<h2>Glósur</h2>${mdHtml(m.notes)}` : ''}
<h2>Uppskrift</h2>${transcript}</body></html>`
}

export async function writeExport(m: Meeting, format: 'md' | 'txt' | 'srt' | 'docx' | 'json', path: string): Promise<void> {
  switch (format) {
    case 'md':
      writeFileSync(path, toMarkdown(m), 'utf8')
      break
    case 'txt':
      writeFileSync(path, toText(m), 'utf8')
      break
    case 'srt':
      writeFileSync(path, toSrt(m), 'utf8')
      break
    case 'json':
      writeFileSync(path, toJson(m), 'utf8')
      break
    case 'docx':
      writeFileSync(path, await toDocx(m))
      break
  }
}
