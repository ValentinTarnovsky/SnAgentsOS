/**
 * The roles of a new team (app 2.7.0, E10 B1): one row per role of the draft
 * main proposed (Líder, Dev, QA, Investigación), with its name, agent, model,
 * effort, access and how many. The Lead always stays, with one agent. Models
 * and efforts come from the same allowlists the definition parser checks;
 * the dialog edits the draft only, main renders the files.
 */
import { CLAUDE_EFFORTS, CLAUDE_MODELS } from '@shared/agentTune'
import { CODEX_EFFORTS, CODEX_MODEL_RE, ROLE_NAME_MAX, type RoleDraft } from '@shared/teamDefinition'
import { ROLE_COUNT_MAX, type RoleKind } from '@shared/teams'
import type { AgentProvider } from '@shared/types'
import { useT, type MessageKey } from '@/i18n'
import { cn } from '@/lib/cn'
import { permLabel, providerLabel } from './TeamDiffView'

const KIND_KEY: Record<RoleKind, MessageKey> = {
  lead: 'teams.setup.kind.lead',
  dev: 'teams.setup.kind.dev',
  qa: 'teams.setup.kind.qa',
  research: 'teams.setup.kind.research',
  custom: 'teams.setup.kind.custom',
}

const PROVIDERS: readonly AgentProvider[] = ['claude', 'codex']
const PERMISSIONS: readonly RoleDraft['permission'][] = ['total', 'readonly']
const COUNTS: readonly number[] = Array.from({ length: ROLE_COUNT_MAX }, (_, i) => i + 1)

/** Model and effort that still make sense after a provider switch (a Claude model never goes to Codex). */
export function switchProvider(role: RoleDraft, provider: AgentProvider): Partial<RoleDraft> {
  if (provider === role.provider) return {}
  const efforts: readonly string[] = provider === 'claude' ? CLAUDE_EFFORTS : CODEX_EFFORTS
  return { provider, model: undefined, effort: role.effort && efforts.includes(role.effort) ? role.effort : undefined }
}

/** A Codex model typed by hand passes CODEX_MODEL_RE; empty means the default. */
export function codexModelOk(model: string | undefined): boolean {
  return !model || CODEX_MODEL_RE.test(model)
}

export function rolesValid(roles: readonly RoleDraft[]): boolean {
  return (
    roles.some((r) => r.kind === 'lead') &&
    roles.every((r) => r.name.trim().length > 0 && (r.provider !== 'codex' || codexModelOk(r.model)))
  )
}

const cellInput =
  'h-8 w-full min-w-0 rounded-btn border border-border bg-bg-primary px-2 text-xs text-text-primary outline-none focus:border-accent-violet/60 disabled:cursor-not-allowed disabled:opacity-60'

export function SetupRolesTable({ roles, onChange }: { roles: RoleDraft[]; onChange: (id: string, patch: Partial<RoleDraft>) => void }) {
  const t = useT()
  return (
    <div className="min-w-0 overflow-x-auto rounded-btn border border-border">
      <table data-setup-roles className="w-full min-w-[672px] table-fixed border-collapse text-xs">
        <thead className="bg-bg-secondary/60 text-left text-[11px] font-medium text-text-secondary">
          <tr>
            <th className="w-12 px-2 py-1.5 font-medium">{t('teams.setup.roles.col.on')}</th>
            <th className="px-2 py-1.5 font-medium">{t('teams.setup.roles.col.role')}</th>
            <th className="w-[104px] px-2 py-1.5 font-medium">{t('teams.setup.roles.col.provider')}</th>
            <th className="w-[116px] px-2 py-1.5 font-medium">{t('teams.setup.roles.col.model')}</th>
            <th className="w-[128px] px-2 py-1.5 font-medium">{t('teams.setup.roles.col.effort')}</th>
            <th className="w-[132px] px-2 py-1.5 font-medium">{t('teams.setup.roles.col.permission')}</th>
            <th className="w-[64px] px-2 py-1.5 font-medium">{t('teams.setup.roles.col.count')}</th>
          </tr>
        </thead>
        <tbody>
          {roles.map((r) => {
            const lead = r.kind === 'lead'
            const on = lead || r.enabled
            const efforts: readonly string[] = r.provider === 'claude' ? CLAUDE_EFFORTS : CODEX_EFFORTS
            const modelBad = r.provider === 'codex' && !codexModelOk(r.model)
            return (
              <tr
                key={r.id}
                data-setup-role={r.id}
                data-role-enabled={on}
                className={cn('border-t border-border align-middle', !on && 'opacity-60')}
              >
                <td className="px-2 py-1.5">
                  <input
                    type="checkbox"
                    data-role-field="enabled"
                    checked={on}
                    disabled={lead}
                    aria-label={lead ? t('teams.setup.roles.leadAlways') : t('teams.setup.roles.enable', { name: r.name || r.id })}
                    onChange={(e) => onChange(r.id, { enabled: e.target.checked })}
                    className="h-4 w-4 accent-[var(--color-accent-violet)] disabled:cursor-not-allowed"
                  />
                </td>
                <td className="px-2 py-1.5">
                  <div className="flex min-w-0 items-center gap-1.5">
                    <input
                      type="text"
                      data-role-field="name"
                      value={r.name}
                      maxLength={ROLE_NAME_MAX}
                      disabled={!on}
                      aria-label={t('teams.setup.roles.nameOf', { id: r.id })}
                      aria-invalid={r.name.trim() ? undefined : true}
                      onChange={(e) => onChange(r.id, { name: e.target.value })}
                      className={cn(cellInput, !r.name.trim() && 'border-red-400/60')}
                    />
                    {r.name.trim() !== t(KIND_KEY[r.kind]) && (
                      <span data-role-kind={r.kind} className="shrink-0 rounded border border-border px-1 text-[10px] leading-4 text-text-secondary">
                        {t(KIND_KEY[r.kind])}
                      </span>
                    )}
                  </div>
                </td>
                <td className="px-2 py-1.5">
                  <select
                    data-role-field="provider"
                    value={r.provider}
                    disabled={!on}
                    aria-label={t('teams.setup.roles.col.provider')}
                    onChange={(e) => onChange(r.id, switchProvider(r, e.target.value as AgentProvider))}
                    className={cellInput}
                  >
                    {PROVIDERS.map((p) => (
                      <option key={p} value={p}>{providerLabel(p, t)}</option>
                    ))}
                  </select>
                </td>
                <td className="px-2 py-1.5">
                  {r.provider === 'claude' ? (
                    <select
                      data-role-field="model"
                      value={r.model ?? 'default'}
                      disabled={!on}
                      aria-label={t('teams.setup.roles.col.model')}
                      onChange={(e) => onChange(r.id, { model: e.target.value === 'default' ? undefined : e.target.value })}
                      className={cellInput}
                    >
                      {CLAUDE_MODELS.map((m) => (
                        <option key={m} value={m}>{m === 'default' ? t('teams.setup.roles.default') : m}</option>
                      ))}
                    </select>
                  ) : (
                    <input
                      type="text"
                      data-role-field="model"
                      spellCheck={false}
                      autoComplete="off"
                      maxLength={48}
                      value={r.model ?? ''}
                      disabled={!on}
                      placeholder={t('teams.setup.roles.default')}
                      aria-label={t('teams.setup.roles.col.model')}
                      aria-invalid={modelBad || undefined}
                      onChange={(e) => onChange(r.id, { model: e.target.value.trim() || undefined })}
                      className={cn(cellInput, 'font-mono', modelBad && 'border-red-400/60')}
                    />
                  )}
                  {modelBad && (
                    <p data-role-model-error className="mt-0.5 text-[10px] leading-3 text-red-400">{t('teams.setup.roles.modelInvalid')}</p>
                  )}
                </td>
                <td className="px-2 py-1.5">
                  <select
                    data-role-field="effort"
                    value={r.effort ?? ''}
                    disabled={!on}
                    aria-label={t('teams.setup.roles.col.effort')}
                    onChange={(e) => onChange(r.id, { effort: e.target.value || undefined })}
                    className={cellInput}
                  >
                    <option value="">{t('teams.setup.roles.default')}</option>
                    {efforts.map((x) => (
                      <option key={x} value={x}>{x}</option>
                    ))}
                  </select>
                </td>
                <td className="px-2 py-1.5">
                  <select
                    data-role-field="permission"
                    value={r.permission}
                    disabled={!on}
                    aria-label={t('teams.setup.roles.col.permission')}
                    onChange={(e) => onChange(r.id, { permission: e.target.value as RoleDraft['permission'] })}
                    className={cn(cellInput, r.permission === 'total' && 'border-amber-400/60')}
                  >
                    {PERMISSIONS.map((p) => (
                      <option key={p} value={p}>{permLabel(p, t)}</option>
                    ))}
                  </select>
                </td>
                <td className="px-2 py-1.5">
                  <select
                    data-role-field="count"
                    value={lead ? 1 : r.count}
                    disabled={!on || lead}
                    aria-label={t('teams.setup.roles.col.count')}
                    onChange={(e) => onChange(r.id, { count: Number(e.target.value) })}
                    className={cellInput}
                  >
                    {COUNTS.map((n) => (
                      <option key={n} value={n}>{n}</option>
                    ))}
                  </select>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
