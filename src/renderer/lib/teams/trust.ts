/**
 * The trust dialog of a team (app 2.7.0, E10 B1): `trustDiff` loads what
 * changed since the last trust (risks, file diffs, definition problems) and
 * `trust` approves exactly the sha256 on screen. When the files moved after
 * the dialog loaded, main answers `changed` and the dialog reloads with "Los
 * archivos cambiaron otra vez". Never persisted.
 */
import { create } from 'zustand'
import type { TeamError, TrustDiff } from '@shared/team-protocol'
import { teamReq } from '@/lib/teamsStore'
import { defWarningsOf, hasDefErrors, isDefWarning } from './issues'

export interface TeamTrustState {
  /** Team whose dialog is open; null = closed. */
  teamId: string | null
  trust?: TrustDiff
  busy: boolean
  error?: TeamError
  /** The last approve found newer files: the dialog now shows them. */
  changedAgain?: boolean
}

const CLOSED: TeamTrustState = { teamId: null, busy: false }

export const useTeamTrustStore = create<TeamTrustState>(() => ({ ...CLOSED }))

// An answer that arrives after a close, a reopen or a newer load is dropped.
let seq = 0

function current(n: number, teamId: string): boolean {
  return n === seq && useTeamTrustStore.getState().teamId === teamId
}

async function load(teamId: string, changedAgain: boolean): Promise<void> {
  const n = ++seq
  useTeamTrustStore.setState({ busy: true, error: undefined })
  const r = await teamReq({ op: 'trustDiff', teamId })
  if (!current(n, teamId)) return
  if (!r.ok) {
    useTeamTrustStore.setState({ busy: false, trust: undefined, error: r.error, changedAgain })
    return
  }
  useTeamTrustStore.setState({ busy: false, trust: r.trust, error: undefined, changedAgain })
}

export function openTeamTrust(teamId: string): void {
  useTeamTrustStore.setState({ ...CLOSED, teamId }, true)
  void load(teamId, false)
}

/** Loads the diff again (the Retry of a failed load). */
export function reloadTeamTrust(): void {
  const { teamId, changedAgain } = useTeamTrustStore.getState()
  if (teamId) void load(teamId, !!changedAgain)
}

/**
 * Trusts the version on screen. True when main trusted it (the dialog closes);
 * false on any failure, `changed` included (the dialog then shows the newer files).
 * Only an error blocks: a version with warnings alone is trusted like any other.
 */
export async function approveTrust(): Promise<boolean> {
  const { teamId, trust, busy } = useTeamTrustStore.getState()
  if (!teamId || !trust || !trust.sha256 || busy || hasDefErrors(trust.issues)) return false
  const n = ++seq
  useTeamTrustStore.setState({ busy: true, error: undefined })
  const r = await teamReq({ op: 'trust', teamId, sha256: trust.sha256 })
  if (!current(n, teamId)) return r.ok
  if (r.ok) {
    closeTeamTrust()
    return true
  }
  if (r.error === 'changed') {
    await load(teamId, true)
    return false
  }
  // Problems main found only now (an extra repo that stopped resolving): listed, and the approve stays off.
  // The warnings on screen stay listed when the answer carries only the errors.
  const found = r.error === 'invalid_definition' ? r.issues : undefined
  if (found && hasDefErrors(found)) {
    const issues = found.some(isDefWarning) ? found : [...found, ...defWarningsOf(trust.issues)]
    useTeamTrustStore.setState({ busy: false, error: r.error, trust: { ...trust, issues } })
    return false
  }
  useTeamTrustStore.setState({ busy: false, error: r.error })
  return false
}

export function closeTeamTrust(): void {
  seq++
  useTeamTrustStore.setState({ ...CLOSED }, true)
}
