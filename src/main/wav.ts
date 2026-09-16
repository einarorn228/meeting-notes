/**
 * Streaming stereo WAV writer (16 kHz, 16-bit). Left = mic, right = system. Chunks from the two capture channels
 * arrive independently with their own sample-accurate timestamps, so we keep a per-channel write cursor and pad with
 * silence where one channel has not delivered audio yet.
 */
import { closeSync, openSync, readSync, statSync, writeSync } from 'node:fs'
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
  private headerFrames = 0 // frames the length fields on disk currently claim
  private bufs: Record<ChannelId, ChannelBuf> = {
    mic: { seen: false, base: 0, chunks: [], total: 0 },
    system: { seen: false, base: 0, chunks: [], total: 0 }
  }
  private closed = false

  constructor(readonly path: string) {
    // 'w+' rather than 'w': a channel that opens late is written back into frames that are already on disk.
    this.fd = openSync(path, 'w+')
    writeSync(this.fd, this.header(0), 0, 44, 0)
  }

  /** Write a mono PCM16 chunk for a channel positioned at `tMs` since start. */
  write(channel: ChannelId, pcm: Int16Array, tMs: number): void {
    if (this.closed) return
    const b = this.bufs[channel]
    const startFrame = Math.round((tMs / 1000) * SAMPLE_RATE)
    if (!b.seen) {
      b.seen = true
      b.base = startFrame
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

  /**
   * Samples belonging to frames that are already on disk. Loopback audio opens a second or two after the
   * microphone, so its first chunks are timestamped before anything the file has written; appending them would
   * leave the two sides of the meeting out of step for the whole recording, and out of step with the transcript
   * that speaker detection is matched against. They are written into their own slots in the frames that are
   * already there instead.
   */
  private backfill(ch: ChannelId, ci: number): void {
    const b = this.bufs[ch]
    if (!b.seen || b.total === 0 || b.base >= this.frames) return
    const data = b.chunks.length === 1 ? b.chunks[0] : concat(b.chunks, b.total)
    const to = Math.min(this.frames, b.base + b.total)
    const n = to - b.base
    if (n > 0) {
      const region = Buffer.alloc(n * FRAME_BYTES)
      readSync(this.fd, region, 0, region.length, 44 + b.base * FRAME_BYTES)
      for (let f = 0; f < n; f++) region.writeInt16LE(data[f], f * FRAME_BYTES + ci * BYTES_PER_SAMPLE)
      writeSync(this.fd, region, 0, region.length, 44 + b.base * FRAME_BYTES)
    }
    const rest = data.subarray(Math.max(0, n))
    b.chunks = rest.length ? [rest] : []
    b.total = rest.length
    b.base = to
  }

  private flush(final: boolean): void {
    const active = (['mic', 'system'] as ChannelId[]).filter((c) => this.bufs[c].seen)
    if (active.length === 0) return
    for (const [ci, ch] of (['mic', 'system'] as ChannelId[]).entries()) this.backfill(ch, ci)
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
    // Explicit positions throughout: the header is rewritten in place between data writes, and an implicit
    // file cursor would be at the mercy of how each platform treats a positional write.
    writeSync(this.fd, out, 0, out.length, 44 + this.frames * FRAME_BYTES)
    this.frames = end
    this.syncHeader(final)
  }

  /**
   * Bring the length fields in the header up to date, at most once a second. A WAV header written once at the
   * start says the file holds no audio, and a recording that never reaches close() - a crash, a power cut, the
   * machine shutting down mid-meeting - would then be an unplayable, un-transcribable file even though every
   * sample is sitting on the disk.
   */
  private syncHeader(force: boolean): void {
    if (!force && this.frames - this.headerFrames < SAMPLE_RATE) return
    writeSync(this.fd, this.header(this.frames), 0, 44, 0)
    this.headerFrames = this.frames
  }

  get durationSec(): number {
    return this.frames / SAMPLE_RATE
  }

  close(): void {
    if (this.closed) return
    this.flush(true)
    this.closed = true
    this.syncHeader(true)
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
      const available = buf.length - off - 8
      // A recording interrupted before its header was finished can claim zero bytes; the samples are there,
      // so trust the file over the field.
      return { sampleRate, channels, dataOffset: off + 8, dataBytes: size === 0 ? available : Math.min(size, available) }
    }
    off += 8 + size + (size % 2)
  }
  throw new Error('WAV data chunk not found')
}

/**
 * How much audio a WAV on disk actually holds, measured from its size rather than its header. Used to give an
 * interrupted recording its real length: the meeting record stopped being updated when the app died, but the
 * audio kept being written up to that moment.
 */
export function wavDurationSec(path: string): number {
  let fd: number | null = null
  try {
    const size = statSync(path).size
    fd = openSync(path, 'r')
    const head = Buffer.alloc(Math.min(4096, size))
    readSync(fd, head, 0, head.length, 0)
    const h = parseWavHeader(head)
    const bytes = Math.max(0, size - h.dataOffset)
    return bytes / (h.channels * BYTES_PER_SAMPLE * h.sampleRate)
  } catch {
    return 0
  } finally {
    if (fd !== null) closeSync(fd)
  }
}

export function monoWavBuffer(pcm: Int16Array, sampleRate = SAMPLE_RATE): Buffer {
  const data = Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength)
  return Buffer.concat([wavHeader(data.length, sampleRate, 1), data])
}
