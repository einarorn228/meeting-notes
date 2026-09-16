/**
 * Pressing "Ræðumenn…" must always produce an answer.
 *
 * Diarization needs the meeting's audio file, which only exists if "Geyma hljóðskrár" was on while recording.
 * Without it the request used to return the meeting unchanged: the app said it had started, then nothing ever
 * happened, which reads as a broken button rather than a missing recording.
 */
import { describe, it, expect, vi } from 'vitest'
import type { Meeting } from '../src/shared/types'

const meeting: Meeting = {
  id: 'm1', title: 'Fundur', createdAt: new Date().toISOString(), durationSec: 60, language: 'is',
  engine: 'local', status: 'done', segments: [{ id: 's1', channel: 'system', start: 0, end: 5, text: 'halló', speaker: 'others' }],
  highlights: [], participants: [], speakers: {}
} as unknown as Meeting

vi.mock('electron', () => ({ app: { getPath: () => '/tmp', isPackaged: false } }))
vi.mock('node:fs', async (orig) => ({ ...(await orig<typeof import('node:fs')>()), existsSync: () => false }))
vi.mock('../src/main/store', () => ({
  audioPath: () => '/tmp/does-not-exist.wav',
  loadMeeting: () => meeting,
  saveMeeting: () => {}
}))
vi.mock('../src/main/settings', () => ({ getSettings: () => ({ local: { diarize: true } }) }))
vi.mock('../src/main/transcription/sidecar', () => ({ sidecar: { ensureStarted: async () => {}, on: () => {}, off: () => {}, send: () => {} } }))

const { diarizeMeeting } = await import('../src/main/diarize')

describe('re-running speaker detection without a stored recording', () => {
  it('explains that the audio is gone instead of pretending to work', async () => {
    await expect(diarizeMeeting('m1', () => {}, { force: true, speakers: 2 })).rejects.toThrow(/Geyma hljóðskrár/)
  })

  it('stays quiet when it runs by itself after a meeting', async () => {
    await expect(diarizeMeeting('m1', () => {})).resolves.toBe(meeting)
  })
})
