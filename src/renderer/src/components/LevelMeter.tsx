import type { ReactNode } from 'react'
import { Icon, type IconName } from './Icons'

/** Horizontal VU meter. `level` is RMS in 0..1 (typical speech 0.02-0.3); shown on a log-ish scale. */
export function LevelMeter({ level, label, icon, warn, compact }: { level: number; label?: string; icon?: IconName; warn?: boolean; compact?: boolean }): ReactNode {
  const db = 20 * Math.log10(Math.max(level, 1e-5))
  const pct = Math.max(0, Math.min(100, ((db + 60) / 60) * 100))
  const tone = warn ? 'warn' : pct > 90 ? 'hot' : pct > 5 ? 'ok' : 'idle'
  return (
    <div className={`meter ${compact ? 'meter-compact' : ''} meter-${tone}`} title={label}>
      {icon && <Icon name={icon} size={14} />}
      {label && !compact && <span className="meter-label">{label}</span>}
      <div className="meter-track">
        <div className="meter-fill" style={{ width: `${pct}%` }} />
      </div>
    </div>
  )
}
