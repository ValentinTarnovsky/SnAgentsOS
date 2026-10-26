/**
 * "Revisá la definición del equipo" (app 2.7.0, E10 B1): what the repo files
 * of a team let its agents do, before any run reads them. Risks first, then
 * every file diff; definition errors disable the approve (warnings are listed
 * in the warning style and never block), and beside them the note that the
 * user's own Claude allow rules hold for the team too. Cancel holds the
 * focus (Enter never trusts on its own) and the approve sends exactly the
 * sha256 on screen; when the files moved meanwhile main answers `changed` and
 * the dialog shows the new version under "Los archivos cambiaron otra vez".
 * Mounted once in App; renders nothing while closed.
 */
import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { Loader2, ShieldAlert } from 'lucide-react'
import { useT, type MessageKey, type TFn } from '@/i18n'
import { labOn } from '@shared/labs'
import type { TeamError } from '@shared/team-protocol'
import { useAppStore } from '@/lib/store'
import { useTeamsStore } from '@/lib/teamsStore'
import { approveTrust, closeTeamTrust, reloadTeamTrust, useTeamTrustStore } from '@/lib/teams/trust'
import { TRUST_WARNINGS } from '@/lib/teams/setup'
import { hasDefErrors } from '@/lib/teams/issues'
import { DefIssueList, TeamDiffView } from './TeamDiffView'
import { SetupWarnings } from './SetupPreview'

const ERROR_KEY: Partial<Record<TeamError, MessageKey>> = {
  disabled: 'teams.setup.err.disabled',
  not_git: 'teams.setup.err.not_git',
  invalid_definition: 'teams.setup.err.invalid_definition',
  io: 'teams.setup.err.io',
  busy: 'teams.setup.err.busy',
  not_found: 'teams.setup.err.not_found',
  forbidden: 'teams.setup.err.forbidden',
  bad_request: 'teams.setup.err.bad_request',
  too_big: 'teams.setup.err.too_big',
}

/** A failed team request in words (setup and trust dialogs). */
export function teamErrorText(error: TeamError, t: TFn): string {
  const key = ERROR_KEY[error]
  return key ? t(key) : t('teams.setup.err.other', { code: error })
}

export function TeamTrustDialog() {
  const t = useT()
  const teamId = useTeamTrustStore((s) => s.teamId)
  const trust = useTeamTrustStore((s) => s.trust)
  const busy = useTeamTrustStore((s) => s.busy)
  const error = useTeamTrustStore((s) => s.error)
  const changedAgain = useTeamTrustStore((s) => s.changedAgain)
  const disabled = useTeamsStore((s) => s.disabled)
  const teamsOn = useAppStore((s) => labOn(s.settings, 'teams'))
  const cancelRef = useRef<HTMLButtonElement>(null)
  const sha = trust?.sha256

  // Labs off while open (here, or main answered `disabled`): nothing of Teams stays on screen.
  useEffect(() => {
    if (teamId && (disabled || !teamsOn)) closeTeamTrust()
  }, [teamId, disabled, teamsOn])

  // A newer version on screen takes the focus back to Cancel: Enter never trusts what was not read.
  useEffect(() => {
    if (changedAgain && sha) cancelRef.current?.focus()
  }, [changedAgain, sha])

  useEffect(() => {
    if (!teamId) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopPropagation()
      closeTeamTrust()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [teamId])

  if (!teamId) return null

  // No definition on disk (empty sha) or definition errors: nothing to trust (warnings never block).
  const blocked = !trust || !trust.sha256 || hasDefErrors(trust.issues)
  return createPortal(
    <div className="fixed inset-0 z-[75] flex items-center justify-center p-6">
      <div className="absolute inset-0 bg-black/60" onClick={() => closeTeamTrust()} />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="team-trust-title"
        data-team-trust-dialog={teamId}
        data-trust-sha={trust?.sha256 ?? ''}
        aria-busy={busy || undefined}
        className="relative z-10 flex max-h-[86vh] w-full max-w-2xl flex-col overflow-hidden rounded-modal border border-border bg-card shadow-[0_20px_48px_-12px_rgba(0,0,0,0.6)]"
      >
        <div className="flex items-start gap-3 border-b border-border px-5 py-4">
          <ShieldAlert size={18} className="mt-0.5 shrink-0 text-amber-400" />
          <div className="min-w-0 flex-1">
            {changedAgain && (
              <p data-trust-changed-again className="mb-1 text-xs font-semibold uppercase tracking-wide text-amber-400">
                {t('teams.trust.changedAgain')}
              </p>
            )}
            <h2 id="team-trust-title" className="text-sm font-semibold text-text-primary">{t('teams.trust.title')}</h2>
            <p className="mt-1 text-xs text-text-secondary">
              {t(trust?.approvedSha ? 'teams.trust.introChanged' : 'teams.trust.intro')}
            </p>
            {trust?.sha256 && (
              <p data-trust-version className="mt-1 font-mono text-[11px] text-text-secondary">
                {t('teams.trust.version', { sha: trust.sha256.slice(0, 12) })}
              </p>
            )}
          </div>
        </div>
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4">
          {!trust && busy && (
            <p data-trust-loading className="flex items-center gap-2 text-xs text-text-secondary">
              <Loader2 size={13} className="animate-spin" />
              {t('teams.trust.loading')}
            </p>
          )}
          {error && (
            <div className="flex flex-wrap items-center gap-2">
              <p data-trust-error={error} className="text-xs text-red-400">{teamErrorText(error, t)}</p>
              {!trust && (
                <button
                  type="button"
                  data-trust-retry
                  onClick={() => reloadTeamTrust()}
                  className="rounded-btn border border-border px-2.5 py-1 text-xs text-text-primary transition-colors hover:bg-bg-secondary"
                >
                  {t('teams.trust.retry')}
                </button>
              )}
            </div>
          )}
          {trust && (
            <>
              <DefIssueList issues={trust.issues} title={t('teams.trust.issues')} />
              {trust.sha256 && <SetupWarnings warnings={TRUST_WARNINGS} />}
              <TeamDiffView diff={trust.diff} />
            </>
          )}
        </div>
        <div className="flex justify-end gap-2 border-t border-border bg-bg-secondary/40 px-5 py-3">
          <button
            ref={cancelRef}
            autoFocus
            type="button"
            data-trust-cancel
            onClick={() => closeTeamTrust()}
            className="rounded-btn border border-border px-4 py-2 text-sm text-text-primary transition-colors hover:bg-card"
          >
            {t('common.cancel')}
          </button>
          <button
            type="button"
            data-trust-approve
            disabled={blocked || busy}
            onClick={() => void approveTrust()}
            className="inline-flex items-center gap-2 rounded-btn bg-amber-500 px-4 py-2 text-sm font-medium text-black transition-[filter] hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy && trust && <Loader2 size={16} className="animate-spin" />}
            {t(busy && trust ? 'teams.trust.approving' : 'teams.trust.approve')}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
