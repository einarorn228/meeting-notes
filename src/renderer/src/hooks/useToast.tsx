import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react'

export type ToastKind = 'info' | 'success' | 'error'
export interface Toast {
  id: number
  kind: ToastKind
  message: string
  action?: { label: string; onClick: () => void }
}

interface ToastApi {
  toast: (message: string, kind?: ToastKind, action?: Toast['action'], ms?: number) => void
  toasts: Toast[]
  dismiss: (id: number) => void
}

const ToastContext = createContext<ToastApi>({ toast: () => {}, toasts: [], dismiss: () => {} })

export function ToastProvider({ children }: { children: ReactNode }): ReactNode {
  const [toasts, setToasts] = useState<Toast[]>([])
  const seq = useRef(0)
  const dismiss = useCallback((id: number) => setToasts((t) => t.filter((x) => x.id !== id)), [])
  const toast = useCallback(
    (message: string, kind: ToastKind = 'info', action?: Toast['action'], ms?: number) => {
      const id = ++seq.current
      setToasts((t) => [...t.slice(-3), { id, kind, message, action }])
      window.setTimeout(() => dismiss(id), ms ?? (kind === 'error' || action ? 8000 : 3000))
    },
    [dismiss]
  )
  const value = useMemo(() => ({ toast, toasts, dismiss }), [toast, toasts, dismiss])
  return <ToastContext.Provider value={value}>{children}</ToastContext.Provider>
}

export function useToast(): ToastApi {
  return useContext(ToastContext)
}
