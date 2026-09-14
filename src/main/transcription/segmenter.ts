/**
 * Energy-based speech segmenter used for cloud batch engines (ElevenLabs / OpenAI file APIs) that have no
 * streaming endpoint we rely on. Cuts speech on >= `silenceMs` of low energy or at `maxSegmentMs`.
 * Adaptive noise floor: threshold = max(absolute floor, 3x running noise RMS).
 */
export interface SegmenterOptions {
  sampleRate?: number
  silenceMs?: number
  maxSegmentMs?: number
  minSpeechMs?: number
  preRollMs?: number
  onSegment(pcm: Int16Array, startMs: number, endMs: number): void
}

export class EnergySegmenter {
  private readonly sr: number
  private readonly silenceMs: number
  private readonly maxMs: number
  private readonly minSpeechMs: number
  private readonly preRollMs: number
  private frames: { pcm: Int16Array; tMs: number; rms: number }[] = []
  private inSpeech = false
  private speechStartMs = 0
  private lastSpeechMs = 0
  private noise = 0.004
  private readonly floor = 0.008

  constructor(private readonly opts: SegmenterOptions) {
    this.sr = opts.sampleRate ?? 16000
    this.silenceMs = opts.silenceMs ?? 700
    this.maxMs = opts.maxSegmentMs ?? 25000
    this.minSpeechMs = opts.minSpeechMs ?? 300
    this.preRollMs = opts.preRollMs ?? 200
  }

  push(pcm: Int16Array, tMs: number): void {
    let sum = 0
    for (let i = 0; i < pcm.length; i++) {
      const v = pcm[i] / 32768
      sum += v * v
    }
    const rms = Math.sqrt(sum / Math.max(1, pcm.length))
    const durMs = (pcm.length / this.sr) * 1000
    const threshold = Math.max(this.floor, this.noise * 3)
    const isSpeech = rms > threshold
    if (!isSpeech) this.noise = this.noise * 0.95 + rms * 0.05
    this.frames.push({ pcm, tMs, rms })

    if (isSpeech) {
      if (!this.inSpeech) {
        this.inSpeech = true
        this.speechStartMs = tMs
        // keep pre-roll frames only
        const keepFrom = tMs - this.preRollMs
        this.frames = this.frames.filter((f) => f.tMs >= keepFrom)
      }
      this.lastSpeechMs = tMs + durMs
      if (this.lastSpeechMs - this.speechStartMs >= this.maxMs) this.emit()
    } else if (this.inSpeech) {
      if (tMs + durMs - this.lastSpeechMs >= this.silenceMs) this.emit()
    } else {
      // idle: keep a small ring of pre-roll frames
      const keepFrom = tMs - this.preRollMs
      if (this.frames.length > 20) this.frames = this.frames.filter((f) => f.tMs >= keepFrom)
    }
  }

  private emit(): void {
    this.inSpeech = false
    if (this.frames.length === 0) return
    const startMs = this.frames[0].tMs
    const endMs = this.lastSpeechMs
    const total = this.frames.reduce((a, f) => a + f.pcm.length, 0)
    const out = new Int16Array(total)
    let o = 0
    for (const f of this.frames) {
      out.set(f.pcm, o)
      o += f.pcm.length
    }
    this.frames = []
    if (endMs - startMs >= this.minSpeechMs) this.opts.onSegment(out, startMs, endMs)
  }

  flush(): void {
    if (this.inSpeech) this.emit()
    this.frames = []
  }
}
