/**
 * RecordingSession: owns one live recording. Receives PCM chunks from the renderer (two channels), writes the
 * stereo WAV, feeds the transcription engine, collects segments into the meeting, tracks capture health
 * (silent channels) and broadcasts state to the renderer.
 */
import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import type { ChannelId, Highlight, Meeting, PendingSegment, RecordingState, Segment } from '../shared/types'
import { getSettings } from './settings'
import { audioPath, newId, saveMeeting, updateMeeting, loadMeeting } from './store'
import { createEngine } from './transcription'
import type { EngineSegment, TranscriptionEngine } from './transcription/types'
import { toSegment } from './transcription/types'
import { StereoWavWriter } from './wav'
import { shortDateTimeIs } from '../shared/dates'

export interface SessionEvents {
  state: (s: RecordingState) => void
  segment: (meetingId: string, seg: Segment) => void
  partial: (meetingId: string, channel: ChannelId, text: string, start: number) => void
  pending: (meetingId: string, items: PendingSegment[]) => void
  error: (meetingId: string | undefined, message: string) => void
  finished: (meetingId: string) => void
}

const SILENCE_WARN_AFTER_MS = 20000

export class RecordingSession extends EventEmitter {
  readonly meetingId: string
  private meeting: Meeting
  private engine: TranscriptionEngine | null = null
  private wav: StereoWavWriter | null = null
  private startedAt = Date.now()
  private paused = false
  private levels = { mic: 0, system: 0 }
  private lastLoud: Record<ChannelId, number> = { mic: Date.now(), system: Date.now() }
  private seen: Record<ChannelId, boolean> = { mic: false, system: false }
  private engineStatus = 'Ræsi…'
  /** Speech that has been captured and queued, but has no text yet. Shown as placeholders in the transcript. */
  private pending: PendingSegment[] = []
  private ticker: NodeJS.Timeout
  private saveTimer: NodeJS.Timeout | null = null
  private stopping = false
  private lastTMs: Record<ChannelId, number> = { mic: 0, system: 0 }

  constructor(opts: { title?: string; language?: string; app?: string; calendarEventId?: string }) {
    super()
    const s = getSettings()
    this.meetingId = newId()
    const now = new Date()
    this.meeting = {
      id: this.meetingId,
      title: opts.title?.trim() || defaultTitle(now, opts.app),
      createdAt: now.toISOString(),
      durationSec: 0,
      language: opts.language || s.language,
      engine: s.engine,
      modelId: s.engine === 'local' ? s.local.modelId : undefined,
      status: 'recording',
      app: opts.app,
      calendarEventId: opts.calendarEventId,
      participants: [],
      speakerNames: { me: 'Ég', others: 'Aðrir' },
      segments: [],
      notes: '',
      highlights: [],
      chat: [],
      tags: [],
      audioFile: s.storage.keepAudio ? 'audio.wav' : undefined
    }
    saveMeeting(this.meeting)
    this.ticker = setInterval(() => this.emitState(), 1000)
  }

  async start(): Promise<void> {
    const s = getSettings()
    if (s.storage.keepAudio) this.wav = new StereoWavWriter(audioPath(this.meetingId))
    this.engine = createEngine(s.engine)
    const channels: ChannelId[] = []
    if (s.audio.captureMic) channels.push('mic')
    if (s.audio.captureSystemAudio) channels.push('system')
    try {
      await this.engine.start(
        { language: this.meeting.language, channels: channels.length ? channels : ['mic', 'system'], vocabulary: s.vocabulary, partials: s.local.partials },
        {
          onSegment: (seg) => this.addSegment(seg),
          onPartial: (ch, text, start) => this.emit('partial', this.meetingId, ch, text, start),
          onPending: ({ id, channel, start, end }) => {
            this.pending.push({ id, channel, start, end })
            this.emit('pending', this.meetingId, [...this.pending])
          },
          onPendingDone: (id) => {
            const i = this.pending.findIndex((p) => p.id === id)
            if (i < 0) return
            this.pending.splice(i, 1)
            this.emit('pending', this.meetingId, [...this.pending])
          },
          onStatus: (st) => {
            this.engineStatus = st
            this.emitState()
          },
          onError: (msg, fatal) => {
            this.emit('error', this.meetingId, msg)
            if (fatal) {
              this.engineStatus = 'Villa: ' + msg
              this.emitState()
            }
          }
        }
      )
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      this.engineStatus = 'Talgreining ræstist ekki: ' + msg
      this.emit('error', this.meetingId, this.engineStatus)
      this.engine = null
    }
    this.emitState()
  }

  pushAudio(channel: ChannelId, pcm: Int16Array, tMs: number): void {
    if (this.stopping) return
    this.seen[channel] = true
    this.lastTMs[channel] = tMs + (pcm.length / 16000) * 1000
    this.wav?.write(channel, pcm, tMs)
    if (!this.paused) this.engine?.pushAudio(channel, pcm, tMs)
  }

  reportLevels(levels: { mic: number; system: number }): void {
    this.levels = levels
    const now = Date.now()
    if (levels.mic > 0.01) this.lastLoud.mic = now
    if (levels.system > 0.005) this.lastLoud.system = now
  }

  setPaused(p: boolean): void {
    this.paused = p
    this.emitState()
  }

  markHighlight(note?: string): Highlight {
    const h: Highlight = { id: randomUUID(), time: this.elapsedSec(), note: note ?? '' }
    this.meeting.highlights.push(h)
    this.scheduleSave()
    return h
  }

  updateMeetingFields(patch: Partial<Meeting>): Meeting {
    // keep segments/highlights authoritative here while recording
    const { segments: _s, highlights: _h, ...rest } = patch
    this.meeting = { ...this.meeting, ...rest }
    this.scheduleSave()
    return this.meeting
  }

  getMeeting(): Meeting {
    return this.meeting
  }

  /** Cuts announced by the engine that have no text yet (for a view that opens mid-recording). */
  getPending(): PendingSegment[] {
    return [...this.pending]
  }

  private addSegment(seg: EngineSegment): void {
    const s = toSegment(seg.id ?? randomUUID(), seg)
    // Keep transcript ordered by start time (channels arrive independently).
    const segs = this.meeting.segments
    let i = segs.length
    while (i > 0 && segs[i - 1].start > s.start) i--
    segs.splice(i, 0, s)
    this.scheduleSave()
    this.emit('segment', this.meetingId, s)
  }

  private scheduleSave(): void {
    if (this.saveTimer) return
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null
      this.meeting.durationSec = this.elapsedSec()
      saveMeeting(this.meeting)
    }, 1500)
  }

  elapsedSec(): number {
    return Math.max((Date.now() - this.startedAt) / 1000, Math.max(this.lastTMs.mic, this.lastTMs.system) / 1000)
  }

  getState(): RecordingState {
    const now = Date.now()
    const s = getSettings()
    const silent: ChannelId[] = []
    if (now - this.startedAt > SILENCE_WARN_AFTER_MS && !this.paused) {
      if (s.audio.captureSystemAudio && (!this.seen.system || now - this.lastLoud.system > SILENCE_WARN_AFTER_MS)) silent.push('system')
      if (s.audio.captureMic && (!this.seen.mic || now - this.lastLoud.mic > SILENCE_WARN_AFTER_MS * 6)) silent.push('mic')
    }
    return {
      active: true,
      meetingId: this.meetingId,
      startedAt: this.meeting.createdAt,
      elapsedSec: this.elapsedSec(),
      engine: this.meeting.engine,
      engineStatus: this.engineStatus,
      levels: this.levels,
      silentChannels: silent,
      paused: this.paused
    }
  }

  private emitState(): void {
    this.emit('state', this.getState())
  }

  async stop(): Promise<Meeting> {
    if (this.stopping) return this.meeting
    this.stopping = true
    clearInterval(this.ticker)
    if (this.saveTimer) {
      clearTimeout(this.saveTimer)
      this.saveTimer = null
    }
    this.meeting.durationSec = this.elapsedSec()
    this.meeting.endedAt = new Date().toISOString()
    this.meeting.status = 'processing'
    saveMeeting(this.meeting)
    this.engineStatus = 'Lýk við uppskrift…'
    this.emit('state', { ...this.getState(), active: true })
    try {
      this.wav?.close()
    } catch (e) {
      this.emit('error', this.meetingId, 'WAV: ' + String(e))
    }
    try {
      await this.engine?.stop()
    } catch (e) {
      this.emit('error', this.meetingId, String(e))
    }
    // Whatever is still queued will never be shown now; the meeting view takes over from here.
    if (this.pending.length) {
      this.pending = []
      this.emit('pending', this.meetingId, [])
    }
    // Reload in case the renderer saved notes/title while we were recording (store cache is shared).
    const latest = loadMeeting(this.meetingId)
    this.meeting = { ...(latest ?? this.meeting), segments: this.meeting.segments, highlights: this.meeting.highlights, durationSec: this.meeting.durationSec, endedAt: this.meeting.endedAt }
    this.meeting.status = 'done'
    saveMeeting(this.meeting)
    this.emit('finished', this.meetingId)
    return this.meeting
  }
}

export function defaultTitle(d: Date, app?: string): string {
  const appName = app ? ` (${appLabel(app)})` : ''
  return `Fundur ${shortDateTimeIs(d)}${appName}`
}

export function appLabel(app: string): string {
  const map: Record<string, string> = { teams: 'Microsoft Teams', zoom: 'Zoom', meet: 'Google Meet', slack: 'Slack', webex: 'Webex', discord: 'Discord', facetime: 'FaceTime', import: 'Innflutt' }
  return map[app] ?? app
}

export { updateMeeting }
