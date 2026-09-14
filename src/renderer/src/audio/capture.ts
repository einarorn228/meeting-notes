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
}

export interface CaptureHandle {
  stop: () => Promise<void>
  hasMic: boolean
  hasSystem: boolean
  setPaused: (paused: boolean) => void
}

const SAMPLE_RATE = 16000
const FRAME = 1600 // 100 ms

interface Track {
  channel: ChannelId
  stream: MediaStream
  source: MediaStreamAudioSourceNode
  node: AudioWorkletNode
  samplesSent: number
}

export async function startCapture(opts: CaptureOptions): Promise<CaptureHandle> {
  const ctx = new AudioContext({ sampleRate: SAMPLE_RATE, latencyHint: 'interactive' })
  await ctx.audioWorklet.addModule('./pcm-worklet.js')
  const tracks: Track[] = []
  const levels = { mic: 0, system: 0 }
  let paused = false
  let levelTimer: number | undefined

  const attach = (channel: ChannelId, stream: MediaStream): void => {
    const source = ctx.createMediaStreamSource(stream)
    const node = new AudioWorkletNode(ctx, 'pcm-worklet', {
      numberOfInputs: 1,
      numberOfOutputs: 0,
      processorOptions: { frameSize: FRAME }
    })
    const track: Track = { channel, stream, source, node, samplesSent: 0 }
    node.port.onmessage = (ev: MessageEvent<{ pcm: ArrayBuffer; rms: number }>) => {
      levels[channel] = ev.data.rms
      if (paused) {
        track.samplesSent += FRAME
        return
      }
      const tMs = Math.round((track.samplesSent / SAMPLE_RATE) * 1000)
      track.samplesSent += FRAME
      window.fundarritari.pushAudio(channel, ev.data.pcm, tMs)
    }
    source.connect(node)
    tracks.push(track)
  }

  let hasMic = false
  let hasSystem = false

  if (opts.captureMic) {
    const constraints: MediaStreamConstraints = {
      audio: {
        deviceId: opts.micDeviceId && opts.micDeviceId !== 'default' ? { exact: opts.micDeviceId } : undefined,
        echoCancellation: opts.echoCancellation,
        noiseSuppression: opts.noiseSuppression,
        autoGainControl: true,
        channelCount: 1
      },
      video: false
    }
    const mic = await navigator.mediaDevices.getUserMedia(constraints)
    attach('mic', mic)
    hasMic = true
  }

  if (opts.captureSystem) {
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
        if (monitor) {
          const mon = await navigator.mediaDevices.getUserMedia({
            audio: { deviceId: { exact: monitor }, echoCancellation: false, noiseSuppression: false, autoGainControl: false }
          })
          attach('system', mon)
          hasSystem = true
        } else {
          opts.onSystemAudioUnavailable?.('no-audio-track')
        }
      } else if (audioTracks[0].readyState === 'ended') {
        // macOS: the "System Audio Recording Only" permission is missing/denied -> track never delivers samples.
        display.getTracks().forEach((t) => t.stop())
        opts.onSystemAudioUnavailable?.('permission-denied')
      } else {
        // We only need audio; drop the video track immediately to save CPU.
        display.getVideoTracks().forEach((t) => t.stop())
        const audioOnly = new MediaStream(audioTracks)
        attach('system', audioOnly)
        hasSystem = true
      }
    } catch (err) {
      opts.onSystemAudioUnavailable?.(err instanceof Error ? err.message : String(err))
    }
  }

  if (ctx.state !== 'running') await ctx.resume()

  levelTimer = window.setInterval(() => {
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
      if (levelTimer) window.clearInterval(levelTimer)
      for (const t of tracks) {
        try {
          t.source.disconnect()
          t.node.port.onmessage = null
          t.node.disconnect()
          t.stream.getTracks().forEach((x) => x.stop())
        } catch {
          /* ignore */
        }
      }
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
