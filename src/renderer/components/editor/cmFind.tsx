/**
 * CodeMirror's search with the app's find widget (v2.3): `search()` still
 * owns the query, the match highlights (drawn only while its panel is open)
 * and the commands, but the panel is an empty host where `ui/FindWidget`
 * mounts through a portal (so it gets the app's i18n). Typing jumps to the
 * nearest match, the counter reads "3 of 12" and a read-only document shows
 * no replace row. Ctrl+F opens find alone and Ctrl+H find with replace (its
 * field takes the focus), as in VS Code; every opening starts without the
 * replace row. The Aa / word / regex choices last for the app session.
 * While open the text gets the widget's height as room on top (VS Code's
 * extra space on top), so the first lines and a found match never hide under it.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { EditorSelection, type Extension } from '@codemirror/state'
import { EditorView, runScopeHandlers, type KeyBinding } from '@codemirror/view'
import { SearchQuery, closeSearchPanel, findNext, findPrevious, getSearchQuery, openSearchPanel, replaceAll, replaceNext, search, searchPanelOpen, setSearchQuery } from '@codemirror/search'
import { FindWidget } from '@/components/ui/FindWidget'
import { collectMatches, currentIndex, type FindOptions } from '@/components/ui/findLogic'

/** The last options chosen in any editor, in memory. */
let remembered: FindOptions | null = null

/** The room the open widget takes over each view's text, in px. */
const room = new WeakMap<EditorView, number>()
const roomOf = (view: EditorView): number => (searchPanelOpen(view.state) ? (room.get(view) ?? 0) : 0)

/** Padding on top of the text (scrolls away with it) and a scroll margin for the jumps to a match. */
const findRoom: Extension = [
  EditorView.contentAttributes.of((view) => {
    const h = roomOf(view)
    return h ? { style: `padding-top: ${h}px` } : null
  }),
  EditorView.scrollMargins.of((view) => {
    const h = roomOf(view)
    return h ? { top: h } : null
  }),
]

interface Host {
  dom: HTMLElement
  view: EditorView
}

interface QuerySpec extends FindOptions {
  search: string
  replace: string
}

function specOf(q: SearchQuery): QuerySpec {
  return { search: q.search, replace: q.replace, caseSensitive: q.caseSensitive, wholeWord: q.wholeWord, regexp: q.regexp }
}

/** Selects the first match from the selection on (wrapping), as VS Code does while typing. */
function selectNearest(view: EditorView, query: SearchQuery): void {
  if (!query.valid) return
  const from = view.state.selection.main.from
  let m = query.getCursor(view.state, from).next()
  if (m.done) m = query.getCursor(view.state, 0, from).next()
  if (m.done) return
  view.dispatch({ selection: EditorSelection.single(m.value.from, m.value.to), scrollIntoView: true, userEvent: 'select.search' })
}

function CmFind({
  view,
  dom,
  replaceOpen,
  replaceFocus,
  onReplaceOpen,
}: {
  view: EditorView
  dom: HTMLElement
  replaceOpen: boolean
  replaceFocus: number
  onReplaceOpen: (open: boolean) => void
}) {
  const state = view.state

  // Keeps the room on top equal to the widget (one or two rows, any zoom).
  useLayoutEffect(() => {
    const el = dom.querySelector<HTMLElement>('[data-find-widget]')
    if (!el) return
    const sync = (): void => {
      const h = Math.ceil(el.offsetTop + el.offsetHeight + 4)
      if (room.get(view) === h) return
      room.set(view, h)
      // An empty transaction recomputes the content attributes.
      if (!view.dom.isConnected) return
      view.dispatch({})
    }
    sync()
    const ro = new ResizeObserver(sync)
    ro.observe(el)
    return () => {
      ro.disconnect()
      room.delete(view)
    }
  }, [view, dom])

  const query = getSearchQuery(state)
  const options: FindOptions = { caseSensitive: query.caseSensitive, wholeWord: query.wholeWord, regexp: query.regexp }
  const invalid = !!query.search && query.regexp && !query.valid
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const matches = useMemo(() => (query.valid ? collectMatches(query.getCursor(state)) : null), [state.doc, query])
  const sel = state.selection.main
  const result = matches ? { index: currentIndex(matches.ranges, sel), total: matches.ranges.length, capped: matches.capped } : null

  const write = (patch: Partial<QuerySpec>, jump: boolean): void => {
    const cur = getSearchQuery(view.state)
    const next = new SearchQuery({ ...specOf(cur), ...patch, literal: true })
    if (next.eq(cur)) return
    view.dispatch({ effects: setSearchQuery.of(next) })
    if (jump) selectNearest(view, next)
  }

  // A new editor starts with the options chosen last.
  useEffect(() => {
    const cur = getSearchQuery(view.state)
    if (remembered && (remembered.caseSensitive !== cur.caseSensitive || remembered.wholeWord !== cur.wholeWord || remembered.regexp !== cur.regexp)) write(remembered, false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view])

  return (
    <FindWidget
      query={query.search}
      onQuery={(search) => write({ search }, true)}
      options={options}
      onOptions={(next) => {
        remembered = next
        write(next, true)
      }}
      result={result}
      invalid={invalid}
      onNext={() => findNext(view)}
      onPrev={() => findPrevious(view)}
      onClose={() => closeSearchPanel(view)}
      onOtherKey={(e) => {
        if (runScopeHandlers(view, e.nativeEvent, 'search-panel')) e.preventDefault()
      }}
      replaceFocusToken={replaceFocus}
      replace={
        state.readOnly
          ? undefined
          : {
              open: replaceOpen,
              onOpen: onReplaceOpen,
              value: query.replace,
              onValue: (replace) => write({ replace }, false),
              onReplace: () => replaceNext(view),
              onReplaceAll: () => replaceAll(view),
            }
      }
    />
  )
}

/**
 * The find of one CodeEditor: `extension()` and `keys()` go into each new view
 * (the keys before `searchKeymap`), `portal` renders the widget while open.
 */
export function useCmFind(): { extension: () => Extension; keys: () => readonly KeyBinding[]; portal: ReactNode } {
  const [host, setHost] = useState<Host | null>(null)
  const [, setTick] = useState(0)
  const [replaceOpen, setReplaceOpen] = useState(false)
  // Bumped by Ctrl+H from the text; 0 while closed, so a Ctrl+F opening never focuses replace.
  const [replaceFocus, setReplaceFocus] = useState(0)
  const hostDom = useRef<HTMLElement | null>(null)

  const api = useMemo(
    () => ({
      extension: (): Extension => [
        findRoom,
        search({
          top: true,
          literal: true,
          createPanel: (view) => {
            const dom = document.createElement('div')
            dom.className = 'cm-sn-find'
            return {
              dom,
              top: true,
              mount: () => {
                hostDom.current = dom
                setHost({ dom, view })
              },
              // Any transaction can move the counter (an edit, the selection, the query, read-only).
              update: (u) => {
                if (u.transactions.length) setTick((n) => n + 1)
              },
              // Closing forgets the replace row: the next Ctrl+F opens find alone.
              destroy: () => {
                if (hostDom.current !== dom) return
                hostDom.current = null
                setHost(null)
                setReplaceOpen(false)
                setReplaceFocus(0)
              },
            }
          },
        }),
      ],
      // Ctrl+F: find alone (it hides an open replace row). Ctrl+H: find with the replace
      // row open and its field focused (read-only documents only find).
      keys: (): readonly KeyBinding[] => [
        {
          key: 'Mod-f',
          preventDefault: true,
          run: (view) => {
            setReplaceOpen(false)
            return openSearchPanel(view)
          },
        },
        {
          key: 'Mod-h',
          preventDefault: true,
          run: (view) => {
            if (!view.state.readOnly) {
              setReplaceOpen(true)
              setReplaceFocus((n) => n + 1)
            }
            return openSearchPanel(view)
          },
        },
      ],
    }),
    [],
  )

  const portal = host ? createPortal(<CmFind view={host.view} dom={host.dom} replaceOpen={replaceOpen} replaceFocus={replaceFocus} onReplaceOpen={setReplaceOpen} />, host.dom) : null
  return { ...api, portal }
}
