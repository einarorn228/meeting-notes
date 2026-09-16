/**
 * The AI features, exercised over real HTTP against a stand-in for the Anthropic API.
 *
 * Everything between the app and Anthropic is covered here - the request the SDK actually puts on the wire,
 * the streamed response the app parses, and what the user is told when the call fails. Unit tests on the
 * request body cannot catch a client that never sends it, or an error the user cannot act on.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

type Handler = (req: IncomingMessage, res: ServerResponse, body: string) => void
let handler: Handler
let server: Server
const sent: Record<string, unknown>[] = []

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      if (body) sent.push(JSON.parse(body))
      handler(req, res, body)
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
afterAll(() => new Promise<void>((r) => server.close(() => r())))

vi.mock('../src/main/settings', () => ({
  getSettings: () => ({ llm: { provider: 'anthropic', anthropicApiKey: 'sk-ant-test', anthropicModel: 'claude-opus-5' } })
}))

const { complete } = await import('../src/main/ai/llm')

/** One Anthropic streaming response, as the SDK expects to receive it. */
function streamMessage(text: string, extra: Record<string, unknown> = {}): Handler {
  return (_req, res) => {
    const message = { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-opus-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 3 }, ...extra }
    const events: [string, unknown][] = [
      ['message_start', { type: 'message_start', message }],
      ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
      ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }],
      ['content_block_stop', { type: 'content_block_stop', index: 0 }],
      // stop_reason and stop_details arrive in message_delta; the SDK overwrites the snapshot from it.
      ['message_delta', { type: 'message_delta', delta: { stop_reason: extra.stop_reason ?? 'end_turn', stop_sequence: null, stop_details: extra.stop_details ?? null }, usage: { output_tokens: 3 } }],
      ['message_stop', { type: 'message_stop' }]
    ]
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    for (const [event, data] of events) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    res.end()
  }
}

function fail(status: number, type: string, message: string): Handler {
  return (_req, res) => {
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ type: 'error', error: { type, message } }))
  }
}

describe('talking to Anthropic', () => {
  it('sends the meeting as a cached system prompt and reads the answer back', async () => {
    sent.length = 0
    handler = streamMessage('# Fundur um fjárhagsáætlun')
    const res = await complete('uppskrift fundarins', [{ role: 'user', content: 'Dragðu saman' }], { effort: 'medium' })
    expect(res).toEqual({ text: '# Fundur um fjárhagsáætlun', provider: 'anthropic', model: 'claude-opus-5' })
    const body = sent[0]
    expect(body.model).toBe('claude-opus-5')
    expect(body.stream).toBe(true)
    expect(body.system).toEqual([{ type: 'text', text: 'uppskrift fundarins', cache_control: { type: 'ephemeral' } }])
    expect(body.messages).toEqual([{ role: 'user', content: 'Dragðu saman' }])
    expect(body.output_config).toEqual({ effort: 'medium' })
    expect(body).not.toHaveProperty('temperature') // rejected by this model
  })

  it('passes on a refusal as something the user can act on', async () => {
    handler = streamMessage('', { stop_reason: 'refusal', stop_details: { type: 'refusal', category: 'cyber' } })
    await expect(complete('kerfi', [{ role: 'user', content: 'hæ' }])).rejects.toThrow(/hafnaði beiðninni.*cyber/s)
  })

  it.each([
    [401, 'authentication_error', /API lyklinum/],
    [403, 'permission_error', /ekki aðgang að þessu líkani/],
    [404, 'not_found_error', /Líkanið fannst ekki/],
    [429, 'rate_limit_error', /Of margar beiðnir/],
    [400, 'invalid_request_error', /hafnaði beiðninni/],
    [529, 'overloaded_error', /Anthropic svaraði villu \(529\)/]
  ])('explains a %i in Icelandic', async (status, type, expected) => {
    handler = fail(status, type, 'something went wrong')
    await expect(complete('kerfi', [{ role: 'user', content: 'hæ' }])).rejects.toThrow(expected)
  })
})

describe('summarising an hour-long meeting', () => {
  it('sends the whole transcript once and stores what comes back', async () => {
    // ~600 lines is what an hour of Icelandic conversation produces.
    const segments = Array.from({ length: 600 }, (_, i) => ({
      id: `s${i}`, channel: i % 3 === 0 ? 'system' : 'mic', start: i * 6, end: i * 6 + 5,
      text: 'Við ræddum fjárhagsáætlun næsta árs og hvað þarf að gera fyrir haustið.', speaker: i % 3 === 0 ? 'others' : 'me'
    }))
    const meeting = {
      id: 'm1', title: 'Fundur 15.9.2026', createdAt: '2026-09-15T16:00:00.000Z', durationSec: 3600, language: 'is',
      engine: 'local', status: 'done', segments, highlights: [], participants: ['Aníta'], speakerNames: { me: 'Ég', others: 'Aníta' },
      chat: [], notes: ''
    }
    const saved: Record<string, unknown>[] = []
    vi.doMock('../src/main/store', () => ({
      loadMeeting: () => meeting,
      saveMeeting: (m: Record<string, unknown>) => saved.push(m),
      allMeetings: () => [meeting],
      transcriptText: () => '',
      formatTime: (s: number) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}`
    }))
    vi.doMock('../src/main/settings', () => ({
      getSettings: () => ({
        llm: { provider: 'anthropic', anthropicApiKey: 'sk-ant-test', anthropicModel: 'claude-opus-5', summaryTemplateId: undefined },
        vocabulary: ['Aníta'], language: 'is'
      })
    }))
    const { summarizeMeeting } = await import('../src/main/ai/notes')

    sent.length = 0
    handler = streamMessage('# Fundur um fjárhagsáætlun\n\n## Helstu atriði\n- Rætt var um fjárhagsáætlun.\n\n## Ákvarðanir\n- Ákveðið var að klára áætlunina.\n\n## Aðgerðir\n- [ ] Klára áætlun — Ábyrgð: Aníta — Frestur: 1. október 2026\n')
    const summary = await summarizeMeeting('m1', undefined, () => {})

    expect(sent).toHaveLength(1)
    const user = String((sent[0].messages as { content: string }[])[0].content)
    expect(user).toContain('Aníta:') // speaker names, not raw channel ids
    expect(user.split('\n').filter((l) => l.startsWith('[')).length).toBe(600) // nothing dropped
    expect(user.length).toBeLessThan(350000) // the transcript cap was not hit
    expect(summary.keyPoints).toEqual(['Rætt var um fjárhagsáætlun.'])
    expect(summary.actionItems).toEqual([{ text: 'Klára áætlun', owner: 'Aníta', due: '1. október 2026', done: false }])
    expect(saved).toHaveLength(1)
    expect((saved[0].summary as { title: string }).title).toBe('Fundur um fjárhagsáætlun')
    expect(saved[0].title).toBe('Fundur um fjárhagsáætlun') // the generated title replaces "Fundur 15.9.2026"
  })
})
