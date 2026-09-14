/**
 * Settings context: loads settings once, exposes optimistic `update(patch)` (merged locally at once, persisted
 * with a 600 ms debounce and a "Vistað" toast) plus `save(patch)` for immediate persistence (onboarding).
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { Settings } from '@shared/types'
import { DEFAULT_SETTINGS } from '@shared/types'
import { api } from '@/api'
import { errorMessage } from '@/utils/format'

export interface SettingsApi {
  settings: Settings
  loaded: boolean
  error: string | null
  /** Optimistic + debounced persistence. */
  update: (patch: Partial<Settings>, opts?: { quiet?: boolean }) => void
  /** Immediate persistence; resolves with the stored settings. */
  save: (patch: Partial<Settings>) => Promise<Settings>
  reload: () => Promise<void>
  /** Registers the callback invoked when a debounced save completes (used to show a toast). */
  setOnSaved: (cb: ((ok: boolean, message?: string) => void) | undefined) => void
}

const SettingsContext = createContext<SettingsApi>({
  settings: DEFAULT_SETTINGS,
  loaded: false,
  error: null,
  update: () => {},
  save: async () => DEFAULT_SETTINGS,
  reload: async () => {},
  setOnSaved: () => {}
})

export function SettingsProvider({ children }: { children: ReactNode }): ReactNode {
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS)
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const pending = useRef<Partial<Settings>>({})
  const timer = useRef<number | undefined>(undefined)
  const quietRef = useRef(true)
  const onSavedRef = useRef<((ok: boolean, message?: string) => void) | undefined>(undefined)
  const setOnSaved = useCallback((cb: ((ok: boolean, message?: string) => void) | undefined) => {
    onSavedRef.current = cb
  }, [])

  const reload = useCallback(async () => {
    try {
      const s = await api.getSettings()
      setSettings({ ...DEFAULT_SETTINGS, ...s })
      setError(null)
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setLoaded(true)
    }
  }, [])

  useEffect(() => {
    void reload()
  }, [reload])

  const flush = useCallback(async () => {
    timer.current = undefined
    const patch = pending.current
    pending.current = {}
    if (Object.keys(patch).length === 0) return
    const quiet = quietRef.current
    quietRef.current = true
    try {
      const stored = await api.saveSettings(patch)
      setSettings((cur) => ({ ...cur, ...stored }))
      if (!quiet) onSavedRef.current?.(true)
    } catch (err) {
      onSavedRef.current?.(false, errorMessage(err))
    }
  }, [])

  const update = useCallback(
    (patch: Partial<Settings>, opts?: { quiet?: boolean }) => {
      setSettings((cur) => ({ ...cur, ...patch }))
      pending.current = { ...pending.current, ...patch }
      if (!opts?.quiet) quietRef.current = false
      if (timer.current !== undefined) window.clearTimeout(timer.current)
      timer.current = window.setTimeout(() => void flush(), 600)
    },
    [flush]
  )

  const save = useCallback(async (patch: Partial<Settings>) => {
    if (timer.current !== undefined) window.clearTimeout(timer.current)
    const merged = { ...pending.current, ...patch }
    pending.current = {}
    timer.current = undefined
    setSettings((cur) => ({ ...cur, ...merged }))
    const stored = await api.saveSettings(merged)
    setSettings((cur) => ({ ...cur, ...stored }))
    return stored
  }, [])

  // flush pending changes when the window is closed
  useEffect(() => {
    const h = (): void => {
      if (timer.current !== undefined) {
        window.clearTimeout(timer.current)
        void flush()
      }
    }
    window.addEventListener('beforeunload', h)
    return () => window.removeEventListener('beforeunload', h)
  }, [flush])

  const value = useMemo<SettingsApi>(() => ({ settings, loaded, error, update, save, reload, setOnSaved }), [settings, loaded, error, update, save, reload, setOnSaved])
  return <SettingsContext.Provider value={value}>{children}</SettingsContext.Provider>
}

export function useSettings(): SettingsApi {
  return useContext(SettingsContext)
}
