import { createContext, useContext, useMemo, type ReactNode } from 'react'
import type { Language } from '@shared/types'
import { en } from './en'
import { es } from './es'

export type MessageKey = keyof typeof en
type Vars = Record<string, string | number>
export type TFn = (key: MessageKey, vars?: Vars) => string

const DICTIONARIES: Record<Language, Record<MessageKey, string>> = { en, es }

function interpolate(template: string, vars?: Vars): string {
  if (!vars) return template
  return template.replace(/\{(\w+)\}/g, (_m, key: string) =>
    key in vars ? String(vars[key]) : `{${key}}`,
  )
}

interface I18nValue {
  lang: Language
  t: TFn
}

const I18nContext = createContext<I18nValue>({
  lang: 'en',
  t: (key) => en[key],
})

export function I18nProvider({
  lang,
  children,
}: {
  lang: Language
  children: ReactNode
}): ReactNode {
  const value = useMemo<I18nValue>(() => {
    const dict = DICTIONARIES[lang] ?? en
    const t: TFn = (key, vars) => interpolate(dict[key] ?? en[key] ?? key, vars)
    return { lang, t }
  }, [lang])

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>
}

export function useT(): TFn {
  return useContext(I18nContext).t
}

export function useLang(): Language {
  return useContext(I18nContext).lang
}
