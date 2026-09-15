/**
 * Meeting length is the time people were talking, not the time the app spent working.
 *
 * On a CPU the Icelandic model loads for a minute or more before the first chunk is heard, and after the stop
 * button the transcription backlog can take minutes to drain. Neither is meeting time: a 3-minute call used to
 * export as "Lengd: 07:58" because the backlog kept saving a growing wall-clock duration.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { EngineCallbacks, TranscriptionEngine } from '../src/main/transcription/types'

const saved: { durationSec: number; status: string }[] = []
let engine: FakeEngine

class FakeEngine implements TranscriptionEngine {
  readonly id = 'local' as const
  cb!: EngineCallbacks
  loadMs = 0
  drainMs = 0
  async start(_opts: unknown, cb: EngineCallbacks): Promise<void> {
    this.cb = cb
    await vi.advanceTimersByTimeAsync(this.loadMs)
    cb.onStatus('Tilbúið')
  }
  pushAudio(): void {}
  async stop(): Promise<void> {
    // The backlog finishes after the stop button: each late segment triggers a save.
    await vi.advanceTimersByTimeAsync(this.drainMs)
    this.cb.onSegment({ channel: 'mic', start: 170, end: 174, text: 'bless' })
    await vi.advanceTimersByTimeAsync(2000) // let the debounced save fire
  }
}

vi.mock('electron', () => ({ app: { getPath: () => '/tmp', isPackaged: false } }))
vi.mock('../src/main/settings', () => ({
  getSettings: () => ({
    engine: 'local',
    language: 'is',
    local: { modelId: 'aalto-large-v3-is', partials: false },
    vocabulary: [],
    audio: { captureMic: true, captureSystemAudio: false },
    storage: { keepAudio: false }
  })
}))
vi.mock('../src/main/store', () => ({
  audioPath: () => '/tmp/x.wav',
  newId: () => 'm1',
  saveMeeting: (m: { durationSec: number; status: string }) => saved.push({ durationSec: m.durationSec, status: m.status }),
  updateMeeting: () => {},
  loadMeeting: () => null
}))
vi.mock('../src/main/transcription', () => ({ createEngine: () => engine }))

const { RecordingSession } = await import('../src/main/session')

beforeEach(() => {
  vi.useFakeTimers()
  saved.length = 0
  engine = new FakeEngine()
})
afterEach(() => vi.useRealTimers())

async function record(seconds: number): Promise<InstanceType<typeof RecordingSession>> {
  const s = new RecordingSession({})
  await s.start()
  for (let t = 0; t < seconds; t++) {
    s.pushAudio('mic', new Int16Array(16000), t * 1000)
    await vi.advanceTimersByTimeAsync(1000)
  }
  return s
}

describe('meeting length', () => {
  it('does not include the minutes spent loading the model before the meeting', async () => {
    engine.loadMs = 90_000
    const s = await record(174)
    expect(s.elapsedSec()).toBeCloseTo(174, 0)
  })

  it('stops at the stop button, even though the backlog keeps saving afterwards', async () => {
    engine.drainMs = 5 * 60_000
    const s = await record(174)
    const m = await s.stop()
    expect(m.durationSec).toBeCloseTo(174, 0)
    expect(saved.at(-1)?.status).toBe('done')
    expect(saved.map((x) => Math.round(x.durationSec))).not.toContain(174 + 300)
    expect(Math.round(saved.at(-1)!.durationSec)).toBe(174)
  })
})
