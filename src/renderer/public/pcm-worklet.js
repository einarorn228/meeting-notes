// AudioWorklet: converts incoming float32 audio (any channel count) to mono PCM16 frames of `frameSize` samples
// and posts them to the main thread together with an RMS level. Runs inside an AudioContext at 16 kHz so no
// resampling is needed here (Chromium resamples MediaStream sources to the context sample rate).
class PcmWorklet extends AudioWorkletProcessor {
  constructor(options) {
    super()
    this.frameSize = (options.processorOptions && options.processorOptions.frameSize) || 1600 // 100 ms @ 16 kHz
    this.buffer = new Int16Array(this.frameSize)
    this.offset = 0
    this.sumSq = 0
    this.samples = 0
  }
  process(inputs) {
    const input = inputs[0]
    if (!input || input.length === 0) return true
    const chans = input.length
    const n = input[0].length
    for (let i = 0; i < n; i++) {
      let s = 0
      for (let c = 0; c < chans; c++) s += input[c][i]
      s /= chans
      if (s > 1) s = 1
      else if (s < -1) s = -1
      this.buffer[this.offset++] = s < 0 ? s * 0x8000 : s * 0x7fff
      this.sumSq += s * s
      this.samples++
      if (this.offset >= this.frameSize) {
        const rms = Math.sqrt(this.sumSq / this.samples)
        const out = this.buffer
        this.port.postMessage({ pcm: out.buffer, rms }, [out.buffer])
        this.buffer = new Int16Array(this.frameSize)
        this.offset = 0
        this.sumSq = 0
        this.samples = 0
      }
    }
    return true
  }
}
registerProcessor('pcm-worklet', PcmWorklet)
