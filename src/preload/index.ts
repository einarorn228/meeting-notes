import { contextBridge, ipcRenderer, IpcRendererEvent } from 'electron'
import type {
  AudioDeviceInfo,
  CalendarEvent,
  ChannelId,
  DetectedMeeting,
  ExportRequest,
  MainEventName,
  MainEvents,
  Meeting,
  MeetingListItem,
  PendingSegment,
  RecordingState,
  SearchResult,
  Settings,
  SidecarStatus,
  Summary,
  SummaryTemplate,
  UpdateStatus
} from '../shared/types'

export interface FundarritariApi {
  // ---- settings ----
  getSettings(): Promise<Settings>
  saveSettings(patch: Partial<Settings>): Promise<Settings>
  getPlatform(): Promise<{ platform: NodeJS.Platform; version: string; dataDir: string }>

  // ---- recording ----
  startRecording(opts: { title?: string; language?: string; app?: string; calendarEventId?: string }): Promise<{ meetingId: string }>
  stopRecording(): Promise<{ meetingId?: string }>
  pauseRecording(paused: boolean): Promise<void>
  getRecordingState(): Promise<RecordingState>
  /** PCM16 mono 16 kHz audio chunk from the renderer capture pipeline. */
  pushAudio(channel: ChannelId, pcm: ArrayBuffer, tMs: number): void
  reportLevels(levels: { mic: number; system: number }): void
  markHighlight(note?: string): Promise<void>

  // ---- meetings ----
  listMeetings(): Promise<MeetingListItem[]>
  getMeeting(id: string): Promise<Meeting | null>
  updateMeeting(id: string, patch: Partial<Meeting>): Promise<Meeting>
  deleteMeeting(id: string): Promise<void>
  deleteMeetingAudio(id: string): Promise<void>
  searchMeetings(query: string): Promise<SearchResult[]>
  renameSpeaker(meetingId: string, from: string, to: string): Promise<Meeting>
  updateSegment(meetingId: string, segmentId: string, patch: { text?: string; speaker?: string }): Promise<Meeting>
  getAudioUrl(meetingId: string): Promise<string | null>
  importAudioFile(): Promise<{ meetingId: string } | null>
  retranscribe(meetingId: string, opts?: { engine?: string; language?: string }): Promise<void>
  /** Speech queued for transcription in the active recording, if any - so a view opened mid-recording can show it. */
  getPendingSegments(): Promise<{ meetingId: string; items: PendingSegment[] } | null>
  /** Re-run speaker separation on the remote channel; `speakers` fixes how many people were on the line. */
  rediarize(meetingId: string, speakers?: number): Promise<Meeting | null>

  // ---- AI ----
  summarize(meetingId: string, templateId?: string): Promise<Summary>
  punctuate(meetingId: string): Promise<Meeting>
  chat(meetingId: string, message: string): Promise<string>
  chatAll(message: string): Promise<string>
  listTemplates(): Promise<SummaryTemplate[]>
  testLlm(): Promise<{ ok: boolean; message: string }>

  // ---- export ----
  exportMeeting(req: ExportRequest): Promise<{ path: string } | null>
  copyToClipboard(text: string): Promise<void>
  openPath(path: string): Promise<void>
  openExternal(url: string): Promise<void>
  showInFolder(path: string): Promise<void>

  // ---- sidecar / local engine ----
  getSidecarStatus(): Promise<SidecarStatus>
  installSidecar(): Promise<void>
  downloadModel(modelId: string): Promise<void>
  warmUpLocalEngine(): Promise<void>
  testEngine(engine: string): Promise<{ ok: boolean; message: string }>

  // ---- updates ----
  getUpdateStatus(): Promise<UpdateStatus>
  checkForUpdates(): Promise<UpdateStatus>
  installUpdate(): Promise<void>

  // ---- detection / calendar ----
  getDetectedMeeting(): Promise<DetectedMeeting | null>
  getUpcomingEvents(): Promise<CalendarEvent[]>
  refreshCalendar(): Promise<CalendarEvent[]>

  // ---- permissions / devices ----
  getMediaPermissions(): Promise<{ microphone: string; screen: string }>
  requestMicrophoneAccess(): Promise<boolean>
  openSystemPreferences(pane: 'microphone' | 'screen'): Promise<void>

  // ---- window ----
  minimizeToTray(): Promise<void>
  setAlwaysOnTop(flag: boolean): Promise<void>

  // ---- events ----
  on<K extends MainEventName>(event: K, cb: (payload: MainEvents[K]) => void): () => void
}

function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  return ipcRenderer.invoke(channel, ...args)
}

const api: FundarritariApi = {
  getSettings: () => invoke('settings:get'),
  saveSettings: (patch) => invoke('settings:save', patch),
  getPlatform: () => invoke('app:platform'),

  startRecording: (opts) => invoke('recording:start', opts),
  stopRecording: () => invoke('recording:stop'),
  pauseRecording: (paused) => invoke('recording:pause', paused),
  getRecordingState: () => invoke('recording:state'),
  pushAudio: (channel, pcm, tMs) => ipcRenderer.send('audio:chunk', channel, pcm, tMs),
  reportLevels: (levels) => ipcRenderer.send('audio:levels', levels),
  markHighlight: (note) => invoke('recording:highlight', note),

  listMeetings: () => invoke('meetings:list'),
  getMeeting: (id) => invoke('meetings:get', id),
  updateMeeting: (id, patch) => invoke('meetings:update', id, patch),
  deleteMeeting: (id) => invoke('meetings:delete', id),
  deleteMeetingAudio: (id) => invoke('meetings:deleteAudio', id),
  searchMeetings: (q) => invoke('meetings:search', q),
  renameSpeaker: (meetingId, from, to) => invoke('meetings:renameSpeaker', meetingId, from, to),
  updateSegment: (meetingId, segmentId, patch) => invoke('meetings:updateSegment', meetingId, segmentId, patch),
  getAudioUrl: (id) => invoke('meetings:audioUrl', id),
  importAudioFile: () => invoke('meetings:importAudio'),
  retranscribe: (id, opts) => invoke('meetings:retranscribe', id, opts),
  getPendingSegments: () => invoke('recording:pending'),
  rediarize: (id, speakers) => invoke('meetings:rediarize', id, speakers),

  summarize: (meetingId, templateId) => invoke('ai:summarize', meetingId, templateId),
  punctuate: (meetingId) => invoke('ai:punctuate', meetingId),
  chat: (meetingId, message) => invoke('ai:chat', meetingId, message),
  chatAll: (message) => invoke('ai:chatAll', message),
  listTemplates: () => invoke('ai:templates'),
  testLlm: () => invoke('ai:test'),

  exportMeeting: (req) => invoke('export:meeting', req),
  copyToClipboard: (text) => invoke('app:clipboard', text),
  openPath: (p) => invoke('app:openPath', p),
  openExternal: (u) => invoke('app:openExternal', u),
  showInFolder: (p) => invoke('app:showInFolder', p),

  getSidecarStatus: () => invoke('sidecar:status'),
  installSidecar: () => invoke('sidecar:install'),
  downloadModel: (modelId) => invoke('sidecar:downloadModel', modelId),
  warmUpLocalEngine: () => invoke('sidecar:warmup'),
  testEngine: (engine) => invoke('engine:test', engine),

  getUpdateStatus: () => invoke('update:status'),
  checkForUpdates: () => invoke('update:check'),
  installUpdate: () => invoke('update:install'),

  getDetectedMeeting: () => invoke('detection:current'),
  getUpcomingEvents: () => invoke('calendar:upcoming'),
  refreshCalendar: () => invoke('calendar:refresh'),

  getMediaPermissions: () => invoke('permissions:get'),
  requestMicrophoneAccess: () => invoke('permissions:requestMic'),
  openSystemPreferences: (pane) => invoke('permissions:openPrefs', pane),

  minimizeToTray: () => invoke('window:minimizeToTray'),
  setAlwaysOnTop: (flag) => invoke('window:alwaysOnTop', flag),

  on: (event, cb) => {
    const listener = (_e: IpcRendererEvent, payload: unknown): void => cb(payload as never)
    ipcRenderer.on(`event:${event}`, listener)
    return () => ipcRenderer.removeListener(`event:${event}`, listener)
  }
}

contextBridge.exposeInMainWorld('fundarritari', api)
export type { AudioDeviceInfo }
