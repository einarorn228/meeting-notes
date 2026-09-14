import { describe, it, expect } from 'vitest'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { StereoWavWriter, parseWavHeader, monoWavBuffer } from '../src/main/wav'

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

  it('writes a valid mono wav buffer', () => {
    const b = monoWavBuffer(tone(160, 5))
    const h = parseWavHeader(b)
    expect(h.channels).toBe(1)
    expect(h.dataBytes).toBe(320)
  })
})
