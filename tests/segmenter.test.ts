import { describe, it, expect } from 'vitest'
import { EnergySegmenter } from '../src/main/transcription/segmenter'

function frame(level: number, n = 1600): Int16Array {
  const a = new Int16Array(n)
  for (let i = 0; i < n; i++) a[i] = Math.round(Math.sin(i / 3) * level * 32767)
  return a
}

describe('EnergySegmenter', () => {
  it('cuts speech segments on silence and enforces max length', () => {
    const segs: { start: number; end: number; len: number }[] = []
    const seg = new EnergySegmenter({ onSegment: (pcm, s, e) => segs.push({ start: s, end: e, len: pcm.length }), maxSegmentMs: 2000 })
    let t = 0
    const push = (level: number, count: number): void => {
      for (let i = 0; i < count; i++) {
        seg.push(frame(level), t)
        t += 100
      }
    }
    push(0.0005, 10) // silence 1 s
    push(0.3, 12) // speech 1.2 s
    push(0.0005, 10) // silence 1 s -> segment 1
    push(0.3, 30) // speech 3 s -> forced cut at 2 s, then remainder
    seg.flush()
    expect(segs.length).toBe(3)
    expect(segs[0].start).toBeLessThanOrEqual(1000)
    expect(segs[0].end).toBe(2200)
    expect(segs[1].end - segs[1].start).toBeGreaterThanOrEqual(2000)
    expect(segs[2].len).toBeGreaterThan(0)
  })
})
