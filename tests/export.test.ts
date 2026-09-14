import { describe, it, expect } from 'vitest'
import { toMarkdown, toSrt, toDocx } from '../src/main/export'
import type { Meeting } from '../src/shared/types'

const meeting: Meeting = {
  id: 'm1',
  title: 'Prufufundur',
  createdAt: '2026-09-14T10:00:00.000Z',
  durationSec: 125,
  language: 'is',
  engine: 'local',
  status: 'done',
  participants: ['Guðrún'],
  speakerNames: { me: 'Ég', others: 'Aðrir', spk1: 'Guðrún' },
  segments: [
    { id: 's1', channel: 'mic', start: 0.5, end: 3.2, text: 'Góðan daginn öll.', speaker: 'me' },
    { id: 's2', channel: 'system', start: 3.4, end: 6.1, text: 'Sæll Einar.', speaker: 'spk1' }
  ],
  notes: 'Muna eftir skýrslunni',
  highlights: [{ id: 'h1', time: 4, note: 'Mikilvægt' }],
  chat: [],
  tags: ['prufa'],
  summary: { templateId: 'fundargerd', language: 'is', generatedAt: '2026-09-14T10:05:00.000Z', provider: 'anthropic', model: 'claude-opus-5', markdown: '# Titill\n\n## Samantekt\nStutt.' }
}

describe('export', () => {
  it('renders markdown with speakers, notes and highlights', () => {
    const md = toMarkdown(meeting)
    expect(md).toContain('# Prufufundur')
    expect(md).toContain('**[00:03] Guðrún:** Sæll Einar.')
    expect(md).toContain('## Glósur')
    expect(md).toContain('[00:04] Mikilvægt')
    expect(md).toContain('## Samantekt')
  })
  it('renders srt with timestamps', () => {
    const srt = toSrt(meeting)
    expect(srt).toContain('1\n00:00:00,500 --> 00:00:03,200\nÉg: Góðan daginn öll.')
  })
  it('produces a docx buffer', async () => {
    const buf = await toDocx(meeting)
    expect(buf.length).toBeGreaterThan(2000)
    expect(buf.subarray(0, 2).toString()).toBe('PK')
  })
})
