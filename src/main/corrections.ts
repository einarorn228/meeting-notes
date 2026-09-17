/**
 * What the user corrected, remembered.
 *
 * When a transcript line is edited, the words that changed are the recogniser's mistakes as this user hears
 * them: "ýkja" for IKEA, "vorm kittí" for warm kitty, a colleague's name spelled by ear. The recogniser itself
 * cannot be taught them - handing it a word list makes it worse (docs/research/05-measurements.md) - but the
 * app can learn them. A correction the user has made twice is applied to new lines on its own, and every
 * correction goes to the AI pass as an example of what this user's meetings sound like to the model.
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Correction } from '../shared/types'
import { dataDir } from './settings'

/** A correction made this often is applied to new lines without asking. */
export const AUTO_APPLY_AFTER = 2
/** A change longer than this is a rewrite, not a word the recogniser got wrong. */
const MAX_SPAN = 4
const MAX_KEPT = 300

let cached: Correction[] | null = null

function filePath(): string {
  return join(dataDir(), 'corrections.json')
}

function load(): Correction[] {
  if (cached) return cached
  try {
    const p = filePath()
    cached = existsSync(p) ? (JSON.parse(readFileSync(p, 'utf8')) as Correction[]).filter((c) => c && typeof c.from === 'string' && typeof c.to === 'string') : []
  } catch {
    // No data directory (tests that mock settings) or an unreadable file: nothing learned, nothing broken.
    cached = []
  }
  return cached
}

function persist(list: Correction[]): void {
  cached = list
  compiled = null
  try {
    const p = filePath()
    writeFileSync(p + '.tmp', JSON.stringify(list, null, 2), 'utf8')
    renameSync(p + '.tmp', p)
  } catch {
    // Not being able to remember a correction must never fail the edit that taught it.
  }
}

const EDGE = /^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu

/** A word as the recogniser and the user would both write it: no case, no punctuation around it. */
function key(token: string): string {
  return token.replace(EDGE, '').toLowerCase()
}

/**
 * The spans that changed between two versions of a line, as (before, after) pairs of at most MAX_SPAN words
 * each. Anchored on the words that stayed, so "besta ýkja sem" edited to "besta IKEA sem" gives one pair.
 */
export function changedSpans(before: string, after: string): { from: string; to: string }[] {
  const a = before.split(/\s+/).filter(Boolean)
  const b = after.split(/\s+/).filter(Boolean)
  const ka = a.map(key)
  const kb = b.map(key)
  // Longest common subsequence on normalised words; lines are short, so the quadratic table is nothing.
  const dp: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0))
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      dp[i][j] = ka[i] === kb[j] && ka[i] !== '' ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }
  const out: { from: string; to: string }[] = []
  let i = 0
  let j = 0
  let runA: string[] = []
  let runB: string[] = []
  const flush = (): void => {
    const from = runA.map(key).filter(Boolean).join(' ')
    const to = runB.map((t) => t.replace(EDGE, '')).filter(Boolean).join(' ')
    // A word dropped or added is not a mishearing, and a run beyond MAX_SPAN is a rewrite; a change of
    // punctuation alone is the punctuation pass's business.
    if (from && to && runA.length <= MAX_SPAN && runB.length <= MAX_SPAN && from !== to) out.push({ from, to })
    runA = []
    runB = []
  }
  while (i < a.length && j < b.length) {
    if (ka[i] === kb[j] && ka[i] !== '') {
      flush()
      // The same word in different letters is a correction too ("sap" to SAP, a name given its capital) -
      // except at the start of the line, where a capital is the sentence's, not the word's.
      const typed = b[j].replace(EDGE, '')
      if (i > 0 && j > 0 && a[i].replace(EDGE, '') !== typed) out.push({ from: ka[i], to: typed })
      i++
      j++
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      runA.push(a[i++])
    } else {
      runB.push(b[j++])
    }
  }
  while (i < a.length) runA.push(a[i++])
  while (j < b.length) runB.push(b[j++])
  flush()
  return out
}

/** Called when the user saves an edited line. Returns what was learned from it. */
export function learnFromEdit(before: string, after: string): Correction[] {
  const spans = changedSpans(before, after)
  if (!spans.length) return []
  const now = new Date().toISOString()
  const list = [...load()]
  const learned: Correction[] = []
  for (const { from, to } of spans) {
    const existing = list.find((c) => c.from === from)
    if (existing) {
      // The latest spelling wins: the user may have refined an earlier correction.
      existing.to = to
      existing.count += 1
      existing.lastAt = now
      learned.push(existing)
    } else {
      const c = { from, to, count: 1, lastAt: now }
      list.push(c)
      learned.push(c)
    }
  }
  list.sort((x, y) => y.count - x.count || y.lastAt.localeCompare(x.lastAt))
  persist(list.slice(0, MAX_KEPT))
  return learned
}

export function listCorrections(): Correction[] {
  return [...load()]
}

export function forgetCorrection(from: string): Correction[] {
  persist(load().filter((c) => c.from !== from))
  return listCorrections()
}

/** Test seam: forget the file's contents, not the file. */
export function resetCorrectionsCache(): void {
  cached = null
  compiled = null
}

let compiled: { pattern: RegExp; lookup: Map<string, string> } | null = null

function autoApplied(): { pattern: RegExp; lookup: Map<string, string> } | null {
  if (compiled) return compiled
  const auto = load().filter((c) => c.count >= AUTO_APPLY_AFTER)
  if (!auto.length) return null
  // Longest first, so "vorm kittí" is matched before a rule for "vorm" alone could split it.
  const sorted = [...auto].sort((x, y) => y.from.length - x.from.length)
  const alternation = sorted.map((c) => c.from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '\\s+')).join('|')
  compiled = {
    pattern: new RegExp(`(?<![\\p{L}\\p{N}])(?:${alternation})(?![\\p{L}\\p{N}])`, 'giu'),
    lookup: new Map(sorted.map((c) => [c.from, c.to]))
  }
  return compiled
}

/** Rewrites the words the user has corrected at least AUTO_APPLY_AFTER times; everything else is left as is. */
export function applyCorrections(text: string): string {
  if (!text) return text
  const c = autoApplied()
  if (!c) return text
  return text.replace(c.pattern, (match: string) => {
    const to = c.lookup.get(match.toLowerCase().replace(/\s+/g, ' '))
    if (to === undefined) return match
    // A line starts with a capital; a correction typed mid-sentence should not take it away.
    const first = match[0]
    return first === first.toUpperCase() && first !== first.toLowerCase() && to[0] === to[0].toLowerCase() ? to[0].toUpperCase() + to.slice(1) : to
  })
}

/** The corrections worth showing the AI pass, most often made first. */
export function correctionsForPrompt(limit = 40): { from: string; to: string }[] {
  return load()
    .slice(0, limit)
    .map((c) => ({ from: c.from, to: c.to }))
}
