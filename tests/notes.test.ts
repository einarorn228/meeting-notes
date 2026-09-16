import { describe, it, expect, vi } from 'vitest'

// The real electron package resolves (and, on a fresh CI checkout, downloads) its binary the moment it is
// imported, which these tests have no use for - they only reach it through settings.ts asking for a data
// directory. Three test files racing on that download is how the suite fails for reasons of its own.
vi.mock('electron', () => ({ app: { getPath: () => '/tmp', isPackaged: false, getVersion: () => '0.0.0' } }))
import { parseSummary } from '../src/main/ai/notes'

const MD = `# Stöðufundur um fjárhagsáætlun

## Samantekt
Fundurinn fjallaði um fjárhagsáætlun næsta árs.

## Helstu atriði
- Tekjur aukast um 5 %.
- Kostnaður við húsnæði hækkar.

## Ákvarðanir
- Ákveðið var að fresta ráðningu til janúar.

## Aðgerðir
- [ ] Senda uppfærða áætlun — Ábyrgð: Guðrún Jónsdóttir — Frestur: 20. september 2026
- [x] Boða næsta fund — Ábyrgð: Einar — Frestur: ekki tilgreint

## Næstu skref
- Ekkert.
`

describe('parseSummary', () => {
  it('extracts title, key points, decisions and action items with owners and due dates', () => {
    const p = parseSummary(MD)
    expect(p.title).toBe('Stöðufundur um fjárhagsáætlun')
    expect(p.keyPoints).toEqual(['Tekjur aukast um 5 %.', 'Kostnaður við húsnæði hækkar.'])
    expect(p.decisions).toEqual(['Ákveðið var að fresta ráðningu til janúar.'])
    expect(p.actionItems).toEqual([
      { text: 'Senda uppfærða áætlun', owner: 'Guðrún Jónsdóttir', due: '20. september 2026', done: false },
      { text: 'Boða næsta fund', owner: 'Einar', due: 'ekki tilgreint', done: true }
    ])
  })
})
