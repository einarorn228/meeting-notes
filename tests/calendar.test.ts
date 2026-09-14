import { describe, it, expect } from 'vitest'
import { parseIcs, detectAppFromText } from '../src/main/detect/calendar'

const ICS = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:abc-1
DTSTART:20260915T090000Z
DTEND:20260915T100000Z
SUMMARY:Stöðufundur\\, vika 38
DESCRIPTION:Join here: https://teams.microsoft.com/l/meetup-join/19%3ameeting_abc
 %40thread.v2/0?context=x
LOCATION:Microsoft Teams Meeting
END:VEVENT
BEGIN:VEVENT
UID:abc-2
DTSTART;TZID=Atlantic/Reykjavik:20260916T130000
DTEND;TZID=Atlantic/Reykjavik:20260916T133000
SUMMARY:Zoom kynning
LOCATION:https://zoom.us/j/123456
END:VEVENT
BEGIN:VEVENT
UID:abc-3
DTSTART:20260917T090000Z
RRULE:FREQ=WEEKLY
SUMMARY:Endurtekinn
END:VEVENT
END:VCALENDAR`

describe('parseIcs', () => {
  it('parses events, unfolds lines, detects meeting apps and join urls', () => {
    const events = parseIcs(ICS)
    expect(events.length).toBe(2) // recurring skipped
    expect(events[0].title).toBe('Stöðufundur, vika 38')
    expect(events[0].app).toBe('teams')
    expect(events[0].joinUrl).toContain('teams.microsoft.com/l/meetup-join/19%3ameeting_abc%40thread.v2/0?context=x')
    expect(events[0].start).toBe('2026-09-15T09:00:00.000Z')
    expect(events[1].app).toBe('zoom')
    expect(new Date(events[1].end).getTime() - new Date(events[1].start).getTime()).toBe(30 * 60000)
  })
  it('detects apps from text', () => {
    expect(detectAppFromText('https://meet.google.com/abc-defg-hij')).toBe('meet')
    expect(detectAppFromText('nothing')).toBeUndefined()
  })
})
