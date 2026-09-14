/** Small UI primitives used across pages. Kept deliberately simple (no styling libraries). */
import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, SelectHTMLAttributes, TextareaHTMLAttributes } from 'react'
import { Icon, type IconName } from './Icons'

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'record'
type Size = 'sm' | 'md' | 'lg'

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant
  size?: Size
  icon?: IconName
  loading?: boolean
  block?: boolean
}

export function Button({ variant = 'secondary', size = 'md', icon, loading, block, className, children, disabled, ...rest }: ButtonProps): ReactNode {
  return (
    <button
      type="button"
      className={`btn btn-${variant} btn-${size} ${block ? 'btn-block' : ''} ${!children ? 'btn-icon' : ''} ${className ?? ''}`}
      disabled={disabled || loading}
      {...rest}
    >
      {loading ? <Spinner size={14} /> : icon ? <Icon name={icon} size={size === 'sm' ? 14 : size === 'lg' ? 20 : 16} /> : null}
      {children}
    </button>
  )
}

export function Spinner({ size = 16 }: { size?: number }): ReactNode {
  return <span className="spinner" style={{ width: size, height: size }} aria-label="loading" />
}

export function Badge({ children, tone = 'neutral', className }: { children: ReactNode; tone?: 'neutral' | 'accent' | 'success' | 'warning' | 'danger' | 'info'; className?: string }): ReactNode {
  return <span className={`badge badge-${tone} ${className ?? ''}`}>{children}</span>
}

export function Card({ children, className, title, actions }: { children: ReactNode; className?: string; title?: ReactNode; actions?: ReactNode }): ReactNode {
  return (
    <section className={`card ${className ?? ''}`}>
      {(title || actions) && (
        <header className="card-header">
          {title && <h3 className="card-title">{title}</h3>}
          {actions && <div className="card-actions">{actions}</div>}
        </header>
      )}
      {children}
    </section>
  )
}

export function Field({ label, hint, children, inline, className }: { label?: ReactNode; hint?: ReactNode; children: ReactNode; inline?: boolean; className?: string }): ReactNode {
  return (
    <div className={`field ${inline ? 'field-inline' : ''} ${className ?? ''}`}>
      {label && <div className="field-label">{label}</div>}
      <div className="field-control">{children}</div>
      {hint && <div className="field-hint">{hint}</div>}
    </div>
  )
}

export function TextInput({ className, ...rest }: InputHTMLAttributes<HTMLInputElement>): ReactNode {
  return <input className={`input ${className ?? ''}`} {...rest} />
}

export function TextArea({ className, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement>): ReactNode {
  return <textarea className={`input textarea ${className ?? ''}`} {...rest} />
}

export function Select({ className, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>): ReactNode {
  return (
    <select className={`input select ${className ?? ''}`} {...rest}>
      {children}
    </select>
  )
}

export function Toggle({ checked, onChange, label, hint, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: ReactNode; hint?: ReactNode; disabled?: boolean }): ReactNode {
  return (
    <label className={`toggle ${disabled ? 'disabled' : ''}`}>
      <span className="toggle-text">
        <span className="toggle-label">{label}</span>
        {hint && <span className="toggle-hint">{hint}</span>}
      </span>
      <span className={`switch ${checked ? 'on' : ''}`}>
        <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
        <span className="knob" />
      </span>
    </label>
  )
}

export function ProgressBar({ value, indeterminate }: { value?: number; indeterminate?: boolean }): ReactNode {
  const pct = value === undefined ? 0 : Math.max(0, Math.min(100, value <= 1 ? value * 100 : value))
  return (
    <div className={`progress ${indeterminate || value === undefined ? 'indeterminate' : ''}`}>
      <div className="progress-bar" style={{ width: indeterminate || value === undefined ? undefined : `${pct}%` }} />
    </div>
  )
}

export function EmptyState({ icon, title, hint, action }: { icon?: IconName; title: ReactNode; hint?: ReactNode; action?: ReactNode }): ReactNode {
  return (
    <div className="empty">
      {icon && (
        <div className="empty-icon">
          <Icon name={icon} size={28} />
        </div>
      )}
      <div className="empty-title">{title}</div>
      {hint && <div className="empty-hint">{hint}</div>}
      {action && <div className="empty-action">{action}</div>}
    </div>
  )
}

export function Kbd({ children }: { children: ReactNode }): ReactNode {
  return <kbd className="kbd">{children}</kbd>
}

export function Alert({ tone = 'info', children, action }: { tone?: 'info' | 'warning' | 'danger' | 'success'; children: ReactNode; action?: ReactNode }): ReactNode {
  const icon: IconName = tone === 'warning' || tone === 'danger' ? 'warning' : tone === 'success' ? 'check' : 'info'
  return (
    <div className={`alert alert-${tone}`} role={tone === 'danger' ? 'alert' : 'status'}>
      <Icon name={icon} size={16} />
      <div className="alert-body">{children}</div>
      {action && <div className="alert-action">{action}</div>}
    </div>
  )
}

export function Tabs<T extends string>({ tabs, value, onChange }: { tabs: { id: T; label: ReactNode; badge?: ReactNode }[]; value: T; onChange: (v: T) => void }): ReactNode {
  return (
    <div className="tabs" role="tablist">
      {tabs.map((tab) => (
        <button key={tab.id} role="tab" type="button" aria-selected={tab.id === value} className={`tab ${tab.id === value ? 'active' : ''}`} onClick={() => onChange(tab.id)}>
          {tab.label}
          {tab.badge !== undefined && tab.badge !== null && <span className="tab-badge">{tab.badge}</span>}
        </button>
      ))}
    </div>
  )
}
