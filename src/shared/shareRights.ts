/**
 * Share guest rights (app 2.6.0): what a guest may use beyond the terminal,
 * apart from the terminal perm (which only gates input). A grant holds the
 * rights of whoever joins it; each session holds its own (the approval prompt
 * and Settings > Sharing set them per guest). Only a workspace scope has any.
 *
 * The caps a session gets on the wire derive from its rights here, per the
 * protocol version it negotiated: a v1 guest (app 2.4 / 2.5) only knows the
 * five v1 caps, so notes it may write show as read-only there and files do
 * not exist for it. Pure: no Node, no DOM.
 */
import type { ShareCaps, ShareScopeKind } from './share-protocol'
import type { ShareFilesRight, ShareNotesRight, SharePerm, ShareRights } from './types'

export type { ShareFilesRight, ShareNotesRight, ShareRights }

export const SHARE_RIGHTS_NONE: Readonly<ShareRights> = Object.freeze({ consoles: false, chat: false, changes: false, notes: 'off', files: 'off' })
export const SHARE_NOTES_RIGHTS: readonly ShareNotesRight[] = ['off', 'read', 'write']
export const SHARE_FILES_RIGHTS: readonly ShareFilesRight[] = ['off', 'read']
export const SHARE_RIGHT_KEYS: ReadonlyArray<keyof ShareRights> = ['consoles', 'chat', 'changes', 'notes', 'files']

/** The rights a level preselects in the Share dialog; the host adjusts each one after. */
export function shareDefaultRights(perm: SharePerm): ShareRights {
  return perm === 'full' ? { consoles: true, chat: true, changes: true, notes: 'write', files: 'read' } : { ...SHARE_RIGHTS_NONE }
}

/**
 * A grant or ticket from before rights existed: exactly what its perm gave
 * then (Full on a workspace: consoles, chat, changes and read-only notes; no
 * files), so an old grant never gains a right on its own.
 */
export function shareLegacyRights(perm: SharePerm, scopeKind: ShareScopeKind): ShareRights {
  if (perm !== 'full' || scopeKind !== 'workspace') return { ...SHARE_RIGHTS_NONE }
  return { consoles: true, chat: true, changes: true, notes: 'read', files: 'off' }
}

/** Exactly a ShareRights: the five keys, no other. */
export function isShareRights(v: unknown): v is ShareRights {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false
  const o = v as Record<string, unknown>
  return (
    Object.keys(o).length === SHARE_RIGHT_KEYS.length &&
    typeof o.consoles === 'boolean' &&
    typeof o.chat === 'boolean' &&
    typeof o.changes === 'boolean' &&
    SHARE_NOTES_RIGHTS.includes(o.notes as ShareNotesRight) &&
    SHARE_FILES_RIGHTS.includes(o.files as ShareFilesRight)
  )
}

/** A pane scope has no rights; a workspace keeps them (a copy). */
export function normalizeShareRights(scopeKind: ShareScopeKind, r: ShareRights): ShareRights {
  return scopeKind === 'workspace' ? { ...r } : { ...SHARE_RIGHTS_NONE }
}

export function sameShareRights(a: ShareRights, b: ShareRights): boolean {
  return SHARE_RIGHT_KEYS.every((k) => a[k] === b[k])
}

function rank(key: keyof ShareRights, v: ShareRights[keyof ShareRights]): number {
  if (key === 'notes') return SHARE_NOTES_RIGHTS.indexOf(v as ShareNotesRight)
  if (key === 'files') return SHARE_FILES_RIGHTS.indexOf(v as ShareFilesRight)
  return v ? 1 : 0
}

/**
 * A session's rights after its grant's change from `oldGrant` to `newGrant`,
 * field by field, the rule of the perm: a field the grant did not change stays;
 * one the session holds below the old grant value (lowered on purpose at the
 * prompt or in Settings) may go lower, never higher; any other takes the new
 * value.
 */
export function remapShareRights(current: ShareRights, oldGrant: ShareRights, newGrant: ShareRights): ShareRights {
  const out = { ...current } as Record<keyof ShareRights, ShareRights[keyof ShareRights]>
  for (const k of SHARE_RIGHT_KEYS) {
    if (newGrant[k] === oldGrant[k]) continue
    if (rank(k, current[k]) < rank(k, oldGrant[k])) out[k] = rank(k, newGrant[k]) < rank(k, current[k]) ? newGrant[k] : current[k]
    else out[k] = newGrant[k]
  }
  return out as unknown as ShareRights
}

/** Which backends the host has (chat hub, git handler, notes store, file service). */
export interface ShareBackends {
  chat: boolean
  git: boolean
  notes: boolean
  files: boolean
}

/**
 * The caps a session gets on the wire. v1 has only the five keys of app 2.4
 * (its schema is strict, so a key more would end the guest's link); v2 adds
 * `notesWrite` and `files`.
 */
export function shareCapsOf(rights: ShareRights, scopeKind: ShareScopeKind, version: number, has: ShareBackends): ShareCaps {
  const r = scopeKind === 'workspace' ? rights : SHARE_RIGHTS_NONE
  const notes = r.notes !== 'off' && has.notes
  const caps: ShareCaps = { createPane: r.consoles, closePane: r.consoles, chat: r.chat && has.chat, notes, git: r.changes && has.git }
  if (version >= 2) {
    caps.notesWrite = notes && r.notes === 'write'
    caps.files = r.files === 'read' && has.files
  }
  return caps
}
