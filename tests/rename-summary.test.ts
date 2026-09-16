import { describe, it, expect, vi } from 'vitest'
import type { Meeting } from '../src/shared/types'

// See llm.test.ts: the real electron package fetches its binary on import, and store.ts only wants a path.
vi.mock('electron', () => ({ app: { getPath: () => '/tmp', isPackaged: false, getVersion: () => '0.0.0' } }))
vi.mock('../src/main/settings', () => ({ getSettings: () => ({}), dataDir: () => '/tmp' }))

import { renameInSummary } from '../src/main/store'

/** The shape of a real meeting, cut down to what renaming touches. */
const meeting = (names: Record<string, string>, markdown: string): Meeting =>
  ({
    id: 'm1',
    speakerNames: names,
    summary: {
      templateId: 'fundargerd',
      language: 'is',
      generatedAt: '2026-09-16T21:56:35.510Z',
      provider: 'anthropic',
      model: 'x',
      markdown,
      title: 'Símtal',
      keyPoints: ['Þátttakandi 1 lýsti jákvæðri reynslu af forritinu.'],
      decisions: [],
      actionItems: [{ text: 'Senda Þátttakanda 1 hönnunina', done: false, owner: 'Þátttakandi 1' }]
    }
  }) as unknown as Meeting

describe('naming a speaker after the minutes were written', () => {
  it('puts the name into the minutes the app had already written', () => {
    const m = meeting({ spk1: 'Þátttakandi 1' }, '## Helstu atriði\n- Þátttakandi 1 lýsti jákvæðri reynslu.')
    const next = renameInSummary(m, 'spk1', 'Aníta')
    expect(next.summary?.markdown).toBe('## Helstu atriði\n- Aníta lýsti jákvæðri reynslu.')
    expect(next.summary?.keyPoints?.[0]).toBe('Aníta lýsti jákvæðri reynslu af forritinu.')
    expect(next.summary?.actionItems?.[0].owner).toBe('Aníta')
  })

  it('leaves the inflected form alone rather than writing nonsense', () => {
    // "Þátttakanda 1" is the dative; only the exact label the app wrote is replaced.
    const m = meeting({ spk1: 'Þátttakandi 1' }, 'Senda Þátttakanda 1 hönnunina.')
    expect(renameInSummary(m, 'spk1', 'Aníta').summary?.markdown).toBe('Senda Þátttakanda 1 hönnunina.')
  })

  it('does not touch a speaker that already had a real name', () => {
    // Renaming "Anna" to "Aníta" must not rewrite the word Anna wherever it appears in the minutes.
    const m = meeting({ spk1: 'Anna' }, 'Anna sagði að Anna-verkefnið væri búið.')
    expect(renameInSummary(m, 'spk1', 'Aníta').summary?.markdown).toBe('Anna sagði að Anna-verkefnið væri búið.')
  })

  it('leaves a longer label alone when a shorter one is renamed', () => {
    const m = meeting({ spk1: 'Þátttakandi 1' }, 'Þátttakandi 1 og Þátttakandi 10 töluðu.')
    expect(renameInSummary(m, 'spk1', 'Aníta').summary?.markdown).toBe('Aníta og Þátttakandi 10 töluðu.')
  })

  it('does nothing when there are no minutes yet', () => {
    const m = { ...meeting({ spk1: 'Þátttakandi 1' }, ''), summary: undefined } as Meeting
    expect(renameInSummary(m, 'spk1', 'Aníta')).toBe(m)
  })
})
