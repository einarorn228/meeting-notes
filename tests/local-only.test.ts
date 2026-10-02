/**
 * "Aðeins á þessari vél": one switch that keeps everything said in a meeting on the computer.
 *
 * Some meetings may not leave the building: a union congress, a board meeting, anything with a promise attached.
 * A person who has made that promise cannot be expected to audit three settings pages before each recording,
 * so the switch is enforced where the data would leave - at the speech engine and at the language model -
 * whatever the other settings say.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { DEFAULT_SETTINGS, type Settings } from '../src/shared/types'
import { effectiveEngine, isLoopbackUrl, leavesTheMachine, llmStaysLocal } from '../src/shared/local-only'

vi.mock('electron', () => ({ app: { getPath: () => '/tmp', isPackaged: false, getVersion: () => '0.0.0' } }))

let settings: Settings
vi.mock('../src/main/settings', () => ({ getSettings: () => settings, dataDir: () => '/tmp' }))

const { complete, llmConfigured } = await import('../src/main/ai/llm')
const { createEngine, testEngine } = await import('../src/main/transcription')
const { LocalEngine } = await import('../src/main/transcription/local')

function withSettings(patch: Omit<Partial<Settings>, 'llm'> & { llm?: Partial<Settings['llm']> }): Settings {
  const s = structuredClone(DEFAULT_SETTINGS)
  return { ...s, ...patch, llm: { ...s.llm, ...patch.llm } }
}

beforeEach(() => {
  settings = withSettings({})
  vi.restoreAllMocks()
})

describe('what counts as this machine', () => {
  it('accepts only loopback addresses', () => {
    for (const url of ['http://127.0.0.1:11434', 'http://localhost:11434/', 'http://[::1]:11434', 'http://LOCALHOST:8080']) {
      expect(isLoopbackUrl(url), url).toBe(true)
    }
    for (const url of ['http://192.168.1.20:11434', 'https://ollama.example.com', 'http://localhost.evil.com', 'http://127.0.0.1.nip.io', '', 'not a url']) {
      expect(isLoopbackUrl(url), url).toBe(false)
    }
  })

  it('treats no AI and a local Ollama as staying on the machine, and nothing else', () => {
    expect(llmStaysLocal(withSettings({ llm: { provider: 'none' } }).llm)).toBe(true)
    expect(llmStaysLocal(withSettings({ llm: { provider: 'ollama' } }).llm)).toBe(true)
    expect(llmStaysLocal(withSettings({ llm: { provider: 'ollama', ollamaUrl: 'http://10.0.0.5:11434' } }).llm)).toBe(false)
    expect(llmStaysLocal(withSettings({ llm: { provider: 'anthropic' } }).llm)).toBe(false)
    expect(llmStaysLocal(withSettings({ llm: { provider: 'openai' } }).llm)).toBe(false)
  })

  it('lists what would leave the machine with the current settings', () => {
    expect(leavesTheMachine(withSettings({ engine: 'local', llm: { provider: 'none' } }))).toEqual([])
    expect(leavesTheMachine(withSettings({ engine: 'azure', llm: { provider: 'anthropic' } }))).toEqual(['speech', 'text'])
    expect(leavesTheMachine(withSettings({ engine: 'local', llm: { provider: 'openai' } }))).toEqual(['text'])
  })
})

describe('the switch is off', () => {
  it('changes nothing', () => {
    settings = withSettings({ engine: 'azure' })
    expect(effectiveEngine(settings)).toBe('azure')
    expect(createEngine('azure')).not.toBeInstanceOf(LocalEngine)
  })
})

describe('the switch is on', () => {
  it('transcribes on the machine whatever engine is chosen or asked for', () => {
    settings = withSettings({ localOnly: true, engine: 'azure' })
    expect(effectiveEngine(settings)).toBe('local')
    for (const id of ['azure', 'elevenlabs', 'openai', 'local'] as const) {
      expect(createEngine(id), id).toBeInstanceOf(LocalEngine)
    }
  })

  it('will not test a cloud speech service, which would send audio to it', async () => {
    settings = withSettings({ localOnly: true })
    const r = await testEngine('openai')
    expect(r.ok).toBe(false)
    expect(r.message).toMatch(/Aðeins á þessari vél/)
  })

  it('refuses to send text to Anthropic or OpenAI, even with a key in place', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    for (const provider of ['anthropic', 'openai'] as const) {
      settings = withSettings({ localOnly: true, llm: { provider, anthropicApiKey: 'sk-ant-test', openaiApiKey: 'sk-test' } })
      await expect(complete('kerfi', [{ role: 'user', content: 'trúnaðarmál' }]), provider).rejects.toThrow(/Aðeins á þessari vél/)
      expect(llmConfigured(), provider).toBe(false)
    }
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('refuses an Ollama on another computer', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    settings = withSettings({ localOnly: true, llm: { provider: 'ollama', ollamaUrl: 'http://192.168.1.20:11434' } })
    await expect(complete('kerfi', [{ role: 'user', content: 'trúnaðarmál' }])).rejects.toThrow(/Aðeins á þessari vél/)
    expect(llmConfigured()).toBe(false)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('still lets a language model on this machine do the work', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ message: { content: 'Hreinn texti.' } }), { status: 200 }))
    settings = withSettings({ localOnly: true, llm: { provider: 'ollama' } })
    expect(llmConfigured()).toBe(true)
    const r = await complete('kerfi', [{ role: 'user', content: 'hrár texti' }])
    expect(r).toMatchObject({ text: 'Hreinn texti.', provider: 'ollama' })
    expect(String(fetchSpy.mock.calls[0][0])).toBe('http://127.0.0.1:11434/api/chat')
  })
})
