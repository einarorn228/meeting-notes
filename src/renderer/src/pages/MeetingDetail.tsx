import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { ChatMessage, ExportRequest, Meeting, PendingSegment, Segment, SummaryTemplate } from '@shared/types'
import { LOCAL_MODELS } from '@shared/types'
import { api } from '@/api'
import { useI18n } from '@/i18n'
import { useRouter, type MeetingTab } from '@/router'
import { useEvent } from '@/hooks/useEvent'
import { useSettings } from '@/hooks/useSettings'
import { useToast } from '@/hooks/useToast'
import { Alert, Button, Card, EmptyState, ProgressBar, Select, Spinner, Tabs, TextArea } from '@/components/ui'
import { Icon } from '@/components/Icons'
import { AppChip, LanguageChip, StatusBadge } from '@/components/StatusBadge'
import { TagsEditor } from '@/components/TagsEditor'
import { TranscriptList } from '@/components/TranscriptList'
import { ConfirmDialog, Modal, PromptDialog } from '@/components/Modal'
import { Markdown } from '@/utils/markdown'
import { errorMessage, formatDateTime, formatDuration, mmss } from '@/utils/format'

interface Props {
  id: string
  initialTab?: MeetingTab
  initialTime?: number
}

export function MeetingPage({ id, initialTab, initialTime }: Props): ReactNode {
  const { t, lang, locale } = useI18n()
  const { navigate } = useRouter()
  const { settings } = useSettings()
  const { toast } = useToast()
  const [meeting, setMeeting] = useState<Meeting | null | undefined>(undefined)
  const [tab, setTab] = useState<MeetingTab>(initialTab ?? 'summary')
  const [audioUrl, setAudioUrl] = useState<string | null>(null)
  const [activeSeg, setActiveSeg] = useState<string | undefined>(undefined)
  const [progress, setProgress] = useState<{ stage: string; progress?: number } | null>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [confirmDeleteAudio, setConfirmDeleteAudio] = useState(false)
  const [rename, setRename] = useState<{ key: string; label: string } | null>(null)
  const [retrans, setRetrans] = useState(false)
  const [speakersDialog, setSpeakersDialog] = useState(false)
  // Speech the engine has queued but not written out yet. Without this the transcript tab of a meeting that
  // is still recording (or draining after stop) looks finished while text is still on its way.
  const [pending, setPending] = useState<PendingSegment[]>([])
  const audioRef = useRef<HTMLAudioElement>(null)
  const titleTimer = useRef<number | undefined>(undefined)

  const load = useCallback(async () => {
    try {
      const m = await api.getMeeting(id)
      setMeeting(m)
      if (m?.audioFile) setAudioUrl(await api.getAudioUrl(id))
      else setAudioUrl(null)
    } catch (err) {
      toast(`${t('meeting.loadError')}: ${errorMessage(err)}`, 'error')
      setMeeting(null)
    }
  }, [id, t, toast])

  useEffect(() => {
    void load()
    void api
      .getPendingSegments()
      .then((p) => setPending(p && p.meetingId === id ? p.items : []))
      .catch(() => {})
  }, [load, id])

  useEvent('meeting:updated', ({ meetingId }) => {
    if (meetingId === id) void load()
  })
  useEvent('transcript:segment', ({ meetingId, segment }) => {
    if (meetingId !== id) return
    setMeeting((m) => {
      if (!m) return m
      const segs = m.segments.filter((s) => s.id !== segment.id).concat(segment).sort((a, b) => a.start - b.start)
      return { ...m, segments: segs }
    })
  })
  useEvent('transcript:pending', ({ meetingId, items }) => {
    if (meetingId === id) setPending(items)
  })
  useEvent('ai:progress', ({ meetingId, stage, progress: p }) => {
    if (meetingId !== id) return
    setProgress(stage === 'done' ? null : { stage, progress: p })
  })

  // seek to initial time (from search results)
  useEffect(() => {
    if (initialTime !== undefined && audioRef.current && audioUrl) {
      audioRef.current.currentTime = initialTime
    }
  }, [initialTime, audioUrl])

  const seek = (time: number): void => {
    const a = audioRef.current
    if (!a) return
    a.currentTime = Math.max(0, time - 0.3)
    void a.play().catch(() => {})
  }

  const onTimeUpdate = (): void => {
    const a = audioRef.current
    if (!a || !meeting) return
    const tcur = a.currentTime
    const seg = meeting.segments.find((s) => tcur >= s.start && tcur < Math.max(s.end, s.start + 1))
    setActiveSeg(seg?.id)
  }

  const update = async (patch: Partial<Meeting>): Promise<void> => {
    if (!meeting) return
    setMeeting({ ...meeting, ...patch })
    try {
      await api.updateMeeting(id, patch)
    } catch (err) {
      toast(t('toast.error', { msg: errorMessage(err) }), 'error')
    }
  }

  const onTitle = (v: string): void => {
    setMeeting((m) => (m ? { ...m, title: v } : m))
    if (titleTimer.current !== undefined) window.clearTimeout(titleTimer.current)
    titleTimer.current = window.setTimeout(() => void api.updateMeeting(id, { title: v }).catch(() => {}), 700)
  }

  const exportAs = async (format: ExportRequest['format']): Promise<void> => {
    setMenuOpen(false)
    try {
      const res = await api.exportMeeting({ meetingId: id, format })
      if (res) toast(t('meeting.exported', { path: res.path }), 'success', { label: t('meeting.openFolder'), onClick: () => void api.showInFolder(res.path) })
    } catch (err) {
      toast(`${t('meeting.exportFailed')}: ${errorMessage(err)}`, 'error')
    }
  }

  if (meeting === undefined) {
    return (
      <div className="page">
        <div className="muted row gap-sm">
          <Spinner size={14} /> {t('common.loading')}
        </div>
      </div>
    )
  }
  if (meeting === null) {
    return (
      <div className="page">
        <EmptyState icon="warning" title={t('meeting.notFound')} action={<Button onClick={() => navigate({ name: 'home' })}>{t('common.back')}</Button>} />
      </div>
    )
  }

  const model = LOCAL_MODELS.find((m) => m.id === meeting.modelId)
  const needsPunct = meeting.engine === 'local' && model && !model.punctuated && !meeting.punctuated && meeting.segments.length > 0

  return (
    <div className="page">
      <div className="row gap-sm" style={{ marginBottom: 8 }}>
        <Button size="sm" variant="ghost" onClick={() => navigate({ name: 'home' })}>
          ← {t('nav.meetings')}
        </Button>
      </div>
      <header className="meeting-header">
        <input className="meeting-title" value={meeting.title} onChange={(e) => onTitle(e.target.value)} />
        <div className="meeting-meta">
          <StatusBadge status={meeting.status} />
          <span>{formatDateTime(meeting.createdAt, locale)}</span>
          <span>· {formatDuration(meeting.durationSec, lang)}</span>
          <AppChip app={meeting.app} />
          <LanguageChip language={meeting.language} />
          <span className="chip">{t(`engine.${meeting.engine}` as 'engine.local')}</span>
          {meeting.participants.length > 0 && (
            <span>
              · {t('meeting.participants')}: {meeting.participants.join(', ')}
            </span>
          )}
          <span className="grow" />
          <div className="menu">
            <Button size="sm" icon="download" onClick={() => setMenuOpen((o) => !o)}>
              {t('meeting.export')}
            </Button>
            {menuOpen && (
              <div className="menu-list" onMouseLeave={() => setMenuOpen(false)}>
                {(['md', 'docx', 'pdf', 'srt', 'txt', 'json'] as const).map((f) => (
                  <button key={f} type="button" className="menu-item" onClick={() => void exportAs(f)}>
                    <Icon name="download" size={14} /> {t(`meeting.export.${f}`)}
                  </button>
                ))}
                <div className="menu-sep" />
                {meeting.audioFile && (
                  <button type="button" className="menu-item" onClick={() => { setMenuOpen(false); setConfirmDeleteAudio(true) }}>
                    <Icon name="trash" size={14} /> {t('meeting.deleteAudio')}
                  </button>
                )}
                <button type="button" className="menu-item danger" onClick={() => { setMenuOpen(false); setConfirmDelete(true) }}>
                  <Icon name="trash" size={14} /> {t('meeting.delete')}
                </button>
              </div>
            )}
          </div>
        </div>
        <TagsEditor tags={meeting.tags} onChange={(tags) => void update({ tags })} />
      </header>

      {meeting.status === 'processing' && <Alert tone="info">{t('meeting.processing')}</Alert>}
      {meeting.status === 'error' && <Alert tone="danger">{t('meeting.errorState', { msg: meeting.error ?? '' })}</Alert>}
      {meeting.status === 'interrupted' && (
        <Alert
          tone="warning"
          action={
            meeting.audioFile ? (
              <Button icon="refresh" onClick={() => setRetrans(true)}>
                {t('meeting.finishTranscript')}
              </Button>
            ) : undefined
          }
        >
          {t(meeting.audioFile ? 'meeting.interrupted' : 'meeting.interruptedNoAudio')}
        </Alert>
      )}
      {progress && (
        <div style={{ marginBottom: 14 }}>
          <div className="small muted" style={{ marginBottom: 4 }}>
            {progressLabel(progress.stage, t)}
          </div>
          <ProgressBar value={progress.progress} indeterminate={progress.progress === undefined} />
        </div>
      )}

      {audioUrl ? (
        <div className="audio-player">
          <Icon name="play" size={16} />
          <audio ref={audioRef} src={audioUrl} controls preload="metadata" onTimeUpdate={onTimeUpdate} />
        </div>
      ) : (
        meeting.audioFile && <div className="muted small" style={{ marginBottom: 12 }}>{t('meeting.audioUnavailable')}</div>
      )}

      <Tabs<MeetingTab>
        value={tab}
        onChange={setTab}
        tabs={[
          { id: 'summary', label: t('meeting.tab.summary'), badge: meeting.summary ? <Icon name="sparkles" size={12} /> : undefined },
          { id: 'transcript', label: t('meeting.tab.transcript'), badge: meeting.segments.length || undefined },
          { id: 'notes', label: t('meeting.tab.notes') },
          { id: 'highlights', label: t('meeting.tab.highlights'), badge: meeting.highlights.length || undefined },
          { id: 'chat', label: t('meeting.tab.chat') }
        ]}
      />

      {tab === 'summary' && <SummaryTab meeting={meeting} onUpdated={load} busy={!!progress} />}
      {tab === 'transcript' && (
        <TranscriptTab
          meeting={meeting}
          activeId={activeSeg}
          onSeek={audioUrl ? seek : undefined}
          onRename={(key, label) => setRename({ key, label })}
          onRetranscribe={() => setRetrans(true)}
          onSpeakers={meeting.audioFile ? () => setSpeakersDialog(true) : undefined}
          needsPunct={!!needsPunct}
          busy={!!progress}
          onPunctuated={load}
          pending={pending}
        />
      )}
      {tab === 'notes' && (
        <Card>
          <TextArea rows={16} value={meeting.notes} placeholder={t('notes.placeholder')} onChange={(e) => onNotesChange(e.target.value)} />
          <div className="field-hint">{t('notes.hint')}</div>
        </Card>
      )}
      {tab === 'highlights' && (
        <Card>
          {meeting.highlights.length === 0 ? (
            <EmptyState icon="bookmark" title={t('highlights.empty')} hint={t('highlights.emptyHint')} />
          ) : (
            <div className="stack">
              {meeting.highlights.map((h) => (
                <div key={h.id} className="highlight-item">
                  <Button size="sm" variant="ghost" icon="play" disabled={!audioUrl} onClick={() => seek(h.time)}>
                    {mmss(h.time)}
                  </Button>
                  <input
                    className="input"
                    defaultValue={h.note}
                    placeholder={t('highlights.notePlaceholder')}
                    onBlur={(e) => void update({ highlights: meeting.highlights.map((x) => (x.id === h.id ? { ...x, note: e.target.value } : x)) })}
                  />
                  <Button size="sm" variant="ghost" icon="trash" onClick={() => void update({ highlights: meeting.highlights.filter((x) => x.id !== h.id) })} />
                </div>
              ))}
            </div>
          )}
        </Card>
      )}
      {tab === 'chat' && <ChatTab meeting={meeting} llmConfigured={settings.llm.provider !== 'none'} onChanged={load} />}

      {confirmDelete && (
        <ConfirmDialog
          title={t('meeting.delete')}
          message={t('meeting.deleteConfirm', { title: meeting.title })}
          confirmLabel={t('common.delete')}
          danger
          onCancel={() => setConfirmDelete(false)}
          onConfirm={async () => {
            await api.deleteMeeting(id)
            navigate({ name: 'home' })
          }}
        />
      )}
      {confirmDeleteAudio && (
        <ConfirmDialog
          title={t('meeting.deleteAudio')}
          message={t('meeting.deleteAudioConfirm')}
          confirmLabel={t('common.delete')}
          danger
          onCancel={() => setConfirmDeleteAudio(false)}
          onConfirm={async () => {
            await api.deleteMeetingAudio(id)
            setConfirmDeleteAudio(false)
            toast(t('meeting.audioDeleted'), 'success')
            await load()
          }}
        />
      )}
      {rename && (
        <PromptDialog
          title={t('transcript.renameSpeaker')}
          hint={t('transcript.renameSpeakerHint', { name: rename.label })}
          initial={rename.label}
          onCancel={() => setRename(null)}
          onSubmit={async (v) => {
            if (v.trim()) {
              const m = await api.renameSpeaker(id, rename.key, v.trim())
              setMeeting(m)
            }
            setRename(null)
          }}
        />
      )}
            {speakersDialog && (
        <PromptDialog
          title={t('transcript.speakersTitle')}
          hint={t('transcript.speakersHint')}
          initial=""
          placeholder="2"
          confirmLabel={t('transcript.speakersStart')}
          onCancel={() => setSpeakersDialog(false)}
          onSubmit={async (value) => {
            const n = parseInt(value, 10)
            setSpeakersDialog(false)
            toast(t('transcript.speakersStarted'), 'info')
            try {
              await api.rediarize(id, Number.isFinite(n) && n > 0 ? n : undefined)
              await load()
            } catch (err) {
              toast(t('toast.error', { msg: errorMessage(err) }), 'error')
            }
          }}
        />
      )}
      {retrans && (
        <RetranscribeDialog
          meeting={meeting}
          onCancel={() => setRetrans(false)}
          onStart={async (engine, language) => {
            setRetrans(false)
            toast(t('transcript.retranscribeStarted'), 'info')
            try {
              await api.retranscribe(id, { engine, language })
            } catch (err) {
              toast(t('toast.error', { msg: errorMessage(err) }), 'error')
            }
          }}
        />
      )}
    </div>
  )

  function onNotesChange(v: string): void {
    setMeeting((m) => (m ? { ...m, notes: v } : m))
    if (titleTimer.current !== undefined) window.clearTimeout(titleTimer.current)
    titleTimer.current = window.setTimeout(() => void api.updateMeeting(id, { notes: v }).catch(() => {}), 800)
  }
}

function progressLabel(stage: string, t: ReturnType<typeof useI18n>['t']): string {
  if (stage === 'punctuate') return t('summary.progress.punctuate')
  if (stage === 'summary') return t('summary.progress.summarize')
  if (stage === 'transcribe') return t('summary.progress.transcribe')
  if (stage === 'diarize') return t('summary.progress.diarize')
  return stage || t('summary.progress.generic')
}

function SummaryTab({ meeting, onUpdated, busy }: { meeting: Meeting; onUpdated: () => Promise<void>; busy: boolean }): ReactNode {
  const { t, lang, locale } = useI18n()
  const { settings } = useSettings()
  const { toast } = useToast()
  const [templates, setTemplates] = useState<SummaryTemplate[]>([])
  const [templateId, setTemplateId] = useState(meeting.summary?.templateId ?? settings.llm.summaryTemplateId)
  const [generating, setGenerating] = useState(false)

  useEffect(() => {
    api.listTemplates().then(setTemplates).catch(() => {})
  }, [])

  const generate = async (): Promise<void> => {
    setGenerating(true)
    try {
      await api.summarize(meeting.id, templateId)
      toast(t('toast.summaryReady'), 'success')
      await onUpdated()
    } catch (err) {
      toast(t('summary.failed', { msg: errorMessage(err) }), 'error')
    } finally {
      setGenerating(false)
    }
  }

  const s = meeting.summary
  const toggleAction = (idx: number): void => {
    if (!s?.actionItems) return
    const items = s.actionItems.map((a, i) => (i === idx ? { ...a, done: !a.done } : a))
    void api.updateMeeting(meeting.id, { summary: { ...s, actionItems: items } }).then(() => onUpdated())
  }

  return (
    <div className="detail-layout">
      <Card
        title={t('meeting.tab.summary')}
        actions={
          <>
            <Select value={templateId} onChange={(e) => setTemplateId(e.target.value)} style={{ width: 240 }}>
              {templates.map((tpl) => (
                <option key={tpl.id} value={tpl.id}>
                  {tpl.name[lang]}
                </option>
              ))}
            </Select>
            <Button variant="primary" icon="sparkles" loading={generating || busy} disabled={settings.llm.provider === 'none' || meeting.segments.length === 0} onClick={generate}>
              {generating ? t('summary.generating') : s ? t('summary.regenerate') : t('summary.generate')}
            </Button>
            {s && (
              <Button icon="copy" onClick={() => { void api.copyToClipboard(s.markdown); toast(t('toast.copied'), 'success') }}>
                {t('summary.copy')}
              </Button>
            )}
          </>
        }
      >
        {settings.llm.provider === 'none' && <Alert tone="warning">{t('summary.needsLlm')}</Alert>}
        {!s ? (
          <EmptyState icon="sparkles" title={t('summary.none')} hint={t('summary.noneHint')} />
        ) : (
          <>
            <Markdown className="summary-md" text={s.markdown} />
            {s.actionItems && s.actionItems.length > 0 && (
              <div style={{ marginTop: 16 }}>
                <h3 style={{ marginBottom: 8 }}>{t('summary.actionItems')}</h3>
                <div className="action-list">
                  {s.actionItems.map((a, i) => (
                    <label key={i} className="action-item">
                      <input type="checkbox" checked={!!a.done} onChange={() => toggleAction(i)} />
                      <div>
                        <div style={{ textDecoration: a.done ? 'line-through' : undefined }}>{a.text}</div>
                        <div className="action-meta">
                          {a.owner && <span>{t('summary.owner')}: {a.owner}</span>}
                          {a.due && <span>{t('summary.due')}: {a.due}</span>}
                        </div>
                      </div>
                    </label>
                  ))}
                </div>
              </div>
            )}
            <div className="muted small" style={{ marginTop: 14 }}>
              {t('summary.generatedBy', { date: formatDateTime(s.generatedAt, locale), model: s.model })}
            </div>
          </>
        )}
      </Card>
    </div>
  )
}

function TranscriptTab({ meeting, activeId, onSeek, onRename, onRetranscribe, onSpeakers, needsPunct, busy, onPunctuated, pending }: { meeting: Meeting; activeId?: string; onSeek?: (t: number) => void; onRename: (key: string, label: string) => void; onRetranscribe: () => void; onSpeakers?: () => void; needsPunct: boolean; busy: boolean; onPunctuated: () => Promise<void>; pending?: PendingSegment[] }): ReactNode {
  const { t } = useI18n()
  const { settings } = useSettings()
  const { toast } = useToast()
  const [query, setQuery] = useState('')
  const [punctuating, setPunctuating] = useState(false)

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return q ? meeting.segments.filter((s) => s.text.toLowerCase().includes(q)) : meeting.segments
  }, [meeting.segments, query])

  const punctuate = async (): Promise<void> => {
    setPunctuating(true)
    try {
      await api.punctuate(meeting.id)
      toast(t('toast.punctuated'), 'success')
      await onPunctuated()
    } catch (err) {
      toast(t('toast.error', { msg: errorMessage(err) }), 'error')
    } finally {
      setPunctuating(false)
    }
  }

  const copyAll = (): void => {
    const text = meeting.segments.map((s) => `[${mmss(s.start)}] ${meeting.speakerNames[s.speaker] ?? s.speaker}: ${s.text}`).join('\n')
    void api.copyToClipboard(text)
    toast(t('toast.copied'), 'success')
  }

  return (
    <Card
      actions={
        <>
          <div className="search-box" style={{ minWidth: 220 }}>
            <Icon name="search" size={14} />
            <input value={query} placeholder={t('transcript.search')} onChange={(e) => setQuery(e.target.value)} />
          </div>
          {needsPunct && settings.llm.provider !== 'none' && (
            <Button icon="sparkles" loading={punctuating || busy} onClick={punctuate} title={t('transcript.punctuateHint')}>
              {punctuating ? t('transcript.punctuating') : t('transcript.punctuate')}
            </Button>
          )}
          <Button icon="copy" onClick={copyAll} disabled={meeting.segments.length === 0}>
            {t('transcript.copyAll')}
          </Button>
          {onSpeakers && meeting.segments.some((seg) => seg.channel === 'system') && (
            <Button icon="tag" onClick={onSpeakers} disabled={busy} title={t('transcript.speakersHint')}>
              {t('transcript.speakers')}
            </Button>
          )}
          <Button icon="refresh" onClick={onRetranscribe} disabled={!meeting.audioFile || busy}>
            {t('transcript.retranscribe')}
          </Button>
        </>
      }
    >
      {query && <div className="muted small" style={{ marginBottom: 8 }}>{t('transcript.matches', { n: filtered.length })}</div>}
      <div style={{ height: 560, display: 'flex', flexDirection: 'column' }}>
        <TranscriptList
          segments={filtered}
          speakerNames={meeting.speakerNames}
          activeId={activeId}
          onSeek={onSeek}
          onSpeakerClick={onRename}
          onEdit={async (segmentId, text) => {
            await api.updateSegment(meeting.id, segmentId, { text })
            await onPunctuated()
          }}
          query={query}
          pending={query ? [] : pending}
          emptyText={
            <div>
              <div>{t('transcript.empty')}</div>
              <div className="small">{t('transcript.emptyHint')}</div>
            </div>
          }
        />
      </div>
    </Card>
  )
}

function ChatTab({ meeting, llmConfigured, onChanged }: { meeting: Meeting; llmConfigured: boolean; onChanged: () => Promise<void> }): ReactNode {
  const { t } = useI18n()
  const [input, setInput] = useState('')
  const [pending, setPending] = useState<ChatMessage[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const box = useRef<HTMLDivElement>(null)
  const messages = [...meeting.chat, ...pending]

  useEffect(() => {
    if (box.current) box.current.scrollTop = box.current.scrollHeight
  }, [messages.length, busy])

  const send = async (): Promise<void> => {
    const q = input.trim()
    if (!q || busy) return
    setInput('')
    setError(null)
    setPending([{ role: 'user', content: q, at: new Date().toISOString() }])
    setBusy(true)
    try {
      await api.chat(meeting.id, q)
      await onChanged()
      setPending([])
    } catch (err) {
      setError(t('chat.failed', { msg: errorMessage(err) }))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card>
      {!llmConfigured && <Alert tone="warning">{t('summary.needsLlm')}</Alert>}
      <div className="chat">
        <div className="chat-messages" ref={box}>
          {messages.length === 0 && <div className="muted">{t('chat.empty')}</div>}
          {messages.map((m, i) => (
            <div key={i} className={`chat-msg chat-${m.role}`}>
              {m.role === 'assistant' ? <Markdown text={m.content} /> : m.content}
            </div>
          ))}
          {busy && (
            <div className="chat-msg chat-assistant muted row gap-sm">
              <Spinner size={12} /> {t('chat.thinking')}
            </div>
          )}
          {error && <div className="text-danger small">{error}</div>}
        </div>
        <div className="chat-input">
          <input
            className="input"
            value={input}
            placeholder={t('chat.placeholder')}
            disabled={!llmConfigured}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void send()
            }}
          />
          <Button variant="primary" icon="chat" loading={busy} disabled={!llmConfigured || !input.trim()} onClick={send}>
            {t('chat.send')}
          </Button>
        </div>
      </div>
    </Card>
  )
}

function RetranscribeDialog({ meeting, onCancel, onStart }: { meeting: Meeting; onCancel: () => void; onStart: (engine: string, language: string) => Promise<void> }): ReactNode {
  const { t } = useI18n()
  const { settings } = useSettings()
  const [engine, setEngine] = useState(settings.engine)
  const [language, setLanguage] = useState(meeting.language)
  return (
    <Modal
      title={t('transcript.retranscribeTitle')}
      onClose={onCancel}
      footer={
        <>
          <Button onClick={onCancel}>{t('common.cancel')}</Button>
          <Button variant="primary" onClick={() => void onStart(engine, language)}>
            {t('transcript.retranscribeStart')}
          </Button>
        </>
      }
    >
      <p className="muted">{t('transcript.retranscribeHint')}</p>
      <div className="field">
        <div className="field-label">{t('settings.engine.title')}</div>
        <Select value={engine} onChange={(e) => setEngine(e.target.value as typeof engine)}>
          {(['local', 'azure', 'elevenlabs', 'openai'] as const).map((e) => (
            <option key={e} value={e}>
              {t(`engine.${e}`)}
            </option>
          ))}
        </Select>
      </div>
      <div className="field">
        <div className="field-label">{t('common.language')}</div>
        <Select value={language} onChange={(e) => setLanguage(e.target.value)}>
          <option value="is">{t('lang.is')}</option>
          <option value="en">{t('lang.en')}</option>
          <option value="auto">{t('lang.auto')}</option>
        </Select>
      </div>
    </Modal>
  )
}

export type { Segment }
