import { AlertTriangle, CircleAlert, ShieldAlert } from 'lucide-react'
import type { DefError } from '@shared/teams'
import type { TeamTrustState } from '@shared/team-protocol'
import { revealTeam } from '@/lib/teamsStore'
import { openTeamTrust } from '@/lib/teams/trust'
import { defErrorsOf, defWarningsOf, isDefWarning } from '@/lib/teams/issues'
import { toast } from '@/lib/toast'
import { useT, type TFn } from '@/i18n'
import { cn } from '@/lib/cn'
import { Button } from '@/components/ui/Button'
import { defIssueAt, defIssueText } from './TeamDiffView'

/** Issues listed in the banner before "+N more" (the trust dialog lists them all). */
const ISSUES_SHOWN = 5

/** One reveal toast at a time: a new failure replaces it, a folder that opens takes it away. */
const REVEAL_TOAST = 'teams.reveal'

/**
 * Opens a team folder (the banner, the sidebar kebab). Main opens it only when
 * it is a real directory: `not_found` (missing, a link or a file) and `io`
 * (the system could not open it) get a toast in catalog words only. The
 * system's reason in `detail` is OS English, so it goes to the console, never
 * to the toast.
 */
export function revealTeamFolder(teamId: string, what: 'definition' | 'data', t: TFn): void {
  void revealTeam(teamId, what).then((fail) => {
    if (!fail) {
      toast.dismissByKey(REVEAL_TOAST)
      return
    }
    if (fail.detail) console.debug('[teams] reveal failed:', fail.error, fail.detail)
    const body = fail.error === 'not_found' ? t('teams.reveal.notFound') : undefined
    toast.error(t('teams.reveal.failed'), { dedupeKey: REVEAL_TOAST, ...(body ? { body } : {}) })
  })
}

/**
 * The trust strip under the Teams header (app 2.7.0, E10 B1), while the
 * definition on disk is not the trusted one: why nothing runs, and the way out
 * (the trust dialog with the diff; with an issue listed, error or warning,
 * the folder to fix it in).
 * Warnings (a misnamed file, the Codex allowlist that is ignored) are listed
 * in the warning style and never block; a trusted team with warnings gets the
 * strip for them alone. "Abrir carpeta" is not offered when the load found a
 * link or could not read the folder (main would not open it).
 */
export function TeamBanner({ teamId, trust, issues }: { teamId: string; trust: TeamTrustState; issues: readonly DefError[] }) {
  const t = useT()
  const errors = defErrorsOf(issues)
  const warnings = defWarningsOf(issues)
  if (trust === 'trusted' && warnings.length === 0) return null
  const error = trust === 'invalid' || trust === 'missing'
  const text =
    trust === 'trusted' ? t('teams.banner.warnings', { count: warnings.length })
    : trust === 'untrusted' ? t('teams.banner.untrusted')
    : trust === 'changed' ? t('teams.banner.changed')
    : trust === 'invalid' ? t('teams.banner.invalid', { count: errors.length })
    : t('teams.banner.missing')
  // Errors first, then warnings; a folder that is gone has nothing to list.
  const listed = trust === 'missing' ? [] : [...errors, ...warnings]
  const unreadable = errors.some((e) => e.code === 'link' || e.code === 'io')
  const canOpen = listed.length > 0 && !unreadable
  const Icon = trust === 'trusted' ? AlertTriangle : ShieldAlert
  return (
    <div
      role="status"
      data-team-trust-banner={trust === 'trusted' ? undefined : trust}
      data-team-def-warnings={warnings.length > 0 ? warnings.length : undefined}
      className={cn('flex shrink-0 items-start gap-3 border-b px-4 py-2 text-xs text-text-primary', error ? 'border-state-error/40 bg-state-error/10' : 'border-state-action/40 bg-state-action/10')}
    >
      <Icon size={15} className={cn('mt-0.5 shrink-0', error ? 'text-state-error' : 'text-state-action')} aria-hidden />
      <div className="min-w-0 flex-1">
        <p className="break-words leading-5">{text}</p>
        {listed.length > 0 && (
          <ul className="mt-1 space-y-0.5 text-text-secondary" data-team-banner-issues>
            {listed.slice(0, ISSUES_SHOWN).map((e, i) => {
              const warning = isDefWarning(e)
              const Mark = warning ? AlertTriangle : CircleAlert
              return (
                <li key={i} data-team-banner-issue={e.code} data-issue-severity={warning ? 'warning' : 'error'} className="flex min-w-0 items-start gap-1 break-words text-[11px]">
                  <Mark
                    size={11}
                    role="img"
                    aria-label={t(warning ? 'teams.banner.warning' : 'teams.banner.error')}
                    className={cn('mt-[3px] shrink-0', warning ? 'text-state-action' : 'text-state-error')}
                  />
                  {/* "roles/dev.md, línea 3: ..." worded like the trust dialog (TeamDiffView's shared renderers). */}
                  <span className="min-w-0">
                    <span className="break-all font-mono">{defIssueAt(e, t)}</span>: {defIssueText(e, t)}
                  </span>
                </li>
              )
            })}
            {listed.length > ISSUES_SHOWN && <li className="text-[11px]">{t('teams.banner.more', { count: listed.length - ISSUES_SHOWN })}</li>}
          </ul>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {canOpen && (
          <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" data-team-open-folder onClick={() => revealTeamFolder(teamId, 'definition', t)}>
            {t('teams.banner.openFolder')}
          </Button>
        )}
        {trust !== 'missing' && trust !== 'trusted' && (
          <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" data-team-trust-review onClick={() => openTeamTrust(teamId)}>
            {t(trust === 'changed' ? 'teams.banner.review' : 'teams.banner.reviewFirst')}
          </Button>
        )}
      </div>
    </div>
  )
}
