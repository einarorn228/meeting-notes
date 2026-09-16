/**
 * A meeting that was still recording when the app died must not stay "recording" forever.
 *
 * At startup nothing can be recording yet, so any meeting in that state belongs to a run that never stopped -
 * a crash, a power cut, the machine shutting down mid-meeting. It is settled here: marked interrupted, given
 * the length of the audio that did reach the disk, and left with an audio file the transcript can be finished
 * from.
 */
import { describe, it, expect, vi, beforeAll } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Meeting } from '../src/shared/types'
import { StereoWavWriter } from '../src/main/wav'

const root = mkdtempSync(join(tmpdir(), 'store-'))

vi.mock('electron', () => ({ app: { getPath: () => root, isPackaged: false } }))
vi.mock('../src/main/settings', () => ({ dataDir: () => root }))

const { recoverInterruptedMeetings, loadMeeting } = await import('../src/main/store')

function meeting(id: string, status: Meeting['status']): Meeting {
  return {
    id, title: 'Fundur', createdAt: new Date().toISOString(), durationSec: 0, language: 'is', engine: 'local',
    status, participants: [], speakerNames: {}, segments: [], notes: '', highlights: [], chat: [], tags: [],
    audioFile: 'audio.wav'
  } as unknown as Meeting
}

function write(m: Meeting): string {
  const dir = join(root, 'meetings', m.id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'meeting.json'), JSON.stringify(m), 'utf8')
  return dir
}

beforeAll(() => {
  const crashed = write(meeting('crashed', 'recording'))
  const w = new StereoWavWriter(join(crashed, 'audio.wav'))
  for (let i = 0; i < 100; i++) w.write('mic', new Int16Array(1600).fill(50), i * 100) // 10 s, then the app dies
  write(meeting('silent', 'recording')) // interrupted before any audio was kept
  write(meeting('finished', 'done'))
})

describe('recovering a meeting the app never finished', () => {
  it('marks it interrupted and takes its length from the audio on disk', () => {
    const ids = recoverInterruptedMeetings().map((m) => m.id).sort()
    expect(ids).toEqual(['crashed', 'silent'])
    const m = loadMeeting('crashed')!
    expect(m.status).toBe('interrupted')
    expect(m.durationSec).toBeGreaterThanOrEqual(9)
    expect(m.audioFile).toBe('audio.wav')
    expect(m.endedAt).toBeTruthy()
  })

  it('says so plainly when no audio was kept, instead of offering a transcript it cannot make', () => {
    const m = loadMeeting('silent')!
    expect(m.status).toBe('interrupted')
    expect(m.audioFile).toBeUndefined()
  })

  it('leaves finished meetings alone', () => {
    expect(loadMeeting('finished')!.status).toBe('done')
  })
})
