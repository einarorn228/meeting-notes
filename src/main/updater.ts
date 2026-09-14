/**
 * In-app updates from the project's GitHub releases.
 *
 * Windows (NSIS) and Linux AppImage builds can install an update themselves. macOS cannot: Squirrel.Mac
 * only accepts a code-signed bundle and this app ships unsigned; a .deb install would need a root prompt.
 * On those two the app still *detects* a new version and points at the download page, so a tester is never
 * left on a broken build without knowing.
 */
import { app } from 'electron'
// electron-updater is CommonJS; the default import keeps this working in the ESM main bundle.
import electronUpdater from 'electron-updater'
import type { UpdateStatus } from '../shared/types'

const { autoUpdater } = electronUpdater

export const RELEASES_URL = 'https://github.com/einarorn228/meeting-notes/releases/latest'

/** Whether this build can download and apply an update on its own. */
export function canSelfUpdate(platform: NodeJS.Platform = process.platform, isAppImage = !!process.env.APPIMAGE): boolean {
  if (platform === 'darwin') return false
  if (platform === 'linux') return isAppImage
  return true
}

type Emit = (status: UpdateStatus) => void

let status: UpdateStatus = {
  state: 'idle',
  currentVersion: '0.0.0',
  canSelfUpdate: canSelfUpdate(),
  releasesUrl: RELEASES_URL
}
let emit: Emit = () => {}
let started = false
/** Set while the user explicitly pressed "check for updates", so "you are up to date" can be shown. */
let userInitiated = false

function set(patch: Partial<UpdateStatus>): void {
  status = { ...status, ...patch }
  emit(status)
}

export function getUpdateStatus(): UpdateStatus {
  return status
}

/**
 * Wires up the updater and starts a first check. `isBusy` guards the restart: an update must never
 * interrupt a recording in progress.
 */
export function initUpdater(onStatus: Emit, isBusy: () => boolean): void {
  emit = onStatus
  status = { ...status, currentVersion: app.getVersion() }
  if (!app.isPackaged) {
    // electron-updater refuses to run from a dev checkout, and would only log a confusing error.
    set({ state: 'idle', message: 'Uppfærslur eru óvirkar í þróunarham' })
    return
  }
  if (started) return
  started = true

  autoUpdater.autoDownload = status.canSelfUpdate
  // Installing on quit would restart mid-recording; installUpdate() below decides when it is safe.
  autoUpdater.autoInstallOnAppQuit = false
  autoUpdater.logger = { info: console.log, warn: console.warn, error: console.error, debug: () => {} }

  autoUpdater.on('checking-for-update', () => set({ state: 'checking', message: undefined }))
  autoUpdater.on('update-available', (info) => {
    set({ state: status.canSelfUpdate ? 'downloading' : 'available', version: info.version, progress: 0, message: undefined })
  })
  autoUpdater.on('update-not-available', () => {
    set({ state: userInitiated ? 'up-to-date' : 'idle', version: undefined, message: undefined })
    userInitiated = false
  })
  autoUpdater.on('download-progress', (p) => set({ state: 'downloading', progress: (p.percent ?? 0) / 100 }))
  autoUpdater.on('update-downloaded', (info) => set({ state: 'ready', version: info.version, progress: 1 }))
  autoUpdater.on('error', (err) => {
    set({ state: 'error', message: err instanceof Error ? err.message : String(err) })
    userInitiated = false
  })

  installGuard = isBusy
  // A check on launch, then daily for the long-running tray sessions this app is designed for.
  setTimeout(() => void checkForUpdates(false), 8000)
  setInterval(() => void checkForUpdates(false), 24 * 3600 * 1000)
}

let installGuard: () => boolean = () => false

export async function checkForUpdates(fromUser = true): Promise<UpdateStatus> {
  if (!app.isPackaged) return status
  userInitiated = userInitiated || fromUser
  try {
    await autoUpdater.checkForUpdates()
  } catch (e) {
    set({ state: 'error', message: e instanceof Error ? e.message : String(e) })
  }
  return status
}

/** Restarts into the new version. Throws (in Icelandic) if that would cut a recording short. */
export function installUpdate(): void {
  if (status.state !== 'ready') throw new Error('Engin uppfærsla er tilbúin til uppsetningar')
  if (installGuard()) throw new Error('Upptaka er í gangi. Stöðvaðu upptökuna fyrst og reyndu svo aftur.')
  setImmediate(() => autoUpdater.quitAndInstall(false, true))
}
