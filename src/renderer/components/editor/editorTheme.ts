/**
 * The code editor's look (v2.2, E9) from the app's theme: chrome from the
 * CSS variables (so a theme switch repaints it), syntax colors from the
 * theme's ANSI palette (the same colors the terminal uses).
 */
import type { Extension } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { tags as t } from '@lezer/highlight'
import type { ThemeTokens } from '@shared/types'

export function editorTheme(tokens: ThemeTokens, light: boolean, fontFamily: string, fontSize: number): Extension[] {
  const chrome = EditorView.theme(
    {
      '&': { height: '100%', backgroundColor: 'var(--color-bg-primary)', color: 'var(--color-text-primary)', fontSize: `${fontSize}px` },
      '.cm-scroller': { fontFamily, lineHeight: '1.5' },
      '.cm-content': { caretColor: 'var(--color-accent-violet)' },
      '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--color-accent-violet)', borderLeftWidth: '2px' },
      '&.cm-focused': { outline: 'none' },
      '.cm-gutters': { backgroundColor: 'var(--color-bg-primary)', color: 'var(--color-text-secondary)', border: 'none', borderRight: '1px solid var(--color-border)' },
      '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--color-text-primary)' },
      '.cm-activeLine': { backgroundColor: 'color-mix(in srgb, var(--color-accent-violet) 7%, transparent)' },
      '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, ::selection': {
        backgroundColor: 'color-mix(in srgb, var(--color-accent-violet) 35%, transparent) !important',
      },
      '.cm-selectionMatch': { backgroundColor: 'color-mix(in srgb, var(--color-accent-blue) 22%, transparent)' },
      '.cm-matchingBracket, &.cm-focused .cm-matchingBracket': { backgroundColor: 'color-mix(in srgb, var(--color-accent-violet) 25%, transparent)', outline: 'none' },
      '.cm-searchMatch': { backgroundColor: 'color-mix(in srgb, var(--color-state-action) 30%, transparent)' },
      '.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: 'color-mix(in srgb, var(--color-state-action) 55%, transparent)' },
      '.cm-foldPlaceholder': { backgroundColor: 'var(--color-card)', border: '1px solid var(--color-border)', color: 'var(--color-text-secondary)' },
      '.cm-panels': { backgroundColor: 'var(--color-bg-secondary)', color: 'var(--color-text-primary)' },
      // The find widget (cmFind.tsx) floats over the text: the top panel takes no room.
      '.cm-panels.cm-panels-top': { backgroundColor: 'transparent', border: 'none', height: '0', overflow: 'visible' },
      '.cm-panels.cm-panels-bottom': { borderTop: '1px solid var(--color-border)' },
      // CodeMirror's own dialogs (Go to line, Ctrl+Alt+G) still open at the bottom.
      '.cm-panels-bottom .cm-textfield': { backgroundColor: 'var(--color-bg-primary)', color: 'var(--color-text-primary)', border: '1px solid var(--color-border)', borderRadius: '6px' },
      '.cm-panels-bottom .cm-button': { backgroundImage: 'none', backgroundColor: 'var(--color-card)', color: 'var(--color-text-primary)', border: '1px solid var(--color-border)', borderRadius: '6px' },
      '.cm-tooltip': { backgroundColor: 'var(--color-card)', border: '1px solid var(--color-border)', color: 'var(--color-text-primary)' },
    },
    { dark: !light },
  )
  const c = (k: keyof ThemeTokens): string => tokens[k]
  const syntax = HighlightStyle.define([
    { tag: [t.keyword, t.controlKeyword, t.moduleKeyword, t.operatorKeyword, t.definitionKeyword], color: c('ansi-magenta') },
    { tag: [t.string, t.special(t.string), t.regexp, t.character], color: c('ansi-green') },
    { tag: [t.number, t.bool, t.null, t.atom, t.unit], color: c('ansi-yellow') },
    { tag: [t.comment, t.lineComment, t.blockComment, t.docComment], color: c('ansi-brightBlack'), fontStyle: 'italic' },
    { tag: [t.function(t.variableName), t.function(t.propertyName), t.definition(t.function(t.variableName))], color: c('ansi-blue') },
    { tag: [t.typeName, t.className, t.namespace, t.definition(t.typeName)], color: c('ansi-cyan') },
    { tag: [t.propertyName, t.attributeName], color: c('ansi-brightBlue') },
    { tag: [t.tagName, t.angleBracket], color: c('ansi-red') },
    { tag: [t.meta, t.annotation, t.processingInstruction], color: c('ansi-brightYellow') },
    { tag: [t.operator, t.punctuation, t.separator, t.bracket], color: 'var(--color-text-secondary)' },
    { tag: t.heading, color: c('ansi-brightBlue'), fontWeight: '700' },
    { tag: [t.link, t.url], color: c('ansi-blue'), textDecoration: 'underline' },
    { tag: t.emphasis, fontStyle: 'italic' },
    { tag: t.strong, fontWeight: '700' },
    { tag: t.strikethrough, textDecoration: 'line-through' },
    { tag: [t.monospace, t.quote], color: c('ansi-cyan') },
    { tag: [t.inserted], color: c('ansi-green') },
    { tag: [t.deleted, t.invalid], color: c('ansi-red') },
  ])
  return [chrome, syntaxHighlighting(syntax)]
}
