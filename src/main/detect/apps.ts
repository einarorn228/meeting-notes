/**
 * Detects running meeting apps by polling the process list (no native modules). On Windows the main window
 * title of Teams/Zoom is also inspected to tell "app open" from "in a meeting".
 */
import { execFile } from 'node:child_process'
import type { DetectedMeeting } from '../../shared/types'

interface AppSpec {
  id: string
  label: string
  processes: RegExp
  /** Window title patterns that indicate an active call (Windows/macOS). */
  inCall?: RegExp
}

export const APPS: AppSpec[] = [
  { id: 'teams', label: 'Microsoft Teams', processes: /^(ms-teams|teams|microsoft teams(?: \(work or school\))?|msteams)(\.exe)?$/i, inCall: /(fundur|meeting|call|símtal|\| Microsoft Teams)/i },
  { id: 'zoom', label: 'Zoom', processes: /^(zoom|zoom\.us|cpthost|zoom\.exe)$/i, inCall: /zoom meeting|zoom fundur/i },
  { id: 'meet', label: 'Google Meet', processes: /^(google meet)$/i },
  { id: 'slack', label: 'Slack', processes: /^slack(\.exe)?$/i, inCall: /huddle/i },
  { id: 'webex', label: 'Webex', processes: /^(webex|ciscocollabhost|webexmta|atmgr)(\.exe)?$/i },
  { id: 'discord', label: 'Discord', processes: /^discord(\.exe)?$/i },
  { id: 'facetime', label: 'FaceTime', processes: /^facetime$/i }
]

function exec(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile(cmd, args, { windowsHide: true, maxBuffer: 16 * 1024 * 1024, timeout: 8000 }, (err, stdout) => resolve(err ? '' : String(stdout)))
  })
}

/** Returns process names (lowercase, without path) and, on Windows, main window titles. */
export async function listProcesses(): Promise<{ name: string; title?: string }[]> {
  if (process.platform === 'win32') {
    const out = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Get-Process | Select-Object ProcessName,MainWindowTitle | ConvertTo-Json -Compress'])
    try {
      const arr = JSON.parse(out || '[]') as { ProcessName: string; MainWindowTitle: string }[]
      return (Array.isArray(arr) ? arr : [arr]).map((p) => ({ name: String(p.ProcessName ?? '').toLowerCase(), title: p.MainWindowTitle || undefined }))
    } catch {
      const t = await exec('tasklist.exe', ['/FO', 'CSV', '/NH'])
      return t
        .split(/\r?\n/)
        .map((l) => l.split('","')[0]?.replace(/^"/, '').replace(/\.exe$/i, '').toLowerCase())
        .filter(Boolean)
        .map((name) => ({ name }))
    }
  }
  const out = await exec('ps', ['-axo', 'comm='])
  return out
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => ({ name: l.split('/').pop()!.toLowerCase() }))
}

export function matchApps(procs: { name: string; title?: string }[], enabled: string[]): DetectedMeeting[] {
  const found: DetectedMeeting[] = []
  for (const app of APPS) {
    if (!enabled.includes(app.id)) continue
    const matches = procs.filter((p) => app.processes.test(p.name))
    if (matches.length === 0) continue
    const title = matches.map((m) => m.title).find((t) => t && app.inCall?.test(t))
    found.push({ app: app.id, appLabel: app.label, windowTitle: title, detectedAt: new Date().toISOString() })
  }
  // Prefer apps that look like they are in a call.
  return found.sort((a, b) => Number(!!b.windowTitle) - Number(!!a.windowTitle))
}

export class MeetingDetector {
  private timer: NodeJS.Timeout | null = null
  private current: DetectedMeeting | null = null
  private notified = new Set<string>()

  constructor(private readonly onDetected: (m: DetectedMeeting) => void, private readonly getEnabled: () => { enabled: boolean; apps: string[] }, private readonly isRecording: () => boolean) {}

  start(intervalMs = 15000): void {
    this.stop()
    this.timer = setInterval(() => void this.poll(), intervalMs)
    void this.poll()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  getCurrent(): DetectedMeeting | null {
    return this.current
  }

  private async poll(): Promise<void> {
    const cfg = this.getEnabled()
    if (!cfg.enabled) {
      this.current = null
      return
    }
    const procs = await listProcesses()
    const found = matchApps(procs, cfg.apps)
    const best = found[0] ?? null
    const wasRunning = this.current?.app
    this.current = best
    if (!best) {
      this.notified.clear()
      return
    }
    // Notify when an app first appears in a call state (Windows title) or first appears at all (other OSes).
    const key = best.app + (best.windowTitle ? ':call' : ':open')
    const newlySeen = !this.notified.has(key) && (best.windowTitle || wasRunning !== best.app)
    if (newlySeen && !this.isRecording()) {
      this.notified.add(key)
      this.onDetected(best)
    }
  }
}
