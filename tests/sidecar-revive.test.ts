import { describe, it, expect, vi, beforeEach } from 'vitest'

// See llm.test.ts: importing the real electron package downloads its binary, and settings.ts only wants a path.
vi.mock('electron', () => ({ app: { getPath: () => '/tmp', isPackaged: false, getVersion: () => '0.0.0' } }))

const settings = vi.hoisted(() => ({ local: { modelId: 'aalto-large-v3-is', partials: false }, vocabulary: [] }))
vi.mock('../src/main/settings', () => ({ getSettings: () => settings, dataDir: () => '/tmp' }))

/** A sidecar that can be told to die, and that records what was sent to it. */
const fake = vi.hoisted(() => {
  // vi.hoisted runs before the imports, so this stands in for the manager's EventEmitter.
  const listeners = new Map<string, ((...a: unknown[]) => void)[]>()
  const state = {
    sent: [] as Record<string, unknown>[],
    alive: true,
    ensureFails: 0,
    ensureCalls: 0,
    modelInfo: { device: 'cpu' },
    async ensureModel(): Promise<void> {
      state.ensureCalls++
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
    request: async (): Promise<Record<string, unknown>> => ({}),
    /** What the real manager does when the process exits: forget it, then tell listeners. */
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

const frame = new Int16Array(1600)
const callbacks = (): { errors: string[]; statuses: string[]; cb: Parameters<LocalEngine['start']>[1] } => {
  const errors: string[] = []
  const statuses: string[] = []
  return {
    errors,
    statuses,
    cb: {
      onSegment: () => {},
      onPartial: () => {},
      onStatus: (s) => statuses.push(s),
      onError: (m) => errors.push(m)
    }
  }
}

const opts = { language: 'is' as const, channels: ['mic' as const], vocabulary: [], partials: false }
const audioSent = (): Record<string, unknown>[] => fake.sent.filter((c) => c.type === 'audio')

beforeEach(() => {
  fake.sent = []
  fake.alive = true
  fake.ensureFails = 0
  fake.ensureCalls = 0
})

describe('the speech service dying in the middle of a meeting', () => {
  it('starts it again and keeps transcribing, without an error per audio frame', async () => {
    const { errors, cb } = callbacks()
    const engine = new LocalEngine()
    await engine.start(opts, cb)
    engine.pushAudio('mic', frame, 0)
    expect(audioSent()).toHaveLength(1)

    fake.die()
    // Ten frames arrive in the second after the crash; the user is told once, not ten times.
    for (let i = 1; i <= 10; i++) engine.pushAudio('mic', frame, i * 100)
    await vi.waitFor(() => expect(fake.sent.filter((c) => c.type === 'start')).toHaveLength(2))
    expect(errors.filter((e) => e).length).toBe(1)
    expect(audioSent()).toHaveLength(1)

    // Back on its feet: audio flows again, and the error line is cleared.
    engine.pushAudio('mic', frame, 2000)
    expect(audioSent()).toHaveLength(2)
    expect(errors.at(-1)).toBe('')
    await engine.stop()
  })

  it('keeps the same timestamps, so the text still lands where it was said', async () => {
    const { cb } = callbacks()
    const engine = new LocalEngine()
    await engine.start(opts, cb)
    fake.die()
    await vi.waitFor(() => expect(fake.sent.filter((c) => c.type === 'start')).toHaveLength(2))
    engine.pushAudio('mic', frame, 930000)
    expect(audioSent().at(-1)?.t_ms).toBe(930000)
    await engine.stop()
  })

  it('gives up with an explanation instead of retrying for the rest of the meeting', async () => {
    const { errors, cb } = callbacks()
    const engine = new LocalEngine()
    await engine.start(opts, cb)
    fake.ensureFails = 99
    vi.useFakeTimers()
    try {
      fake.die()
      engine.pushAudio('mic', frame, 100)
      // The whole backoff ladder, without waiting through it.
      await vi.advanceTimersByTimeAsync(120000)
      expect(errors.at(-1)).toMatch(/fór ekki í gang aftur/)
      expect(fake.ensureCalls).toBe(6) // the start of the meeting, then five attempts
      expect(fake.sent.filter((c) => c.type === 'start')).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not restart it after the user has pressed stop', async () => {
    const { cb } = callbacks()
    const engine = new LocalEngine()
    await engine.start(opts, cb)
    await engine.stop()
    fake.die()
    await new Promise((r) => setTimeout(r, 50))
    expect(fake.sent.filter((c) => c.type === 'start')).toHaveLength(1)
  })
})
