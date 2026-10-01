/**
 * A meeting whose transcript did not finish is never saved as done.
 *
 * "done" is what lets the minutes be written. When the engine says its transcript is incomplete and the audio
 * was kept, the meeting is saved as interrupted instead, so it is finished from the audio before anything is
 * summarised.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { EngineCallbacks, TranscriptionEngine } from '../src/main/transcription/types'

const saved: { status: string }[] = []
const config = { keepAudio: true }
let engine: FakeEngine

class FakeEngine implements TranscriptionEngine {
  readonly id = 'local' as const
  incomplete = false
  async start(_opts: unknown, cb: EngineCallbacks): Promise<void> {
    cb.onStatus('Tilbúið')
  }
  pushAudio(): void {}
  async stop(): Promise<void> {}
}

vi.mock('electron', () => ({ app: { getPath: () => '/tmp', isPackaged: false } }))
vi.mock('../src/main/settings', () => ({
  getSettings: () => ({
    engine: 'local',
    language: 'is',
    local: { modelId: 'aalto-large-v3-is', partials: false },
    vocabulary: [],
    audio: { captureMic: true, captureSystemAudio: false },
    storage: { keepAudio: config.keepAudio }
  })
}))
vi.mock('../src/main/store', () => ({
  audioPath: () => '/tmp/x.wav',
  newId: () => 'm1',
  saveMeeting: (m: { status: string }) => saved.push({ status: m.status }),
  updateMeeting: () => {},
  loadMeeting: () => null
}))
vi.mock('../src/main/wav', () => ({
  StereoWavWriter: class {
    write(): void {}
    close(): void {}
  }
}))
vi.mock('../src/main/transcription', () => ({ createEngine: () => engine }))

const { RecordingSession } = await import('../src/main/session')

beforeEach(() => {
  saved.length = 0
  config.keepAudio = true
  engine = new FakeEngine()
})

describe('finishing a recording', () => {
  it('is done when the engine delivered the whole transcript', async () => {
    const s = new RecordingSession({})
    await s.start()
    expect((await s.stop()).status).toBe('done')
  })

  it('is interrupted, not done, when the transcript is incomplete and the audio was kept', async () => {
    const s = new RecordingSession({})
    await s.start()
    engine.incomplete = true
    const m = await s.stop()
    expect(m.status).toBe('interrupted')
    expect(saved.at(-1)?.status).toBe('interrupted')
  })

  it('is done when nothing more can be made of it: no audio was kept', async () => {
    config.keepAudio = false
    const s = new RecordingSession({})
    await s.start()
    engine.incomplete = true
    expect((await s.stop()).status).toBe('done')
  })
})
