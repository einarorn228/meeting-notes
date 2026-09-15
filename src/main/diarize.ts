/**
 * Post-meeting speaker diarization of the "system" channel (remote participants), so that every person in the
 * meeting gets their own label instead of one shared "Aðrir". Runs in the Python sidecar with sherpa-onnx.
 */
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import type { Meeting, Segment } from '../shared/types'
import { getSettings } from './settings'
import { audioPath, loadMeeting, saveMeeting } from './store'
import { modelsDir, sidecar, type SidecarEvent } from './transcription/sidecar'

export interface DiarSegment {
  start: number
  end: number
  speaker: number
}

/** Assigns each system-channel transcript segment the diarization speaker with the largest time overlap. */
export function assignSpeakers(segments: Segment[], diar: DiarSegment[], label: (n: number) => string): { segments: Segment[]; speakers: Record<string, string> } {
  const used = new Map<string, string>()
  const out = segments.map((s) => {
    if (s.channel !== 'system') return s
    const overlaps = new Map<number, number>()
    for (const d of diar) {
      const o = Math.min(s.end, d.end) - Math.max(s.start, d.start)
      if (o > 0) overlaps.set(d.speaker, (overlaps.get(d.speaker) ?? 0) + o)
    }
    let best: number | null = null
    let bestO = 0
    for (const [spk, o] of overlaps) {
      if (o > bestO) {
        best = spk
        bestO = o
      }
    }
    if (best === null) return s
    const key = `spk${best + 1}`
    if (!used.has(key)) used.set(key, label(best + 1))
    return { ...s, speaker: key }
  })
  return { segments: out, speakers: Object.fromEntries(used) }
}

/** Splits a long segment across diarization boundaries when two speakers clearly share it (optional refinement). */
export function needsDiarization(m: Meeting): boolean {
  return m.segments.some((s) => s.channel === 'system' && (s.speaker === 'others' || s.speaker === 'system'))
}

export interface DiarizeOptions {
  /** How many people spoke on the remote channel, when the user knows. Clustering then cannot invent more. */
  speakers?: number
  /** Re-run even if every remote segment already carries a speaker label. */
  force?: boolean
}

export async function diarizeMeeting(meetingId: string, progress: (stage: string, p?: number) => void, opts: DiarizeOptions = {}): Promise<Meeting | null> {
  const m = loadMeeting(meetingId)
  if (!m || (!opts.force && !needsDiarization(m))) return m
  const path = audioPath(meetingId)
  if (!existsSync(path)) return m
  const s = getSettings()
  if (!s.local.diarize) return m
  progress('diarize')
  await sidecar.ensureStarted()
  const requestId = randomUUID()
  const ev = await new Promise<SidecarEvent>((resolve, reject) => {
    const listener = (e: SidecarEvent): void => {
      if (e.request_id !== requestId) return
      if (e.type === 'diarized') {
        cleanup()
        resolve(e)
      } else if (e.type === 'error') {
        cleanup()
        reject(new Error(String(e.message)))
      }
    }
    const cleanup = (): void => {
      sidecar.off('event', listener)
    }
    sidecar.on('event', listener)
    try {
      sidecar.send({ type: 'diarize_file', request_id: requestId, path, channel: 1, models_dir: modelsDir(), threshold: 0.55, num_speakers: opts.speakers && opts.speakers > 0 ? Math.round(opts.speakers) : -1 })
    } catch (e) {
      cleanup()
      reject(e)
    }
    setTimeout(() => {
      cleanup()
      reject(new Error('diarization timeout'))
    }, 30 * 60 * 1000)
  })
  const diar = (ev.segments as DiarSegment[]) ?? []
  const latest = loadMeeting(meetingId) ?? m
  const { segments, speakers } = assignSpeakers(latest.segments, diar, (n) => `Þátttakandi ${n}`)
  const names = { ...latest.speakerNames }
  if (opts.force) {
    // Cluster numbers are not stable between runs, so labels from the previous run would point at the
    // wrong voices. Names the user typed for a cluster are kept only if that cluster still exists.
    for (const key of Object.keys(names)) if (/^spk\d+$/.test(key) && !(key in speakers)) delete names[key]
  }
  for (const [key, label] of Object.entries(speakers)) if (!names[key]) names[key] = label
  const updated = saveMeeting({ ...latest, segments, speakerNames: names })
  progress('diarize', 1)
  return updated
}
