/**
 * An imported recording keeps its own extension. Everything that touches the audio afterwards - delete,
 * re-transcribe, diarization - must find that file, not an audio.wav that was never written for it.
 */
import { describe, it, expect, vi, beforeAll } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Meeting } from '../src/shared/types'

const root = mkdtempSync(join(tmpdir(), 'imported-audio-'))

vi.mock('electron', () => ({ app: { getPath: () => root, isPackaged: false } }))
vi.mock('../src/main/settings', () => ({ dataDir: () => root }))

const { audioPath, deleteAudio, loadMeeting } = await import('../src/main/store')

function write(id: string, audioFile: string | undefined): string {
  const dir = join(root, 'meetings', id)
  mkdirSync(dir, { recursive: true })
  const m = {
    id, title: 'Fundur', createdAt: new Date().toISOString(), durationSec: 1, language: 'is', engine: 'local',
    status: 'done', participants: [], speakerNames: {}, segments: [], notes: '', highlights: [], chat: [],
    tags: [], audioFile
  } as unknown as Meeting
  writeFileSync(join(dir, 'meeting.json'), JSON.stringify(m), 'utf8')
  return dir
}

beforeAll(() => {
  writeFileSync(join(write('imported', 'audio.mp3'), 'audio.mp3'), 'not really audio', 'utf8')
  writeFileSync(join(write('recorded', 'audio.wav'), 'audio.wav'), 'not really audio', 'utf8')
  write('nothing', undefined)
})

describe('finding the audio file of a meeting', () => {
  it('follows the extension an imported file actually has', () => {
    expect(audioPath('imported').endsWith('audio.mp3')).toBe(true)
  })

  it('still points at audio.wav for a recording', () => {
    expect(audioPath('recorded').endsWith('audio.wav')).toBe(true)
  })

  it('falls back to audio.wav while a meeting has no audioFile yet', () => {
    // RecordingSession asks for the path before the meeting has been given one.
    expect(audioPath('nothing').endsWith('audio.wav')).toBe(true)
  })

  it('deletes the imported file instead of leaving it orphaned on disk', () => {
    const p = audioPath('imported')
    deleteAudio('imported')
    expect(existsSync(p)).toBe(false)
    expect(loadMeeting('imported')!.audioFile).toBeUndefined()
  })
})
