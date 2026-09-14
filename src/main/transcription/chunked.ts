/**
 * Base class for cloud engines that transcribe files: audio is cut into speech chunks per channel with the
 * energy segmenter and each chunk is sent to the API (sequentially per channel, channels in parallel).
 */
import type { ChannelId, Language } from '../../shared/types'
import { monoWavBuffer } from '../wav'
import { EnergySegmenter } from './segmenter'
import type { EngineCallbacks, EngineStartOptions, TranscriptionEngine } from './types'

export abstract class ChunkedCloudEngine implements TranscriptionEngine {
  abstract readonly id: string
  protected cb: EngineCallbacks | null = null
  protected language: Language = 'is'
  protected vocabulary: string[] = []
  private segmenters = new Map<ChannelId, EnergySegmenter>()
  private queues = new Map<ChannelId, Promise<void>>()
  private stopped = false

  /** Transcribe one WAV chunk; return text (empty string for nothing). */
  protected abstract transcribeChunk(wav: Buffer, channel: ChannelId): Promise<{ text: string; speaker?: string }>

  protected abstract statusLabel(): string

  async start(opts: EngineStartOptions, cb: EngineCallbacks): Promise<void> {
    this.cb = cb
    this.language = opts.language
    this.vocabulary = opts.vocabulary
    this.stopped = false
    for (const ch of opts.channels) {
      this.queues.set(ch, Promise.resolve())
      this.segmenters.set(
        ch,
        new EnergySegmenter({
          onSegment: (pcm, startMs, endMs) => this.enqueue(ch, pcm, startMs, endMs)
        })
      )
    }
    cb.onStatus(this.statusLabel())
  }

  private enqueue(ch: ChannelId, pcm: Int16Array, startMs: number, endMs: number): void {
    const prev = this.queues.get(ch) ?? Promise.resolve()
    const next = prev.then(async () => {
      if (!this.cb) return
      try {
        const res = await this.transcribeChunk(monoWavBuffer(pcm), ch)
        const text = res.text.trim()
        if (text) this.cb.onSegment({ channel: ch, start: startMs / 1000, end: endMs / 1000, text, speaker: res.speaker })
      } catch (e) {
        this.cb.onError(`${this.id}: ${e instanceof Error ? e.message : String(e)}`)
      }
    })
    this.queues.set(ch, next)
  }

  pushAudio(channel: ChannelId, pcm: Int16Array, tMs: number): void {
    if (this.stopped) return
    this.segmenters.get(channel)?.push(pcm, tMs)
  }

  async stop(): Promise<void> {
    this.stopped = true
    for (const s of this.segmenters.values()) s.flush()
    await Promise.all([...this.queues.values()])
    this.segmenters.clear()
    this.queues.clear()
  }

  /** Whole-file transcription: split stereo into channels and run the same chunk pipeline offline. */
  async transcribeFile(path: string, opts: { language: Language; vocabulary: string[]; stereo: boolean }, cb: EngineCallbacks): Promise<void> {
    const { readFileSync } = await import('node:fs')
    const { parseWavHeader } = await import('../wav')
    const buf = readFileSync(path)
    const h = parseWavHeader(buf)
    if (h.sampleRate !== 16000) throw new Error('Aðeins 16 kHz WAV skrár eru studdar fyrir skýjaþjónustur; notaðu staðbundna talgreiningu fyrir aðrar skrár.')
    const frames = h.dataBytes / (2 * h.channels)
    const channels: ChannelId[] = h.channels === 2 && opts.stereo ? ['mic', 'system'] : ['system']
    await this.start({ language: opts.language, channels, vocabulary: opts.vocabulary, partials: false }, cb)
    const step = 1600
    for (let f = 0; f < frames; f += step) {
      const n = Math.min(step, frames - f)
      for (const [ci, ch] of channels.entries()) {
        const pcm = new Int16Array(n)
        for (let i = 0; i < n; i++) {
          if (h.channels === 1) pcm[i] = buf.readInt16LE(h.dataOffset + (f + i) * 2)
          else if (channels.length === 1) pcm[i] = Math.round((buf.readInt16LE(h.dataOffset + (f + i) * 4) + buf.readInt16LE(h.dataOffset + (f + i) * 4 + 2)) / 2)
          else pcm[i] = buf.readInt16LE(h.dataOffset + (f + i) * 4 + ci * 2)
        }
        this.pushAudio(ch, pcm, (f / 16000) * 1000)
      }
    }
    await this.stop()
  }
}
