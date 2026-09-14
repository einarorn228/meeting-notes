import { useEffect, useState, type ReactNode } from 'react'
import { Button } from './ui'
import { useT } from '@/i18n'

export function Modal({ title, children, onClose, footer, width }: { title: ReactNode; children: ReactNode; onClose: () => void; footer?: ReactNode; width?: number }): ReactNode {
  useEffect(() => {
    const h = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [onClose])
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" style={width ? { width } : undefined}>
        <header className="modal-header">
          <h3>{title}</h3>
          <Button variant="ghost" size="sm" icon="x" onClick={onClose} aria-label="close" />
        </header>
        <div className="modal-body">{children}</div>
        {footer && <footer className="modal-footer">{footer}</footer>}
      </div>
    </div>
  )
}

export function ConfirmDialog({ title, message, confirmLabel, danger, onConfirm, onCancel }: { title: ReactNode; message: ReactNode; confirmLabel?: string; danger?: boolean; onConfirm: () => void | Promise<void>; onCancel: () => void }): ReactNode {
  const t = useT()
  const [busy, setBusy] = useState(false)
  return (
    <Modal
      title={title}
      onClose={onCancel}
      footer={
        <>
          <Button onClick={onCancel}>{t('common.cancel')}</Button>
          <Button
            variant={danger ? 'danger' : 'primary'}
            loading={busy}
            onClick={async () => {
              setBusy(true)
              try {
                await onConfirm()
              } finally {
                setBusy(false)
              }
            }}
          >
            {confirmLabel ?? t('common.confirm')}
          </Button>
        </>
      }
    >
      <p>{message}</p>
    </Modal>
  )
}

export function PromptDialog({ title, hint, initial, placeholder, confirmLabel, multiline, onSubmit, onCancel }: { title: ReactNode; hint?: ReactNode; initial?: string; placeholder?: string; confirmLabel?: string; multiline?: boolean; onSubmit: (value: string) => void | Promise<void>; onCancel: () => void }): ReactNode {
  const t = useT()
  const [value, setValue] = useState(initial ?? '')
  const [busy, setBusy] = useState(false)
  const submit = async (): Promise<void> => {
    setBusy(true)
    try {
      await onSubmit(value)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Modal
      title={title}
      onClose={onCancel}
      footer={
        <>
          <Button onClick={onCancel}>{t('common.cancel')}</Button>
          <Button variant="primary" loading={busy} onClick={submit}>
            {confirmLabel ?? t('common.save')}
          </Button>
        </>
      }
    >
      {hint && <p className="muted">{hint}</p>}
      {multiline ? (
        <textarea className="input textarea" rows={5} autoFocus value={value} placeholder={placeholder} onChange={(e) => setValue(e.target.value)} />
      ) : (
        <input
          className="input"
          autoFocus
          value={value}
          placeholder={placeholder}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void submit()
          }}
        />
      )}
    </Modal>
  )
}
