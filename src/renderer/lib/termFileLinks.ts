/**
 * Ctrl+click on `file:line` in a desktop terminal (app 2.7.0, A9). An xterm
 * link provider finds the paths of the hovered logical line with
 * `@shared/termLinks` (the phone's tap uses the same finder), asks main which
 * of them are files of the console's tree (`files:resolveRefs`, once per
 * line, cached a few seconds) and underlines only those. The answer comes
 * back later, so hovering never waits on main. Activating one opens it in
 * the Files drawer at its line and column; a plain click keeps selecting
 * text, and URLs stay with the web links addon.
 */
import type { IBufferRange, ILink, ILinkProvider, Terminal } from '@xterm/xterm'
import { FILE_REFS_MAX, FILE_REL_MAX, type FileRefResolved } from '@shared/files'
import { pathAt, urlRanges } from '@shared/termLinks'
import { translate, type MessageKey, type TFn } from '@/i18n'
import { useAppStore } from './store'
import { openFile, paneFilesKey, restoreUnsaved, showFilesTree } from './filesStore'
import { openSidePanel, sidePanelOf } from './sidePanels'
import { toast } from './toast'

/** One logical line: rows joined while xterm marks them wrapped, and the cell of every string index. */
export interface TermLine {
  text: string
  cells: Array<{ row: number; col: number; width: number }>
}

/** A path on a line: [start, end) string indices and the text sent to main. */
export interface PathSpan {
  start: number
  end: number
  ref: string
  /** A spaced path's own tokens, tried when the whole does not exist. */
  parts?: PathSpan[]
}

/** Longer logical lines are not scanned (a minified bundle, a progress bar run wild). */
const LINE_MAX = 4096
/** `pathAt` calls per line at most: the rest of a line of hundreds of tokens is left plain. */
const SCAN_CALLS = 256
/** How long a line's answer is reused before main is asked again. */
const CACHE_MS = 15_000
const CACHE_MAX = 200

/** Characters a path runs through; a new one can only start after anything else. */
const PATH_BODY = /[A-Za-z0-9._\-/\\]/

/**
 * The logical line holding buffer row `row` (0-based), walked as the phone's
 * `logicalLineAt` does. A wide character's spacer cell is skipped (its width
 * says how far it reaches); empty cells read as spaces. Null past LINE_MAX
 * characters: a blob wrapped over thousands of rows (a minified file, a long
 * JSON) is not walked on every hover, and it would not be scanned anyway.
 */
export function termLineAt(term: Terminal, row: number): TermLine | null {
  const buf = term.buffer.active
  if (!buf.getLine(row)) return null
  // A wrapped row is full, so it holds at least half its cells in characters.
  const maxRows = Math.ceil((2 * LINE_MAX) / Math.max(1, term.cols)) + 1
  let first = row
  while (first > 0 && buf.getLine(first)?.isWrapped) {
    first--
    if (row - first > maxRows) return null
  }
  const text: string[] = []
  const cells: TermLine['cells'] = []
  const cell = buf.getNullCell()
  for (let r = first; r < buf.length; r++) {
    const line = buf.getLine(r)
    if (!line || (r > first && !line.isWrapped)) break
    if (text.length > LINE_MAX) return null
    for (let c = 0; c < term.cols; c++) {
      if (!line.getCell(c, cell)) break
      const width = cell.getWidth()
      if (width === 0) continue
      const ch = cell.getChars() || ' '
      // UTF-16 units, so string indices line up with cells (an emoji is two).
      for (let k = 0; k < ch.length; k++) {
        text.push(ch[k])
        cells.push({ row: r, col: c, width })
      }
    }
  }
  return { text: text.join(''), cells }
}

/** A bare token without a separator or a letter extension is too vague (1.5, v2.0). */
function plausible(path: string): boolean {
  return /[\\/]/.test(path) || /\.[A-Za-z][A-Za-z0-9]*$/.test(path)
}

/**
 * Paths of a text with their spans, left to right. `pathAt` is asked only at
 * the start of a run of path characters, over the next FILE_REL_MAX
 * characters (no ref is longer), and a hit is taken from where it starts:
 * a line costs a handful of calls, at most `budget.calls` in all.
 */
function scanPaths(text: string, offset: number, nested: boolean, budget: { calls: number }): PathSpan[] {
  const out: PathSpan[] = []
  let i = 0
  while (i < text.length && budget.calls > 0) {
    const ch = text.charAt(i)
    if (/\s/.test(ch) || (i > 0 && PATH_BODY.test(text.charAt(i - 1)))) {
      i++
      continue
    }
    budget.calls--
    const win = text.slice(i, i + FILE_REL_MAX)
    const link = pathAt(win, 0)
    if (!link || link.kind !== 'path' || !win.startsWith(link.raw)) {
      i++
      continue
    }
    const end = i + link.raw.length
    // "src/a.ts and src/b.ts" reads as one spaced path: its words are tried too.
    const parts: PathSpan[] = []
    if (!nested && /\s/.test(link.raw)) {
      const word = /\S+/g
      let m: RegExpExecArray | null
      while ((m = word.exec(link.raw)) !== null) parts.push(...scanPaths(m[0], offset + i + m.index, true, budget))
    }
    if (plausible(link.path)) out.push(parts.length ? { start: offset + i, end: offset + end, ref: link.raw, parts } : { start: offset + i, end: offset + end, ref: link.raw })
    else out.push(...parts)
    i = end
  }
  return out
}

/** The file path candidates of one logical line, URLs left out (the web links addon has them). */
export function pathSpans(text: string): PathSpan[] {
  if (!text || text.length > LINE_MAX || !/[\\/.]/.test(text)) return []
  const urls = urlRanges(text)
  const free = (s: PathSpan): boolean => !urls.some((u) => s.start < u.end && u.start < s.end)
  const out: PathSpan[] = []
  for (const s of scanPaths(text, 0, false, { calls: SCAN_CALLS })) {
    const parts = s.parts?.filter(free) ?? []
    // A spaced path that runs into a URL keeps only its own words.
    if (!free(s)) out.push(...parts)
    else out.push(parts.length ? { ...s, parts } : { start: s.start, end: s.end, ref: s.ref })
  }
  return out
}

/** Every ref of the spans (wholes and parts), each once, in order. */
export function spanRefs(spans: PathSpan[]): string[] {
  const refs = new Set<string>()
  for (const s of spans) {
    refs.add(s.ref)
    for (const p of s.parts ?? []) refs.add(p.ref)
  }
  return [...refs]
}

/** What gets underlined: a whole path that exists, else the parts of it that do. */
export function existingSpans(spans: PathSpan[], exists: (ref: string) => boolean): PathSpan[] {
  const out: PathSpan[] = []
  for (const s of spans) {
    if (exists(s.ref)) out.push({ start: s.start, end: s.end, ref: s.ref })
    else for (const p of s.parts ?? []) if (exists(p.ref)) out.push(p)
  }
  return out
}

/** xterm's range (1-based, end inclusive) of a span of `line`. */
export function spanRange(line: TermLine, span: PathSpan): IBufferRange | null {
  const a = line.cells[span.start]
  const b = line.cells[span.end - 1]
  if (!a || !b) return null
  return { start: { x: a.col + 1, y: a.row + 1 }, end: { x: b.col + b.width, y: b.row + 1 } }
}

export interface FileLinkDeps {
  /** files:resolveRefs of this console (at most FILE_REFS_MAX refs a call). */
  resolve: (refs: string[]) => Promise<FileRefResolved[]>
  /** A Ctrl (Cmd) + click on an underlined ref. */
  open: (ref: string) => void
  now?: () => number
}

/** The provider of one terminal; register it with `term.registerLinkProvider`. */
export function createFileLinkProvider(term: Terminal, deps: FileLinkDeps): ILinkProvider {
  const now = deps.now ?? Date.now
  const cache = new Map<string, { at: number; spans: PathSpan[] }>()
  const pending = new Map<string, Promise<PathSpan[]>>()
  // The newest line asked: an answer for an older one is dropped (xterm would file it under the new line).
  let asked = 0

  const remember = (text: string, spans: PathSpan[]): PathSpan[] => {
    cache.delete(text)
    cache.set(text, { at: now(), spans })
    while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value as string)
    return spans
  }

  /** The spans of a line main confirmed: right away when cached, else once main answered. */
  const resolveLine = (text: string): PathSpan[] | Promise<PathSpan[]> => {
    const hit = cache.get(text)
    if (hit && now() - hit.at < CACHE_MS) return hit.spans
    const inflight = pending.get(text)
    if (inflight) return inflight
    const spans = pathSpans(text)
    if (spans.length === 0) return remember(text, [])
    const refs = spanRefs(spans)
    const batches: string[][] = []
    for (let i = 0; i < refs.length; i += FILE_REFS_MAX) batches.push(refs.slice(i, i + FILE_REFS_MAX))
    const job = Promise.all(batches.map((b) => deps.resolve(b).catch((): FileRefResolved[] => [])))
      .then((answers) => {
        const found = new Set<string>()
        answers.forEach((res, k) => {
          batches[k].forEach((ref, j) => {
            if (res[j]?.exists === true) found.add(ref)
          })
        })
        return remember(text, existingSpans(spans, (ref) => found.has(ref)))
      })
      .finally(() => pending.delete(text))
    pending.set(text, job)
    return job
  }

  const linksOf = (line: TermLine, y: number, shown: PathSpan[]): ILink[] | undefined => {
    const links: ILink[] = []
    for (const s of shown) {
      const range = spanRange(line, s)
      if (!range || range.end.y < y || range.start.y > y) continue
      links.push({
        range,
        text: s.ref,
        activate: (event) => {
          if (event.ctrlKey || event.metaKey) deps.open(s.ref)
        },
      })
    }
    return links.length ? links : undefined
  }

  return {
    provideLinks(y, callback) {
      const seq = ++asked
      const line = termLineAt(term, y - 1)
      if (!line) return callback(undefined)
      const shown = resolveLine(line.text)
      if (Array.isArray(shown)) return callback(linksOf(line, y, shown))
      void shown.then((spans) => {
        if (seq === asked) callback(linksOf(line, y, spans))
      })
    },
  }
}

/**
 * Opens a ref of `paneId`'s terminal in the Files drawer at its line and
 * column: main resolves it again (it may be gone since the hover) and names
 * it relative to the console's tree, the worktree's for a worktree console.
 */
export async function openTerminalRef(paneId: string, ref: string): Promise<void> {
  const tNow: TFn = (key, vars) => translate(useAppStore.getState().settings.language, key, vars)
  const res = await window.snApi.files.resolveRefs({ paneId, refs: [ref] }).catch((): FileRefResolved[] => [])
  const hit = res[0]
  const s = useAppStore.getState()
  const shownWs = s.workspaces.find((w) => w.panes.some((p) => p.id === paneId))
  const pane = shownWs?.panes.find((p) => p.id === paneId)
  if (!hit?.exists || !hit.rel || !shownWs || !pane) {
    toast.error(tNow('files.openFailed', { path: ref }), { dedupeKey: 'files-op' })
    return
  }
  // Main answers against the console's home workspace (a moved console still belongs there).
  const homeId = s.paneHome[paneId]?.workspaceId ?? shownWs.id
  const key = pane.worktree ? paneFilesKey(homeId, paneId) : homeId
  // The tree's hot-exit stash first, as the drawer does when it opens: a file
  // with unsaved edits of the last run opens with them, never from disk.
  restoreUnsaved(key)
  const err = await openFile(key, hit.rel, { line: hit.line, col: hit.col })
  if (err) {
    toast.error(tNow(`files.err.${err}` as MessageKey), { dedupeKey: 'files-op' })
    return
  }
  showFilesTree(shownWs.id, key)
  if (useAppStore.getState().activeWorkspaceId !== shownWs.id) useAppStore.getState().setActive(shownWs.id)
  if (sidePanelOf(shownWs.id) !== 'files') openSidePanel('files')
}
