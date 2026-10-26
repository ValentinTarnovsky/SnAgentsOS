/**
 * What a team definition changes (app 2.7.0, E10 B1): the security relevant
 * risks first (teamRiskFlags order), then every file with its line diff in
 * the chat patch block, the +/- prefix kept as text. Used by the trust dialog
 * and the adopt step of the setup dialog. Also the shared renderers of a risk
 * and of a definition problem, so every surface words them the same. Repo
 * text (ids, tools, paths, commands, file names) goes through visibleName,
 * every diff line through visibleLine (hidden or reordering characters in
 * role instructions or team.md show as `<U+XXXX>`).
 */
import { useMemo, useState } from 'react'
import { AlertTriangle, ChevronDown, ChevronRight, CircleAlert, FileText } from 'lucide-react'
import { REPO_MAIN, type DefError, type DefErrorCode, type PermissionProfile } from '@shared/teams'
import type { AgentProvider } from '@shared/types'
import type { ChatPatchHunk } from '@shared/chat-types'
import type { TeamDefinitionDiff, TeamFileDiff, TeamRiskFlag } from '@shared/teamDiff'
import { useT, type MessageKey, type TFn } from '@/i18n'
import { cn } from '@/lib/cn'
import { defErrorsOf, defWarningsOf, isDefWarning, visibleLine, visibleName } from '@/lib/teams/issues'
import { PatchBlock } from '@/components/chat/ToolRunRow'

const PERM_KEY: Record<PermissionProfile, MessageKey> = {
  total: 'teams.setup.perm.total',
  readonly: 'teams.setup.perm.readonly',
  custom: 'teams.setup.perm.custom',
}

const PROVIDER_KEY: Record<AgentProvider, MessageKey> = {
  claude: 'teams.setup.provider.claude',
  codex: 'teams.setup.provider.codex',
}

const ISSUE_KEY: Record<DefErrorCode, MessageKey> = {
  missing_team: 'teams.def.issue.missing_team',
  frontmatter: 'teams.def.issue.frontmatter',
  unknown_key: 'teams.def.issue.unknown_key',
  duplicate_key: 'teams.def.issue.duplicate_key',
  bad_value: 'teams.def.issue.bad_value',
  required: 'teams.def.issue.required',
  too_large: 'teams.def.issue.too_large',
  too_many: 'teams.def.issue.too_many',
  bad_name: 'teams.def.issue.bad_name',
  reserved_name: 'teams.def.issue.reserved_name',
  no_lead: 'teams.def.issue.no_lead',
  two_leads: 'teams.def.issue.two_leads',
  lead_count: 'teams.def.issue.lead_count',
  cron: 'teams.def.issue.cron',
  cron_interval: 'teams.def.issue.cron_interval',
  routine_role: 'teams.def.issue.routine_role',
  repo: 'teams.def.issue.repo',
  tool_pattern: 'teams.def.issue.tool_pattern',
  bad_model: 'teams.def.issue.bad_model',
  bad_effort: 'teams.def.issue.bad_effort',
  link: 'teams.def.issue.link',
  io: 'teams.def.issue.io',
}

/** Details main gives a `repo` problem (parseDefinition and TeamService.resolveRepos). */
const REPO_WHY_KEY: Record<string, MessageKey> = {
  unc: 'teams.def.issue.repoWhy.unc',
  missing: 'teams.def.issue.repoWhy.missing',
  link: 'teams.def.issue.repoWhy.link',
  not_git: 'teams.def.issue.repoWhy.not_git',
  not_main_root: 'teams.def.issue.repoWhy.not_main_root',
  inside: 'teams.def.issue.repoWhy.inside',
  duplicate: 'teams.def.issue.repoWhy.duplicate',
}

const FILE_STATUS_KEY: Record<TeamFileDiff['status'], MessageKey> = {
  added: 'teams.trust.file.added',
  removed: 'teams.trust.file.removed',
  changed: 'teams.trust.file.changed',
}

export function permLabel(p: PermissionProfile, t: TFn): string {
  return t(PERM_KEY[p])
}

export function providerLabel(p: AgentProvider, t: TFn): string {
  return t(PROVIDER_KEY[p])
}

/** One risk flag in words. Ids, tools, paths and commands are repo text, shown as text with hidden characters spelled out. */
export function riskText(flag: TeamRiskFlag, t: TFn): string {
  const v = visibleName
  switch (flag.code) {
    case 'permissionUp':
      return flag.from === null
        ? t('teams.risk.permissionNew', { role: v(flag.roleId), to: permLabel(flag.to, t) })
        : t('teams.risk.permissionUp', { role: v(flag.roleId), from: permLabel(flag.from, t), to: permLabel(flag.to, t) })
    case 'toolsAdded':
      return t('teams.risk.toolsAdded', { role: v(flag.roleId), tools: flag.tools.map(v).join(', ') })
    case 'providerChanged':
      return t('teams.risk.providerChanged', { role: v(flag.roleId), from: providerLabel(flag.from, t), to: providerLabel(flag.to, t) })
    case 'countUp':
      return t('teams.risk.countUp', { role: v(flag.roleId), from: flag.from, to: flag.to })
    case 'verifyChanged': {
      // The team's own repo has no name to show ('main' would read as a branch).
      const main = flag.repoId === REPO_MAIN
      return flag.to === undefined
        ? t(main ? 'teams.risk.verifyRemovedMain' : 'teams.risk.verifyRemoved', { repo: v(flag.repoId), from: v(flag.from ?? '') })
        : t(main ? 'teams.risk.verifyChangedMain' : 'teams.risk.verifyChanged', { repo: v(flag.repoId), to: v(flag.to) })
    }
    case 'extraRepo':
      return t('teams.risk.extraRepo', { repo: v(flag.repoId), path: v(flag.path) })
    case 'routineAdded':
      return t('teams.risk.routineAdded', {
        routine: v(flag.routineId),
        cron: v(flag.cron),
        action: t(flag.action === 'task' ? 'teams.risk.routineAction.task' : 'teams.risk.routineAction.wake'),
      })
    case 'instructionsChanged':
      return t('teams.risk.instructionsChanged', { role: v(flag.roleId) })
  }
}

/** The warning of a custom Codex role that lists allowedTools (Codex has no allowlist: the list is ignored). */
function codexToolsWarning(issue: DefError): boolean {
  return issue.code === 'bad_value' && issue.key === 'allowedTools' && issue.detail === 'codex'
}

/**
 * One definition problem: t(`teams.def.issue.${code}`, {file, line, key, detail}); a `repo` detail in words.
 * Two warnings have their own words: the Codex allowlist that is ignored and a misnamed file the team does not read.
 */
export function defIssueText(issue: DefError, t: TFn): string {
  if (codexToolsWarning(issue)) return t('teams.def.issue.codexTools')
  if (issue.code === 'bad_name' && isDefWarning(issue) && !issue.detail) return t('teams.def.issue.badNameIgnored')
  const why = issue.code === 'repo' && issue.detail ? REPO_WHY_KEY[issue.detail] : undefined
  const text = t(ISSUE_KEY[issue.code] ?? 'teams.def.issue.io', {
    file: visibleName(issue.file),
    line: issue.line,
    key: visibleName(issue.key ?? ''),
    detail: visibleName(issue.detail ?? ''),
  })
  return why ? `${text}: ${t(why)}` : text
}

/** Where a problem is: "roles/dev.md, línea 4" (the file alone without a line); the name with its hidden characters spelled out. */
export function defIssueAt(issue: DefError, t: TFn): string {
  const file = visibleName(issue.file)
  return issue.line > 0 ? t('teams.def.issue.at', { file, line: issue.line }) : file
}

/** The detail shown after the text, when the text does not already say it. */
function issueDetail(issue: DefError): string | null {
  if (!issue.detail || issue.code === 'repo' || codexToolsWarning(issue)) return null
  return visibleName(issue.detail)
}

function IssueItems({ issues }: { issues: readonly DefError[] }) {
  const t = useT()
  return (
    <ul className="mt-1.5 space-y-1">
      {issues.map((issue, i) => {
        const detail = issueDetail(issue)
        return (
          <li key={i} data-def-issue={issue.code} data-def-severity={isDefWarning(issue) ? 'warning' : 'error'} className="min-w-0 text-xs text-text-primary">
            <span className="break-all font-mono text-[11px] text-text-secondary">{defIssueAt(issue, t)}</span>
            <span className="mx-1.5 text-text-secondary">·</span>
            <span className="break-words">{defIssueText(issue, t)}</span>
            {detail && <span className="ml-1.5 break-all font-mono text-[11px] text-text-secondary">{detail}</span>}
          </li>
        )
      })}
    </ul>
  )
}

/**
 * The definition problems, each with its place: the errors (they block a
 * trust, an adopt or a write) under `title`, then the warnings in the warning
 * style under their own title (they never block).
 */
export function DefIssueList({ issues, title }: { issues: readonly DefError[]; title: string }) {
  const t = useT()
  const errors = defErrorsOf(issues)
  const warnings = defWarningsOf(issues)
  if (errors.length === 0 && warnings.length === 0) return null
  return (
    <>
      {errors.length > 0 && (
        <div data-def-issues className="rounded-btn border border-red-400/40 bg-red-400/10 px-3 py-2.5">
          <p className="flex items-center gap-1.5 text-xs font-medium text-red-400">
            <CircleAlert size={13} className="shrink-0" />
            {title}
          </p>
          <IssueItems issues={errors} />
        </div>
      )}
      {warnings.length > 0 && (
        <div data-def-warnings className="rounded-btn border border-amber-400/40 bg-amber-400/10 px-3 py-2.5">
          <p className="flex items-center gap-1.5 text-xs font-medium text-amber-400">
            <AlertTriangle size={13} className="shrink-0" />
            {t('teams.def.issue.warnings')}
          </p>
          <IssueItems issues={warnings} />
        </div>
      )}
    </>
  )
}

/** The risks in teamRiskFlags order, or a line saying there are none. */
export function RiskList({ risks }: { risks: readonly TeamRiskFlag[] }) {
  const t = useT()
  return (
    <section className="space-y-1.5">
      <h3 className="text-xs font-medium text-text-secondary">{t('teams.trust.risks')}</h3>
      {risks.length === 0 ? (
        <p data-trust-no-risks className="text-xs text-text-secondary">{t('teams.trust.noRisks')}</p>
      ) : (
        <ul data-trust-risks className="space-y-1 rounded-btn border border-amber-400/40 bg-amber-400/10 px-3 py-2">
          {risks.map((r, i) => (
            <li key={i} data-trust-risk={r.code} className="flex min-w-0 items-start gap-1.5 text-xs text-text-primary">
              <AlertTriangle size={13} className="mt-px shrink-0 text-amber-400" />
              <span className="min-w-0 break-words">{riskText(r, t)}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

/** The hunks with every line's hiding characters spelled out (the +/- prefix is plain ASCII, so it stays). */
function visibleHunks(hunks: readonly ChatPatchHunk[]): ChatPatchHunk[] {
  return hunks.map((h) => ({ ...h, lines: h.lines.map(visibleLine) }))
}

function FileDiff({ file }: { file: TeamFileDiff }) {
  const t = useT()
  const [open, setOpen] = useState(true)
  const hunks = useMemo(() => visibleHunks(file.hunks), [file.hunks])
  return (
    <li data-trust-file={file.rel} data-file-status={file.status} className="min-w-0 rounded-btn border border-border bg-bg-secondary/40">
      <button
        type="button"
        aria-expanded={open}
        data-trust-file-toggle
        onClick={() => setOpen((v) => !v)}
        className="flex w-full min-w-0 items-center gap-1.5 px-2.5 py-1.5 text-left text-xs transition-colors hover:bg-card"
      >
        {open ? <ChevronDown size={13} className="shrink-0 text-text-secondary" /> : <ChevronRight size={13} className="shrink-0 text-text-secondary" />}
        <FileText size={13} className="shrink-0 text-text-secondary" />
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-text-primary">{visibleName(file.rel)}</span>
        <span
          className={cn(
            'shrink-0 rounded border px-1 text-[10px] leading-4',
            file.status === 'changed' ? 'border-border text-text-secondary' : 'border-amber-400/60 bg-amber-400/15 text-amber-500',
          )}
        >
          {t(FILE_STATUS_KEY[file.status])}
        </span>
        <span className="shrink-0 font-mono text-[11px] tabular-nums text-text-secondary">{t('teams.trust.fileStat', { add: file.add, del: file.del })}</span>
      </button>
      {open && (
        <div className="min-w-0 space-y-1 border-t border-border p-2">
          {hunks.length > 0 ? (
            <PatchBlock hunks={hunks} />
          ) : (
            <p className="text-[11px] text-text-secondary">{t('teams.trust.noHunks')}</p>
          )}
          {file.truncated && (
            <p data-trust-file-cut className="text-[11px] text-text-secondary">{t('teams.trust.fileCut')}</p>
          )}
        </div>
      )}
    </li>
  )
}

/** Risks first, then the file list with each diff (open by default; a click folds one). */
export function TeamDiffView({ diff }: { diff: TeamDefinitionDiff }) {
  const t = useT()
  return (
    <div data-team-diff className="min-w-0 space-y-4">
      <RiskList risks={diff.risks} />
      <section className="min-w-0 space-y-1.5">
        <h3 className="text-xs font-medium text-text-secondary">{t('teams.trust.files')}</h3>
        {diff.files.length === 0 ? (
          <p data-trust-no-files className="text-xs text-text-secondary">{t('teams.trust.noFiles')}</p>
        ) : (
          <ul data-trust-files className="min-w-0 space-y-1.5">
            {diff.files.map((f) => (
              <FileDiff key={f.rel} file={f} />
            ))}
          </ul>
        )}
        {diff.truncated && (
          <p data-trust-truncated className="text-[11px] text-text-secondary">{t('teams.trust.truncated')}</p>
        )}
      </section>
    </div>
  )
}
