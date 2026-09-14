/**
 * Minimal state-based router. Routes are plain objects; the main process can push string routes
 * (e.g. "/meetings/<id>", "/settings/engine", "/recording") via the `navigate` event, parsed by parseRoute().
 */
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react'

export type SettingsSection = 'general' | 'audio' | 'engine' | 'llm' | 'vocabulary' | 'detection' | 'hotkeys' | 'privacy'
export type MeetingTab = 'summary' | 'transcript' | 'notes' | 'highlights' | 'chat'

export type Route =
  | { name: 'home' }
  | { name: 'recording' }
  | { name: 'meeting'; id: string; tab?: MeetingTab; time?: number }
  | { name: 'settings'; section?: SettingsSection }
  | { name: 'search'; q?: string }
  | { name: 'onboarding' }

const SETTINGS_SECTIONS: SettingsSection[] = ['general', 'audio', 'engine', 'llm', 'vocabulary', 'detection', 'hotkeys', 'privacy']

export function parseRoute(str: string): Route {
  const [pathPart, query = ''] = (str || '/').split('?')
  const parts = pathPart.split('/').filter(Boolean)
  const params = new URLSearchParams(query)
  switch (parts[0]) {
    case undefined:
    case 'home':
    case 'meetings':
      if (parts[1]) {
        const tab = params.get('tab') as MeetingTab | null
        const time = params.get('t')
        return { name: 'meeting', id: parts[1], tab: tab ?? undefined, time: time ? Number(time) : undefined }
      }
      return { name: 'home' }
    case 'meeting':
      return parts[1] ? { name: 'meeting', id: parts[1] } : { name: 'home' }
    case 'recording':
    case 'record':
      return { name: 'recording' }
    case 'settings': {
      const section = parts[1] as SettingsSection | undefined
      return { name: 'settings', section: section && SETTINGS_SECTIONS.includes(section) ? section : undefined }
    }
    case 'search':
      return { name: 'search', q: params.get('q') ?? undefined }
    case 'onboarding':
      return { name: 'onboarding' }
    default:
      return { name: 'home' }
  }
}

interface RouterValue {
  route: Route
  navigate: (route: Route | string) => void
  back: () => void
}

const RouterContext = createContext<RouterValue>({ route: { name: 'home' }, navigate: () => {}, back: () => {} })

export function RouterProvider({ initial, children }: { initial: Route; children: ReactNode }): ReactNode {
  const [stack, setStack] = useState<Route[]>([initial])
  const navigate = useCallback((r: Route | string) => {
    const next = typeof r === 'string' ? parseRoute(r) : r
    setStack((s) => [...s.slice(-30), next])
  }, [])
  const back = useCallback(() => {
    setStack((s) => (s.length > 1 ? s.slice(0, -1) : [{ name: 'home' }]))
  }, [])
  const value = useMemo(() => ({ route: stack[stack.length - 1], navigate, back }), [stack, navigate, back])
  return <RouterContext.Provider value={value}>{children}</RouterContext.Provider>
}

export function useRouter(): RouterValue {
  return useContext(RouterContext)
}
