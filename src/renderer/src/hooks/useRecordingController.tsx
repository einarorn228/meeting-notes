/**
 * Owns the whole recording lifecycle for the app: the main-process session (startRecording/stopRecording) and the
 * renderer capture pipeline (startCapture). Lives at App level so the capture handle survives route changes.
 *
 * Start:  api.startRecording(...) -> startCapture(...) -> navigate('recording')
 * Stop:   capture.stop() -> api.stopRecording() -> navigate(meeting detail)
 * The main process can toggle recording via the `hotkey:toggleRecording` event and request navigation via `navigate`.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { ChannelId, RecordingState, Segment, SidecarStatus } from '@shared/types'
import { api } from '@/api'
import { startCapture, type CaptureHandle } from '@/audio/capture'
import { useEvent } from './useEvent'
import { useSettings } from './useSettings'
import { useToast } from './useToast'
import { useRouter } from '@/router'
import { useI18n } from '@/i18n'
import { errorMessage, formatDateTime } from '@/utils/format'

export interface StartOptions {
  title?: string
  language?: string
  app?: string
  calendarEventId?: string
}

export type Partials = Partial<Record<ChannelId, { text: string; start: number }>>

export interface RecordingController {
  state: RecordingState
  elapsedSec: number
  levels: { mic: number; system: number }
  segments: Segment[]
  partials: Partials
  /** Reason string from capture when system audio could not be captured (null when fine). */
  systemUnavailable: string | null
  /** True when main reports an active recording but this renderer holds no capture handle (window reloaded). */
  captureLost: boolean
  error: string | null
  sidecar: SidecarStatus | null
  title: string
  setTitle: (t: string) => void
  busy: 'starting' | 'stopping' | null
  start: (opts?: StartOptions) => Promise<boolean>
  stop: () => Promise<string | undefined>
  toggle: () => Promise<void>
  togglePause: () => Promise<void>
  markHighlight: (note?: string) => Promise<void>
  clearError: () => void
}

const IDLE: RecordingState = {
  active: false,
  elapsedSec: 0,
  engineStatus: '',
  levels: { mic: 0, system: 0 },
  silentChannels: [],
  paused: false
}

const RecordingContext = createContext<RecordingController | null>(null)

export function RecordingProvider({ children }: { children: ReactNode }): ReactNode {
  const { settings, loaded } = useSettings()
  const { toast } = useToast()
  const { navigate } = useRouter()
  const { t, locale } = useI18n()

  const [state, setState] = useState<RecordingState>(IDLE)
  const [elapsedSec, setElapsed] = useState(0)
  const [levels, setLevels] = useState({ mic: 0, system: 0 })
  const [segments, setSegments] = useState<Segment[]>([])
  const [partials, setPartials] = useState<Partials>({})
  const [systemUnavailable, setSystemUnavailable] = useState<string | null>(null)
  const [captureLost, setCaptureLost] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [sidecar, setSidecar] = useState<SidecarStatus | null>(null)
  const [title, setTitleState] = useState('')
  const [busy, setBusy] = useState<'starting' | 'stopping' | null>(null)

  const handle = useRef<CaptureHandle | null>(null)
  const stateRef = useRef(state)
  stateRef.current = state
  const busyRef = useRef(busy)
  busyRef.current = busy
  const settingsRef = useRef(settings)
  settingsRef.current = settings
  const titleTimer = useRef<number | undefined>(undefined)

  // Initial sync (covers a renderer reload while a recording is running in main).
  useEffect(() => {
    let cancelled = false
    void api
      .getRecordingState()
      .then((s) => {
        if (cancelled || !s) return
        setState(s)
        setElapsed(s.elapsedSec)
        if (s.active && !handle.current) setCaptureLost(true)
      })
      .catch(() => {})
    void api
      .getSidecarStatus()
      .then((s) => !cancelled && setSidecar(s))
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])

  // Timer: main sends elapsedSec in state updates; between them we tick locally.
  useEffect(() => {
    setElapsed(state.elapsedSec)
    if (!state.active || state.paused) return
    const id = window.setInterval(() => setElapsed((e) => e + 1), 1000)
    return () => window.clearInterval(id)
  }, [state.active, state.paused, state.elapsedSec, state.startedAt])

  useEvent('recording:state', (s) => {
    setState(s)
    if (!s.active) {
      setCaptureLost(false)
    }
  })
  useEvent('transcript:segment', ({ meetingId, segment }) => {
    if (stateRef.current.meetingId && meetingId !== stateRef.current.meetingId) return
    setSegments((prev) => {
      const idx = prev.findIndex((x) => x.id === segment.id)
      if (idx >= 0) {
        const next = prev.slice()
        next[idx] = segment
        return next
      }
      const next = [...prev, segment]
      next.sort((a, b) => a.start - b.start)
      return next
    })
    setPartials((p) => (p[segment.channel] ? { ...p, [segment.channel]: undefined } : p))
  })
  useEvent('transcript:partial', ({ meetingId, channel, text, start }) => {
    if (stateRef.current.meetingId && meetingId !== stateRef.current.meetingId) return
    setPartials((p) => ({ ...p, [channel]: text ? { text, start } : undefined }))
  })
  useEvent('transcript:error', ({ message }) => setError(message))
  useEvent('sidecar:status', (s) => setSidecar(s))

  const setTitle = useCallback((next: string) => {
    setTitleState(next)
    const id = stateRef.current.meetingId
    if (!id) return
    if (titleTimer.current !== undefined) window.clearTimeout(titleTimer.current)
    titleTimer.current = window.setTimeout(() => {
      void api.updateMeeting(id, { title: next }).catch(() => {})
    }, 700)
  }, [])

  const start = useCallback(
    async (opts?: StartOptions): Promise<boolean> => {
      if (busyRef.current || stateRef.current.active) return false
      const s = settingsRef.current
      setBusy('starting')
      setError(null)
      setSegments([])
      setPartials({})
      setSystemUnavailable(null)
      setCaptureLost(false)
      const meetingTitle = opts?.title?.trim() || t('rec.untitled', { date: formatDateTime(new Date().toISOString(), locale) })
      setTitleState(meetingTitle)
      let meetingId: string
      try {
        const res = await api.startRecording({
          title: meetingTitle,
          language: opts?.language ?? s.language,
          app: opts?.app,
          calendarEventId: opts?.calendarEventId
        })
        meetingId = res.meetingId
      } catch (err) {
        setError(`${t('rec.startFailed')}: ${errorMessage(err)}`)
        toast(`${t('rec.startFailed')}: ${errorMessage(err)}`, 'error')
        setBusy(null)
        return false
      }
      setState((prev) => ({ ...prev, active: true, meetingId, startedAt: new Date().toISOString(), elapsedSec: 0, paused: false, engine: s.engine }))
      try {
        handle.current = await startCapture({
          micDeviceId: s.audio.micDeviceId,
          captureMic: s.audio.captureMic,
          captureSystem: s.audio.captureSystemAudio,
          echoCancellation: s.audio.echoCancellation,
          noiseSuppression: s.audio.noiseSuppression,
          onLevels: (l) => setLevels(l),
          onSystemAudioUnavailable: (reason) => setSystemUnavailable(reason)
        })
        if (s.audio.captureSystemAudio && !handle.current.hasSystem) setSystemUnavailable((r) => r ?? 'no-audio-track')
      } catch (err) {
        handle.current = null
        await api.stopRecording().catch(() => {})
        setState(IDLE)
        setError(t('rec.micFailed', { msg: errorMessage(err) }))
        toast(t('rec.micFailed', { msg: errorMessage(err) }), 'error')
        setBusy(null)
        return false
      }
      setBusy(null)
      navigate({ name: 'recording' })
      return true
    },
    [t, locale, toast, navigate]
  )

  const stop = useCallback(async (): Promise<string | undefined> => {
    if (busyRef.current === 'stopping') return undefined
    setBusy('stopping')
    const h = handle.current
    handle.current = null
    if (h) await h.stop().catch(() => {})
    setLevels({ mic: 0, system: 0 })
    let meetingId: string | undefined
    try {
      const res = await api.stopRecording()
      meetingId = res?.meetingId ?? stateRef.current.meetingId
    } catch (err) {
      meetingId = stateRef.current.meetingId
      toast(t('toast.error', { msg: errorMessage(err) }), 'error')
    }
    setState(IDLE)
    setPartials({})
    setCaptureLost(false)
    setBusy(null)
    if (meetingId) navigate({ name: 'meeting', id: meetingId })
    else navigate({ name: 'home' })
    return meetingId
  }, [navigate, t, toast])

  const toggle = useCallback(async () => {
    if (stateRef.current.active) await stop()
    else await start()
  }, [start, stop])

  const togglePause = useCallback(async () => {
    const paused = !stateRef.current.paused
    handle.current?.setPaused(paused)
    setState((prev) => ({ ...prev, paused }))
    await api.pauseRecording(paused).catch(() => {})
  }, [])

  const markHighlight = useCallback(
    async (note?: string) => {
      if (!stateRef.current.active) return
      try {
        await api.markHighlight(note)
        toast(t('toast.highlightMarked'), 'success')
      } catch (err) {
        toast(t('toast.error', { msg: errorMessage(err) }), 'error')
      }
    },
    [t, toast]
  )

  const clearError = useCallback(() => setError(null), [])

  // Global hotkeys / navigation requests coming from main.
  useEvent('hotkey:toggleRecording', () => {
    if (!loaded || !settingsRef.current.onboardingDone) return
    void toggle()
  })
  useEvent('hotkey:markHighlight', () => void markHighlight())
  useEvent('navigate', ({ route }) => navigate(route))

  const value = useMemo<RecordingController>(
    () => ({
      state,
      elapsedSec,
      levels,
      segments,
      partials,
      systemUnavailable,
      captureLost,
      error,
      sidecar,
      title,
      setTitle,
      busy,
      start,
      stop,
      toggle,
      togglePause,
      markHighlight,
      clearError
    }),
    [state, elapsedSec, levels, segments, partials, systemUnavailable, captureLost, error, sidecar, title, setTitle, busy, start, stop, toggle, togglePause, markHighlight, clearError]
  )
  return <RecordingContext.Provider value={value}>{children}</RecordingContext.Provider>
}

export function useRecording(): RecordingController {
  const ctx = useContext(RecordingContext)
  if (!ctx) throw new Error('useRecording must be used within RecordingProvider')
  return ctx
}
