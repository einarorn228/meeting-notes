import { describe, it, expect } from 'vitest'
import { assignSpeakers } from '../src/main/diarize'
import type { Segment } from '../src/shared/types'

const seg = (id: string, channel: 'mic' | 'system', start: number, end: number): Segment => ({ id, channel, start, end, text: id, speaker: channel === 'mic' ? 'me' : 'others' })

describe('assignSpeakers', () => {
  it('labels system segments by the dominant overlapping diarization speaker and leaves mic alone', () => {
    const segments = [seg('a', 'system', 0, 4), seg('b', 'mic', 4, 6), seg('c', 'system', 6, 10), seg('d', 'system', 20, 22)]
    const diar = [
      { start: 0, end: 5, speaker: 0 },
      { start: 5, end: 7, speaker: 0 },
      { start: 7, end: 10, speaker: 1 }
    ]
    const { segments: out, speakers } = assignSpeakers(segments, diar, (n) => `Þátttakandi ${n}`)
    expect(out[0].speaker).toBe('spk1')
    expect(out[1].speaker).toBe('me')
    expect(out[2].speaker).toBe('spk2') // 3 s overlap with speaker 1 vs 1 s with speaker 0
    expect(out[3].speaker).toBe('others') // no overlap
    expect(speakers).toEqual({ spk1: 'Þátttakandi 1', spk2: 'Þátttakandi 2' })
  })
})
