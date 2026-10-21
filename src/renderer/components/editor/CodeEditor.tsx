/**
 * The code editor of the Files and Notes drawers (v2.2, E9): CodeMirror 6
 * with the usual VS Code keys (Ctrl+S save, Ctrl+F find, Ctrl+H replace, Ctrl+D
 * next match, Alt+Up/Down move line, Ctrl+/ comment, multi-cursor with
 * Alt+click), the app's theme and font, and the file's grammar loaded on
 * demand. The text is the caller's: `onChange` reports every edit and a new
 * `docKey` (another file, a reload) replaces the document and its history.
 * Find and replace is the app's widget (`cmFind.tsx`, v2.3).
 */
import { useEffect, useRef } from 'react'
import { Compartment, EditorState, type Extension } from '@codemirror/state'
import {
  EditorView,
  crosshairCursor,
  drawSelection,
  dropCursor,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  rectangularSelection,
} from '@codemirror/view'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { highlightSelectionMatches, searchKeymap } from '@codemirror/search'
import { closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete'
import { bracketMatching, foldGutter, foldKeymap, indentOnInput } from '@codemirror/language'
import type { ThemeTokens } from '@shared/types'
import { editorTheme } from './editorTheme'
import { loadLanguage } from './languages'
import { useCmFind } from './cmFind'

export interface CodeEditorProps {
  /** Identity of the document: a change replaces the text, the selection and the undo history. */
  docKey: string
  /** The text loaded for `docKey` (read only when `docKey` changes). */
  initialText: string
  /** File name, for the grammar ('' = plain text). */
  fileName: string
  readOnly?: boolean
  wrap?: boolean
  /** Line numbers and folding (off for notes). */
  gutters?: boolean
  tokens: ThemeTokens
  light: boolean
  fontFamily: string
  fontSize: number
  autoFocus?: boolean
  onChange?: (text: string) => void
  onSave?: () => void
  onCursor?: (line: number, col: number) => void
  /** The live view, for callers that read or replace the text. */
  onView?: (view: EditorView | null) => void
}

export function CodeEditor(props: CodeEditorProps) {
  const host = useRef<HTMLDivElement | null>(null)
  const view = useRef<EditorView | null>(null)
  const latest = useRef(props)
  latest.current = props
  const compartments = useRef({ lang: new Compartment(), theme: new Compartment(), wrap: new Compartment(), readOnly: new Compartment() })
  const find = useCmFind()

  // One view per document key: a new key builds a fresh state (no undo across files).
  useEffect(() => {
    const el = host.current
    if (!el) return
    const p = latest.current
    const c = compartments.current
    const base: Extension[] = [
      highlightSpecialChars(),
      history(),
      drawSelection(),
      dropCursor(),
      EditorState.allowMultipleSelections.of(true),
      indentOnInput(),
      bracketMatching(),
      closeBrackets(),
      rectangularSelection(),
      crosshairCursor(),
      highlightActiveLine(),
      highlightSelectionMatches(),
      find.extension(),
      keymap.of([
        { key: 'Mod-s', preventDefault: true, run: () => (latest.current.onSave?.(), true) },
        ...closeBracketsKeymap,
        ...defaultKeymap,
        ...find.keys(),
        ...searchKeymap,
        ...historyKeymap,
        ...foldKeymap,
        indentWithTab,
      ]),
      EditorView.updateListener.of((u) => {
        if (u.docChanged) latest.current.onChange?.(u.state.doc.toString())
        if (u.selectionSet || u.docChanged) {
          const head = u.state.selection.main.head
          const line = u.state.doc.lineAt(head)
          latest.current.onCursor?.(line.number, head - line.from + 1)
        }
      }),
      c.lang.of([]),
      c.theme.of(editorTheme(p.tokens, p.light, p.fontFamily, p.fontSize)),
      c.wrap.of(p.wrap ? EditorView.lineWrapping : []),
      c.readOnly.of(EditorState.readOnly.of(!!p.readOnly)),
    ]
    if (p.gutters !== false) base.unshift(lineNumbers(), highlightActiveLineGutter(), foldGutter())
    const v = new EditorView({ state: EditorState.create({ doc: p.initialText, extensions: base }), parent: el })
    view.current = v
    p.onView?.(v)
    p.onCursor?.(1, 1)
    if (p.autoFocus) v.focus()
    let alive = true
    void loadLanguage(p.fileName).then((lang) => {
      if (alive && lang && view.current === v) v.dispatch({ effects: c.lang.reconfigure(lang) })
    })
    return () => {
      alive = false
      latest.current.onView?.(null)
      v.destroy()
      if (view.current === v) view.current = null
    }
    // Only a new document rebuilds the view; the rest is reconfigured below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.docKey])

  useEffect(() => {
    view.current?.dispatch({ effects: compartments.current.theme.reconfigure(editorTheme(props.tokens, props.light, props.fontFamily, props.fontSize)) })
  }, [props.tokens, props.light, props.fontFamily, props.fontSize])

  useEffect(() => {
    view.current?.dispatch({ effects: compartments.current.wrap.reconfigure(props.wrap ? EditorView.lineWrapping : []) })
  }, [props.wrap])

  useEffect(() => {
    view.current?.dispatch({ effects: compartments.current.readOnly.reconfigure(EditorState.readOnly.of(!!props.readOnly)) })
  }, [props.readOnly])

  return (
    <>
      <div ref={host} data-code-editor className="h-full min-h-0 overflow-hidden" />
      {find.portal}
    </>
  )
}
