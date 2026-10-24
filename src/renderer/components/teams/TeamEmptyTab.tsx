import type { PermissionProfile, RoleKind } from '@shared/teams'
import type { AgentProvider } from '@shared/types'
import type { RoleSummary, TeamView } from '@shared/team-protocol'
import type { TeamTab } from '@/lib/teamsStore'
import { useT, type MessageKey } from '@/i18n'

export const KIND_KEY: Record<RoleKind, MessageKey> = {
  lead: 'teams.host.kind.lead',
  dev: 'teams.host.kind.dev',
  qa: 'teams.host.kind.qa',
  research: 'teams.host.kind.research',
  custom: 'teams.host.kind.custom',
}

export const PERMISSION_KEY: Record<PermissionProfile, MessageKey> = {
  total: 'teams.host.perm.total',
  readonly: 'teams.host.perm.readonly',
  custom: 'teams.host.perm.custom',
}

const PROVIDER_KEY: Record<AgentProvider, MessageKey> = {
  claude: 'pane.runningAgent.claude',
  codex: 'pane.runningAgent.codex',
}

const SECTION_TITLE = 'mb-2 text-[11px] font-semibold uppercase tracking-wide text-text-secondary'
const TH = 'border-b border-border px-3 py-1.5 text-left font-medium text-text-secondary'
const TD = 'border-b border-border/60 px-3 py-1.5 align-top'

function RolesTable({ roles }: { roles: readonly RoleSummary[] }) {
  const t = useT()
  return (
    <div className="overflow-x-auto rounded-card border border-border" data-team-roles>
      <table className="w-full min-w-[520px] border-collapse text-xs">
        <thead className="bg-bg-secondary/60">
          <tr>
            <th className={TH}>{t('teams.host.col.role')}</th>
            <th className={TH}>{t('teams.host.col.kind')}</th>
            <th className={TH}>{t('teams.host.col.agent')}</th>
            <th className={TH}>{t('teams.host.col.effort')}</th>
            <th className={TH}>{t('teams.host.col.permission')}</th>
            <th className={`${TH} text-right`}>{t('teams.host.col.count')}</th>
          </tr>
        </thead>
        <tbody>
          {roles.map((r) => (
            <tr key={r.id} data-team-role={r.id}>
              <td className={TD}>
                <span className="block text-text-primary">{r.name}</span>
                <span className="block font-mono text-[10px] text-text-secondary">{r.id}</span>
              </td>
              <td className={`${TD} text-text-primary`}>{t(KIND_KEY[r.kind])}</td>
              <td className={`${TD} text-text-primary`}>
                {t(PROVIDER_KEY[r.provider])}
                <span className="text-text-secondary"> · {r.model || t('teams.host.modelDefault')}</span>
              </td>
              <td className={`${TD} text-text-secondary`}>{r.effort || t('teams.host.effortDefault')}</td>
              <td className={`${TD} text-text-primary`} data-team-role-permission={r.permission}>
                {t(PERMISSION_KEY[r.permission])}
              </td>
              <td className={`${TD} text-right tabular-nums text-text-primary`}>{r.count}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/** The definition summary the Tablero tab shows in B1: goal, how it works, roles, other repos. */
function DefinitionSummary({ view }: { view: TeamView }) {
  const t = useT()
  const repoName = (id: string): string => (id === 'main' ? view.repoName : view.extraRepos.find((r) => r.id === id)?.name ?? id)
  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-6" data-team-summary>
      <section>
        <h3 className={SECTION_TITLE}>{t('teams.host.goal')}</h3>
        {view.goal.trim() ? (
          <p className="whitespace-pre-wrap break-words rounded-card border border-border bg-card/40 px-4 py-3 text-sm leading-6 text-text-primary" data-team-goal>
            {view.goal}
          </p>
        ) : (
          <p className="text-sm text-text-secondary" data-team-goal>
            {t('teams.host.noGoal')}
          </p>
        )}
      </section>
      <section>
        <h3 className={SECTION_TITLE}>{t('teams.host.settings')}</h3>
        <ul className="space-y-1 text-sm text-text-primary">
          <li>{t('teams.host.maxConcurrent', { count: view.maxConcurrent })}</li>
          <li>{t('teams.host.maxRunMinutes', { count: view.maxRunMinutes })}</li>
          <li>{t(view.leadApprovesSmallPlans ? 'teams.host.leadApproves' : 'teams.host.userApproves')}</li>
          {view.verify.length === 0 ? (
            <li className="text-text-secondary">{t('teams.host.verifyNone')}</li>
          ) : (
            view.verify.map((v) => (
              <li key={v.repoId} className="break-words">
                {t('teams.host.verify', { repo: repoName(v.repoId) })}{' '}
                <code className="rounded bg-bg-secondary px-1 font-mono text-xs">{v.command}</code>
                {v.confirmed && <span className="ml-1.5 text-xs text-text-secondary">({t('teams.host.verifyConfirmed')})</span>}
              </li>
            ))
          )}
        </ul>
      </section>
      <section>
        <h3 className={SECTION_TITLE}>{t('teams.host.roles')}</h3>
        <RolesTable roles={view.roles} />
      </section>
      {view.extraRepos.length > 0 && (
        <section>
          <h3 className={SECTION_TITLE}>{t('teams.host.extraRepos')}</h3>
          <ul className="space-y-1 text-sm text-text-primary">
            {view.extraRepos.map((r) => (
              <li key={r.id}>
                {r.name} <span className="font-mono text-xs text-text-secondary">({r.baseBranch})</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  )
}

/**
 * The B1 body of each tab (app 2.7.0, E10 B1): Tablero shows the definition
 * summary, Agentes and Te necesita one line on what will show there, so B1 is
 * a real screen. Later milestones mount their tab bodies in its place.
 */
export function TeamEmptyTab({ tab, view }: { tab: TeamTab; view: TeamView }) {
  const t = useT()
  if (tab === 'board') return <DefinitionSummary view={view} />
  const line =
    tab === 'agents' ? t('teams.tab.soonAgents')
    : view.trust !== 'trusted' ? t('teams.tab.needsTrust')
    : view.needsCount > 0 ? t('teams.tab.soonNeeds')
    : t('teams.tab.nothing')
  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-6" data-team-empty-tab={tab}>
      <p className="text-sm text-text-secondary">{line}</p>
      {tab === 'agents' && <RolesTable roles={view.roles} />}
    </div>
  )
}
