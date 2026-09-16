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

export type Effort = 'low' | 'medium' | 'high'

/**
 * Current Claude models removed the sampling parameters (temperature / top_p / top_k): sending one returns
 * `400 "temperature is deprecated for this model"`. Older models still accept them.
 */
export function anthropicSupportsSampling(model: string): boolean {
  return !/^claude-(fable-5|mythos-5|opus-5|opus-4-8|opus-4-7|sonnet-5)/.test(model)
}

/** Models that accept `output_config.effort`. Haiku 4.5 and Sonnet 4.5 reject it. */
export function anthropicSupportsEffort(model: string): boolean {
  return /^claude-(fable-5|mythos-5|opus-5|opus-4-8|opus-4-7|opus-4-6|opus-4-5|sonnet-5|sonnet-4-6)/.test(model)
}

/**
 * Builds the Anthropic request body. Kept pure so the capability rules above are unit-testable without
 * network access — getting them wrong breaks every AI feature in the app with an opaque 400.
 */
export function anthropicRequest(args: {
  model: string
  system: string
  messages: LlmMessage[]
  maxTokens: number
  temperature: number
  effort?: Effort
}): Anthropic.MessageCreateParamsNonStreaming {
  const body: Record<string, unknown> = {
    model: args.model,
    max_tokens: args.maxTokens,
    // The system prompt carries the transcript for chat, so cache it: follow-up turns are then much cheaper.
    system: [{ type: 'text', text: args.system, cache_control: { type: 'ephemeral' } }],
    messages: args.messages.map((m) => ({ role: m.role, content: m.content }))
  }
  if (anthropicSupportsSampling(args.model)) body.temperature = args.temperature
  if (args.effort && anthropicSupportsEffort(args.model)) body.output_config = { effort: args.effort }
  return body as unknown as Anthropic.MessageCreateParamsNonStreaming
}

/** Turns an Anthropic refusal (HTTP 200, stop_reason "refusal") into a message the user can act on. */
function refusalMessage(category?: string | null): string {
  return `Claude hafnaði beiðninni${category ? ` (flokkur: ${category})` : ''}. Þetta gerist stundum ef efni fundarins ræsir öryggissíu. Prófaðu annað sniðmát, styttri kafla, eða aðra þjónustu í Stillingar → Gervigreind.`
}

/**
 * Turns an SDK failure into something the user can act on. Without this the app shows the raw SDK message
 * (`401 {"type":"error",...}`), which says nothing about what to do next.
 */
function anthropicFailure(err: unknown): Error {
  if (err instanceof Anthropic.AuthenticationError) {
    return new Error('Anthropic hafnaði API lyklinum. Athugaðu hvort hann sé réttur og enn virkur (Stillingar → Gervigreind).')
  }
  if (err instanceof Anthropic.PermissionDeniedError) {
    return new Error('Lykillinn hefur ekki aðgang að þessu líkani. Veldu annað líkan eða lykil með aðgang (Stillingar → Gervigreind).')
  }
  if (err instanceof Anthropic.RateLimitError) {
    return new Error('Of margar beiðnir á Anthropic í bili. Bíddu í mínútu og reyndu aftur.')
  }
  if (err instanceof Anthropic.NotFoundError) {
    return new Error('Líkanið fannst ekki hjá Anthropic. Athugaðu heiti líkansins í stillingum.')
  }
  if (err instanceof Anthropic.BadRequestError) {
    return new Error(`Anthropic hafnaði beiðninni: ${err.message}`)
  }
  if (err instanceof Anthropic.APIConnectionError) {
    return new Error('Náðist ekki samband við Anthropic. Athugaðu nettenginguna.')
  }
  if (err instanceof Anthropic.APIError) {
    return new Error(`Anthropic svaraði villu (${err.status ?? '?'}): ${err.message}`)
  }
  return err instanceof Error ? err : new Error(String(err))
}

/**
 * Whether the chosen AI provider can actually be called. Someone who skipped the AI step, or picked a provider
 * and never pasted a key, has said no to AI as clearly as choosing "Engin"; the app must not answer every
 * meeting they record with an error about a missing key.
 */
export function llmConfigured(): boolean {
  const s = getSettings().llm
  switch (s.provider) {
    case 'anthropic':
      return !!s.anthropicApiKey.trim()
    case 'openai':
      return !!s.openaiApiKey.trim()
    case 'ollama':
      return !!s.ollamaUrl.trim()
    default:
      return false
  }
}

export async function complete(
  system: string,
  messages: LlmMessage[],
  opts: { maxTokens?: number; temperature?: number; effort?: Effort } = {}
): Promise<LlmResult> {
  const s = getSettings().llm
  const maxTokens = opts.maxTokens ?? 16000
  const temperature = opts.temperature ?? 0.2
  switch (s.provider) {
    case 'anthropic': {
      if (!s.anthropicApiKey) throw new Error('Anthropic API lykil vantar (Stillingar → Gervigreind)')
      const model = s.anthropicModel || 'claude-opus-5'
      const client = new Anthropic({ apiKey: s.anthropicApiKey })
      const params = anthropicRequest({ model, system, messages, maxTokens, temperature, effort: opts.effort })
      let res: Anthropic.Message
      try {
        // Streamed: an hour-long meeting is a large prompt and a long answer, and a non-streaming request of
        // that size is the one that runs into request timeouts.
        res = await client.messages.stream(params).finalMessage()
      } catch (err) {
        throw anthropicFailure(err)
      }
      if (res.stop_reason === 'refusal') {
        const details = (res as { stop_details?: { category?: string | null } }).stop_details
        throw new Error(refusalMessage(details?.category))
      }
      const text = res.content.map((c) => (c.type === 'text' ? c.text : '')).join('')
      if (!text.trim() && res.stop_reason === 'max_tokens') {
        throw new Error('Svarið rúmaðist ekki innan token-marka. Prófaðu styttri fund eða annað sniðmát.')
      }
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
    // Budget has to leave room for thinking tokens: current Claude models think by default, and a tiny
    // max_tokens would be spent before any visible text is produced.
    const r = await complete('Svaraðu með einu orði.', [{ role: 'user', content: 'Segðu „Halló“ á íslensku.' }], { maxTokens: 2000, temperature: 0, effort: 'low' })
    return { ok: true, message: `Tenging virkar (${r.provider} / ${r.model}): ${r.text.trim().slice(0, 40)}` }
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) }
  }
}
