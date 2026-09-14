/**
 * Typed access to the preload bridge. Everything the renderer needs from the main process goes through here.
 * When running outside Electron (e.g. a plain browser during UI work) `window.fundarritari` is undefined; the
 * proxy below turns every call into a rejected promise instead of a hard crash so the UI can show an error state.
 */
import type { FundarritariApi } from '../../preload/index'

function missing(): FundarritariApi {
  const handler: ProxyHandler<object> = {
    get: (_t, prop) => {
      if (prop === 'on') return () => () => {}
      if (prop === 'pushAudio' || prop === 'reportLevels') return () => {}
      return () => Promise.reject(new Error(`Fundarritari API unavailable (${String(prop)})`))
    }
  }
  return new Proxy({}, handler) as FundarritariApi
}

export const api: FundarritariApi = typeof window !== 'undefined' && window.fundarritari ? window.fundarritari : missing()
export type { FundarritariApi }
export default api
