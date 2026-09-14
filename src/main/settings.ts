import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DEFAULT_SETTINGS, type Settings } from '../shared/types'

let cached: Settings | null = null

export function dataDir(): string {
  const dir = join(app.getPath('userData'), 'data')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

function settingsPath(): string {
  return join(app.getPath('userData'), 'settings.json')
}

function deepMerge<T>(base: T, patch: unknown): T {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return (patch as T) ?? base
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) }
  for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
    const cur = out[k]
    if (v && typeof v === 'object' && !Array.isArray(v) && cur && typeof cur === 'object' && !Array.isArray(cur)) {
      out[k] = deepMerge(cur, v)
    } else if (v !== undefined) {
      out[k] = v
    }
  }
  return out as T
}

export function getSettings(): Settings {
  if (cached) return cached
  try {
    const raw = readFileSync(settingsPath(), 'utf8')
    cached = deepMerge(DEFAULT_SETTINGS, JSON.parse(raw))
  } catch {
    cached = structuredClone(DEFAULT_SETTINGS)
  }
  return cached!
}

export function saveSettings(patch: Partial<Settings>): Settings {
  cached = deepMerge(getSettings(), patch)
  writeFileSync(settingsPath(), JSON.stringify(cached, null, 2), 'utf8')
  for (const l of listeners) l(cached)
  return cached
}

const listeners: ((s: Settings) => void)[] = []
export function onSettingsChange(cb: (s: Settings) => void): void {
  listeners.push(cb)
}
