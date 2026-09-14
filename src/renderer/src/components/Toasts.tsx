import type { ReactNode } from 'react'
import { useToast } from '@/hooks/useToast'
import { Icon } from './Icons'

export function Toasts(): ReactNode {
  const { toasts, dismiss } = useToast()
  if (toasts.length === 0) return null
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast toast-${t.kind}`}>
          <Icon name={t.kind === 'error' ? 'warning' : t.kind === 'success' ? 'check' : 'info'} size={16} />
          <span className="toast-msg">{t.message}</span>
          {t.action && (
            <button type="button" className="toast-action" onClick={() => (t.action?.onClick(), dismiss(t.id))}>
              {t.action.label}
            </button>
          )}
          <button type="button" className="toast-close" onClick={() => dismiss(t.id)} aria-label="close">
            <Icon name="x" size={14} />
          </button>
        </div>
      ))}
    </div>
  )
}
