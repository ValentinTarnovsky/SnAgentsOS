/**
 * "Nuevo equipo" (app 2.7.0, E10 B1): the state of TeamSetupDialog. Steps:
 * repo (probe a folder), adopt (the repo already brings a definition: review
 * and trust it), edit (the draft main proposed) and preview (the exact files
 * main renders, written only with the hash of that preview). Main renders,
 * validates and writes everything; this store only holds what the dialog
 * shows and never edits file text. Never persisted.
 */
import { create } from 'zustand'
import type { DefError } from '@shared/teams'
import type { RoleDraft, TeamSetupDraft } from '@shared/teamDefinition'
import type { SetupPreview, SetupProbe, SetupWarning, TeamError } from '@shared/team-protocol'
import { openTeams, refreshTeamList, teamReq, useTeamsStore } from '@/lib/teamsStore'

export type SetupStep = 'repo' | 'adopt' | 'edit' | 'preview'
/** Why the dialog shows a step again: the preview was stale, a definition appeared, the adopted files moved. */
export type SetupNotice = 'previewChanged' | 'exists' | 'adoptChanged'

export interface TeamSetupState {
  open: boolean
  step: SetupStep
  dir?: string
  probe?: SetupProbe
  draft?: TeamSetupDraft
  preview?: SetupPreview
  busy: boolean
  error?: TeamError
  /** The definition problems of an `invalid_definition` answer. */
  issues?: DefError[]
  notice?: SetupNotice
}

const CLOSED: TeamSetupState = { open: false, step: 'repo', busy: false }

export const useTeamSetupStore = create<TeamSetupState>(() => ({ ...CLOSED }))

// Each open of the dialog and each request gets a number: an answer that
// arrives after a close, a reopen or a newer request is dropped.
let seq = 0

function current(n: number): boolean {
  return n === seq && useTeamSetupStore.getState().open
}

function patch(p: Partial<TeamSetupState>): void {
  useTeamSetupStore.setState(p)
}

/** Opens the dialog on the repo step; with a folder it probes it right away. */
export function openTeamSetup(dir?: string): void {
  seq++
  useTeamSetupStore.setState({ ...CLOSED, open: true }, true)
  if (dir) void probeRepo(dir)
}

export function closeTeamSetup(): void {
  seq++
  useTeamSetupStore.setState({ ...CLOSED }, true)
}

/**
 * setupProbe: main resolves the git main root. A registered repo stays on the
 * repo step with "Abrir el equipo"; a repo that brings a definition goes to
 * adopt; anything else to edit with the draft main proposed.
 */
export async function probeRepo(dir: string, notice?: SetupNotice): Promise<void> {
  const n = ++seq
  patch({ dir, busy: true, error: undefined, issues: undefined, notice: undefined })
  const r = await teamReq({ op: 'setupProbe', dir })
  if (!current(n)) return
  if (!r.ok) {
    patch({ busy: false, step: 'repo', probe: undefined, error: r.error })
    return
  }
  const probe = r.probe
  if (probe.registered) {
    patch({ busy: false, step: 'repo', probe, draft: undefined, preview: undefined })
  } else if (probe.existing) {
    patch({ busy: false, step: 'adopt', probe, draft: undefined, preview: undefined, notice })
  } else {
    patch({ busy: false, step: 'edit', probe, draft: probe.defaults, preview: undefined, notice })
  }
}

/** Edits the draft; any edit drops a preview made before it. */
export function setDraft(p: Partial<TeamSetupDraft>): void {
  const s = useTeamSetupStore.getState()
  if (!s.draft) return
  patch({ draft: { ...s.draft, ...p }, preview: undefined, error: undefined, issues: undefined })
}

/** Replaces one role of the draft by id. */
export function setRoleDraft(id: string, p: Partial<RoleDraft>): void {
  const d = useTeamSetupStore.getState().draft
  if (!d) return
  setDraft({ roles: d.roles.map((r) => (r.id === id ? { ...r, ...p } : r)) })
}

/** setupPreview: the exact files, their hash, issues and warnings; moves to the preview step. */
export async function previewSetup(notice?: SetupNotice): Promise<void> {
  const s = useTeamSetupStore.getState()
  if (!s.probe || !s.draft) return
  const n = ++seq
  patch({ busy: true, error: undefined, issues: undefined, notice: undefined })
  const r = await teamReq({ op: 'setupPreview', repoRoot: s.probe.repoRoot, draft: s.draft })
  if (!current(n)) return
  if (!r.ok) {
    patch({ busy: false, error: r.error, issues: r.issues })
    return
  }
  patch({ busy: false, step: 'preview', preview: r.preview, notice })
}

function listed(teamId: string): boolean {
  return useTeamsStore.getState().list.some((team) => team.id === teamId)
}

/**
 * Closes the dialog and opens the new team in the host, once the list has it
 * (openTeams drops an id it does not list). A list answer can be dropped when
 * the teamChanged refetch starts meanwhile, so the pull is repeated a few times.
 */
async function landed(teamId: string): Promise<void> {
  closeTeamSetup()
  for (let i = 0; i < 3 && !listed(teamId); i++) await refreshTeamList()
  openTeams(teamId)
}

/**
 * setupWrite with the hash of the preview on screen. `changed`: main renders
 * something else now, so the preview is made again and shown; `exists`: a
 * definition showed up in the repo meanwhile, so the dialog goes to adopt.
 */
export async function writeSetup(): Promise<void> {
  const s = useTeamSetupStore.getState()
  if (!s.probe || !s.draft || !s.preview || s.busy) return
  const n = ++seq
  patch({ busy: true, error: undefined, issues: undefined })
  const r = await teamReq({ op: 'setupWrite', repoRoot: s.probe.repoRoot, draft: s.draft, previewHash: s.preview.hash })
  if (!current(n)) return
  if (r.ok) {
    await landed(r.teamId)
    return
  }
  if (r.error === 'changed') {
    patch({ busy: false })
    await previewSetup('previewChanged')
    return
  }
  if (r.error === 'exists') {
    patch({ busy: false })
    await probeRepo(s.probe.repoRoot, 'exists')
    return
  }
  patch({ busy: false, error: r.error, issues: r.issues })
}

/** adopt with the hash of the definition on screen; `changed` probes again and shows the new version. */
export async function adoptExisting(): Promise<void> {
  const s = useTeamSetupStore.getState()
  const sha256 = s.probe?.existing?.sha256
  if (!s.probe || !sha256 || s.busy) return
  const n = ++seq
  patch({ busy: true, error: undefined, issues: undefined })
  const r = await teamReq({ op: 'adopt', repoRoot: s.probe.repoRoot, sha256 })
  if (!current(n)) return
  if (r.ok) {
    await landed(r.teamId)
    return
  }
  if (r.error === 'changed') {
    patch({ busy: false })
    await probeRepo(s.probe.repoRoot, 'adoptChanged')
    return
  }
  patch({ busy: false, error: r.error, issues: r.issues })
}

/** "Abrir el equipo" of a repo that already has one. */
export async function openRegistered(): Promise<void> {
  const id = useTeamSetupStore.getState().probe?.registered
  if (!id) return
  await landed(id)
}

/** Back: preview -> edit (the draft is kept), edit and adopt -> repo. */
export function setupBack(): void {
  const s = useTeamSetupStore.getState()
  seq++
  if (s.step === 'preview') patch({ step: 'edit', busy: false, preview: undefined, error: undefined, issues: undefined, notice: undefined })
  else patch({ step: 'repo', busy: false, probe: undefined, draft: undefined, preview: undefined, error: undefined, issues: undefined, notice: undefined })
}

/**
 * The warnings the edit step shows while the draft changes (main repeats them
 * in the preview, with `noVerify` and `notCommitted`): an enabled Claude role
 * with full access bypasses permissions, a Codex one runs without a sandbox,
 * and a read only Codex role reports its actions in a block.
 */
export function draftWarnings(draft: TeamSetupDraft): SetupWarning[] {
  const on = draft.roles.filter((r) => r.enabled || r.kind === 'lead')
  const out: SetupWarning[] = []
  if (on.some((r) => r.provider === 'claude' && r.permission === 'total')) out.push('totalBypass')
  if (on.some((r) => r.provider === 'codex' && r.permission === 'total')) out.push('codexTotal')
  if (on.some((r) => r.provider === 'codex' && r.permission === 'readonly')) out.push('codexReadonlyBlock')
  return out
}

/** UTF-8 bytes of a draft text (the goal counter). */
export function textBytes(text: string): number {
  return new TextEncoder().encode(text).length
}
