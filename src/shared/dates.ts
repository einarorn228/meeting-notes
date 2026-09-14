/** Icelandic date/time formatting that does not depend on ICU locale data being available. */
const MONTHS_IS = ['janúar', 'febrúar', 'mars', 'apríl', 'maí', 'júní', 'júlí', 'ágúst', 'september', 'október', 'nóvember', 'desember']
const WEEKDAYS_IS = ['sunnudagur', 'mánudagur', 'þriðjudagur', 'miðvikudagur', 'fimmtudagur', 'föstudagur', 'laugardagur']
const p2 = (n: number): string => n.toString().padStart(2, '0')

export function timeIs(d: Date): string {
  return `${p2(d.getHours())}:${p2(d.getMinutes())}`
}

/** 14. september 2026 */
export function dateIs(d: Date, weekday = false): string {
  const base = `${d.getDate()}. ${MONTHS_IS[d.getMonth()]} ${d.getFullYear()}`
  return weekday ? `${WEEKDAYS_IS[d.getDay()]}, ${base}` : base
}

/** 14. september 2026 kl. 10:01 */
export function dateTimeIs(d: Date): string {
  return `${dateIs(d)} kl. ${timeIs(d)}`
}

/** Short numeric form used in titles: 14.9.2026 10:01 */
export function shortDateTimeIs(d: Date): string {
  return `${d.getDate()}.${d.getMonth() + 1}.${d.getFullYear()} ${timeIs(d)}`
}

export function formatDateForLocale(d: Date, locale: string, weekday = false): string {
  if (locale.startsWith('is')) return dateIs(d, weekday)
  return d.toLocaleDateString(locale, weekday ? { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' } : { day: 'numeric', month: 'long', year: 'numeric' })
}

export function formatDateTimeForLocale(d: Date, locale: string): string {
  if (locale.startsWith('is')) return dateTimeIs(d)
  return d.toLocaleString(locale, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
}
