import type { ChannelId, Language, Segment } from '../../shared/types'

export interface EngineSegment {
  channel: ChannelId
  start: number
  end: number
  text: string
  /** engine-provided speaker id (e.g. Azure Guest-1), optional */
  speaker?: string
  confidence?: number
}

export interface EngineCallbacks {
  onSegment(seg: EngineSegment): void
  onPartial(channel: ChannelId, text: string, start: number): void
  onStatus(status: string): void
  onError(message: string, fatal?: boolean): void
}

export interface EngineStartOptions {
  language: Language
  channels: ChannelId[]
  vocabulary: string[]
  partials: boolean
}

/** A streaming transcription engine fed with PCM16 mono 16 kHz audio per channel. */
export interface TranscriptionEngine {
  readonly id: string
  start(opts: EngineStartOptions, cb: EngineCallbacks): Promise<void>
  pushAudio(channel: ChannelId, pcm: Int16Array, tMs: number): void
  /** Flush and finish; resolves once all final segments have been delivered. */
  stop(): Promise<void>
  /** Transcribe a whole file (stereo WAV: left=mic, right=system, or mono). */
  transcribeFile?(path: string, opts: { language: Language; vocabulary: string[]; stereo: boolean }, cb: EngineCallbacks): Promise<void>
}

export function toSegment(id: string, s: EngineSegment): Segment {
  return {
    id,
    channel: s.channel,
    start: s.start,
    end: s.end,
    text: s.text,
    speaker: s.speaker ?? (s.channel === 'mic' ? 'me' : 'others'),
    confidence: s.confidence
  }
}

/** Icelandic-first language code helpers. */
export function bcp47(lang: Language): string {
  switch (lang) {
    case 'is':
      return 'is-IS'
    case 'en':
      return 'en-US'
    case 'da':
      return 'da-DK'
    case 'no':
      return 'nb-NO'
    case 'sv':
      return 'sv-SE'
    case 'de':
      return 'de-DE'
    default:
      return lang.includes('-') ? lang : 'is-IS'
  }
}

export function iso3(lang: Language): string {
  const map: Record<string, string> = { is: 'isl', en: 'eng', da: 'dan', no: 'nor', sv: 'swe', de: 'deu', fr: 'fra', es: 'spa', pl: 'pol' }
  return map[lang] ?? lang
}
