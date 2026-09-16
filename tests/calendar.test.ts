import { describe, it, expect } from 'vitest'
import { parseIcs, detectAppFromText, attendeeName } from '../src/main/detect/calendar'

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
ORGANIZER;CN="Einar Örn":mailto:einar@example.is
ATTENDEE;CN=Aníta Jónsdóttir;ROLE=REQ-PARTICIPANT:mailto:anita@example.is
ATTENDEE;CN="Jón Þór Sigurðsson":mailto:jon@example.is
ATTENDEE;CN=Aníta Jónsdóttir:mailto:anita@example.is
ATTENDEE:mailto:sigrun.olafs@example.is
ATTENDEE:mailto:info@example.is
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

describe('who was invited', () => {
  it('reads the names off the invitation, in order, without repeats', () => {
    // These become the names offered when a speaker is named, so an address that is not a person's name
    // ("info@") is left out rather than offered as one.
    expect(parseIcs(ICS)[0].attendees).toEqual(['Einar Örn', 'Aníta Jónsdóttir', 'Jón Þór Sigurðsson', 'Sigrun Olafs'])
    expect(parseIcs(ICS)[1].attendees).toBeUndefined()
  })

  it('prefers the display name the calendar wrote', () => {
    expect(attendeeName('CN="Guðrún Jónsdóttir";ROLE=CHAIR', 'mailto:g@x.is')).toBe('Guðrún Jónsdóttir')
    expect(attendeeName('', 'mailto:einar.orn@x.is')).toBe('Einar Orn')
    expect(attendeeName('', 'mailto:reception@x.is')).toBe(null)
  })
})

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
