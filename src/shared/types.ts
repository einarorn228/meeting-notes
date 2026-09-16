// Shared contract between main, preload, renderer and (conceptually) the Python sidecar.

export type ChannelId = 'mic' | 'system'
export type Language = 'is' | 'en' | 'auto' | string

export type EngineId = 'local' | 'azure' | 'elevenlabs' | 'openai'
export type LlmProviderId = 'anthropic' | 'openai' | 'ollama' | 'none'

/** Local model catalogue (faster-whisper / CTranslate2 models on Hugging Face). */
export interface LocalModelInfo {
  id: string
  /** Hugging Face repo id */
  repo: string
  label: string
  description: string
  languages: string[]
  sizeMb: number
  /** Whether the model writes punctuation & casing itself. */
  punctuated: boolean
  recommended?: boolean
}

export const LOCAL_MODELS: LocalModelInfo[] = [
  {
    id: 'aalto-large-v3-is',
    repo: 'Aalto-Speech-Synthesis/whisper-large-v3-Icelandic-finetuned-ct2',
    label: 'Íslenska – Whisper large-v3 (Aalto 2026)',
    description:
      'Best Icelandic accuracy. Fine-tuned on ~1,000+ h of Icelandic incl. conversational speech (Spjallrómur, Alþingi). WER 8.1 % Alþingi, 3.5 % Malrómur.',
    languages: ['is'],
    sizeMb: 3100,
    punctuated: false,
    recommended: true
  },
  {
    id: 'lvl-large-is',
    repo: 'language-and-voice-lab/whisper-large-icelandic-30k-steps-1000h-ct2',
    label: 'Íslenska – Whisper large (Háskólinn í Reykjavík 2023)',
    description: 'Fine-tuned on 1,000 h incl. 514 h Alþingi speech. WER 8.5 % Samrómur, 5.1 % Malrómur, 8.3 % Alþingi.',
    languages: ['is'],
    sizeMb: 3100,
    punctuated: false
  },
  {
    id: 'large-v3-turbo',
    repo: 'deepdml/faster-whisper-large-v3-turbo-ct2',
    label: 'Fjöltyngt – Whisper large-v3-turbo (hratt)',
    description: 'Fast multilingual OpenAI model. Good for English, weaker for Icelandic.',
    languages: ['*'],
    sizeMb: 1600,
    punctuated: true
  },
  {
    id: 'large-v3',
    repo: 'Systran/faster-whisper-large-v3',
    label: 'Fjöltyngt – Whisper large-v3',
    description: 'Multilingual OpenAI model. Punctuated output, weaker Icelandic than the fine-tuned models.',
    languages: ['*'],
    sizeMb: 3100,
    punctuated: true
  }
]

export interface Settings {
  uiLanguage: 'is' | 'en'
  /** Default spoken language for meetings. */
  language: Language
  engine: EngineId
  local: {
    modelId: string
    device: 'auto' | 'cpu' | 'cuda'
    computeType: 'auto' | 'int8' | 'float16' | 'float32'
    /** Emit partial (in-progress) results while someone is still speaking. Costs CPU. */
    partials: boolean
    /** Speaker diarization of the system channel after the recording (sherpa-onnx, offline). */
    diarize: boolean
    /** Path to python executable to use for the sidecar (optional, auto-detected otherwise). */
    pythonPath?: string
    threads?: number
  }
  azure: { key: string; region: string; diarization: boolean }
  elevenlabs: { apiKey: string; diarize: boolean }
  openaiStt: { apiKey: string; model: string }
  llm: {
    provider: LlmProviderId
    anthropicApiKey: string
    anthropicModel: string
    openaiApiKey: string
    openaiModel: string
    ollamaUrl: string
    ollamaModel: string
    /** Restore punctuation/casing with the LLM after local transcription. */
    autoPunctuate: boolean
    /** Generate the summary automatically when a recording stops. */
    autoSummarize: boolean
    summaryTemplateId: string
  }
  audio: {
    micDeviceId: string | 'default'
    captureSystemAudio: boolean
    captureMic: boolean
    echoCancellation: boolean
    noiseSuppression: boolean
  }
  vocabulary: string[]
  detection: {
    enabled: boolean
    apps: string[]
    calendarIcsUrls: string[]
    notifyMinutesBefore: number
  }
  hotkeys: { toggleRecording: string; markHighlight: string }
  storage: { keepAudio: boolean }
  updates: {
    /** Check for and download new versions on its own. Off means updates only happen when asked for. */
    auto: boolean
  }
  onboardingDone: boolean
  consentNotice: string
}

export interface Segment {
  id: string
  channel: ChannelId
  /** seconds from recording start */
  start: number
  end: number
  text: string
  speaker: string
  /** true while the segment may still change (partial result) */
  partial?: boolean
  confidence?: number
}

/** A cut of speech that has been queued for transcription but has no text yet. */
export interface PendingSegment {
  id: string
  channel: ChannelId
  start: number
  end: number
}

export interface Highlight {
  id: string
  time: number
  note: string
}

export interface ActionItem {
  text: string
  owner?: string
  due?: string
  done?: boolean
}

export interface Summary {
  templateId: string
  language: Language
  generatedAt: string
  provider: string
  model: string
  markdown: string
  title?: string
  keyPoints?: string[]
  decisions?: string[]
  actionItems?: ActionItem[]
}

export interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
  at: string
}

export type MeetingStatus = 'recording' | 'processing' | 'done' | 'error'

export interface Meeting {
  id: string
  title: string
  createdAt: string
  endedAt?: string
  durationSec: number
  language: Language
  engine: EngineId
  modelId?: string
  status: MeetingStatus
  /** Detected meeting app (teams, zoom, meet, ...) */
  app?: string
  calendarEventId?: string
  participants: string[]
  speakerNames: Record<string, string>
  segments: Segment[]
  notes: string
  summary?: Summary
  highlights: Highlight[]
  chat: ChatMessage[]
  tags: string[]
  audioFile?: string
  /** Whether the transcript has been punctuated/cased by the LLM. */
  punctuated?: boolean
  error?: string
}

export interface MeetingListItem {
  id: string
  title: string
  createdAt: string
  durationSec: number
  language: Language
  status: MeetingStatus
  app?: string
  tags: string[]
  hasSummary: boolean
  preview: string
}

export interface SummaryTemplate {
  id: string
  name: { is: string; en: string }
  description: { is: string; en: string }
  /** Extra instructions appended to the base prompt */
  instructions: { is: string; en: string }
  sections: { is: string[]; en: string[] }
}

export interface RecordingState {
  active: boolean
  meetingId?: string
  startedAt?: string
  elapsedSec: number
  engine?: EngineId
  engineStatus: string
  levels: { mic: number; system: number }
  silentChannels: ChannelId[]
  paused: boolean
  /** How many seconds the transcript is behind the speech, from the oldest cut still waiting for its text. */
  transcriptLagSec: number
}

export interface DetectedMeeting {
  app: string
  appLabel: string
  windowTitle?: string
  detectedAt: string
}

export interface CalendarEvent {
  id: string
  title: string
  start: string
  end: string
  location?: string
  joinUrl?: string
  app?: string
}

export interface SidecarStatus {
  state: 'not-installed' | 'installing' | 'idle' | 'loading-model' | 'downloading-model' | 'ready' | 'error'
  message?: string
  progress?: number
  modelId?: string
  device?: string
  pythonPath?: string
  installedModels?: string[]
}

export interface ExportRequest {
  meetingId: string
  format: 'md' | 'txt' | 'srt' | 'docx' | 'json' | 'pdf'
}

export interface SearchResult {
  meetingId: string
  title: string
  createdAt: string
  snippet: string
  segmentId?: string
  time?: number
}

export interface AudioDeviceInfo {
  deviceId: string
  label: string
}

export type CapturePermissionState = 'granted' | 'denied' | 'unknown' | 'restricted' | 'not-determined'

export const DEFAULT_SUMMARY_TEMPLATE_ID = 'fundargerd'

export const DEFAULT_SETTINGS: Settings = {
  uiLanguage: 'is',
  language: 'is',
  engine: 'local',
  local: { modelId: 'aalto-large-v3-is', device: 'auto', computeType: 'auto', partials: false, diarize: true },
  azure: { key: '', region: 'northeurope', diarization: true },
  elevenlabs: { apiKey: '', diarize: true },
  openaiStt: { apiKey: '', model: 'gpt-4o-transcribe' },
  llm: {
    provider: 'anthropic',
    anthropicApiKey: '',
    anthropicModel: 'claude-opus-5',
    openaiApiKey: '',
    openaiModel: 'gpt-5.6-sol',
    ollamaUrl: 'http://127.0.0.1:11434',
    ollamaModel: 'gemma4:12b',
    autoPunctuate: true,
    autoSummarize: true,
    summaryTemplateId: DEFAULT_SUMMARY_TEMPLATE_ID
  },
  audio: {
    micDeviceId: 'default',
    captureSystemAudio: true,
    captureMic: true,
    echoCancellation: true,
    noiseSuppression: true
  },
  vocabulary: [],
  detection: {
    enabled: true,
    apps: ['teams', 'zoom', 'meet', 'slack', 'webex', 'discord', 'facetime'],
    calendarIcsUrls: [],
    notifyMinutesBefore: 1
  },
  hotkeys: { toggleRecording: 'CommandOrControl+Shift+R', markHighlight: 'CommandOrControl+Shift+H' },
  updates: { auto: true },
  storage: { keepAudio: true },
  onboardingDone: false,
  consentNotice: 'Athugið: Þessi fundur er hljóðritaður og skrifaður niður sjálfkrafa með Fundarritara.'
}

/** Events pushed from main to renderer. */
export interface UpdateStatus {
  state: 'idle' | 'checking' | 'available' | 'downloading' | 'ready' | 'up-to-date' | 'error'
  currentVersion: string
  /** The newer version, once one is found. */
  version?: string
  progress?: number
  message?: string
  /** False on macOS and .deb installs, where a new version has to be downloaded by hand. */
  canSelfUpdate: boolean
  releasesUrl: string
}

export interface MainEvents {
  'recording:state': RecordingState
  'transcript:segment': { meetingId: string; segment: Segment }
  'transcript:partial': { meetingId: string; channel: ChannelId; text: string; start: number }
  'transcript:pending': { meetingId: string; items: PendingSegment[] }
  'transcript:error': { meetingId?: string; message: string }
  'meeting:updated': { meetingId: string }
  'meetings:changed': void
  'sidecar:status': SidecarStatus
  'detection:meeting': DetectedMeeting
  'calendar:upcoming': CalendarEvent
  'hotkey:toggleRecording': void
  'hotkey:markHighlight': void
  'navigate': { route: string }
  'ai:progress': { meetingId: string; stage: string; progress?: number }
  'update:status': UpdateStatus
}

export type MainEventName = keyof MainEvents
