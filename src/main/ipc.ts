import { app, BrowserWindow, clipboard, dialog, ipcMain, shell, systemPreferences, Notification } from 'electron'
import { copyFileSync, existsSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import type { ChannelId, ExportRequest, MainEventName, MainEvents, Meeting, RecordingState, Settings } from '../shared/types'
import { LOCAL_MODELS } from '../shared/types'
import { chatWithAllMeetings, chatWithMeeting, punctuateMeeting, summarizeMeeting } from './ai/notes'
import { testLlm } from './ai/llm'
import { TEMPLATES } from './ai/templates'
import { writeExport, toHtml } from './export'
import { getSettings, saveSettings, dataDir } from './settings'
import { RecordingSession, appLabel } from './session'
import { audioPath, deleteAudio, deleteMeeting, listMeetings, loadMeeting, meetingDir, newId, saveMeeting, searchMeetings, updateMeeting } from './store'
import { createEngine, testEngine } from './transcription'
import { sidecar } from './transcription/sidecar'
import type { MeetingDetector } from './detect/apps'
import type { CalendarService } from './detect/calendar'

export interface AppContext {
  getWindow(): BrowserWindow | null
  showWindow(): void
  detector: MeetingDetector
  calendar: CalendarService
}

let session: RecordingSession | null = null

export function isRecording(): boolean {
  return session !== null
}

export function broadcast<K extends MainEventName>(event: K, payload: MainEvents[K]): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send(`event:${event}`, payload)
  }
}

function idleState(): RecordingState {
  return { active: false, elapsedSec: 0, engineStatus: '', levels: { mic: 0, system: 0 }, silentChannels: [], paused: false }
}

export async function startRecording(ctx: AppContext, opts: { title?: string; language?: string; app?: string; calendarEventId?: string }): Promise<{ meetingId: string }> {
  if (session) return { meetingId: session.meetingId }
  const s = new RecordingSession(opts)
  session = s
  s.on('state', (st: RecordingState) => broadcast('recording:state', st))
  s.on('segment', (meetingId: string, segment) => broadcast('transcript:segment', { meetingId, segment }))
  s.on('partial', (meetingId: string, channel: ChannelId, text: string, start: number) => broadcast('transcript:partial', { meetingId, channel, text, start }))
  s.on('error', (meetingId: string | undefined, message: string) => broadcast('transcript:error', { meetingId, message }))
  broadcast('meetings:changed', undefined)
  await s.start()
  return { meetingId: s.meetingId }
}

export async function stopRecording(): Promise<{ meetingId?: string }> {
  if (!session) return {}
  const s = session
  const meeting = await s.stop()
  session = null
  broadcast('recording:state', idleState())
  broadcast('meetings:changed', undefined)
  broadcast('meeting:updated', { meetingId: meeting.id })
  void postProcess(meeting.id)
  return { meetingId: meeting.id }
}

/** After a recording: punctuate (if the engine writes lowercase) and summarize, per settings. */
async function postProcess(meetingId: string): Promise<void> {
  const st = getSettings()
  const m = loadMeeting(meetingId)
  if (!m || m.segments.length === 0) return
  const progress = (stage: string, progress?: number): void => broadcast('ai:progress', { meetingId, stage, progress })
  try {
    if (st.llm.provider !== 'none') {
      const model = LOCAL_MODELS.find((x) => x.id === m.modelId)
      const needsPunct = m.engine === 'local' && model && !model.punctuated
      if (st.llm.autoPunctuate && needsPunct && !m.punctuated) {
        await punctuateMeeting(meetingId, progress)
        broadcast('meeting:updated', { meetingId })
      }
      if (st.llm.autoSummarize) {
        await summarizeMeeting(meetingId, undefined, progress)
        broadcast('meeting:updated', { meetingId })
        broadcast('meetings:changed', undefined)
        new Notification({ title: 'Fundargerð tilbúin', body: loadMeeting(meetingId)?.title ?? '' }).show()
      }
    }
  } catch (e) {
    broadcast('transcript:error', { meetingId, message: e instanceof Error ? e.message : String(e) })
  } finally {
    progress('done', 1)
  }
}

export function currentRecordingState(): RecordingState {
  return session ? session.getState() : idleState()
}

async function retranscribe(meetingId: string, opts?: { engine?: string; language?: string }): Promise<void> {
  const m = loadMeeting(meetingId)
  if (!m) throw new Error('Fundur fannst ekki')
  const path = audioPath(meetingId)
  if (!existsSync(path)) throw new Error('Hljóðskrá er ekki til fyrir þennan fund')
  const st = getSettings()
  const engineId = (opts?.engine as Settings['engine']) ?? st.engine
  const language = opts?.language ?? m.language
  const engine = createEngine(engineId)
  if (!engine.transcribeFile) throw new Error('Þessi vél styður ekki endurritun úr skrá')
  saveMeeting({ ...m, status: 'processing', segments: [], punctuated: false, summary: undefined, engine: engineId, language, modelId: engineId === 'local' ? st.local.modelId : undefined })
  broadcast('meeting:updated', { meetingId })
  const progress = (stage: string, progress?: number): void => broadcast('ai:progress', { meetingId, stage, progress })
  progress('transcribe', 0)
  const segments: Meeting['segments'] = []
  try {
    await engine.transcribeFile(
      path,
      { language, vocabulary: st.vocabulary, stereo: true },
      {
        onSegment: (seg) => {
          const s = { id: randomUUID(), channel: seg.channel, start: seg.start, end: seg.end, text: seg.text, speaker: seg.speaker ?? (seg.channel === 'mic' ? 'me' : 'others') }
          segments.push(s)
          segments.sort((a, b) => a.start - b.start)
          progress('transcribe', Math.min(0.99, seg.end / Math.max(1, m.durationSec)))
          broadcast('transcript:segment', { meetingId, segment: s })
        },
        onPartial: () => {},
        onStatus: (msg) => progress(msg),
        onError: (msg) => broadcast('transcript:error', { meetingId, message: msg })
      }
    )
    const latest = loadMeeting(meetingId) ?? m
    saveMeeting({ ...latest, segments, status: 'done' })
    broadcast('meeting:updated', { meetingId })
    await postProcess(meetingId)
  } catch (e) {
    const latest = loadMeeting(meetingId) ?? m
    saveMeeting({ ...latest, segments, status: 'error', error: e instanceof Error ? e.message : String(e) })
    broadcast('meeting:updated', { meetingId })
    throw e
  }
}

async function importAudioFile(ctx: AppContext): Promise<{ meetingId: string } | null> {
  const win = ctx.getWindow()
  const res = await dialog.showOpenDialog(win ?? new BrowserWindow({ show: false }), {
    title: 'Flytja inn hljóðskrá',
    filters: [{ name: 'Hljóðskrár', extensions: ['wav', 'mp3', 'm4a', 'mp4', 'ogg', 'opus', 'flac', 'webm', 'aac', 'wma'] }],
    properties: ['openFile']
  })
  if (res.canceled || res.filePaths.length === 0) return null
  const src = res.filePaths[0]
  const id = newId()
  const ext = extname(src).toLowerCase()
  const dest = join(meetingDir(id), 'audio' + ext)
  copyFileSync(src, dest)
  const st = getSettings()
  const meeting: Meeting = {
    id,
    title: basename(src, ext),
    createdAt: new Date().toISOString(),
    durationSec: 0,
    language: st.language,
    engine: st.engine,
    modelId: st.engine === 'local' ? st.local.modelId : undefined,
    status: 'processing',
    app: 'import',
    participants: [],
    speakerNames: { me: 'Ég', others: 'Aðrir' },
    segments: [],
    notes: '',
    highlights: [],
    chat: [],
    tags: [],
    audioFile: 'audio' + ext
  }
  saveMeeting(meeting)
  broadcast('meetings:changed', undefined)
  void (async () => {
    const engine = createEngine(st.engine)
    const progress = (stage: string, progress?: number): void => broadcast('ai:progress', { meetingId: id, stage, progress })
    const segments: Meeting['segments'] = []
    try {
      if (!engine.transcribeFile) throw new Error('Vélin styður ekki skrár')
      await engine.transcribeFile(dest, { language: st.language, vocabulary: st.vocabulary, stereo: false }, {
        onSegment: (seg) => {
          const s = { id: randomUUID(), channel: seg.channel, start: seg.start, end: seg.end, text: seg.text, speaker: seg.speaker ?? 'others' }
          segments.push(s)
          broadcast('transcript:segment', { meetingId: id, segment: s })
        },
        onPartial: () => {},
        onStatus: (msg) => progress(msg),
        onError: (msg) => broadcast('transcript:error', { meetingId: id, message: msg })
      })
      const dur = segments.reduce((a, s) => Math.max(a, s.end), 0)
      saveMeeting({ ...(loadMeeting(id) ?? meeting), segments: segments.sort((a, b) => a.start - b.start), status: 'done', durationSec: dur })
      broadcast('meeting:updated', { meetingId: id })
      broadcast('meetings:changed', undefined)
      await postProcess(id)
    } catch (e) {
      saveMeeting({ ...(loadMeeting(id) ?? meeting), status: 'error', error: e instanceof Error ? e.message : String(e) })
      broadcast('meeting:updated', { meetingId: id })
    }
  })()
  return { meetingId: id }
}

async function exportMeeting(ctx: AppContext, req: ExportRequest): Promise<{ path: string } | null> {
  const m = loadMeeting(req.meetingId)
  if (!m) throw new Error('Fundur fannst ekki')
  const safe = m.title.replace(/[\\/:*?"<>|]/g, '_').slice(0, 80)
  const ext = req.format
  const names: Record<string, string> = { md: 'Markdown', txt: 'Texti', srt: 'SRT texti', docx: 'Word skjal', json: 'JSON', pdf: 'PDF' }
  const win = ctx.getWindow()
  const res = await dialog.showSaveDialog(win ?? new BrowserWindow({ show: false }), {
    title: 'Flytja út',
    defaultPath: join(app.getPath('documents'), `${safe}.${ext}`),
    filters: [{ name: names[ext] ?? ext, extensions: [ext] }]
  })
  if (res.canceled || !res.filePath) return null
  if (req.format === 'pdf') {
    const w = new BrowserWindow({ show: false, webPreferences: { sandbox: true } })
    await w.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(toHtml(m)))
    const pdf = await w.webContents.printToPDF({ printBackground: true, pageSize: 'A4' })
    const { writeFileSync } = await import('node:fs')
    writeFileSync(res.filePath, pdf)
    w.destroy()
  } else {
    await writeExport(m, req.format, res.filePath)
  }
  return { path: res.filePath }
}

export function registerIpc(ctx: AppContext): void {
  const h = ipcMain.handle.bind(ipcMain)

  h('settings:get', () => getSettings())
  h('settings:save', (_e, patch: Partial<Settings>) => saveSettings(patch))
  h('app:platform', () => ({ platform: process.platform, version: app.getVersion(), dataDir: dataDir() }))

  h('recording:start', (_e, opts) => startRecording(ctx, opts ?? {}))
  h('recording:stop', () => stopRecording())
  h('recording:pause', (_e, paused: boolean) => session?.setPaused(paused))
  h('recording:state', () => currentRecordingState())
  h('recording:highlight', (_e, note?: string) => {
    session?.markHighlight(note)
  })
  ipcMain.on('audio:chunk', (_e, channel: ChannelId, pcm: ArrayBuffer | Uint8Array, tMs: number) => {
    if (!session) return
    const u8 = pcm instanceof Uint8Array ? pcm : new Uint8Array(pcm)
    const i16 = new Int16Array(u8.buffer, u8.byteOffset, Math.floor(u8.byteLength / 2))
    session.pushAudio(channel, i16, tMs)
  })
  ipcMain.on('audio:levels', (_e, levels: { mic: number; system: number }) => session?.reportLevels(levels))

  h('meetings:list', () => listMeetings())
  h('meetings:get', (_e, id: string) => (session && session.meetingId === id ? session.getMeeting() : loadMeeting(id)))
  h('meetings:update', (_e, id: string, patch: Partial<Meeting>) => {
    const m = session && session.meetingId === id ? session.updateMeetingFields(patch) : updateMeeting(id, patch)
    if (!(session && session.meetingId === id)) saveMeeting(m)
    broadcast('meetings:changed', undefined)
    return m
  })
  h('meetings:delete', (_e, id: string) => {
    deleteMeeting(id)
    broadcast('meetings:changed', undefined)
  })
  h('meetings:deleteAudio', (_e, id: string) => {
    deleteAudio(id)
    broadcast('meeting:updated', { meetingId: id })
  })
  h('meetings:search', (_e, q: string) => searchMeetings(q))
  h('meetings:renameSpeaker', (_e, id: string, from: string, to: string) => {
    const m = loadMeeting(id)
    if (!m) throw new Error('Fundur fannst ekki')
    const names = { ...m.speakerNames, [from]: to }
    const participants = Array.from(new Set([...m.participants, to].filter((p) => p && p !== 'Ég' && p !== 'Aðrir')))
    const next = saveMeeting({ ...m, speakerNames: names, participants })
    broadcast('meeting:updated', { meetingId: id })
    return next
  })
  h('meetings:updateSegment', (_e, id: string, segmentId: string, patch: { text?: string; speaker?: string }) => {
    const m = loadMeeting(id)
    if (!m) throw new Error('Fundur fannst ekki')
    const segments = m.segments.map((s) => (s.id === segmentId ? { ...s, ...patch } : s))
    return saveMeeting({ ...m, segments })
  })
  h('meetings:audioUrl', (_e, id: string) => {
    const m = loadMeeting(id)
    if (!m?.audioFile) return null
    const p = join(meetingDir(id), m.audioFile)
    return existsSync(p) ? `fundarritari-audio://meeting/${encodeURIComponent(id)}/${encodeURIComponent(m.audioFile)}` : null
  })
  h('meetings:importAudio', () => importAudioFile(ctx))
  h('meetings:retranscribe', (_e, id: string, opts) => retranscribe(id, opts))

  h('ai:summarize', (_e, id: string, templateId?: string) => summarizeMeeting(id, templateId, (stage, progress) => broadcast('ai:progress', { meetingId: id, stage, progress })).then((s) => {
    broadcast('meeting:updated', { meetingId: id })
    broadcast('meetings:changed', undefined)
    return s
  }))
  h('ai:punctuate', (_e, id: string) => punctuateMeeting(id, (stage, progress) => broadcast('ai:progress', { meetingId: id, stage, progress })).then((m) => {
    broadcast('meeting:updated', { meetingId: id })
    return m
  }))
  h('ai:chat', (_e, id: string, message: string) => chatWithMeeting(id, message))
  h('ai:chatAll', (_e, message: string) => chatWithAllMeetings(message))
  h('ai:templates', () => TEMPLATES)
  h('ai:test', () => testLlm())

  h('export:meeting', (_e, req: ExportRequest) => exportMeeting(ctx, req))
  h('app:clipboard', (_e, text: string) => clipboard.writeText(text))
  h('app:openPath', (_e, p: string) => shell.openPath(p).then(() => undefined))
  h('app:openExternal', (_e, u: string) => (/^https?:\/\//.test(u) ? shell.openExternal(u) : Promise.resolve()))
  h('app:showInFolder', (_e, p: string) => shell.showItemInFolder(p))

  h('sidecar:status', () => sidecar.getStatus())
  h('sidecar:install', () => sidecar.install())
  h('sidecar:downloadModel', (_e, modelId: string) => sidecar.downloadModel(modelId))
  h('sidecar:warmup', () => sidecar.ensureModel())
  h('engine:test', (_e, engine: string) => testEngine(engine))

  h('detection:current', () => ctx.detector.getCurrent())
  h('calendar:upcoming', () => ctx.calendar.upcoming())
  h('calendar:refresh', () => ctx.calendar.refresh())

  h('permissions:get', () => {
    if (process.platform === 'darwin') {
      return { microphone: systemPreferences.getMediaAccessStatus('microphone'), screen: systemPreferences.getMediaAccessStatus('screen') }
    }
    if (process.platform === 'win32') return { microphone: systemPreferences.getMediaAccessStatus('microphone'), screen: 'granted' }
    return { microphone: 'granted', screen: 'granted' }
  })
  h('permissions:requestMic', async () => {
    if (process.platform === 'darwin') return systemPreferences.askForMediaAccess('microphone')
    return true
  })
  h('permissions:openPrefs', (_e, pane: 'microphone' | 'screen') => {
    if (process.platform === 'darwin') {
      const url = pane === 'microphone' ? 'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone' : 'x-apple.systempreferences:com.apple.preference.security?Privacy_AudioCapture'
      return shell.openExternal(url)
    }
    if (process.platform === 'win32') return shell.openExternal('ms-settings:privacy-microphone')
    return Promise.resolve()
  })

  h('window:minimizeToTray', () => ctx.getWindow()?.hide())
  h('window:alwaysOnTop', (_e, flag: boolean) => ctx.getWindow()?.setAlwaysOnTop(flag))

  sidecar.on('status', (st) => broadcast('sidecar:status', st))
  void pathToFileURL
  void appLabel
}
