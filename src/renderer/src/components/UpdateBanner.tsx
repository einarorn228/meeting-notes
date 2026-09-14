import { useEffect, useState, type ReactNode } from 'react'
import type { UpdateStatus } from '@shared/types'
import { api } from '@/api'
import { useI18n } from '../i18n'
import { useToast } from '../hooks/useToast'
import { Button, ProgressBar } from './ui'

/** Subscribes to the main process's updater and surfaces it; renders nothing while there is no news. */
export function useUpdateStatus(): UpdateStatus | null {
  const [status, setStatus] = useState<UpdateStatus | null>(null)
  useEffect(() => {
    api.getUpdateStatus().then(setStatus).catch(() => {})
    return api.on('update:status', setStatus)
  }, [])
  return status
}

export function UpdateBanner(): ReactNode {
  const status = useUpdateStatus()
  const { t } = useI18n()
  const { toast } = useToast()
  const [installing, setInstalling] = useState(false)

  if (!status) return null
  const { state, version } = status

  if (state === 'ready') {
    const install = async (): Promise<void> => {
      setInstalling(true)
      try {
        await api.installUpdate()
      } catch (e) {
        setInstalling(false)
        toast(e instanceof Error ? e.message : String(e), 'error')
      }
    }
    return (
      <div className="update-banner">
        <span>{t('update.ready', { version: version ?? '' })}</span>
        <Button size="sm" variant="primary" loading={installing} onClick={() => void install()}>
          {t('update.restart')}
        </Button>
      </div>
    )
  }

  // macOS and .deb cannot install for themselves, so send the user to the download page instead.
  if (state === 'available' && !status.canSelfUpdate) {
    return (
      <div className="update-banner">
        <span>{t('update.available', { version: version ?? '' })}</span>
        <Button size="sm" variant="primary" onClick={() => void api.openExternal(status.releasesUrl)}>
          {t('update.download')}
        </Button>
      </div>
    )
  }

  if (state === 'downloading') {
    return (
      <div className="update-banner update-banner-quiet">
        <span>{t('update.downloading', { version: version ?? '' })}</span>
        <div className="update-banner-progress">
          <ProgressBar value={status.progress} indeterminate={status.progress === undefined} />
        </div>
      </div>
    )
  }

  return null
}
