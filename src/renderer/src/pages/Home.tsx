import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import type { CalendarEvent, DetectedMeeting, MeetingListItem, SearchResult } from '@shared/types'
import { api } from '@/api'
import { useI18n } from '@/i18n'
import { useRouter } from '@/router'
import { useEvent } from '@/hooks/useEvent'
import { useRecording } from '@/hooks/useRecordingController'
import { useToast } from '@/hooks/useToast'
import { Alert, Button, EmptyState, Spinner } from '@/components/ui'
import { Icon } from '@/components/Icons'
import { AppChip, LanguageChip, StatusBadge } from '@/components/StatusBadge'
import { dayKey, formatDate, formatDuration, formatTime, errorMessage, mmss } from '@/utils/format'

export function HomePage(): ReactNode {
  const { t, lang, locale } = useI18n()
  const { navigate } = useRouter()
  const rec = useRecording()
  const { toast } = useToast()
  const [meetings, setMeetings] = useState<MeetingListItem[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [detected, setDetected] = useState<DetectedMeeting | null>(null)
  const [dismissedApp, setDismissedApp] = useState<string | null>(null)
  const [events, setEvents] = useState<CalendarEvent[]>([])
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<SearchResult[] | null>(null)
  const [searching, setSearching] = useState(false)
  const [importing, setImporting] = useState(false)

  const load = useCallback(async () => {
    try {
      setMeetings(await api.listMeetings())
      setError(null)
    } catch (err) {
      setError(errorMessage(err))
      setMeetings((m) => m ?? [])
    }
  }, [])

  useEffect(() => {
    void load()
    api.getDetectedMeeting().then((d) => setDetected(d)).catch(() => {})
    api.getUpcomingEvents().then((e) => setEvents(e ?? [])).catch(() => {})
  }, [load])

  useEvent('meetings:changed', () => void load())
  useEvent('meeting:updated', () => void load())
  useEvent('detection:meeting', (d) => setDetected(d))
  useEvent('calendar:upcoming', (ev) => setEvents((list) => (list.some((x) => x.id === ev.id) ? list : [...list, ev].sort((a, b) => a.start.localeCompare(b.start)))))

  // Debounced search
  useEffect(() => {
    const q = query.trim()
    if (!q) {
      setResults(null)
      setSearching(false)
      return
    }
    setSearching(true)
    const id = window.setTimeout(() => {
      api
        .searchMeetings(q)
        .then((r) => setResults(r))
        .catch((err) => toast(t('toast.error', { msg: errorMessage(err) }), 'error'))
        .finally(() => setSearching(false))
    }, 250)
    return () => window.clearTimeout(id)
  }, [query, t, toast])

  const groups = useMemo(() => {
    const map = new Map<string, MeetingListItem[]>()
    for (const m of meetings ?? []) {
      const k = dayKey(m.createdAt)
      const arr = map.get(k) ?? []
      arr.push(m)
      map.set(k, arr)
    }
    return [...map.entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1))
  }, [meetings])

  const dayLabel = (key: string, iso: string): string => {
    const today = dayKey(new Date().toISOString())
    const yesterday = dayKey(new Date(Date.now() - 86400000).toISOString())
    if (key === today) return t('common.today')
    if (key === yesterday) return t('common.yesterday')
    return formatDate(iso, locale)
  }

  const importAudio = async (): Promise<void> => {
    setImporting(true)
    try {
      const res = await api.importAudioFile()
      if (res?.meetingId) navigate({ name: 'meeting', id: res.meetingId })
    } catch (err) {
      toast(t('toast.error', { msg: errorMessage(err) }), 'error')
    } finally {
      setImporting(false)
    }
  }

  const upcoming = useMemo(() => {
    const now = Date.now()
    return events.filter((e) => new Date(e.end).getTime() > now - 5 * 60000).sort((a, b) => a.start.localeCompare(b.start)).slice(0, 5)
  }, [events])

  const showBanner = detected && !rec.state.active && dismissedApp !== detected.app + detected.detectedAt

  return (
    <div className="page">
      <header className="page-header">
        <h1>{t('home.title')}</h1>
        <div className="row gap-sm">
          <div className="search-box">
            <Icon name="search" size={15} />
            <input value={query} placeholder={t('home.searchPlaceholder')} onChange={(e) => setQuery(e.target.value)} />
            {query && <button type="button" className="search-clear" onClick={() => setQuery('')} aria-label={t('common.close')}><Icon name="x" size={13} /></button>}
          </div>
          <Button icon="upload" loading={importing} onClick={importAudio}>
            {importing ? t('home.importing') : t('home.importAudio')}
          </Button>
        </div>
      </header>

      {showBanner && detected && (
        <Alert
          tone="info"
          action={
            <>
              <Button size="sm" variant="primary" icon="record" onClick={() => void rec.start({ title: detected.windowTitle || detected.appLabel, app: detected.app })}>
                {t('home.detectedStart')}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setDismissedApp(detected.app + detected.detectedAt)}>
                {t('home.detectedDismiss')}
              </Button>
            </>
          }
        >
          {t('home.detected', { app: detected.appLabel || detected.app })}
          {detected.windowTitle && <span className="muted"> · {detected.windowTitle}</span>}
        </Alert>
      )}

      {error && <Alert tone="danger" action={<Button size="sm" onClick={() => void load()}>{t('common.retry')}</Button>}>{t('home.loadError')}: {error}</Alert>}

      {results !== null || searching ? (
        <section className="section">
          <h2 className="section-title">{t('home.results')}</h2>
          {searching && <div className="muted row gap-sm"><Spinner size={14} /> {t('home.searching')}</div>}
          {!searching && results && results.length === 0 && <div className="muted">{t('home.noResults', { q: query })}</div>}
          <div className="list">
            {results?.map((r, i) => (
              <button key={`${r.meetingId}-${r.segmentId ?? i}`} type="button" className="list-item" onClick={() => navigate({ name: 'meeting', id: r.meetingId, tab: r.segmentId ? 'transcript' : undefined, time: r.time })}>
                <div className="list-main">
                  <div className="list-title">{r.title}</div>
                  <div className="list-preview">{r.snippet}</div>
                </div>
                <div className="list-meta">
                  <span>{formatDate(r.createdAt, locale, { day: 'numeric', month: 'short' })}</span>
                  {r.time !== undefined && <span className="mono">{mmss(r.time)}</span>}
                </div>
              </button>
            ))}
          </div>
        </section>
      ) : (
        <>
          {upcoming.length > 0 && (
            <section className="section">
              <h2 className="section-title">
                <Icon name="calendar" size={15} /> {t('home.upcoming')}
              </h2>
              <div className="events">
                {upcoming.map((ev) => {
                  const startMs = new Date(ev.start).getTime()
                  const minutes = Math.round((startMs - Date.now()) / 60000)
                  const rel = minutes > 0 ? t('home.meetingStartsIn', { min: minutes }) : minutes > -2 ? t('home.meetingStartsNow') : t('home.meetingOngoing')
                  return (
                    <div key={ev.id} className="event">
                      <div className="event-time">
                        <span>{formatTime(ev.start, locale)}</span>
                        <span className="muted">{formatDate(ev.start, locale, { day: 'numeric', month: 'short' })}</span>
                      </div>
                      <div className="event-main">
                        <div className="event-title">{ev.title}</div>
                        <div className="muted small">
                          {rel}
                          {ev.app && <> · <AppChip app={ev.app} /></>}
                          {ev.location && <> · {ev.location}</>}
                        </div>
                      </div>
                      <div className="row gap-sm">
                        {ev.joinUrl && (
                          <Button size="sm" variant="ghost" icon="external" onClick={() => void api.openExternal(ev.joinUrl!)}>
                            {t('home.join')}
                          </Button>
                        )}
                        <Button size="sm" variant="primary" icon="record" disabled={rec.state.active} onClick={() => void rec.start({ title: ev.title, app: ev.app, calendarEventId: ev.id })}>
                          {t('home.prepare')}
                        </Button>
                      </div>
                    </div>
                  )
                })}
              </div>
            </section>
          )}

          {meetings === null ? (
            <div className="muted row gap-sm"><Spinner size={14} /> {t('common.loading')}</div>
          ) : meetings.length === 0 ? (
            <EmptyState icon="mic" title={t('home.noMeetings')} hint={t('home.noMeetingsHint')} action={<Button variant="primary" icon="record" onClick={() => void rec.start()}>{t('nav.startRecording')}</Button>} />
          ) : (
            groups.map(([key, items]) => (
              <section key={key} className="section">
                <h2 className="section-title">
                  {dayLabel(key, items[0].createdAt)} <span className="muted small">· {items.length === 1 ? t('home.count1') : t('home.count', { n: items.length })}</span>
                </h2>
                <div className="list">
                  {items.map((m) => (
                    <button key={m.id} type="button" className="list-item meeting-item" onClick={() => (m.status === 'recording' && rec.state.active ? navigate({ name: 'recording' }) : navigate({ name: 'meeting', id: m.id }))}>
                      <div className="list-main">
                        <div className="list-title">
                          {m.title}
                          {m.hasSummary && <Icon name="sparkles" size={13} className="text-accent" />}
                        </div>
                        <div className="list-preview">{m.preview || t('home.noPreview')}</div>
                        <div className="row gap-sm wrap small">
                          <StatusBadge status={m.status} />
                          <AppChip app={m.app} />
                          <LanguageChip language={m.language} />
                          {m.tags.map((tag) => (
                            <span key={tag} className="tag small">{tag}</span>
                          ))}
                        </div>
                      </div>
                      <div className="list-meta">
                        <span>{formatTime(m.createdAt, locale)}</span>
                        <span className="muted">{formatDuration(m.durationSec, lang)}</span>
                      </div>
                    </button>
                  ))}
                </div>
              </section>
            ))
          )}
        </>
      )}
    </div>
  )
}
