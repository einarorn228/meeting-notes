/** Formatting helpers shared across pages. All locale-aware functions take the BCP-47 locale from useI18n(). */
import { formatDateForLocale, formatDateTimeForLocale, timeIs } from '@shared/dates'

export function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n)
}

/** mm:ss or h:mm:ss for transcript timestamps and the recording timer. */
export function mmss(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds || 0))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  return h > 0 ? `${h}:${pad2(m)}:${pad2(sec)}` : `${pad2(m)}:${pad2(sec)}`
}

/** Human duration such as "1 klst. 5 mín." / "12 mín." / "45 sek." */
export function formatDuration(seconds: number, lang: 'is' | 'en'): string {
  const s = Math.max(0, Math.round(seconds || 0))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const units = lang === 'is' ? { h: 'klst.', m: 'mín.', s: 'sek.' } : { h: 'h', m: 'min', s: 's' }
  if (h > 0) return m > 0 ? `${h} ${units.h} ${m} ${units.m}` : `${h} ${units.h}`
  if (m > 0) return `${m} ${units.m}`
  return `${s} ${units.s}`
}

export function formatTime(iso: string, locale: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  if (locale.startsWith('is')) return timeIs(d)
  return d.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
}

export function formatDate(iso: string, locale: string, opts?: Intl.DateTimeFormatOptions): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  if (locale.startsWith('is')) return formatDateForLocale(d, locale, !opts || !!opts.weekday)
  return d.toLocaleDateString(locale, opts ?? { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })
}

export function formatDateTime(iso: string, locale: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return formatDateTimeForLocale(d, locale)
}

/** YYYY-MM-DD key of a date in local time, used to group meetings by day. */
export function dayKey(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return 'unknown'
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
}

export function isSameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
}

/** Rounds a size in MB to a "3.1" GB string. */
export function mbToGb(mb: number): string {
  return (mb / 1000).toFixed(1).replace(/\.0$/, '')
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
  return String(err)
}

/** Debounce helper for autosave. Returns [call, flush, cancel]. */
export function debounce<A extends unknown[]>(fn: (...args: A) => void, ms: number): { call: (...args: A) => void; flush: () => void; cancel: () => void } {
  let timer: number | undefined
  let last: A | undefined
  const cancel = (): void => {
    if (timer !== undefined) window.clearTimeout(timer)
    timer = undefined
  }
  const flush = (): void => {
    if (timer !== undefined && last) {
      cancel()
      const args = last
      last = undefined
      fn(...args)
    }
  }
  return {
    call: (...args: A) => {
      last = args
      cancel()
      timer = window.setTimeout(() => {
        timer = undefined
        last = undefined
        fn(...args)
      }, ms)
    },
    flush,
    cancel
  }
}
