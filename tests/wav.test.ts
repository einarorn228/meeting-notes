import { describe, it, expect } from 'vitest'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { StereoWavWriter, parseWavHeader, monoWavBuffer, wavDurationSec } from '../src/main/wav'

function tone(n: number, v: number): Int16Array {
  const a = new Int16Array(n)
  a.fill(v)
  return a
}

describe('StereoWavWriter', () => {
  it('interleaves two channels with independent timing and pads gaps', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wav-'))
    const p = join(dir, 'a.wav')
    const w = new StereoWavWriter(p)
    // mic: 3 chunks of 100 ms starting at 0; system starts 100 ms later, then a 500 ms gap
    w.write('mic', tone(1600, 100), 0)
    w.write('system', tone(1600, -100), 100)
    w.write('mic', tone(1600, 100), 100)
    w.write('mic', tone(1600, 100), 200)
    w.write('system', tone(1600, -100), 800)
    w.close()
    const buf = readFileSync(p)
    const h = parseWavHeader(buf)
    expect(h.channels).toBe(2)
    expect(h.sampleRate).toBe(16000)
    const frames = h.dataBytes / 4
    // system ended at 800 ms + 100 ms = 900 ms
    expect(frames).toBe(14400)
    const sample = (frame: number, ch: number): number => buf.readInt16LE(h.dataOffset + frame * 4 + ch * 2)
    expect(sample(10, 0)).toBe(100) // mic at 0.6 ms
    expect(sample(10, 1)).toBe(0) // system silent before 100 ms
    expect(sample(2000, 1)).toBe(-100) // system active at 125 ms
    expect(sample(5000, 0)).toBe(0) // mic silent after 300 ms
    expect(sample(5000, 1)).toBe(0) // system gap
    expect(sample(13000, 1)).toBe(-100) // system second chunk (812 ms)
    expect(w.durationSec).toBeCloseTo(0.9, 3)
  })

  it('leaves a playable file behind when the recording never reaches close()', () => {
    // A crash or a power cut means close() never runs. The header written when the file was created says the
    // file holds no audio at all, and every second that did reach the disk would be lost with it.
    const dir = mkdtempSync(join(tmpdir(), 'wav-'))
    const p = join(dir, 'crash.wav')
    const w = new StereoWavWriter(p)
    for (let i = 0; i < 40; i++) w.write('mic', tone(1600, 77), i * 100) // 4 s, 100 ms at a time
    // deliberately no close()
    const buf = readFileSync(p)
    const h = parseWavHeader(buf)
    expect(h.channels).toBe(2)
    expect(h.dataBytes / 4 / 16000).toBeGreaterThanOrEqual(3)
    expect(buf.readInt16LE(h.dataOffset + 30000 * 4)).toBe(77) // audio is really there, not just a length
    expect(wavDurationSec(p)).toBeGreaterThanOrEqual(3.9)
  })

  it('reads the audio of a file whose header still claims zero bytes', () => {
    // Files recorded before the header was kept up to date, and any writer that does the same.
    const dir = mkdtempSync(join(tmpdir(), 'wav-'))
    const p = join(dir, 'zero.wav')
    const w = new StereoWavWriter(p)
    w.write('mic', tone(16000, 42), 0)
    w.close()
    const buf = readFileSync(p)
    buf.writeUInt32LE(0, 40) // as an interrupted recording used to be left on disk
    buf.writeUInt32LE(36, 4)
    writeFileSync(p, buf)
    const h = parseWavHeader(readFileSync(p))
    expect(h.dataBytes).toBe(16000 * 4)
    expect(wavDurationSec(p)).toBeCloseTo(1, 2)
  })

  it('puts a channel that opened late where it was actually captured', () => {
    // Loopback audio opens a second or two after the microphone. Appended at the end of what is already
    // written, everything the other side said would sit that much late for the whole recording - including
    // against the transcript that speaker detection is matched to.
    const dir = mkdtempSync(join(tmpdir(), 'wav-'))
    const p = join(dir, 'late.wav')
    const w = new StereoWavWriter(p)
    for (let i = 0; i < 15; i++) w.write('mic', tone(1600, 100), i * 100) // 1.5 s of microphone alone
    w.write('system', tone(1600, -100), 1200) // the other side, captured at 1.2 s, long after the file started
    for (let i = 13; i < 25; i++) w.write('system', tone(1600, -100), i * 100)
    w.close()
    const buf = readFileSync(p)
    const h = parseWavHeader(buf)
    const sample = (frame: number, ch: number): number => buf.readInt16LE(h.dataOffset + frame * 4 + ch * 2)
    expect(sample(16000 * 1.1, 1)).toBe(0) // silent before it opened
    expect(sample(16000 * 1.25, 1)).toBe(-100) // and present at 1.2 s, where it was said
    expect(sample(16000 * 1.25, 0)).toBe(100) // without disturbing the microphone already written there
  })

  it('writes a valid mono wav buffer', () => {
    const b = monoWavBuffer(tone(160, 5))
    const h = parseWavHeader(b)
    expect(h.channels).toBe(1)
    expect(h.dataBytes).toBe(320)
  })
})
