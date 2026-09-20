/**
 * settings.json holds every setting and every API key. getSettings() falls back to DEFAULT_SETTINGS when the
 * file does not parse, so a half-written file would wipe the user's configuration without saying a word.
 * The write therefore goes through a temporary file and a rename, the same way saveMeeting does.
 */
import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = mkdtempSync(join(tmpdir(), 'settings-'))

vi.mock('electron', () => ({ app: { getPath: () => root, isPackaged: false } }))

const { getSettings, saveSettings } = await import('../src/main/settings')

const file = join(root, 'settings.json')

describe('saving settings', () => {
  it('leaves a complete, parseable file and no temporary file behind', () => {
    saveSettings({ language: 'en' })
    expect(existsSync(file)).toBe(true)
    expect(existsSync(file + '.tmp')).toBe(false)
    expect(JSON.parse(readFileSync(file, 'utf8')).language).toBe('en')
  })

  it('merges into what is already there instead of replacing it', () => {
    saveSettings({ llm: { autoSummarize: false } } as never)
    const s = getSettings()
    expect(s.language).toBe('en')
    expect(s.llm.autoSummarize).toBe(false)
    expect(s.llm.provider).toBe('anthropic')
    expect(existsSync(file + '.tmp')).toBe(false)
  })
})
