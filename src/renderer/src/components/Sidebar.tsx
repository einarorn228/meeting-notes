import type { ReactNode } from 'react'
import { useI18n } from '@/i18n'
import { useRouter, type Route } from '@/router'
import { useRecording } from '@/hooks/useRecordingController'
import { useSettings } from '@/hooks/useSettings'
import { Icon, type IconName } from './Icons'
import { mmss } from '@/utils/format'

const NAV: { route: Route; key: 'nav.meetings' | 'nav.search' | 'nav.settings'; icon: IconName }[] = [
  { route: { name: 'home' }, key: 'nav.meetings', icon: 'list' },
  { route: { name: 'search' }, key: 'nav.search', icon: 'search' },
  { route: { name: 'settings' }, key: 'nav.settings', icon: 'settings' }
]

export function Sidebar(): ReactNode {
  const { t } = useI18n()
  const { route, navigate } = useRouter()
  const rec = useRecording()
  const { settings } = useSettings()
  const active = rec.state.active

  const isActive = (r: Route): boolean => {
    if (r.name === 'home') return route.name === 'home' || route.name === 'meeting'
    return route.name === r.name
  }

  return (
    <aside className="sidebar">
      <div className="brand" onClick={() => navigate({ name: 'home' })} role="button" tabIndex={0}>
        <span className="brand-mark">
          <Icon name="mic" size={16} />
        </span>
        <span className="brand-name">{t('app.name')}</span>
      </div>

      <div className="sidebar-record">
        {active ? (
          <>
            <button type="button" className="btn btn-record btn-lg btn-block" onClick={() => void rec.stop()} disabled={rec.busy === 'stopping'}>
              <Icon name="stop" size={16} />
              {rec.busy === 'stopping' ? t('nav.stopping') : t('nav.stopRecording')}
            </button>
            <button type="button" className={`rec-indicator ${route.name === 'recording' ? 'current' : ''}`} onClick={() => navigate({ name: 'recording' })}>
              <span className={`rec-dot ${rec.state.paused ? 'paused' : ''}`} />
              <span className="rec-indicator-text">{rec.state.paused ? t('rec.paused') : t('nav.recordingNow')}</span>
              <span className="rec-indicator-time">{mmss(rec.elapsedSec)}</span>
            </button>
          </>
        ) : (
          <button type="button" className="btn btn-primary btn-lg btn-block" onClick={() => void rec.start()} disabled={rec.busy === 'starting'} title={t('rec.hotkeyHint', { key: settings.hotkeys.toggleRecording })}>
            <Icon name="record" size={16} />
            {rec.busy === 'starting' ? t('nav.starting') : t('nav.startRecording')}
          </button>
        )}
      </div>

      <nav className="nav">
        {NAV.map((item) => (
          <button key={item.key} type="button" className={`nav-item ${isActive(item.route) ? 'active' : ''}`} onClick={() => navigate(item.route)}>
            <Icon name={item.icon} size={17} />
            <span>{t(item.key)}</span>
          </button>
        ))}
      </nav>

      <div className="sidebar-footer">
        {rec.sidecar && settings.engine === 'local' && (
          <div className={`sidecar-pill sidecar-${rec.sidecar.state}`} title={rec.sidecar.message}>
            <span className="dot" />
            {t(`settings.engine.sidecar.${rec.sidecar.state}`)}
          </div>
        )}
      </div>
    </aside>
  )
}
