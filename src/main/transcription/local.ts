import { randomUUID } from 'node:crypto'
import { LOCAL_MODELS, type ChannelId } from '../../shared/types'
import { getSettings } from '../settings'
import { sidecar, type SidecarEvent } from './sidecar'
import type { EngineCallbacks, EngineStartOptions, TranscriptionEngine } from './types'

/** Local faster-whisper engine backed by the Python sidecar. */
export class LocalEngine implements TranscriptionEngine {
  readonly id = 'local'
  private sessionId = ''
  private cb: EngineCallbacks | null = null
  private listener: ((ev: SidecarEvent) => void) | null = null

  async start(opts: EngineStartOptions, cb: EngineCallbacks): Promise<void> {
    this.cb = cb
    cb.onStatus('Ræsi staðbundna talgreiningu…')
    await sidecar.ensureModel()
    const s = getSettings()
    const info = LOCAL_MODELS.find((m) => m.id === s.local.modelId) ?? LOCAL_MODELS[0]
    this.sessionId = randomUUID()
    this.listener = (ev) => {
      if (ev.session_id !== this.sessionId) return
      if (ev.type === 'segment') {
        const text = String(ev.text ?? '').trim()
        if (!text) return
        cb.onSegment({ channel: ev.channel as ChannelId, start: Number(ev.start), end: Number(ev.end), text, confidence: typeof ev.avg_logprob === 'number' ? Math.exp(ev.avg_logprob) : undefined })
      } else if (ev.type === 'partial') {
        cb.onPartial(ev.channel as ChannelId, String(ev.text ?? ''), Number(ev.start))
      } else if (ev.type === 'error') {
        cb.onError(String(ev.message), !!ev.fatal)
      }
    }
    sidecar.on('event', this.listener)
    sidecar.send({
      type: 'start',
      session_id: this.sessionId,
      language: opts.language === 'auto' ? null : opts.language,
      channels: opts.channels,
      vocabulary: opts.vocabulary,
      partials: opts.partials,
      punctuated: info.punctuated
    })
    const mi = sidecar.modelInfo
    cb.onStatus(`Staðbundin talgreining (${info.label.split(' – ')[0]}, ${mi?.device ?? 'cpu'})`)
  }

  pushAudio(channel: ChannelId, pcm: Int16Array, tMs: number): void {
    if (!this.sessionId) return
    try {
      sidecar.send({ type: 'audio', session_id: this.sessionId, channel, t_ms: tMs, pcm: Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength).toString('base64') })
    } catch (e) {
      this.cb?.onError(String(e), true)
    }
  }

  async stop(): Promise<void> {
    if (!this.sessionId) return
    try {
      await sidecar.request({ type: 'stop', session_id: this.sessionId }, 'stopped', 30 * 60 * 1000).catch((e) => this.cb?.onError(String(e)))
    } finally {
      if (this.listener) sidecar.off('event', this.listener)
      this.listener = null
      this.sessionId = ''
    }
  }

  async transcribeFile(path: string, opts: { language: string; vocabulary: string[]; stereo: boolean }, cb: EngineCallbacks): Promise<void> {
    await sidecar.ensureModel()
    const requestId = randomUUID()
    const listener = (ev: SidecarEvent): void => {
      if (ev.request_id !== requestId) return
      if (ev.type === 'segment') {
        const text = String(ev.text ?? '').trim()
        if (text) cb.onSegment({ channel: (ev.channel as ChannelId) ?? 'system', start: Number(ev.start), end: Number(ev.end), text })
      } else if (ev.type === 'status' && ev.message) {
        cb.onStatus(String(ev.message))
      }
    }
    sidecar.on('event', listener)
    try {
      await sidecar.request(
        { type: 'transcribe_file', request_id: requestId, path, language: opts.language === 'auto' ? null : opts.language, vocabulary: opts.vocabulary, channels_map: opts.stereo ? { '0': 'mic', '1': 'system' } : null },
        'file_done',
        6 * 3600 * 1000
      )
    } finally {
      sidecar.off('event', listener)
    }
  }
}
