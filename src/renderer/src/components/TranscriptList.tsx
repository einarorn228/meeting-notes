/**
 * Transcript rows shared by the live recording view and the meeting detail view.
 * Speaker chips: channel 'mic' => "Ég", channel 'system' => "Aðrir" unless renamed via speakerNames.
 */
import { memo, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { ChannelId, PendingSegment, Segment } from '@shared/types'
import { mmss } from '@/utils/format'
import { useI18n, type I18n } from '@/i18n'
import { Icon } from './Icons'
import { Button } from './ui'
import type { Partials } from '@/hooks/useRecordingController'

export function speakerLabel(speaker: string | undefined, channel: ChannelId, speakerNames: Record<string, string> | undefined, t: I18n['t']): string {
  const key = speaker || channel
  const renamed = speakerNames?.[key]
  if (renamed) return renamed
  if (key === 'mic' || key === 'me' || key === 'Ég' || key === 'Me') return t('common.me')
  if (key === 'system' || key === 'others' || key === 'Aðrir' || key === 'Others') return t('common.others')
  // A diarization key that never got a name of its own; "spk1" is storage, not something to show anyone.
  const spk = /^spk(\d+)$/.exec(key)
  if (spk) return t('speaker.participant', { n: spk[1] })
  return key
}

export function speakerKey(seg: Segment): string {
  return seg.speaker || seg.channel
}

function Highlighted({ text, query }: { text: string; query?: string }): ReactNode {
  if (!query) return text
  const q = query.trim().toLowerCase()
  if (!q) return text
  const parts: ReactNode[] = []
  let idx = 0
  const lower = text.toLowerCase()
  let found = lower.indexOf(q, idx)
  let k = 0
  while (found >= 0) {
    if (found > idx) parts.push(text.slice(idx, found))
    parts.push(<mark key={k++}>{text.slice(found, found + q.length)}</mark>)
    idx = found + q.length
    found = lower.indexOf(q, idx)
  }
  if (idx < text.length) parts.push(text.slice(idx))
  return parts
}

export interface TranscriptListProps {
  segments: Segment[]
  speakerNames?: Record<string, string>
  activeId?: string
  onSeek?: (time: number) => void
  onSpeakerClick?: (speakerKey: string, label: string) => void
  onEdit?: (segmentId: string, text: string) => Promise<void> | void
  query?: string
  partials?: Partials
  /** Live mode: speech that has been captured and queued but has no text yet. */
  pending?: PendingSegment[]
  /** Live mode: keep scrolled to bottom unless the user scrolled up. */
  live?: boolean
  emptyText?: ReactNode
}

function TranscriptListInner({ segments, speakerNames, activeId, onSeek, onSpeakerClick, onEdit, query, partials, pending, live, emptyText }: TranscriptListProps): ReactNode {
  const { t } = useI18n()
  const box = useRef<HTMLDivElement>(null)
  const [stuck, setStuck] = useState(true)
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null)
  const [saving, setSaving] = useState(false)

  const partialList = useMemo(() => {
    if (!partials) return []
    return (Object.keys(partials) as ChannelId[]).filter((c) => partials[c]?.text).map((c) => ({ channel: c, ...partials[c]! }))
  }, [partials])

  // Oldest first, so the queue reads top to bottom like the rest of the transcript.
  const pendingList = useMemo(() => [...(pending ?? [])].sort((a, b) => a.start - b.start), [pending])

  useEffect(() => {
    if (!live || !stuck || !box.current) return
    box.current.scrollTop = box.current.scrollHeight
  }, [segments, partialList, pendingList, live, stuck])

  useEffect(() => {
    if (!activeId || live || !box.current) return
    const el = box.current.querySelector<HTMLElement>(`[data-seg="${CSS.escape(activeId)}"]`)
    if (!el) return
    const r = el.getBoundingClientRect()
    const br = box.current.getBoundingClientRect()
    if (r.top < br.top || r.bottom > br.bottom) el.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }, [activeId, live])

  const onScroll = (): void => {
    const el = box.current
    if (!el || !live) return
    setStuck(el.scrollHeight - el.scrollTop - el.clientHeight < 48)
  }

  const commitEdit = async (): Promise<void> => {
    if (!editing || !onEdit) return
    setSaving(true)
    try {
      await onEdit(editing.id, editing.text)
      setEditing(null)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="transcript-wrap">
      <div className="transcript" ref={box} onScroll={onScroll}>
        {segments.length === 0 && partialList.length === 0 && pendingList.length === 0 && <div className="transcript-empty">{emptyText}</div>}
        {segments.map((seg) => {
          const key = speakerKey(seg)
          const label = speakerLabel(seg.speaker, seg.channel, speakerNames, t)
          const isEditing = editing?.id === seg.id
          return (
            <div key={seg.id} data-seg={seg.id} className={`seg seg-${seg.channel} ${activeId === seg.id ? 'active' : ''}`}>
              <button type="button" className="seg-time" onClick={() => onSeek?.(seg.start)} title={onSeek ? mmss(seg.start) : undefined} disabled={!onSeek}>
                {mmss(seg.start)}
              </button>
              <button
                type="button"
                className={`chip chip-speaker ${onSpeakerClick ? 'clickable' : ''}`}
                onClick={() => onSpeakerClick?.(key, label)}
                disabled={!onSpeakerClick}
                title={onSpeakerClick ? t('transcript.renameSpeaker') : undefined}
              >
                {label}
              </button>
              <div className="seg-text">
                {isEditing ? (
                  <div className="seg-edit">
                    <textarea
                      className="input textarea"
                      autoFocus
                      rows={3}
                      value={editing.text}
                      onChange={(e) => setEditing({ id: seg.id, text: e.target.value })}
                      onKeyDown={(e) => {
                        if (e.key === 'Escape') setEditing(null)
                        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void commitEdit()
                      }}
                    />
                    <div className="row gap-sm">
                      <Button size="sm" variant="primary" loading={saving} onClick={commitEdit}>
                        {t('common.save')}
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setEditing(null)}>
                        {t('common.cancel')}
                      </Button>
                    </div>
                  </div>
                ) : (
                  <>
                    <span onDoubleClick={() => onEdit && setEditing({ id: seg.id, text: seg.text })}>
                      <Highlighted text={seg.text} query={query} />
                    </span>
                    {onEdit && (
                      <button type="button" className="seg-edit-btn" onClick={() => setEditing({ id: seg.id, text: seg.text })} title={t('transcript.editSegment')}>
                        <Icon name="edit" size={13} />
                      </button>
                    )}
                  </>
                )}
              </div>
            </div>
          )
        })}
        {partialList.map((p) => (
          <div key={`partial-${p.channel}`} className={`seg seg-${p.channel} partial`}>
            <span className="seg-time">{mmss(p.start)}</span>
            <span className="chip chip-speaker">{speakerLabel(undefined, p.channel, speakerNames, t)}</span>
            <div className="seg-text">{p.text}</div>
          </div>
        ))}
        {/* Heard but not yet written out. The wait is seconds, sometimes longer than the speech itself, so the
            line appears the moment someone stops talking and fills in with the real text. */}
        {pendingList.map((p, i) => (
          <div key={`pending-${p.id}`} className={`seg seg-${p.channel} seg-pending ${i === 0 ? '' : 'waiting'}`}>
            <span className="seg-time">{mmss(p.start)}</span>
            <span className="chip chip-speaker">{speakerLabel(undefined, p.channel, speakerNames, t)}</span>
            <div className="seg-text">
              <span className="writing" aria-hidden="true">
                <i />
                <i />
                <i />
              </span>
              <span className="muted small">
                {i === 0 ? t('transcript.writing') : t('transcript.queued')}
              </span>
            </div>
          </div>
        ))}
      </div>
      {live && !stuck && (
        <button
          type="button"
          className="scroll-bottom"
          onClick={() => {
            setStuck(true)
            if (box.current) box.current.scrollTop = box.current.scrollHeight
          }}
        >
          <Icon name="arrowDown" size={14} /> {t('rec.scrollToBottom')}
        </button>
      )}
    </div>
  )
}

/**
 * The recording view broadcasts its state once a second (clock, levels, transcript lag), and by the end of an
 * hour-long meeting the list holds a thousand rows. Re-rendering all of them on every tick competes with the
 * transcription for the same CPU, so the list only re-renders when the transcript itself changes.
 */
export const TranscriptList = memo(TranscriptListInner)
