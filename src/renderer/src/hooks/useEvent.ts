import { useEffect, useRef } from 'react'
import type { MainEventName, MainEvents } from '@shared/types'
import { api } from '@/api'

/** Subscribes to a main-process event for the lifetime of the component. The callback may change freely. */
export function useEvent<K extends MainEventName>(event: K, cb: (payload: MainEvents[K]) => void): void {
  const ref = useRef(cb)
  ref.current = cb
  useEffect(() => api.on(event, (payload) => ref.current(payload)), [event])
}
