/**
 * Local-first meeting storage: one folder per meeting in <userData>/data/meetings/<id>/ containing
 * meeting.json (everything except audio) and audio.wav (stereo: left = mic, right = system).
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync, renameSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { dataDir } from './settings'
import { wavDurationSec } from './wav'
import type { Meeting, MeetingListItem, SearchResult, Segment } from '../shared/types'

export function meetingsDir(): string {
  const d = join(dataDir(), 'meetings')
  if (!existsSync(d)) mkdirSync(d, { recursive: true })
  return d
}

export function meetingDir(id: string): string {
  const d = join(meetingsDir(), id)
  if (!existsSync(d)) mkdirSync(d, { recursive: true })
  return d
}

export function newId(): string {
  return `${new Date().toISOString().slice(0, 10)}-${randomUUID().slice(0, 8)}`
}

const cache = new Map<string, Meeting>()

export function saveMeeting(m: Meeting): Meeting {
  cache.set(m.id, m)
  const p = join(meetingDir(m.id), 'meeting.json')
  const tmp = p + '.tmp'
  writeFileSync(tmp, JSON.stringify(m, null, 2), 'utf8')
  renameSync(tmp, p)
  return m
}

export function loadMeeting(id: string): Meeting | null {
  const c = cache.get(id)
  if (c) return c
  const p = join(meetingsDir(), id, 'meeting.json')
  if (!existsSync(p)) return null
  try {
    const m = JSON.parse(readFileSync(p, 'utf8')) as Meeting
    m.segments ??= []
    m.highlights ??= []
    m.chat ??= []
    m.tags ??= []
    m.participants ??= []
    m.speakerNames ??= {}
    m.notes ??= ''
    cache.set(id, m)
    return m
  } catch {
    return null
  }
}

export function updateMeeting(id: string, patch: Partial<Meeting>): Meeting {
  const m = loadMeeting(id)
  if (!m) throw new Error(`Meeting ${id} not found`)
  const next = { ...m, ...patch, id }
  return saveMeeting(next)
}

export function deleteMeeting(id: string): void {
  cache.delete(id)
  const d = join(meetingsDir(), id)
  if (existsSync(d)) rmSync(d, { recursive: true, force: true })
}

export function audioPath(id: string): string {
  return join(meetingDir(id), 'audio.wav')
}

export function deleteAudio(id: string): void {
  const p = audioPath(id)
  if (existsSync(p)) rmSync(p)
  const m = loadMeeting(id)
  if (m) saveMeeting({ ...m, audioFile: undefined })
}

/**
 * Meetings still marked 'recording' when the app starts belong to a run that never stopped - a crash, a power
 * cut, the machine shutting down mid-meeting. Nothing can be recording before the app is up, so they are marked
 * interrupted here. Whatever the engine had already transcribed is in meeting.json, and the audio that reached
 * the disk is a playable WAV, so the transcript can be finished from it on the meeting page.
 */
export function recoverInterruptedMeetings(): Meeting[] {
  const out: Meeting[] = []
  for (const id of readdirSync(meetingsDir())) {
    const m = loadMeeting(id)
    if (!m || m.status !== 'recording') continue
    const audio = audioPath(id)
    const seconds = existsSync(audio) ? wavDurationSec(audio) : 0
    const hasAudio = seconds >= 1
    out.push(
      saveMeeting({
        ...m,
        status: 'interrupted',
        durationSec: Math.max(m.durationSec, seconds),
        endedAt: m.endedAt ?? new Date(statSync(join(meetingsDir(), id, 'meeting.json')).mtime).toISOString(),
        audioFile: hasAudio ? (m.audioFile ?? 'audio.wav') : undefined
      })
    )
  }
  return out
}

export function listMeetings(): MeetingListItem[] {
  const out: MeetingListItem[] = []
  for (const id of readdirSync(meetingsDir())) {
    const m = loadMeeting(id)
    if (!m) continue
    out.push({
      id: m.id,
      title: m.title,
      createdAt: m.createdAt,
      durationSec: m.durationSec,
      language: m.language,
      status: m.status,
      app: m.app,
      tags: m.tags,
      hasSummary: !!m.summary,
      preview: (m.summary?.markdown || transcriptText(m.segments)).replace(/\s+/g, ' ').slice(0, 160)
    })
  }
  return out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
}

export function allMeetings(): Meeting[] {
  return listMeetings()
    .map((x) => loadMeeting(x.id))
    .filter((m): m is Meeting => !!m)
}

/**
 * Names to offer when someone is naming a speaker: whoever was invited to this meeting, then the names used in
 * earlier meetings, most recent first. Typing "Aníta" once should be enough; the second time it is a click.
 */
export function speakerNameSuggestions(meetingId: string): string[] {
  const out: string[] = []
  const add = (name: string): void => {
    const n = name.trim()
    if (!n || n === 'Ég' || n === 'Aðrir' || /^Þátttakandi \d+$/.test(n)) return
    if (!out.some((x) => x.toLowerCase() === n.toLowerCase())) out.push(n)
  }
  const meeting = loadMeeting(meetingId)
  for (const name of meeting?.invitees ?? []) add(name)
  for (const item of listMeetings()) {
    if (item.id === meetingId) continue
    const m = loadMeeting(item.id)
    if (!m) continue
    for (const name of m.participants) add(name)
    for (const name of Object.values(m.speakerNames)) add(name)
    if (out.length >= 24) break
  }
  return out.slice(0, 24)
}

/**
 * Carries a renamed speaker into minutes that were written before the rename.
 *
 * The minutes are generated from the transcript as it stood, so a meeting summarised before anyone was named
 * talks about "Þátttakandi 1" - and kept saying so after the user had put a name to that voice, which reads as
 * though the app did not notice. Only the app's own placeholder is rewritten (`Þátttakandi 1`, or the raw
 * `spk1`); a real name is left alone, because a person's name can be an ordinary word somewhere in the text.
 */
export function renameInSummary(m: Meeting, from: string, to: string): Meeting {
  const was = (m.speakerNames[from] ?? from).trim()
  const name = to.trim()
  if (!m.summary || !name || !(/^Þátttakandi \d+$/.test(was) || /^spk\d+$/i.test(was)) || was === name) return m
  // The digit matters: "Þátttakandi 1" must not match inside "Þátttakandi 10".
  const pattern = new RegExp(`(?<![\\p{L}\\p{N}])${was.replace(/\s+/g, '\\s+')}(?![\\p{L}\\p{N}])`, 'gu')
  const sub = (text: string): string => text.replace(pattern, name)
  const s = m.summary
  return {
    ...m,
    summary: {
      ...s,
      markdown: sub(s.markdown),
      title: s.title ? sub(s.title) : s.title,
      keyPoints: s.keyPoints?.map(sub),
      decisions: s.decisions?.map(sub),
      actionItems: s.actionItems?.map((a) => ({ ...a, text: sub(a.text), owner: a.owner ? sub(a.owner) : a.owner }))
    }
  }
}

export function transcriptText(segments: Segment[]): string {
  return segments
    .filter((s) => !s.partial)
    .map((s) => s.text)
    .join(' ')
}

export function speakerLabel(m: Meeting, s: Segment): string {
  return m.speakerNames[s.speaker] || s.speaker
}

export function formatTime(sec: number): string {
  const s = Math.max(0, Math.floor(sec))
  const h = Math.floor(s / 3600)
  const mm = Math.floor((s % 3600) / 60)
  const ss = s % 60
  const p = (n: number): string => n.toString().padStart(2, '0')
  return h > 0 ? `${h}:${p(mm)}:${p(ss)}` : `${p(mm)}:${p(ss)}`
}

export function searchMeetings(query: string): SearchResult[] {
  const q = query.trim().toLowerCase()
  if (!q) return []
  const terms = q.split(/\s+/)
  const results: SearchResult[] = []
  for (const m of allMeetings()) {
    const haystacks: { text: string; segmentId?: string; time?: number }[] = [
      { text: m.title },
      { text: m.notes },
      { text: m.summary?.markdown ?? '' },
      ...m.segments.map((s) => ({ text: s.text, segmentId: s.id, time: s.start }))
    ]
    let found = 0
    for (const h of haystacks) {
      const lower = h.text.toLowerCase()
      if (terms.every((t) => lower.includes(t))) {
        const idx = lower.indexOf(terms[0])
        const from = Math.max(0, idx - 60)
        results.push({
          meetingId: m.id,
          title: m.title,
          createdAt: m.createdAt,
          snippet: (from > 0 ? '…' : '') + h.text.slice(from, idx + 100) + (idx + 100 < h.text.length ? '…' : ''),
          segmentId: h.segmentId,
          time: h.time
        })
        if (++found >= 3) break
      }
    }
  }
  return results.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)).slice(0, 100)
}

export function storageStats(): { meetings: number; bytes: number } {
  let bytes = 0
  let meetings = 0
  for (const id of readdirSync(meetingsDir())) {
    meetings++
    const d = join(meetingsDir(), id)
    for (const f of readdirSync(d)) {
      try {
        bytes += statSync(join(d, f)).size
      } catch {
        /* ignore */
      }
    }
  }
  return { meetings, bytes }
}
