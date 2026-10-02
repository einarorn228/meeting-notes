/**
 * A line can be corrected while the meeting is still being recorded.
 *
 * At a conference a person sits beside the app and fixes what the recogniser got wrong as it appears. The live
 * session holds the transcript in memory and saves it over the file on disk, so an edit that only went to the
 * file was silently lost at the next save. The edit has to land in the session itself.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { EngineCallbacks, TranscriptionEngine } from '../src/main/transcription/types'
import type { Meeting, Segment } from '../src/shared/types'

const saved: Meeting[] = []
const learned: { before: string; after: string }[] = []
let engine: FakeEngine

class FakeEngine implements TranscriptionEngine {
  readonly id = 'local' as const
  cb!: EngineCallbacks
  async start(_opts: unknown, cb: EngineCallbacks): Promise<void> {
    this.cb = cb
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
    storage: { keepAudio: false }
  })
}))
vi.mock('../src/main/store', () => ({
  audioPath: () => '/tmp/x.wav',
  newId: () => 'm1',
  saveMeeting: (m: Meeting) => saved.push(structuredClone(m)),
  updateMeeting: () => {},
  loadMeeting: () => null
}))
vi.mock('../src/main/corrections', () => ({
  applyCorrections: (text: string) => text,
  learnFromEdit: (before: string, after: string) => learned.push({ before, after })
}))
vi.mock('../src/main/transcription', () => ({ createEngine: () => engine }))

const { RecordingSession } = await import('../src/main/session')

beforeEach(() => {
  vi.useFakeTimers()
  saved.length = 0
  learned.length = 0
  engine = new FakeEngine()
})
afterEach(() => vi.useRealTimers())

async function recordingWithTwoLines(): Promise<{ s: InstanceType<typeof RecordingSession>; sent: Segment[] }> {
  const s = new RecordingSession({})
  const sent: Segment[] = []
  s.on('segment', (_id: string, seg: Segment) => sent.push(seg))
  await s.start()
  engine.cb.onSegment({ id: 'a', channel: 'mic', start: 1, end: 4, text: 'forseti asíí setur þingið' })
  engine.cb.onSegment({ id: 'b', channel: 'mic', start: 5, end: 8, text: 'góðan daginn' })
  return { s, sent }
}

describe('correcting a line during the recording', () => {
  it('changes the line in the running meeting and tells the view', async () => {
    const { s, sent } = await recordingWithTwoLines()
    sent.length = 0

    const edited = s.editSegment('a', { text: 'Forseti ASÍ setur þingið' })

    expect(edited?.text).toBe('Forseti ASÍ setur þingið')
    expect(s.getMeeting().segments.map((x) => x.text)).toEqual(['Forseti ASÍ setur þingið', 'góðan daginn'])
    expect(sent).toEqual([expect.objectContaining({ id: 'a', text: 'Forseti ASÍ setur þingið', start: 1 })])
  })

  it('survives the saves that follow, to the end of the meeting', async () => {
    const { s } = await recordingWithTwoLines()
    s.editSegment('a', { text: 'Forseti ASÍ setur þingið' })
    engine.cb.onSegment({ id: 'c', channel: 'mic', start: 9, end: 12, text: 'næsta mál' })
    await vi.advanceTimersByTimeAsync(2000)

    const m = await s.stop()

    expect(m.segments.find((x) => x.id === 'a')?.text).toBe('Forseti ASÍ setur þingið')
    expect(saved.at(-1)?.segments.find((x) => x.id === 'a')?.text).toBe('Forseti ASÍ setur þingið')
  })

  it('remembers what the recogniser got wrong, like an edit after the meeting does', async () => {
    const { s } = await recordingWithTwoLines()
    s.editSegment('a', { text: 'Forseti ASÍ setur þingið' })
    expect(learned).toEqual([{ before: 'forseti asíí setur þingið', after: 'Forseti ASÍ setur þingið' }])
  })

  it('learns nothing from a speaker change or an unchanged text', async () => {
    const { s } = await recordingWithTwoLines()
    s.editSegment('a', { speaker: 'Forseti' })
    s.editSegment('b', { text: 'góðan daginn' })
    expect(learned).toEqual([])
    expect(s.getMeeting().segments[0].speaker).toBe('Forseti')
  })

  it('says so when the line does not exist', async () => {
    const { s, sent } = await recordingWithTwoLines()
    sent.length = 0
    expect(s.editSegment('nope', { text: 'x' })).toBeUndefined()
    expect(sent).toEqual([])
  })
})
