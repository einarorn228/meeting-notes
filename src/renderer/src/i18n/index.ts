import { createContext, createElement, useCallback, useContext, useMemo, type ReactNode } from 'react'
import { is, type TranslationKey } from './is'
import { en } from './en'

export type UiLanguage = 'is' | 'en'
export type { TranslationKey }
export type Vars = Record<string, string | number>

const dictionaries: Record<UiLanguage, Record<TranslationKey, string>> = { is, en }

export function translate(lang: UiLanguage, key: TranslationKey, vars?: Vars): string {
  const dict = dictionaries[lang] ?? is
  let str = dict[key] ?? is[key] ?? key
  if (vars) for (const [k, v] of Object.entries(vars)) str = str.split(`{${k}}`).join(String(v))
  return str
}

/** Looks up a key that may or may not exist (e.g. built dynamically) and falls back to a default string. */
export function translateMaybe(lang: UiLanguage, key: string, fallback: string, vars?: Vars): string {
  if (key in is) return translate(lang, key as TranslationKey, vars)
  return fallback
}

export interface I18n {
  lang: UiLanguage
  t: (key: TranslationKey, vars?: Vars) => string
  /** Dynamic keys (e.g. `app.${id}`) with fallback. */
  tm: (key: string, fallback: string, vars?: Vars) => string
  locale: string
}

const I18nContext = createContext<I18n>({
  lang: 'is',
  t: (k, v) => translate('is', k, v),
  tm: (k, f, v) => translateMaybe('is', k, f, v),
  locale: 'is-IS'
})

export function I18nProvider({ lang, children }: { lang: UiLanguage; children: ReactNode }): ReactNode {
  const t = useCallback((key: TranslationKey, vars?: Vars) => translate(lang, key, vars), [lang])
  const tm = useCallback((key: string, fallback: string, vars?: Vars) => translateMaybe(lang, key, fallback, vars), [lang])
  const value = useMemo<I18n>(() => ({ lang, t, tm, locale: lang === 'is' ? 'is-IS' : 'en-GB' }), [lang, t, tm])
  return createElement(I18nContext.Provider, { value }, children)
}

export function useI18n(): I18n {
  return useContext(I18nContext)
}

export function useT(): I18n['t'] {
  return useContext(I18nContext).t
}
