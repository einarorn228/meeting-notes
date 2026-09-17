/**
 * The app learns from the user's corrections.
 *
 * The recogniser writes what it hears ("ýkja" for IKEA); the user fixes the line; the next time the same
 * mishearing comes up the app should know. What must not happen: learning a rewrite as if it were a word,
 * treating a comma as a correction, or applying something the user did only once.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = mkdtempSync(join(tmpdir(), 'corr-'))

vi.mock('electron', () => ({ app: { getPath: () => root, isPackaged: false } }))
vi.mock('../src/main/settings', () => ({ dataDir: () => root }))

const { applyCorrections, changedSpans, correctionsForPrompt, forgetCorrection, learnFromEdit, listCorrections, resetCorrectionsCache } = await import('../src/main/corrections')

beforeEach(() => {
  for (const c of listCorrections()) forgetCorrection(c.from)
  resetCorrectionsCache()
})

describe('what an edit teaches', () => {
  it('finds the words that changed and nothing else', () => {
    expect(changedSpans('Þetta er besta ýkja app sem ég hef notað.', 'Þetta er besta IKEA app sem ég hef notað.')).toEqual([{ from: 'ýkja', to: 'IKEA' }])
    expect(changedSpans('við þurfum að koma honum öpp tú spíd fyrir mánudag', 'Við þurfum að koma honum up to speed fyrir mánudag.')).toEqual([
      { from: 'öpp tú spíd', to: 'up to speed' }
    ])
  })

  it('ignores punctuation and casing the user only tidied', () => {
    expect(changedSpans('já já við gerum það', 'Já, já - við gerum það.')).toEqual([])
  })

  it('keeps a casing fix: the user wants SAP written so', () => {
    expect(changedSpans('kerfið heitir sap', 'Kerfið heitir SAP.')).toEqual([{ from: 'sap', to: 'SAP' }])
  })

  it('does not learn a rewrite, a dropped filler or an added word', () => {
    expect(changedSpans('sko þetta var nú bara svona', 'Þetta var nú bara svona')).toEqual([])
    expect(changedSpans('við ræddum þetta', 'við ræddum þetta ítarlega')).toEqual([])
    expect(changedSpans('hann sagði að þetta yrði klárað fyrir helgi ef veður leyfir', 'Allt annað var sagt um verkið og lokafrestinn og veðrið')).toEqual([])
  })
})

describe('remembering and applying', () => {
  it('counts how often the same correction is made and keeps the latest spelling', () => {
    learnFromEdit('besta ýkja sem ég veit', 'besta Ikea sem ég veit')
    learnFromEdit('fórum í ýkja í gær', 'fórum í IKEA í gær')
    expect(listCorrections()).toEqual([expect.objectContaining({ from: 'ýkja', to: 'IKEA', count: 2 })])
  })

  it('applies a correction made twice, and leaves one made once alone', () => {
    learnFromEdit('besta ýkja sem ég veit', 'besta IKEA sem ég veit')
    expect(applyCorrections('við fórum í ýkja')).toBe('við fórum í ýkja')
    learnFromEdit('fórum í ýkja í gær', 'fórum í IKEA í gær')
    expect(applyCorrections('við fórum í ýkja')).toBe('við fórum í IKEA')
  })

  it('matches whole words only, keeps a capital at the start of a line, and handles several words', () => {
    for (let i = 0; i < 2; i++) {
      learnFromEdit('koma honum öpp tú spíd', 'koma honum up to speed')
      learnFromEdit('Rún kom', 'Rúna kom')
    }
    expect(applyCorrections('Öpp tú spíd fyrir mánudag')).toBe('Up to speed fyrir mánudag')
    expect(applyCorrections('Rún og Rúnar komu')).toBe('Rúna og Rúnar komu')
  })

  it('survives a settings module without a data directory', () => {
    expect(applyCorrections('')).toBe('')
    expect(correctionsForPrompt()).toEqual([])
  })

  it('gives the AI pass the corrections, most frequent first, and forgets on request', () => {
    learnFromEdit('a ýkja b', 'a IKEA b')
    learnFromEdit('c vorm kittí d', 'c warm kitty d')
    learnFromEdit('e ýkja f', 'e IKEA f')
    expect(correctionsForPrompt()).toEqual([
      { from: 'ýkja', to: 'IKEA' },
      { from: 'vorm kittí', to: 'warm kitty' }
    ])
    forgetCorrection('ýkja')
    expect(correctionsForPrompt()).toEqual([{ from: 'vorm kittí', to: 'warm kitty' }])
  })
})
