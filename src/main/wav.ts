/**
 * Streaming stereo WAV writer (16 kHz, 16-bit). Left = mic, right = system. Chunks from the two capture channels
 * arrive independently with their own sample-accurate timestamps, so we keep a per-channel write cursor and pad with
 * silence where one channel has not delivered audio yet.
 */
import { closeSync, openSync, writeSync } from 'node:fs'
import type { ChannelId } from '../shared/types'

const SAMPLE_RATE = 16000
const CHANNELS = 2
const BYTES_PER_SAMPLE = 2
const FRAME_BYTES = CHANNELS * BYTES_PER_SAMPLE

interface ChannelBuf {
  seen: boolean
  /** absolute frame index of data[0] */
  base: number
  chunks: Int16Array[]
  total: number
}

export class StereoWavWriter {
  private fd: number
  private frames = 0 // frames written to disk
  private bufs: Record<ChannelId, ChannelBuf> = {
    mic: { seen: false, base: 0, chunks: [], total: 0 },
    system: { seen: false, base: 0, chunks: [], total: 0 }
  }
  private closed = false

  constructor(readonly path: string) {
    this.fd = openSync(path, 'w')
    writeSync(this.fd, this.header(0))
  }

  /** Write a mono PCM16 chunk for a channel positioned at `tMs` since start. */
  write(channel: ChannelId, pcm: Int16Array, tMs: number): void {
    if (this.closed) return
    const b = this.bufs[channel]
    const startFrame = Math.round((tMs / 1000) * SAMPLE_RATE)
    if (!b.seen) {
      b.seen = true
      b.base = Math.max(startFrame, this.frames)
    } else {
      const expected = b.base + b.total
      if (startFrame > expected + 80) {
        // gap (e.g. pause) -> pad with silence
        const gap = startFrame - expected
        b.chunks.push(new Int16Array(gap))
        b.total += gap
      }
    }
    b.chunks.push(pcm)
    b.total += pcm.length
    this.flush(false)
  }

  private flush(final: boolean): void {
    const active = (['mic', 'system'] as ChannelId[]).filter((c) => this.bufs[c].seen)
    if (active.length === 0) return
    const ends = active.map((c) => this.bufs[c].base + this.bufs[c].total)
    let end = final ? Math.max(...ends) : Math.min(...ends)
    if (!final) {
      // Do not let one stalled channel hold back the other for more than 2 s.
      const maxEnd = Math.max(...ends)
      if (maxEnd - end > SAMPLE_RATE * 2) end = maxEnd - SAMPLE_RATE * 2
    }
    if (end <= this.frames) return
    const n = end - this.frames
    const out = Buffer.alloc(n * FRAME_BYTES)
    for (const [ci, ch] of (['mic', 'system'] as ChannelId[]).entries()) {
      const b = this.bufs[ch]
      if (!b.seen || b.total === 0) continue
      const data = b.chunks.length === 1 ? b.chunks[0] : concat(b.chunks, b.total)
      // absolute range of data: [b.base, b.base + b.total)
      const from = Math.max(this.frames, b.base)
      const to = Math.min(end, b.base + b.total)
      for (let f = from; f < to; f++) {
        out.writeInt16LE(data[f - b.base], (f - this.frames) * FRAME_BYTES + ci * BYTES_PER_SAMPLE)
      }
      // drop consumed part
      const consumed = Math.max(0, end - b.base)
      if (consumed >= b.total) {
        b.chunks = []
        b.total = 0
        b.base = end
      } else if (consumed > 0) {
        const rest = data.subarray(consumed)
        b.chunks = [rest]
        b.total = rest.length
        b.base = end
      }
    }
    writeSync(this.fd, out)
    this.frames = end
  }

  get durationSec(): number {
    return this.frames / SAMPLE_RATE
  }

  close(): void {
    if (this.closed) return
    this.flush(true)
    this.closed = true
    writeSync(this.fd, this.header(this.frames), 0, 44, 0)
    closeSync(this.fd)
  }

  private header(frames: number): Buffer {
    return wavHeader(frames * FRAME_BYTES, SAMPLE_RATE, CHANNELS)
  }
}

function concat(chunks: Int16Array[], total: number): Int16Array {
  const out = new Int16Array(total)
  let o = 0
  for (const c of chunks) {
    out.set(c, o)
    o += c.length
  }
  return out
}

export function wavHeader(dataBytes: number, sampleRate: number, channels: number): Buffer {
  const frameBytes = channels * BYTES_PER_SAMPLE
  const b = Buffer.alloc(44)
  b.write('RIFF', 0)
  b.writeUInt32LE(36 + dataBytes, 4)
  b.write('WAVE', 8)
  b.write('fmt ', 12)
  b.writeUInt32LE(16, 16)
  b.writeUInt16LE(1, 20)
  b.writeUInt16LE(channels, 22)
  b.writeUInt32LE(sampleRate, 24)
  b.writeUInt32LE(sampleRate * frameBytes, 28)
  b.writeUInt16LE(frameBytes, 32)
  b.writeUInt16LE(16, 34)
  b.write('data', 36)
  b.writeUInt32LE(dataBytes, 40)
  return b
}

/** Reads a 16-bit PCM WAV file header and returns format + data offset. */
export function parseWavHeader(buf: Buffer): { sampleRate: number; channels: number; dataOffset: number; dataBytes: number } {
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') throw new Error('Not a WAV file')
  let off = 12
  let sampleRate = 16000
  let channels = 1
  let bits = 16
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4)
    const size = buf.readUInt32LE(off + 4)
    if (id === 'fmt ') {
      const fmt = buf.readUInt16LE(off + 8)
      channels = buf.readUInt16LE(off + 10)
      sampleRate = buf.readUInt32LE(off + 12)
      bits = buf.readUInt16LE(off + 22)
      if (fmt !== 1 || bits !== 16) throw new Error('Only 16-bit PCM WAV is supported')
    } else if (id === 'data') {
      return { sampleRate, channels, dataOffset: off + 8, dataBytes: Math.min(size, buf.length - off - 8) }
    }
    off += 8 + size + (size % 2)
  }
  throw new Error('WAV data chunk not found')
}

export function monoWavBuffer(pcm: Int16Array, sampleRate = SAMPLE_RATE): Buffer {
  const data = Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength)
  return Buffer.concat([wavHeader(data.length, sampleRate, 1), data])
}
