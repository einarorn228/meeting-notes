/**
 * Calendar integration via ICS feeds (Outlook/Microsoft 365 "publish calendar" links, Google Calendar secret
 * address, Apple iCloud shared links). Polled every 10 minutes; upcoming events trigger a notification shortly
 * before they start.
 */
import type { CalendarEvent } from '../../shared/types'

function unfold(ics: string): string[] {
  return ics
    .replace(/\r\n[ \t]/g, '')
    .replace(/\n[ \t]/g, '')
    .split(/\r?\n/)
}

function parseDate(value: string, params: string): Date | null {
  const v = value.trim()
  const m = v.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/)
  if (!m) return null
  const [, y, mo, d, h = '00', mi = '00', s = '00', z] = m
  if (z) return new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi, +s))
  // Floating or TZID times: treat as local time (good enough for reminders).
  void params
  return new Date(+y, +mo - 1, +d, +h, +mi, +s)
}

function unescape(v: string): string {
  return v.replace(/\\n/g, '\n').replace(/\\,/g, ',').replace(/\;/g, ';').replace(/\\\\/g, '\\')
}

export function detectAppFromText(text: string): string | undefined {
  const t = text.toLowerCase()
  if (t.includes('teams.microsoft.com') || t.includes('teams.live.com') || t.includes('microsoft teams')) return 'teams'
  if (t.includes('zoom.us') || t.includes('zoom.com')) return 'zoom'
  if (t.includes('meet.google.com')) return 'meet'
  if (t.includes('webex.com')) return 'webex'
  if (t.includes('slack.com')) return 'slack'
  return undefined
}

export function parseIcs(ics: string): CalendarEvent[] {
  const events: CalendarEvent[] = []
  let cur: Record<string, { value: string; params: string }> | null = null
  for (const line of unfold(ics)) {
    if (line === 'BEGIN:VEVENT') {
      cur = {}
      continue
    }
    if (line === 'END:VEVENT' && cur) {
      const start = cur.DTSTART ? parseDate(cur.DTSTART.value, cur.DTSTART.params) : null
      const end = cur.DTEND ? parseDate(cur.DTEND.value, cur.DTEND.params) : start ? new Date(start.getTime() + 3600000) : null
      if (start && end && !cur.RRULE) {
        const desc = unescape(cur.DESCRIPTION?.value ?? '')
        const loc = unescape(cur.LOCATION?.value ?? '')
        const urlMatch = (desc + ' ' + loc + ' ' + (cur.URL?.value ?? '') + ' ' + (cur['X-MICROSOFT-SKYPETEAMSMEETINGURL']?.value ?? '')).match(/https?:\/\/[^\s<>"']+(teams\.microsoft\.com|teams\.live\.com|zoom\.us|meet\.google\.com|webex\.com)[^\s<>"']*/i)
        events.push({
          id: cur.UID?.value ?? `${start.toISOString()}-${cur.SUMMARY?.value ?? ''}`,
          title: unescape(cur.SUMMARY?.value ?? 'Fundur'),
          start: start.toISOString(),
          end: end.toISOString(),
          location: loc || undefined,
          joinUrl: urlMatch ? urlMatch[0] : undefined,
          app: detectAppFromText(desc + ' ' + loc + ' ' + (cur.URL?.value ?? ''))
        })
      }
      cur = null
      continue
    }
    if (!cur) continue
    const idx = line.indexOf(':')
    if (idx < 0) continue
    const keyPart = line.slice(0, idx)
    const value = line.slice(idx + 1)
    const [key, ...params] = keyPart.split(';')
    cur[key.toUpperCase()] = { value, params: params.join(';') }
  }
  return events
}

export class CalendarService {
  private events: CalendarEvent[] = []
  private timer: NodeJS.Timeout | null = null
  private notified = new Set<string>()

  constructor(private readonly getUrls: () => string[], private readonly onUpcoming: (e: CalendarEvent) => void, private readonly getMinutesBefore: () => number) {}

  start(): void {
    this.stop()
    this.timer = setInterval(() => void this.refresh(), 10 * 60 * 1000)
    setInterval(() => this.checkUpcoming(), 30 * 1000)
    void this.refresh()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  async refresh(): Promise<CalendarEvent[]> {
    const urls = this.getUrls().filter((u) => u.trim())
    const all: CalendarEvent[] = []
    for (const raw of urls) {
      const url = raw.trim().replace(/^webcal:\/\//i, 'https://')
      try {
        const res = await fetch(url, { headers: { 'user-agent': 'Fundarritari/0.1' } })
        if (!res.ok) continue
        all.push(...parseIcs(await res.text()))
      } catch {
        /* offline */
      }
    }
    const now = Date.now()
    this.events = all.filter((e) => new Date(e.end).getTime() > now - 3600000 && new Date(e.start).getTime() < now + 7 * 86400000).sort((a, b) => a.start.localeCompare(b.start))
    this.checkUpcoming()
    return this.upcoming()
  }

  upcoming(): CalendarEvent[] {
    const now = Date.now()
    return this.events.filter((e) => new Date(e.end).getTime() > now).slice(0, 20)
  }

  private checkUpcoming(): void {
    const now = Date.now()
    const lead = this.getMinutesBefore() * 60000
    for (const e of this.events) {
      const start = new Date(e.start).getTime()
      if (start - now <= lead && start - now > -2 * 60000 && !this.notified.has(e.id)) {
        this.notified.add(e.id)
        this.onUpcoming(e)
      }
    }
  }
}
