/** Thin LLM provider layer: Anthropic (default, best Icelandic grammar), OpenAI, Ollama (offline). */
import Anthropic from '@anthropic-ai/sdk'
import OpenAI from 'openai'
import { getSettings } from '../settings'

export interface LlmMessage {
  role: 'user' | 'assistant'
  content: string
}

export interface LlmResult {
  text: string
  provider: string
  model: string
}

export async function complete(system: string, messages: LlmMessage[], opts: { maxTokens?: number; temperature?: number } = {}): Promise<LlmResult> {
  const s = getSettings().llm
  const maxTokens = opts.maxTokens ?? 4000
  const temperature = opts.temperature ?? 0.2
  switch (s.provider) {
    case 'anthropic': {
      if (!s.anthropicApiKey) throw new Error('Anthropic API lykil vantar (Stillingar → Gervigreind)')
      const client = new Anthropic({ apiKey: s.anthropicApiKey })
      const res = await client.messages.create({
        model: s.anthropicModel || 'claude-opus-5',
        max_tokens: maxTokens,
        temperature,
        system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
        messages: messages.map((m) => ({ role: m.role, content: m.content }))
      })
      const text = res.content.map((c) => (c.type === 'text' ? c.text : '')).join('')
      return { text, provider: 'anthropic', model: res.model }
    }
    case 'openai': {
      if (!s.openaiApiKey) throw new Error('OpenAI API lykil vantar (Stillingar → Gervigreind)')
      const client = new OpenAI({ apiKey: s.openaiApiKey })
      const model = s.openaiModel || 'gpt-5.6-sol'
      const res = await client.chat.completions.create({
        model,
        messages: [{ role: 'system', content: system }, ...messages.map((m) => ({ role: m.role, content: m.content }))],
        max_completion_tokens: maxTokens,
        ...(model.startsWith('gpt-5') || model.startsWith('gpt-6') || model.startsWith('o') ? {} : { temperature })
      })
      return { text: res.choices[0]?.message?.content ?? '', provider: 'openai', model }
    }
    case 'ollama': {
      const url = (s.ollamaUrl || 'http://127.0.0.1:11434').replace(/\/$/, '')
      const model = s.ollamaModel || 'gemma4:12b'
      const res = await fetch(`${url}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model, stream: false, options: { temperature, num_ctx: 32768, num_predict: maxTokens }, messages: [{ role: 'system', content: system }, ...messages] })
      })
      if (!res.ok) throw new Error(`Ollama svaraði ${res.status}: ${(await res.text()).slice(0, 200)}`)
      const json = (await res.json()) as { message?: { content?: string } }
      return { text: json.message?.content ?? '', provider: 'ollama', model }
    }
    default:
      throw new Error('Engin gervigreindarþjónusta valin (Stillingar → Gervigreind)')
  }
}

export async function testLlm(): Promise<{ ok: boolean; message: string }> {
  try {
    const r = await complete('Svaraðu með einu orði.', [{ role: 'user', content: 'Segðu „Halló“ á íslensku.' }], { maxTokens: 20, temperature: 0 })
    return { ok: true, message: `Tenging virkar (${r.provider} / ${r.model}): ${r.text.trim().slice(0, 40)}` }
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) }
  }
}
