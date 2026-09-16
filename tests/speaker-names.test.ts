/**
 * Naming a speaker should get easier, not repeat itself.
 *
 * The same people come to the same meetings, so the names typed before - and the names on the invitation for
 * this meeting - are offered as one-click suggestions. What must never be offered back is the placeholder the
 * user is trying to replace.
 */
import { describe, it, expect, vi, beforeAll } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Meeting } from '../src/shared/types'

const root = mkdtempSync(join(tmpdir(), 'names-'))

vi.mock('electron', () => ({ app: { getPath: () => root, isPackaged: false } }))
vi.mock('../src/main/settings', () => ({ dataDir: () => root }))

const { speakerNameSuggestions } = await import('../src/main/store')

function write(m: Partial<Meeting> & { id: string; createdAt: string }): void {
  const full = {
    title: 'Fundur', durationSec: 0, language: 'is', engine: 'local', status: 'done', participants: [],
    speakerNames: { me: 'Ég', others: 'Aðrir' }, segments: [], notes: '', highlights: [], chat: [], tags: [],
    ...m
  }
  mkdirSync(join(root, 'meetings', m.id), { recursive: true })
  writeFileSync(join(root, 'meetings', m.id, 'meeting.json'), JSON.stringify(full), 'utf8')
}

beforeAll(() => {
  write({ id: '2026-01-01-a', createdAt: '2026-01-01T09:00:00.000Z', participants: ['Guðrún Jónsdóttir'] })
  write({
    id: '2026-02-01-b', createdAt: '2026-02-01T09:00:00.000Z', participants: ['Jón Þór'],
    speakerNames: { me: 'Ég', others: 'Aðrir', spk1: 'Jón Þór', spk2: 'Þátttakandi 2' }
  })
  write({ id: '2026-03-01-c', createdAt: '2026-03-01T09:00:00.000Z', invitees: ['Aníta Jónsdóttir', 'Jón Þór'] })
})

describe('names offered when naming a speaker', () => {
  it('puts this meeting’s invitees first, then the names used most recently', () => {
    expect(speakerNameSuggestions('2026-03-01-c')).toEqual(['Aníta Jónsdóttir', 'Jón Þór', 'Guðrún Jónsdóttir'])
  })

  it('never offers the placeholders back', () => {
    const names = speakerNameSuggestions('2026-01-01-a')
    expect(names).not.toContain('Ég')
    expect(names).not.toContain('Aðrir')
    expect(names).not.toContain('Þátttakandi 2')
    expect(names).toContain('Jón Þór')
  })
})
