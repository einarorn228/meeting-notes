import { useEffect, useState, type ReactNode } from 'react'
import { I18nProvider, useI18n } from './i18n'
import { RouterProvider, useRouter } from './router'
import { SettingsProvider, useSettings } from './hooks/useSettings'
import { ToastProvider, useToast } from './hooks/useToast'
import { RecordingProvider, useRecording } from './hooks/useRecordingController'
import { Sidebar } from './components/Sidebar'
import { Toasts } from './components/Toasts'
import { UpdateBanner } from './components/UpdateBanner'
import { Spinner } from './components/ui'
import { HomePage } from './pages/Home'
import { RecordingPage } from './pages/Recording'
import { MeetingPage } from './pages/MeetingDetail'
import { SettingsPage } from './pages/Settings'
import { SearchPage } from './pages/Search'
import { OnboardingPage } from './pages/Onboarding'

function Screen(): ReactNode {
  const { route, navigate } = useRouter()
  const { settings, loaded, error } = useSettings()
  const { t } = useI18n()
  const rec = useRecording()

  // When a recording starts elsewhere (hotkey while on the home page) jump to the recording view once.
  const [seenActive, setSeenActive] = useState(false)
  useEffect(() => {
    if (rec.state.active && !seenActive) {
      setSeenActive(true)
      if (route.name !== 'recording' && route.name !== 'onboarding') navigate({ name: 'recording' })
    }
    if (!rec.state.active && seenActive) setSeenActive(false)
  }, [rec.state.active, seenActive, route.name, navigate])

  if (!loaded) {
    return (
      <div className="app-loading">
        <Spinner size={24} />
        <span>{t('common.loading')}</span>
      </div>
    )
  }
  if (error) {
    return (
      <div className="app-loading">
        <span className="text-danger">{t('common.error')}: {error}</span>
      </div>
    )
  }
  if (!settings.onboardingDone || route.name === 'onboarding') return <OnboardingPage />

  let page: ReactNode
  switch (route.name) {
    case 'home':
      page = <HomePage />
      break
    case 'recording':
      page = <RecordingPage />
      break
    case 'meeting':
      page = <MeetingPage key={route.id} id={route.id} initialTab={route.tab} initialTime={route.time} />
      break
    case 'settings':
      page = <SettingsPage section={route.section} />
      break
    case 'search':
      page = <SearchPage initialQuery={route.q} />
      break
    default:
      page = <HomePage />
  }
  return (
    <div className="app-shell">
      <Sidebar />
      <main className="main">
        <UpdateBanner />
        {page}
      </main>
    </div>
  )
}

/** Shows a toast when a debounced settings save completes (sits inside the language provider so it is translated). */
function SaveToasts(): ReactNode {
  const { toast } = useToast()
  const { t } = useI18n()
  const { setOnSaved } = useSettings()
  useEffect(() => {
    setOnSaved((ok, msg) => toast(ok ? t('common.saved') : `${t('settings.saveFailed')}: ${msg ?? ''}`, ok ? 'success' : 'error'))
    return () => setOnSaved(undefined)
  }, [setOnSaved, toast, t])
  return null
}

function LanguageBridge({ children }: { children: ReactNode }): ReactNode {
  const { settings } = useSettings()
  useEffect(() => {
    document.documentElement.lang = settings.uiLanguage
  }, [settings.uiLanguage])
  return (
    <I18nProvider lang={settings.uiLanguage}>
      <SaveToasts />
      {children}
    </I18nProvider>
  )
}

export default function App(): ReactNode {
  return (
    <ToastProvider>
      <SettingsProvider>
        <LanguageBridge>
          <RouterProvider initial={{ name: 'home' }}>
            <RecordingProvider>
              <Screen />
              <Toasts />
            </RecordingProvider>
          </RouterProvider>
        </LanguageBridge>
      </SettingsProvider>
    </ToastProvider>
  )
}
