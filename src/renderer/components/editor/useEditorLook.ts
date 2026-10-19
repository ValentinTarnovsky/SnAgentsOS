import { useMemo } from 'react'
import { useAppStore } from '@/lib/store'
import { THEMES, resolveTokens } from '@/themes'

/** The editor follows the app: theme tokens, light or dark, the terminal's font and size. */
export function useEditorLook() {
  const theme = useAppStore((s) => s.settings.theme)
  const customColors = useAppStore((s) => s.settings.customColors)
  const fontFamily = useAppStore((s) => s.settings.fontFamily)
  const fontSize = useAppStore((s) => s.settings.fontSize)
  const tokens = useMemo(() => resolveTokens(theme, customColors), [theme, customColors])
  return { tokens, light: !!THEMES[theme]?.light, fontFamily, fontSize }
}
