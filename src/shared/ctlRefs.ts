/**
 * Workspace and console addresses of the `snaos` CLI (E8-FR-14). Pure: main
 * resolves against the renderer's `list` (sidebar order, grid order) with the
 * caller derived from the token.
 *
 * Workspace: id, exact name (case-insensitive) or 1-based sidebar index.
 * Console: `self`, 1-based grid index in the scope workspace, `<ws>:<index>`,
 * pane id, or exact title (case-insensitive; the scope workspace first, then
 * every workspace). Note: id or exact title (case-insensitive).
 */
import type { CtlErrorCode, CtlListData, CtlListPane, CtlListWorkspace } from './ctl-protocol'
import { noteTitle, type WsNoteMeta } from './ws-notes'

export type RefError = { ok: false; code: Extract<CtlErrorCode, 'bad_request' | 'not_found' | 'ambiguous'>; message: string }
export type WorkspaceRef = { ok: true; workspace: CtlListWorkspace; index: number } | RefError
export type ConsoleRef = { ok: true; workspace: CtlListWorkspace; pane: CtlListPane; index: number } | RefError
export type NoteRef = { ok: true; note: WsNoteMeta } | RefError

const DIGITS = /^\d+$/

function fail(code: RefError['code'], message: string): RefError {
  return { ok: false, code, message }
}

export function resolveWorkspaceRef(list: Pick<CtlListData, 'workspaces'>, ref: string): WorkspaceRef {
  const raw = ref.trim()
  if (!raw) return fail('bad_request', 'empty workspace reference')
  const all = list.workspaces
  const byId = all.findIndex((w) => w.id === raw)
  if (byId >= 0) return { ok: true, workspace: all[byId], index: byId + 1 }
  const lower = raw.toLowerCase()
  const named = all.flatMap((w, i) => (w.name.toLowerCase() === lower ? [i] : []))
  if (named.length > 1) return fail('ambiguous', `workspace "${raw}" is ambiguous: ${named.map((i) => `${i + 1} (${all[i].id})`).join(', ')}`)
  if (named.length === 1) return { ok: true, workspace: all[named[0]], index: named[0] + 1 }
  if (DIGITS.test(raw)) {
    const n = Number(raw)
    if (n >= 1 && n <= all.length) return { ok: true, workspace: all[n - 1], index: n }
  }
  return fail('not_found', `workspace "${raw}" not found`)
}

/**
 * A Markdown note of a workspace (app 2.3.0): its id, or its exact title
 * (case-insensitive; a repeated title is `ambiguous`). No index: the list is
 * newest first and reorders on every write, so an index could hit another
 * note (dangerous for `notes rm`).
 */
export function resolveNoteRef(notes: readonly WsNoteMeta[], ref: string): NoteRef {
  const raw = ref.trim()
  if (!raw) return fail('bad_request', 'empty note reference')
  const byId = notes.find((n) => n.id === raw)
  if (byId) return { ok: true, note: byId }
  const lower = raw.toLowerCase()
  // The stored title drops Markdown marks (`fix_login` is listed as `fixlogin`): the ref is cleaned the same way.
  const clean = noteTitle(raw).toLowerCase()
  const titled = notes.filter((n) => {
    const title = n.title.trim().toLowerCase()
    return title === lower || (clean !== '' && title === clean)
  })
  if (titled.length > 1) return fail('ambiguous', `note "${raw}" is ambiguous: ${titled.map((n) => n.id).join(', ')}`)
  if (titled.length === 1) return { ok: true, note: titled[0] }
  return fail('not_found', `note "${raw}" not found`)
}

/** Workspace holding a pane, with its sidebar index, or null. */
export function workspaceOfPane(list: Pick<CtlListData, 'workspaces'>, paneId: string): { workspace: CtlListWorkspace; index: number } | null {
  const i = list.workspaces.findIndex((w) => w.panes.some((p) => p.id === paneId))
  return i >= 0 ? { workspace: list.workspaces[i], index: i + 1 } : null
}

function inWorkspace(ws: CtlListWorkspace, paneId: string): ConsoleRef {
  const i = ws.panes.findIndex((p) => p.id === paneId)
  return i >= 0 ? { ok: true, workspace: ws, pane: ws.panes[i], index: i + 1 } : fail('not_found', `console "${paneId}" not found`)
}

/**
 * `scopeId` is the workspace of `--workspace`, else the caller's, else the
 * active one (null when there is none). `callerPaneId` is null with the
 * master token, where `self` does not exist.
 */
export function resolveConsoleRef(
  list: Pick<CtlListData, 'workspaces'>,
  scopeId: string | null,
  ref: string,
  callerPaneId: string | null,
): ConsoleRef {
  const raw = ref.trim()
  if (!raw) return fail('bad_request', 'empty console reference')
  if (raw.toLowerCase() === 'self') {
    if (!callerPaneId) return fail('bad_request', '"self" only exists inside a SnAgentsOS console')
    const owner = workspaceOfPane(list, callerPaneId)
    return owner ? inWorkspace(owner.workspace, callerPaneId) : fail('not_found', 'this console is no longer in any workspace')
  }
  const scope = scopeId ? list.workspaces.find((w) => w.id === scopeId) ?? null : null
  // <workspace>:<index>; the last colon, so a workspace name may hold one.
  const colon = raw.lastIndexOf(':')
  if (colon > 0 && DIGITS.test(raw.slice(colon + 1))) {
    const wsRef = resolveWorkspaceRef(list, raw.slice(0, colon))
    if (wsRef.ok) {
      const n = Number(raw.slice(colon + 1))
      const pane = wsRef.workspace.panes[n - 1]
      return pane ? { ok: true, workspace: wsRef.workspace, pane, index: n } : fail('not_found', `workspace "${wsRef.workspace.name}" has no console ${n}`)
    }
    if (wsRef.code === 'ambiguous') return wsRef
  }
  if (DIGITS.test(raw)) {
    if (!scope) return fail('bad_request', `console index ${raw} needs a workspace (--workspace)`)
    const n = Number(raw)
    const pane = scope.panes[n - 1]
    if (pane) return { ok: true, workspace: scope, pane, index: n }
  }
  for (const ws of list.workspaces) {
    const i = ws.panes.findIndex((p) => p.id === raw)
    if (i >= 0) return { ok: true, workspace: ws, pane: ws.panes[i], index: i + 1 }
  }
  const lower = raw.toLowerCase()
  const titled = (ws: CtlListWorkspace): ConsoleRef[] =>
    ws.panes.flatMap((p, i) => (p.title.toLowerCase() === lower ? [{ ok: true as const, workspace: ws, pane: p, index: i + 1 }] : []))
  let hits = scope ? titled(scope) : []
  if (hits.length === 0) hits = list.workspaces.flatMap(titled)
  if (hits.length > 1) {
    const names = hits.map((h) => (h.ok ? `${h.workspace.name}:${h.index} (${h.pane.id})` : '')).join(', ')
    return fail('ambiguous', `console "${raw}" is ambiguous: ${names}`)
  }
  if (hits.length === 1) return hits[0]
  return fail('not_found', `console "${raw}" not found`)
}
