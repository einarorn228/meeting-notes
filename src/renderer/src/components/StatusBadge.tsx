import type { ReactNode } from 'react'
import type { MeetingStatus } from '@shared/types'
import { Badge } from './ui'
import { useI18n } from '@/i18n'

export function StatusBadge({ status }: { status: MeetingStatus }): ReactNode {
  const { t } = useI18n()
  const tone = status === 'done' ? 'success' : status === 'error' ? 'danger' : status === 'recording' ? 'danger' : 'info'
  return (
    <Badge tone={tone} className={status === 'recording' ? 'pulse' : undefined}>
      {t(`status.${status}`)}
    </Badge>
  )
}

export function AppChip({ app }: { app?: string }): ReactNode {
  const { tm } = useI18n()
  if (!app) return null
  return <span className="chip chip-app">{tm(`app.${app}`, app)}</span>
}

export function LanguageChip({ language }: { language: string }): ReactNode {
  const { tm } = useI18n()
  return <span className="chip">{tm(`lang.${language}`, language.toUpperCase())}</span>
}
