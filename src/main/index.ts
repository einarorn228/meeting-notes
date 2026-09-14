import { app, BrowserWindow, desktopCapturer, globalShortcut, Menu, nativeImage, net, Notification, protocol, session, shell, Tray } from 'electron'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { getSettings, onSettingsChange } from './settings'
import { broadcast, currentRecordingState, isRecording, registerIpc, startRecording, stopRecording } from './ipc'
import { MeetingDetector } from './detect/apps'
import { CalendarService } from './detect/calendar'
import { sidecar } from './transcription/sidecar'
import { meetingsDir } from './store'

let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null
let quitting = false

protocol.registerSchemesAsPrivileged([{ scheme: 'fundarritari-audio', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, bypassCSP: true } }])

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => showWindow())
}

app.setAppUserModelId('is.fundarritari.app')
if (process.platform === 'linux') app.commandLine.appendSwitch('enable-features', 'PulseaudioLoopbackForScreenShare')

function iconPath(): string {
  const p = join(__dirname, '../../resources/icon.png')
  return existsSync(p) ? p : join(process.resourcesPath ?? '', 'icon.png')
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1240,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    title: 'Fundarritari',
    icon: existsSync(iconPath()) ? iconPath() : undefined,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#f6f7fb',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false
    }
  })
  win.on('ready-to-show', () => win.show())
  win.on('close', (e) => {
    // Keep running in the tray (the renderer owns the audio capture pipeline).
    if (!quitting) {
      e.preventDefault()
      win.hide()
      if (isRecording()) new Notification({ title: 'Fundarritari', body: 'Upptaka heldur áfram í bakgrunni. Opnaðu úr kerfisbakkanum.' }).show()
    }
  })
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  if (process.env.ELECTRON_RENDERER_URL) void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else void win.loadFile(join(__dirname, '../renderer/index.html'))
  return win
}

function showWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) mainWindow = createWindow()
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

function setupDisplayMediaHandler(): void {
  // Answer getDisplayMedia() from the renderer with a throwaway screen source + system audio loopback.
  // Windows: WASAPI loopback (Electron ≥ 22). macOS 14.2+: Core Audio tap (Electron ≥ 39). Linux: PulseAudio feature.
  session.defaultSession.setDisplayMediaRequestHandler(
    async (_request, callback) => {
      try {
        const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } })
        callback({ video: sources[0], audio: 'loopback' })
      } catch (e) {
        console.error('display media handler failed', e)
        callback({})
      }
    },
    { useSystemPicker: false }
  )
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => {
    cb(['media', 'audioCapture', 'display-capture', 'notifications', 'clipboard-read', 'clipboard-sanitized-write'].includes(permission))
  })
  session.defaultSession.setPermissionCheckHandler(() => true)
}

function setupAudioProtocol(): void {
  protocol.handle('fundarritari-audio', (req) => {
    const url = new URL(req.url)
    const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent)
    const [id, file] = parts
    if (!id || !file || file.includes('..') || id.includes('..')) return new Response('bad request', { status: 400 })
    const p = join(meetingsDir(), id, file)
    if (!existsSync(p)) return new Response('not found', { status: 404 })
    return net.fetch(pathToFileURL(p).toString(), { headers: req.headers })
  })
}

function buildTray(): void {
  const img = existsSync(iconPath()) ? nativeImage.createFromPath(iconPath()).resize({ width: 18, height: 18 }) : nativeImage.createEmpty()
  tray = new Tray(img)
  tray.setToolTip('Fundarritari')
  const refresh = (): void => {
    const rec = isRecording()
    const menu = Menu.buildFromTemplate([
      { label: rec ? '● Upptaka í gangi' : 'Fundarritari', enabled: false },
      { type: 'separator' },
      { label: rec ? 'Stöðva upptöku' : 'Hefja upptöku', click: () => void toggleRecording() },
      { label: 'Merkja stað', enabled: rec, click: () => broadcast('hotkey:markHighlight', undefined) },
      { type: 'separator' },
      { label: 'Opna Fundarritara', click: () => showWindow() },
      { label: 'Stillingar', click: () => { showWindow(); broadcast('navigate', { route: '/settings' }) } },
      { type: 'separator' },
      { label: 'Hætta', click: () => { quitting = true; app.quit() } }
    ])
    tray?.setContextMenu(menu)
  }
  refresh()
  tray.on('click', () => showWindow())
  setInterval(refresh, 3000)
}

async function toggleRecording(): Promise<void> {
  showWindow()
  // The renderer owns audio capture, so recording is toggled there.
  broadcast('hotkey:toggleRecording', undefined)
}

function registerHotkeys(): void {
  globalShortcut.unregisterAll()
  const s = getSettings()
  try {
    if (s.hotkeys.toggleRecording) globalShortcut.register(s.hotkeys.toggleRecording, () => void toggleRecording())
    if (s.hotkeys.markHighlight) globalShortcut.register(s.hotkeys.markHighlight, () => broadcast('hotkey:markHighlight', undefined))
  } catch (e) {
    console.error('hotkey registration failed', e)
  }
}

app.whenReady().then(() => {
  setupDisplayMediaHandler()
  setupAudioProtocol()

  const detector = new MeetingDetector(
    (m) => {
      broadcast('detection:meeting', m)
      const n = new Notification({ title: `${m.appLabel} fundur greindist`, body: 'Smelltu til að hefja upptöku með Fundarritara.' })
      n.on('click', () => {
        showWindow()
        broadcast('navigate', { route: `/record?app=${m.app}` })
      })
      n.show()
    },
    () => ({ enabled: getSettings().detection.enabled, apps: getSettings().detection.apps }),
    isRecording
  )
  const calendar = new CalendarService(
    () => getSettings().detection.calendarIcsUrls,
    (e) => {
      broadcast('calendar:upcoming', e)
      const n = new Notification({ title: `Fundur að hefjast: ${e.title}`, body: 'Smelltu til að hefja upptöku.' })
      n.on('click', () => {
        showWindow()
        broadcast('navigate', { route: `/record?event=${encodeURIComponent(e.id)}&title=${encodeURIComponent(e.title)}${e.app ? '&app=' + e.app : ''}` })
      })
      n.show()
    },
    () => getSettings().detection.notifyMinutesBefore
  )

  registerIpc({ getWindow: () => mainWindow, showWindow, detector, calendar })
  mainWindow = createWindow()
  buildTray()
  registerHotkeys()
  detector.start()
  calendar.start()
  onSettingsChange(() => registerHotkeys())

  // Warm the local engine in the background so the first recording starts quickly.
  const s = getSettings()
  if (s.engine === 'local' && s.onboardingDone) {
    sidecar
      .isInstalled()
      .then((ok) => (ok ? sidecar.ensureModel() : undefined))
      .catch((e) => console.error('warmup failed', e))
  }

  app.on('activate', () => showWindow())
})

app.on('before-quit', () => {
  quitting = true
})

app.on('will-quit', async (e) => {
  if (isRecording()) {
    e.preventDefault()
    await stopRecording()
    quitting = true
    app.quit()
    return
  }
  globalShortcut.unregisterAll()
  sidecar.shutdown()
})

app.on('window-all-closed', () => {
  // Keep alive in tray.
})

export { currentRecordingState, startRecording }
