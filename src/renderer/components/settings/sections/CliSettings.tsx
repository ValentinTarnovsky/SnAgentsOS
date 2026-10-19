import { useCallback, useEffect, useState } from 'react'
import { Copy, RefreshCw, Wrench } from 'lucide-react'
import type { CliUiState, SkillOp, SkillStatus } from '@shared/ctl-protocol'
import { useAppStore } from '@/lib/store'
import { useAppInfo } from '@/lib/useAppInfo'
import { toast } from '@/lib/toast'
import { useT } from '@/i18n'
import { SettingRow, ToggleRow } from '../ui'

const btnCls =
  'flex shrink-0 items-center gap-1.5 rounded-btn border border-border bg-card px-2.5 py-1.5 text-xs text-text-primary transition-colors hover:border-accent-violet/40 disabled:cursor-not-allowed disabled:opacity-50'

/** The example "Copy example" puts on the clipboard. */
export const CLI_EXAMPLE = 'snaos ls'

/**
 * Settings > Automation, CLI block (E8-FR-21/22): the snaos switch, the SSH
 * protection, the user PATH (Windows, never in the portable), the server
 * state with "Copy example" and the Claude skill row. Nothing here installs
 * or edits anything on its own: every side effect is a click.
 */
export function CliSettings() {
  const t = useT()
  const info = useAppInfo()
  const cliEnabled = useAppStore((s) => s.settings.cliEnabled !== false)
  const protectSsh = useAppStore((s) => s.settings.automation?.cliProtectSsh !== false)
  const userPath = useAppStore((s) => s.settings.automation?.cliUserPath === true)
  const updateSettings = useAppStore((s) => s.updateSettings)
  const [state, setState] = useState<CliUiState | null>(null)
  const [skill, setSkill] = useState<SkillStatus | null>(null)
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(() => {
    window.snApi.cli
      .state()
      .then(setState)
      .catch(() => setState(null))
  }, [])

  useEffect(() => {
    refresh()
    // The switch reaches main on the App effect; read the state back shortly after.
    const id = setTimeout(refresh, 400)
    return () => clearTimeout(id)
  }, [cliEnabled, refresh])

  useEffect(() => {
    window.snApi.cli
      .skill('status')
      .then(setSkill)
      .catch(() => setSkill(null))
  }, [])

  const automation = useAppStore((s) => s.settings.automation)
  const patchAutomation = (patch: Partial<typeof automation>): void => updateSettings({ automation: { ...useAppStore.getState().settings.automation, ...patch } })

  const portable = info?.portable === true || state?.portable === true
  const windows = (info?.platform ?? window.snApi.platform) === 'win32'
  const pathDisabled = portable || !windows || busy

  const setUserPath = async (v: boolean): Promise<void> => {
    setBusy(true)
    try {
      const ok = await window.snApi.cli.userPath(v)
      if (ok) patchAutomation({ cliUserPath: v })
      else toast.error(t('settings.cli.userPathFailed'), { dedupeKey: 'cli-path' })
    } finally {
      setBusy(false)
      refresh()
    }
  }

  const runSkill = async (op: SkillOp): Promise<void> => {
    setBusy(true)
    try {
      const next = await window.snApi.cli.skill(op)
      setSkill(next)
      if (next.error) toast.error(next.error === 'foreign' ? t('settings.cli.skill.foreignError') : t('settings.cli.skill.failed'), { dedupeKey: 'cli-skill' })
    } finally {
      setBusy(false)
    }
  }

  let server: string
  let serverBad = false
  if (!state) server = t('settings.cli.server.unknown')
  else if (state.running && state.endpoint) server = t('settings.cli.server.running', { endpoint: state.endpoint, time: state.startedAt ? new Date(state.startedAt).toLocaleTimeString() : '?' })
  else if (!state.enabled) server = t('settings.cli.server.off')
  else {
    server = state.error ? t('settings.cli.server.error', { error: state.error }) : t('settings.cli.server.starting')
    serverBad = !!state.error
  }

  let skillText: string
  if (!skill) skillText = t('settings.cli.server.unknown')
  else if (skill.state === 'installed') skillText = t('settings.cli.skill.installed', { version: skill.version ?? '?' })
  else if (skill.state === 'outdated') skillText = t('settings.cli.skill.outdated', { version: skill.version ?? '?' })
  else if (skill.state === 'foreign') skillText = t('settings.cli.skill.foreign')
  else skillText = t('settings.cli.skill.missing')

  return (
    <div className="space-y-6" data-cli-settings>
      <ToggleRow searchId="automation.cli" checked={cliEnabled} onChange={(v) => updateSettings({ cliEnabled: v })} title={t('settings.cli.enabled')} description={t('settings.cli.enabledHint')} />
      <ToggleRow
        searchId="automation.protectSsh"
        checked={protectSsh}
        onChange={(v) => patchAutomation({ cliProtectSsh: v })}
        title={t('settings.cli.protectSsh')}
        description={t('settings.cli.protectSshHint')}
      />
      <div title={portable ? t('settings.cli.userPathPortable') : undefined} data-cli-user-path>
        <ToggleRow
          searchId="automation.userPath"
          checked={userPath && !portable}
          disabled={pathDisabled}
          onChange={(v) => void setUserPath(v)}
          title={t('settings.cli.userPath')}
          description={portable ? t('settings.cli.userPathPortable') : t('settings.cli.userPathHint', { dir: state?.binDir ?? '' })}
        />
      </div>
      <p className="text-xs text-text-secondary" data-cli-restart-note>
        {t('settings.cli.restartNote')}
      </p>
      <SettingRow searchId="automation.server" title={t('settings.cli.server')} description={t('settings.cli.serverHint')}>
        <div className="flex items-center gap-3">
          <p data-cli-server className={serverBad ? 'min-w-0 break-all text-xs text-state-error' : 'min-w-0 break-all font-mono text-xs text-text-primary'}>
            {server}
          </p>
          <button type="button" onClick={refresh} className={btnCls} aria-label={t('settings.cli.refresh')}>
            <RefreshCw size={13} className="text-accent-violet" />
          </button>
          <button
            type="button"
            data-cli-copy
            onClick={() => {
              window.snApi.clipboard.writeText(CLI_EXAMPLE)
              toast.success(t('toast.copied'), { dedupeKey: 'copied' })
            }}
            className={btnCls}
          >
            <Copy size={13} className="text-accent-violet" />
            {t('settings.cli.copyExample')}
          </button>
        </div>
      </SettingRow>
      <SettingRow searchId="automation.skill" title={t('settings.cli.skill')} description={t('settings.cli.skillHint')}>
        <div className="flex flex-wrap items-center gap-2">
          <p data-cli-skill={skill?.state ?? 'unknown'} className="mr-auto min-w-0 break-all text-xs text-text-primary">
            {skillText}
          </p>
          {(skill?.state === 'missing' || !skill) && (
            <button type="button" data-cli-skill-install disabled={busy} onClick={() => void runSkill('install')} className={btnCls}>
              {t('settings.cli.skill.install')}
            </button>
          )}
          {(skill?.state === 'installed' || skill?.state === 'outdated') && (
            <button type="button" data-cli-skill-repair disabled={busy} onClick={() => void runSkill('repair')} className={btnCls}>
              <Wrench size={13} className="text-accent-violet" />
              {t('settings.cli.skill.repair')}
            </button>
          )}
          {(skill?.state === 'installed' || skill?.state === 'outdated') && (
            <button type="button" data-cli-skill-remove disabled={busy} onClick={() => void runSkill('remove')} className={btnCls}>
              {t('settings.cli.skill.remove')}
            </button>
          )}
        </div>
      </SettingRow>
    </div>
  )
}
