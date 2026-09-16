/**
 * Meeting audio capture running in the renderer.
 *
 * Two independent tracks are captured:
 *  - `mic`    : the user's microphone (getUserMedia)
 *  - `system` : everything the user hears (Teams/Zoom/Meet/... output) via getDisplayMedia loopback audio.
 *               The main process answers the display-media request with `audio: 'loopback'` (Windows, macOS 13+
 *               with Electron's ScreenCaptureKit support) so no virtual audio driver is needed.
 *
 * Each track is converted to PCM16 mono 16 kHz in an AudioWorklet and pushed to the main process in 100 ms chunks
 * with a sample-accurate timestamp. Levels are reported ~10x per second for the VU meters and silence warnings.
 */
import type { ChannelId } from '@shared/types'

export interface CaptureOptions {
  micDeviceId?: string
  captureMic: boolean
  captureSystem: boolean
  echoCancellation: boolean
  noiseSuppression: boolean
  onLevels?: (levels: { mic: number; system: number }) => void
  onSystemAudioUnavailable?: (reason: string) => void
  /** The channel's device went away mid-meeting; the app is trying to reopen it. */
  onChannelLost?: (channel: ChannelId) => void
  onChannelRestored?: (channel: ChannelId) => void
  /** Still gone after two minutes of trying. */
  onChannelGone?: (channel: ChannelId) => void
}

export interface CaptureHandle {
  stop: () => Promise<void>
  hasMic: boolean
  hasSystem: boolean
  setPaused: (paused: boolean) => void
}

const SAMPLE_RATE = 16000
const FRAME = 1600 // 100 ms
/** How long to keep trying to reopen a channel whose device vanished, and how quickly to give up trying often. */
const RECOVER_FOR_MS = 120000
const RECOVER_EVERY_MS = 2000
const RECOVER_SLOWEST_MS = 10000

interface Track {
  channel: ChannelId
  stream: MediaStream
  source: MediaStreamAudioSourceNode
  node: AudioWorkletNode
  samplesSent: number
  /** Milliseconds into the meeting at which this track's first sample was taken. */
  startMs: number
}

type Acquire = () => Promise<MediaStream | null>

export async function startCapture(opts: CaptureOptions): Promise<CaptureHandle> {
  const ctx = new AudioContext({ sampleRate: SAMPLE_RATE, latencyHint: 'interactive' })
  await ctx.audioWorklet.addModule('./pcm-worklet.js')
  const tracks: Track[] = []
  const levels = { mic: 0, system: 0 }
  let paused = false
  let stopping = false
  let levelTimer: number | undefined
  // One clock for both channels. Loopback audio takes a moment longer to open than the microphone, and counting
  // each channel's samples from its own zero put everything the other side said that much too early.
  const t0 = performance.now()
  const nowMs = (): number => performance.now() - t0

  const detach = (track: Track): void => {
    const i = tracks.indexOf(track)
    if (i >= 0) tracks.splice(i, 1)
    try {
      track.node.port.onmessage = null
      track.source.disconnect()
      track.node.disconnect()
      track.stream.getTracks().forEach((x) => x.stop())
    } catch {
      /* ignore */
    }
    levels[track.channel] = 0
  }

  const attach = (channel: ChannelId, stream: MediaStream, acquire?: Acquire): void => {
    const source = ctx.createMediaStreamSource(stream)
    const node = new AudioWorkletNode(ctx, 'pcm-worklet', {
      numberOfInputs: 1,
      numberOfOutputs: 0,
      processorOptions: { frameSize: FRAME }
    })
    const track: Track = { channel, stream, source, node, samplesSent: 0, startMs: nowMs() }
    node.port.onmessage = (ev: MessageEvent<{ pcm: ArrayBuffer; rms: number }>) => {
      levels[channel] = ev.data.rms
      if (paused) {
        track.samplesSent += FRAME
        return
      }
      const tMs = Math.round(track.startMs + (track.samplesSent / SAMPLE_RATE) * 1000)
      track.samplesSent += FRAME
      window.fundarritari.pushAudio(channel, ev.data.pcm, tMs)
    }
    source.connect(node)
    tracks.push(track)
    const [audio] = stream.getAudioTracks()
    if (audio && acquire) audio.addEventListener('ended', () => void recover(track, acquire), { once: true })
  }

  /**
   * A capture device can disappear in the middle of a meeting: a Bluetooth headset drops out, a USB microphone
   * is unplugged, Windows moves the system output to headphones that were just plugged in. The track simply
   * ends, and with nothing watching for it the rest of the meeting is recorded as silence. Reopen the channel
   * and carry on; the seconds that were missed become a gap in the timeline instead of shifting everything
   * said afterwards.
   */
  const recover = async (lost: Track, acquire: Acquire): Promise<void> => {
    if (stopping || !tracks.includes(lost)) return
    detach(lost)
    opts.onChannelLost?.(lost.channel)
    const deadline = nowMs() + RECOVER_FOR_MS
    let attempt = 0
    while (!stopping && nowMs() < deadline) {
      // Quickly at first - a headset usually comes back within seconds - then less often, because asking the
      // system for the loopback device is not free.
      attempt += 1
      await new Promise((r) => setTimeout(r, Math.min(RECOVER_EVERY_MS * attempt, RECOVER_SLOWEST_MS)))
      if (stopping) return
      let stream: MediaStream | null = null
      try {
        stream = await acquire()
      } catch {
        stream = null
      }
      if (!stream) continue
      attach(lost.channel, stream, acquire)
      opts.onChannelRestored?.(lost.channel)
      return
    }
    if (!stopping) opts.onChannelGone?.(lost.channel)
  }

  const micConstraints: MediaStreamConstraints = {
    audio: {
      deviceId: opts.micDeviceId && opts.micDeviceId !== 'default' ? { exact: opts.micDeviceId } : undefined,
      echoCancellation: opts.echoCancellation,
      noiseSuppression: opts.noiseSuppression,
      autoGainControl: true,
      channelCount: 1
    },
    video: false
  }
  const acquireMic = (): Promise<MediaStream> => navigator.mediaDevices.getUserMedia(micConstraints)

  /** Everything the user hears, with the per-platform fallbacks. `report` is only true for the first attempt. */
  const acquireSystem = async (report: boolean): Promise<MediaStream | null> => {
    const unavailable = (reason: string): null => {
      if (report) opts.onSystemAudioUnavailable?.(reason)
      return null
    }
    try {
      // The main process' setDisplayMediaRequestHandler supplies a screen source + loopback audio.
      // A video track must be requested (Windows throws otherwise; Electron 40+ needs >= 4x4 px).
      const display = await navigator.mediaDevices.getDisplayMedia({
        audio: true,
        video: { width: 4, height: 4, frameRate: 1 }
      })
      const audioTracks = display.getAudioTracks()
      if (audioTracks.length === 0) {
        display.getTracks().forEach((t) => t.stop())
        const monitor = await findLinuxMonitorDevice()
        if (!monitor) return unavailable('no-audio-track')
        return await navigator.mediaDevices.getUserMedia({
          audio: { deviceId: { exact: monitor }, echoCancellation: false, noiseSuppression: false, autoGainControl: false }
        })
      }
      if (audioTracks[0].readyState === 'ended') {
        // macOS: the "System Audio Recording Only" permission is missing/denied -> track never delivers samples.
        display.getTracks().forEach((t) => t.stop())
        return unavailable('permission-denied')
      }
      // We only need audio; drop the video track immediately to save CPU.
      display.getVideoTracks().forEach((t) => t.stop())
      return new MediaStream(audioTracks)
    } catch (err) {
      return unavailable(err instanceof Error ? err.message : String(err))
    }
  }

  let hasMic = false
  let hasSystem = false

  if (opts.captureMic) {
    attach('mic', await acquireMic(), acquireMic)
    hasMic = true
  }

  if (opts.captureSystem) {
    const stream = await acquireSystem(true)
    if (stream) {
      attach('system', stream, () => acquireSystem(false))
      hasSystem = true
    }
  }

  if (ctx.state !== 'running') await ctx.resume()

  levelTimer = window.setInterval(() => {
    // Sleeping the machine mid-meeting leaves the audio graph suspended on wake, and a suspended graph
    // delivers nothing at all without ever ending a track. Start it again.
    if (!stopping && ctx.state === 'suspended') void ctx.resume()
    opts.onLevels?.({ mic: levels.mic, system: levels.system })
    window.fundarritari.reportLevels({ mic: levels.mic, system: levels.system })
  }, 100)

  return {
    hasMic,
    hasSystem,
    setPaused: (p) => {
      paused = p
    },
    stop: async () => {
      stopping = true
      if (levelTimer) window.clearInterval(levelTimer)
      for (const t of [...tracks]) detach(t)
      await ctx.close()
    }
  }
}

/** Linux (PulseAudio/PipeWire): system audio is exposed as a "Monitor of ..." input device. */
async function findLinuxMonitorDevice(): Promise<string | null> {
  if (!navigator.userAgent.includes('Linux')) return null
  try {
    const devices = await navigator.mediaDevices.enumerateDevices()
    const mon = devices.find((d) => d.kind === 'audioinput' && /monitor/i.test(d.label))
    return mon ? mon.deviceId : null
  } catch {
    return null
  }
}

/** Lists microphones (labels only appear after permission has been granted once). */
export async function listMicrophones(): Promise<{ deviceId: string; label: string }[]> {
  const devices = await navigator.mediaDevices.enumerateDevices()
  return devices
    .filter((d) => d.kind === 'audioinput')
    .map((d, i) => ({ deviceId: d.deviceId, label: d.label || `Hljóðnemi ${i + 1}` }))
}

/**
 * Short capture test used by onboarding/settings: runs capture for `ms` milliseconds without a recording session
 * and reports the peak level seen on each channel.
 */
export async function testCapture(opts: CaptureOptions, ms = 4000): Promise<{ mic: number; system: number; hasSystem: boolean; hasMic: boolean }> {
  const peak = { mic: 0, system: 0 }
  const handle = await startCapture({
    ...opts,
    onLevels: (l) => {
      peak.mic = Math.max(peak.mic, l.mic)
      peak.system = Math.max(peak.system, l.system)
      opts.onLevels?.(l)
    }
  })
  await new Promise((r) => setTimeout(r, ms))
  await handle.stop()
  return { ...peak, hasSystem: handle.hasSystem, hasMic: handle.hasMic }
}
