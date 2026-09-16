import { describe, it, expect, vi } from 'vitest'

// The real electron package resolves (and, on a fresh CI checkout, downloads) its binary the moment it is
// imported, which these tests have no use for - they only reach it through settings.ts asking for a data
// directory. Three test files racing on that download is how the suite fails for reasons of its own.
vi.mock('electron', () => ({ app: { getPath: () => '/tmp', isPackaged: false, getVersion: () => '0.0.0' } }))

const settings = vi.hoisted(() => ({
  llm: { provider: 'anthropic', anthropicApiKey: '', openaiApiKey: '', ollamaUrl: 'http://127.0.0.1:11434' }
}))
vi.mock('../src/main/settings', () => ({ getSettings: () => settings, dataDir: () => '/tmp' }))
import { anthropicRequest, anthropicSupportsEffort, anthropicSupportsSampling } from '../src/main/ai/llm'

const base = { system: 'kerfi', messages: [{ role: 'user' as const, content: 'hæ' }], maxTokens: 16000, temperature: 0.2 }

describe('Anthropic model capabilities', () => {
  it('omits temperature for models that removed sampling parameters', () => {
    // These return 400 "temperature is deprecated for this model" if temperature is sent.
    for (const model of ['claude-opus-5', 'claude-sonnet-5', 'claude-fable-5-1', 'claude-fable-5', 'claude-opus-4-8', 'claude-opus-4-7']) {
      expect(anthropicSupportsSampling(model), model).toBe(false)
      expect(anthropicRequest({ ...base, model })).not.toHaveProperty('temperature')
    }
  })

  it('keeps temperature for older models that still accept it', () => {
    for (const model of ['claude-opus-4-6', 'claude-sonnet-4-6', 'claude-haiku-4-5']) {
      expect(anthropicSupportsSampling(model), model).toBe(true)
      expect(anthropicRequest({ ...base, model })).toHaveProperty('temperature', 0.2)
    }
  })

  it('sends output_config.effort only to models that support it', () => {
    expect(anthropicSupportsEffort('claude-opus-5')).toBe(true)
    expect(anthropicSupportsEffort('claude-haiku-4-5')).toBe(false)
    expect(anthropicRequest({ ...base, model: 'claude-opus-5', effort: 'low' })).toMatchObject({ output_config: { effort: 'low' } })
    expect(anthropicRequest({ ...base, model: 'claude-haiku-4-5', effort: 'low' })).not.toHaveProperty('output_config')
    expect(anthropicRequest({ ...base, model: 'claude-opus-5' })).not.toHaveProperty('output_config')
  })

  it('always caches the system prompt and passes messages through', () => {
    const body = anthropicRequest({ ...base, model: 'claude-opus-5' }) as unknown as Record<string, unknown>
    expect(body.system).toEqual([{ type: 'text', text: 'kerfi', cache_control: { type: 'ephemeral' } }])
    expect(body.messages).toEqual([{ role: 'user', content: 'hæ' }])
    expect(body.max_tokens).toBe(16000)
  })
})

describe('whether the AI is configured at all', () => {
  it('counts an empty key as no AI, so a skipped setup does not error after every meeting', async () => {
    const { llmConfigured } = await import('../src/main/ai/llm')
    settings.llm = { ...settings.llm, provider: 'anthropic', anthropicApiKey: '   ' }
    expect(llmConfigured()).toBe(false)
    settings.llm = { ...settings.llm, anthropicApiKey: 'sk-ant-abc' }
    expect(llmConfigured()).toBe(true)
    settings.llm = { ...settings.llm, provider: 'none' }
    expect(llmConfigured()).toBe(false)
  })
})
