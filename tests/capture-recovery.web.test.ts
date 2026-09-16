/**
 * What happens when a capture device disappears in the middle of a meeting.
 *
 * A Bluetooth headset drops out, a USB microphone is unplugged, Windows moves the system output to headphones
 * that were just plugged in: the media track ends. With nothing watching for it the worklet simply stops
 * delivering samples and the rest of the meeting is silence that nobody notices until afterwards.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

interface FakeNode {
  port: { onmessage: ((ev: { data: { pcm: ArrayBuffer; rms: number } }) => void) | null }
}

const nodes: FakeNode[] = []
const contexts: { state: string }[] = []
let resumed = 0
const pushed: { channel: string; tMs: number }[] = []
let endTrack: (() => void) | null = null
let opened = 0

class FakeTrack {
  readyState = 'live'
  private listeners: (() => void)[] = []
  addEventListener(_: string, fn: () => void): void {
    this.listeners.push(fn)
  }
  end(): void {
    this.readyState = 'ended'
    for (const fn of this.listeners) fn()
  }
  stop(): void {}
}

class FakeStream {
  track = new FakeTrack()
  getAudioTracks(): FakeTrack[] {
    return [this.track]
  }
  getVideoTracks(): FakeTrack[] {
    return []
  }
  getTracks(): FakeTrack[] {
    return [this.track]
  }
}

function install(): void {
  nodes.length = 0
  contexts.length = 0
  pushed.length = 0
  opened = 0
  resumed = 0
  const g = globalThis as Record<string, unknown>
  g.window = globalThis
  g.AudioContext = class {
    state = 'running'
    audioWorklet = { addModule: async (): Promise<void> => {} }
    createMediaStreamSource(): { connect: () => void; disconnect: () => void } {
      return { connect: () => {}, disconnect: () => {} }
    }
    async resume(): Promise<void> {
      this.state = 'running'
      resumed++
    }
    async close(): Promise<void> {}
    constructor() {
      contexts.push(this as unknown as { state: string })
    }
  }
  g.AudioWorkletNode = class {
    port: FakeNode['port'] = { onmessage: null }
    constructor() {
      nodes.push(this as unknown as FakeNode)
    }
    disconnect(): void {}
  }
  g.MediaStream = FakeStream
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: {
      userAgent: 'test',
      mediaDevices: {
        getUserMedia: async (): Promise<FakeStream> => {
          opened++
          const s = new FakeStream()
          endTrack = () => s.track.end()
          return s
        }
      }
    }
  })
  g.fundarritari = {
    pushAudio: (channel: string, _pcm: ArrayBuffer, tMs: number) => pushed.push({ channel, tMs }),
    reportLevels: () => {}
  }
}

/** One 100 ms frame out of the worklet for the track opened most recently. */
function frame(): void {
  nodes[nodes.length - 1].port.onmessage?.({ data: { pcm: new ArrayBuffer(3200), rms: 0.4 } })
}

describe('a microphone that disappears mid-meeting', () => {
  beforeEach(() => {
    install()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance', 'Date'] })
  })
  afterEach(() => vi.useRealTimers())

  it('is reopened, and the seconds it was gone stay gone instead of shifting the rest', async () => {
    const { startCapture } = await import('../src/renderer/src/audio/capture')
    const lost: string[] = []
    const restored: string[] = []
    const handle = await startCapture({
      captureMic: true,
      captureSystem: false,
      echoCancellation: true,
      noiseSuppression: true,
      onChannelLost: (c) => lost.push(c),
      onChannelRestored: (c) => restored.push(c)
    })
    expect(handle.hasMic).toBe(true)
    for (let i = 0; i < 10; i++) frame() // 1 s of audio
    expect(pushed.map((p) => p.tMs)).toEqual([0, 100, 200, 300, 400, 500, 600, 700, 800, 900])

    endTrack!()
    expect(lost).toEqual(['mic'])
    await vi.advanceTimersByTimeAsync(5000) // the headset comes back while the app is retrying
    expect(restored).toEqual(['mic'])
    expect(opened).toBe(2)

    frame()
    // The first frame after the reconnect is placed where the meeting actually is - roughly five seconds in -
    // so the gap is silence in the recording rather than a transcript that runs ahead of the meeting.
    expect(pushed[pushed.length - 1].tMs).toBeGreaterThanOrEqual(2000)
    await handle.stop()
  })

  it('starts the audio graph again after the machine has slept', async () => {
    const { startCapture } = await import('../src/renderer/src/audio/capture')
    const handle = await startCapture({ captureMic: true, captureSystem: false, echoCancellation: true, noiseSuppression: true })
    contexts[0].state = 'suspended' // what waking from sleep leaves behind: no samples, and no track ever ends
    await vi.advanceTimersByTimeAsync(300)
    expect(resumed).toBeGreaterThan(0)
    expect(contexts[0].state).toBe('running')
    await handle.stop()
  })

  it('places audio at the real time again after the graph stalled', async () => {
    const { startCapture } = await import('../src/renderer/src/audio/capture')
    const handle = await startCapture({ captureMic: true, captureSystem: false, echoCancellation: true, noiseSuppression: true })
    for (let i = 0; i < 5; i++) frame() // 0.5 s
    contexts[0].state = 'suspended'
    await vi.advanceTimersByTimeAsync(30000) // lid closed for half a minute
    frame()
    // Not 500 ms, which is all the audio there is: what was said after the machine woke belongs where it was said.
    expect(pushed[pushed.length - 1].tMs).toBeGreaterThan(29000)
    await handle.stop()
  })

  it('stops trying once the meeting is stopped', async () => {
    const { startCapture } = await import('../src/renderer/src/audio/capture')
    const gone: string[] = []
    const handle = await startCapture({
      captureMic: true,
      captureSystem: false,
      echoCancellation: false,
      noiseSuppression: false,
      onChannelGone: (c) => gone.push(c)
    })
    endTrack!()
    await handle.stop()
    await vi.advanceTimersByTimeAsync(130000)
    expect(gone).toEqual([])
    expect(opened).toBe(1)
  })
})
