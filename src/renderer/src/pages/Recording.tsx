import { useEffect, useRef, useState, type ReactNode } from 'react'
import { api } from '@/api'
import { useI18n } from '@/i18n'
import { useRouter } from '@/router'
import { useRecording } from '@/hooks/useRecordingController'
import { useSettings } from '@/hooks/useSettings'
import { useToast } from '@/hooks/useToast'
import { Alert, Badge, Button } from '@/components/ui'
import { LevelMeter } from '@/components/LevelMeter'
import { TranscriptList } from '@/components/TranscriptList'
import { LanguageChip } from '@/components/StatusBadge'
import { PromptDialog } from '@/components/Modal'
import { mmss } from '@/utils/format'

export function RecordingPage(): ReactNode {
  const { t } = useI18n()
  const { navigate } = useRouter()
  const rec = useRecording()
  const { settings } = useSettings()
  const { toast } = useToast()
  const [notes, setNotes] = useState('')
  const [askNote, setAskNote] = useState(false)
  const notesTimer = useRef<number | undefined>(undefined)
  const meetingId = rec.state.meetingId

  // Load existing notes for the running meeting (e.g. after navigating away and back).
  useEffect(() => {
    if (!meetingId) return
    api
      .getMeeting(meetingId)
      .then((m) => m && setNotes(m.notes ?? ''))
      .catch(() => {})
  }, [meetingId])

  const onNotes = (v: string): void => {
    setNotes(v)
    if (!meetingId) return
    if (notesTimer.current !== undefined) window.clearTimeout(notesTimer.current)
    notesTimer.current = window.setTimeout(() => void api.updateMeeting(meetingId, { notes: v }).catch(() => {}), 800)
  }

  useEffect(
    () => () => {
      if (notesTimer.current !== undefined) window.clearTimeout(notesTimer.current)
    },
    []
  )

  if (!rec.state.active) {
    return (
      <div className="page">
        <div className="empty">
          <div className="empty-title">{t('rec.noActive')}</div>
          <div className="empty-action row gap-sm" style={{ justifyContent: 'center' }}>
            <Button variant="primary" icon="record" onClick={() => void rec.start()} loading={rec.busy === 'starting'}>
              {t('nav.startRecording')}
            </Button>
            <Button onClick={() => navigate({ name: 'home' })}>{t('rec.goHome')}</Button>
          </div>
        </div>
      </div>
    )
  }

  const silentSystem = rec.state.silentChannels.includes('system')
  const silentMic = rec.state.silentChannels.includes('mic')
  // Transcription on a CPU always trails speech by a few seconds; the number only earns screen space once it
  // is bigger than that, and only counts as a problem when it keeps climbing.
  const lagSec = Math.round(rec.state.transcriptLagSec)
  const lag =
    lagSec < 20
      ? null
      : {
          behind: lagSec >= 120,
          text: t(lagSec >= 120 ? 'rec.lagBehind' : 'rec.lag', {
            v: lagSec >= 90 ? t('rec.lagMin', { n: String(Math.round(lagSec / 60)) }) : t('rec.lagSec', { n: String(lagSec) })
          })
        }
  const sidecarBusy = rec.sidecar && ['installing', 'loading-model', 'downloading-model'].includes(rec.sidecar.state)

  return (
    <div className="rec-page">
      <header className="rec-header">
        <input className="rec-title" value={rec.title} placeholder={t('rec.titlePlaceholder')} onChange={(e) => rec.setTitle(e.target.value)} />
        <div className="rec-status">
          <Badge tone={rec.state.paused ? 'warning' : 'danger'} className={rec.state.paused ? '' : 'pulse'}>
            {rec.state.paused ? t('rec.paused') : t('rec.rec')}
          </Badge>
          <span>{mmss(rec.elapsedSec)}</span>
        </div>
        <LanguageChip language={settings.language} />
        <LevelMeter level={rec.levels.mic} icon="mic" label={t('rec.mic')} warn={silentMic} compact />
        <LevelMeter level={rec.levels.system} icon="speaker" label={t('rec.system')} warn={silentSystem} compact />
      </header>

      {(silentSystem || rec.systemUnavailable) && settings.audio.captureSystemAudio && (
        <div style={{ padding: '10px 22px 0' }}>
          <Alert tone="warning">
            <strong>{rec.systemUnavailable ? t('rec.systemUnavailable') : t('rec.noSystemAudio')}</strong>
            <div className="small">{rec.systemUnavailable ? t(`rec.systemUnavailable.${rec.systemUnavailable === 'permission-denied' ? 'permission-denied' : 'no-audio-track'}`) : t('rec.noSystemAudioHint')}</div>
          </Alert>
        </div>
      )}
      {rec.captureLost && (
        <div style={{ padding: '10px 22px 0' }}>
          <Alert tone="danger" action={<Button size="sm" variant="danger" onClick={() => void rec.stop()}>{t('rec.stop')}</Button>}>
            {t('rec.lostCapture')}
          </Alert>
        </div>
      )}
      {rec.error && (
        <div style={{ padding: '10px 22px 0' }}>
          <Alert tone="danger" action={<Button size="sm" variant="ghost" icon="x" onClick={rec.clearError} />}>
            <strong>{t('rec.error')}</strong>
            <div className="small">{rec.error}</div>
          </Alert>
        </div>
      )}

      <div className="rec-body">
        <section className="rec-pane">
          <div className="rec-pane-header">
            <span>{t('rec.notes')}</span>
            <Button
              size="sm"
              variant="ghost"
              icon="copy"
              onClick={() => {
                void api.copyToClipboard(settings.consentNotice)
                toast(t('rec.consentCopied'), 'success')
              }}
            >
              {t('rec.copyConsent')}
            </Button>
          </div>
          <textarea className="input textarea rec-notes" value={notes} placeholder={t('rec.notesPlaceholder')} onChange={(e) => onNotes(e.target.value)} />
        </section>
        <section className="rec-pane">
          <div className="rec-pane-header">
            <span>{t('rec.liveTranscript')}</span>
            {lag && <span className={`lag-chip${lag.behind ? ' behind' : ''}`}>{lag.text}</span>}
            <span className="engine-status">{sidecarBusy ? rec.sidecar?.message : rec.state.engineStatus || t('rec.engineStarting')}</span>
          </div>
          <TranscriptList segments={rec.segments} partials={rec.partials} pending={rec.pending} live emptyText={t('rec.waiting')} />
        </section>
      </div>

      <footer className="rec-footer">
        <Button icon={rec.state.paused ? 'play' : 'pause'} onClick={() => void rec.togglePause()}>
          {rec.state.paused ? t('rec.resume') : t('rec.pause')}
        </Button>
        <Button icon="bookmark" onClick={() => setAskNote(true)} title={t('rec.hotkeyHint', { key: settings.hotkeys.markHighlight })}>
          {t('rec.mark')}
        </Button>
        <span className="grow" />
        <Button variant="record" size="lg" icon="stop" loading={rec.busy === 'stopping'} onClick={() => void rec.stop()}>
          {rec.busy === 'stopping' ? t('rec.stopping') : t('rec.stop')}
        </Button>
      </footer>

      {askNote && (
        <PromptDialog
          title={t('rec.mark')}
          placeholder={t('rec.highlightNote')}
          confirmLabel={t('rec.mark')}
          onCancel={() => setAskNote(false)}
          onSubmit={async (v) => {
            await rec.markHighlight(v)
            setAskNote(false)
          }}
        />
      )}
    </div>
  )
}
