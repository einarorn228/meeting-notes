/**
 * Pressing stop must not cut the transcript short.
 *
 * A large model on a CPU is slower than speech, so a long meeting ends with minutes of audio still queued. The
 * stop used to wait a flat ten minutes and then save the meeting as done with whatever text existed: a 45-minute
 * meeting kept 25 minutes of transcript, and the minutes were written from that half. Now the wait lasts as long
 * as the speech service keeps reporting progress, and a transcript that did not finish is said to be incomplete
 * so the meeting can be finished from its audio.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: () => '/tmp', isPackaged: false, getVersion: () => '0.0.0' } }))

const settings = vi.hoisted(() => ({ local: { modelId: 'aalto-large-v3-is', partials: false }, vocabulary: [] }))
vi.mock('../src/main/settings', () => ({ getSettings: () => settings, dataDir: () => '/tmp' }))

const fake = vi.hoisted(() => {
  const listeners = new Map<string, ((...a: unknown[]) => void)[]>()
  const state = {
    sent: [] as Record<string, unknown>[],
    alive: true,
    ensureFails: 0,
    shutdowns: 0,
    modelInfo: { device: 'cpu' },
    async ensureModel(): Promise<void> {
      if (state.ensureFails > 0) {
        state.ensureFails--
        throw new Error('sidecar-not-installed')
      }
      state.alive = true
    },
    send(cmd: Record<string, unknown>): void {
      if (!state.alive) throw new Error('sidecar not running')
      state.sent.push(cmd)
    },
    shutdown(): void {
      state.shutdowns++
      state.alive = false
    },
    die(): void {
      state.alive = false
      state.emit('exit', 137)
    },
    on(event: string, fn: (...a: unknown[]) => void): void {
      listeners.set(event, [...(listeners.get(event) ?? []), fn])
    },
    off(event: string, fn: (...a: unknown[]) => void): void {
      listeners.set(event, (listeners.get(event) ?? []).filter((f) => f !== fn))
    },
    emit(event: string, ...args: unknown[]): void {
      for (const fn of [...(listeners.get(event) ?? [])]) fn(...args)
    }
  }
  return state
})
vi.mock('../src/main/transcription/sidecar', () => ({ sidecar: fake }))

import { LocalEngine } from '../src/main/transcription/local'

const MINUTE = 60_000
const frame = new Int16Array(1600)
const opts = { language: 'is' as const, channels: ['mic' as const], vocabulary: [], partials: false }

function started(): { engine: LocalEngine; errors: string[]; segments: string[] } {
  const errors: string[] = []
  const segments: string[] = []
  const engine = new LocalEngine()
  void engine.start(opts, { onSegment: (s) => segments.push(s.text), onPartial: () => {}, onStatus: () => {}, onError: (m) => errors.push(m) })
  return { engine, errors, segments }
}

const sessionId = (): string => String(fake.sent.find((c) => c.type === 'start')?.session_id)

beforeEach(() => {
  vi.useFakeTimers()
  fake.sent = []
  fake.alive = true
  fake.ensureFails = 0
  fake.shutdowns = 0
})
afterEach(() => vi.useRealTimers())

describe('stopping a meeting whose transcript is far behind', () => {
  it('waits for the whole backlog while the speech service keeps reporting progress', async () => {
    const { engine, errors, segments } = started()
    await vi.advanceTimersByTimeAsync(0)
    let done = false
    const stop = engine.stop().then(() => (done = true))
    await vi.advanceTimersByTimeAsync(0)
    expect(fake.sent.at(-1)).toMatchObject({ type: 'stop', session_id: sessionId() })

    // 35 minutes of backlog: a line of text and a shrinking count every half minute.
    for (let i = 70; i > 0; i--) {
      await vi.advanceTimersByTimeAsync(MINUTE / 2)
      fake.emit('event', { type: 'segment', session_id: sessionId(), channel: 'mic', start: i, end: i + 1, text: 'orð' })
      fake.emit('event', { type: 'finishing', session_id: sessionId(), pending: i })
      expect(done).toBe(false)
    }
    fake.emit('event', { type: 'stopped', session_id: sessionId() })
    await stop
    expect(segments).toHaveLength(70)
    expect(engine.incomplete).toBe(false)
    expect(errors).toEqual([])
    expect(fake.shutdowns).toBe(0)
  })

  it('gives up only after ten silent minutes, says the transcript is incomplete and stops the wedged process', async () => {
    const { engine, errors } = started()
    await vi.advanceTimersByTimeAsync(0)
    const stop = engine.stop()
    await vi.advanceTimersByTimeAsync(4 * MINUTE)
    fake.emit('event', { type: 'finishing', session_id: sessionId(), pending: 12 })
    await vi.advanceTimersByTimeAsync(9 * MINUTE)
    expect(engine.incomplete).toBe(false)
    await vi.advanceTimersByTimeAsync(2 * MINUTE)
    await stop
    expect(engine.incomplete).toBe(true)
    expect(errors.at(-1)).toMatch(/kláraðist ekki/)
    expect(fake.shutdowns).toBe(1)
  })

  it('is incomplete when the speech service died while the backlog was draining', async () => {
    const { engine } = started()
    await vi.advanceTimersByTimeAsync(0)
    const stop = engine.stop()
    await vi.advanceTimersByTimeAsync(MINUTE)
    fake.die()
    await stop
    expect(engine.incomplete).toBe(true)
  })

  it('is incomplete when audio was dropped while the speech service was down', async () => {
    const { engine } = started()
    await vi.advanceTimersByTimeAsync(0)
    fake.ensureFails = 1
    fake.die()
    engine.pushAudio('mic', frame, 1000) // dropped: the service is restarting
    await vi.advanceTimersByTimeAsync(MINUTE)
    engine.pushAudio('mic', frame, 61000) // back up
    const stop = engine.stop()
    await vi.advanceTimersByTimeAsync(0)
    fake.emit('event', { type: 'stopped', session_id: sessionId() })
    await stop
    expect(engine.incomplete).toBe(true)
  })
})
