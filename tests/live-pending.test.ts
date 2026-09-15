/**
 * The live transcript shows a placeholder for speech that has been captured but not written out yet.
 *
 * On a CPU the Icelandic large model transcribes several times slower than people talk (measured: 10.4 s for a
 * 3-second sentence), so between someone speaking and the text landing there used to be nothing on screen at
 * all - which reads as a broken app. These tests pin the contract that makes the placeholder possible: every
 * announced cut is closed exactly once, whether or not it produced text.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EventEmitter } from 'node:events'
import type { ChannelId, PendingSegment } from '../src/shared/types'

const bus = new EventEmitter()
const sent: Record<string, unknown>[] = []

vi.mock('electron', () => ({ app: { getPath: () => '/tmp', isPackaged: false } }))
vi.mock('../src/main/settings', () => ({
  getSettings: () => ({ local: { modelId: 'aalto-large-v3-is' } })
}))
vi.mock('../src/main/transcription/sidecar', () => ({
  sidecar: {
    on: (e: string, fn: (...a: unknown[]) => void) => bus.on(e, fn),
    off: (e: string, fn: (...a: unknown[]) => void) => bus.off(e, fn),
    send: (cmd: Record<string, unknown>) => sent.push(cmd),
    ensureModel: async () => {},
    request: async () => ({ type: 'stopped' }),
    get modelInfo() {
      return { modelId: 'aalto-large-v3-is', device: 'cpu' }
    }
  }
}))

const { LocalEngine } = await import('../src/main/transcription/local')

type Calls = {
  pending: (PendingSegment & { queue: number })[]
  done: string[]
  segments: { id?: string; text: string }[]
  statuses: string[]
}

async function startEngine(): Promise<{ calls: Calls; sessionId: string; emit: (ev: Record<string, unknown>) => void }> {
  const calls: Calls = { pending: [], done: [], segments: [], statuses: [] }
  const engine = new LocalEngine()
  await engine.start(
    { language: 'is', channels: ['mic'] as ChannelId[], vocabulary: [], partials: false },
    {
      onSegment: (s) => calls.segments.push({ id: s.id, text: s.text }),
      onPartial: () => {},
      onPending: (p) => calls.pending.push(p),
      onPendingDone: (id) => calls.done.push(id),
      onStatus: (s) => calls.statuses.push(s),
      onError: () => {}
    }
  )
  const sessionId = String(sent.find((c) => c.type === 'start')?.session_id)
  return { calls, sessionId, emit: (ev) => bus.emit('event', { session_id: sessionId, ...ev }) }
}

beforeEach(() => {
  sent.length = 0
  bus.removeAllListeners()
})

describe('pending speech in the live transcript', () => {
  it('announces a cut before its text exists and closes it when the text arrives', async () => {
    const { calls, emit } = await startEngine()

    emit({ type: 'pending', seg_id: 'a1', channel: 'mic', start: 3.2, end: 6.1, queue: 1 })
    expect(calls.pending).toEqual([{ id: 'a1', channel: 'mic', start: 3.2, end: 6.1, queue: 1 }])
    expect(calls.segments).toEqual([])

    emit({ type: 'segment', seg_id: 'a1', channel: 'mic', start: 3.2, end: 6.1, text: 'góðan daginn' })
    expect(calls.done).toEqual(['a1'])
    expect(calls.segments).toEqual([{ id: 'a1', text: 'góðan daginn' }])
  })

  it('closes a cut that produced no text, instead of leaving a placeholder up forever', async () => {
    const { calls, emit } = await startEngine()

    emit({ type: 'pending', seg_id: 'b1', channel: 'mic', start: 0, end: 1, queue: 1 })
    // An empty segment is how the sidecar reports "nothing usable here" - a dropped hallucination, or a
    // segment whose transcription failed.
    emit({ type: 'segment', seg_id: 'b1', channel: 'mic', start: 0, end: 1, text: '' })

    expect(calls.done).toEqual(['b1'])
    expect(calls.segments).toEqual([])
  })

  it('says once when the machine stops keeping up, and takes it back when it catches up', async () => {
    const { calls, emit } = await startEngine()
    const ready = calls.statuses[calls.statuses.length - 1]

    for (const queue of [1, 3, 6, 7, 8]) emit({ type: 'pending', seg_id: `q${queue}`, channel: 'mic', start: queue, end: queue + 1, queue })
    const warnings = calls.statuses.filter((s) => s.includes('hefur ekki undan'))
    expect(warnings).toHaveLength(1)

    emit({ type: 'pending', seg_id: 'q-last', channel: 'mic', start: 20, end: 21, queue: 1 })
    expect(calls.statuses[calls.statuses.length - 1]).toBe(ready)
  })
})
