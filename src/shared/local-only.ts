/**
 * "Aðeins á þessari vél": what stays on the computer and what would leave it.
 *
 * The meeting leaves the machine in two places only: the audio, when a cloud speech service transcribes it, and
 * the transcript, when a hosted language model punctuates it or writes the minutes. Updates, model downloads
 * and calendar feeds carry nothing that was said, so the switch does not touch them.
 */
import type { EngineId, Settings } from './types'

export const LOCAL_ONLY_REFUSAL = 'Stillingin „Aðeins á þessari vél“ er á: ekkert úr fundinum er sent út af tölvunni.'

/** True only for an address on this computer. A LAN address is another machine, however close it is. */
export function isLoopbackUrl(url: string): boolean {
  let host: string
  try {
    host = new URL(url).hostname.toLowerCase()
  } catch {
    return false
  }
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1'
}

export function llmStaysLocal(llm: Settings['llm']): boolean {
  if (llm.provider === 'none') return true
  return llm.provider === 'ollama' && isLoopbackUrl(llm.ollamaUrl || 'http://127.0.0.1:11434')
}

/** The engine a recording will really use: the chosen one, or the local one when nothing may leave. */
export function effectiveEngine(s: Pick<Settings, 'localOnly' | 'engine'>): EngineId {
  return s.localOnly ? 'local' : s.engine
}

/** Which parts of a meeting the current choices send away, ignoring the switch. For showing the user. */
export function leavesTheMachine(s: Pick<Settings, 'engine' | 'llm'>): ('speech' | 'text')[] {
  const out: ('speech' | 'text')[] = []
  if (s.engine !== 'local') out.push('speech')
  if (!llmStaysLocal(s.llm)) out.push('text')
  return out
}
