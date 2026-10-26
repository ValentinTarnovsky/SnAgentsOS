import { useState } from 'react'
import { Pencil, Plus, Trash2 } from 'lucide-react'
import type { AgentPreset, AgentSettings, AwakeMode, ResumeOnStartup, SilenceSettings } from '@shared/types'
import { HIBERNATE_MAX_MINUTES, HIBERNATE_MIN_MINUTES, HIBERNATE_SUGGESTED_MINUTES, normalizeIdleMinutes } from '@shared/hibernation'
import { normalizeSilence, SILENCE_QUIET_MIN, SILENCE_STALLED_MIN } from '@shared/silence'
import { useAppStore } from '@/lib/store'
import { iconFor } from '@/lib/icons'
import { cn } from '@/lib/cn'
import { useT, type MessageKey } from '@/i18n'
import { PresetEditor } from '../PresetEditor'
import { SettingRow, ToggleRow, inputCls } from '../ui'

const AWAKE_MODES: Array<{ mode: AwakeMode; key: MessageKey }> = [
  { mode: 'auto', key: 'awake.mode.auto' },
  { mode: 'always', key: 'awake.mode.always' },
  { mode: 'never', key: 'awake.mode.never' },
]

const RESUME_POLICIES: Array<{ policy: ResumeOnStartup; key: MessageKey }> = [
  { policy: 'ask', key: 'settings.agents.resume.ask' },
  { policy: 'auto', key: 'settings.agents.resume.auto' },
  { policy: 'off', key: 'settings.agents.resume.off' },
]

const SIDEBAR_SORTS: Array<{ sort: AgentSettings['sidebarSort']; key: MessageKey }> = [
  { sort: 'manual', key: 'settings.agents.sort.manual' },
  { sort: 'smart', key: 'settings.agents.sort.smart' },
]

const CACHE_TTLS: Array<5 | 60> = [5, 60]

const headingCls = 'text-xs font-semibold uppercase tracking-wide text-text-secondary'

/** Whole seconds 0..600 for settings.agents.resumeModalTimeoutSec (0 = never). */
function clampTimeout(value: string): number {
  const n = Math.round(Number(value))
  return Number.isFinite(n) ? Math.min(600, Math.max(0, n)) : 60
}

/** Typed minutes for hibernation, clamped to 5..1440 (a non-number keeps `fallback`). */
export function clampIdleMinutes(value: string, fallback: number): number {
  const n = Math.round(Number(value))
  if (!value.trim() || !Number.isFinite(n)) return fallback
  return Math.min(HIBERNATE_MAX_MINUTES, Math.max(HIBERNATE_MIN_MINUTES, n))
}

/**
 * Hibernation (E5-FR-25): off by default; turning it on proposes 30 minutes.
 * The minutes field commits on blur or Enter, so typing "1" on the way to
 * "120" never clamps mid-word.
 */
function HibernateRows() {
  const t = useT()
  const minutes = useAppStore((s) => normalizeIdleMinutes(s.settings.hibernateIdleMinutes))
  const updateSettings = useAppStore((s) => s.updateSettings)
  const [draft, setDraft] = useState<string | null>(null)
  const on = minutes > 0
  const commit = (): void => {
    if (draft === null) return
    updateSettings({ hibernateIdleMinutes: clampIdleMinutes(draft, minutes || HIBERNATE_SUGGESTED_MINUTES) })
    setDraft(null)
  }
  return (
    <>
      <ToggleRow
        checked={on}
        onChange={(v) => updateSettings({ hibernateIdleMinutes: v ? HIBERNATE_SUGGESTED_MINUTES : 0 })}
        searchId="agents.hibernate"
        title={t('settings.agents.hibernate')}
        description={t('settings.agents.hibernateHint')}
      />
      <SettingRow searchId="agents.hibernateMinutes" title={t('settings.agents.hibernateMinutes')} description={t('settings.agents.hibernateMinutesHint')}>
        <input
          type="number"
          min={HIBERNATE_MIN_MINUTES}
          max={HIBERNATE_MAX_MINUTES}
          step={5}
          data-hibernate-minutes
          disabled={!on}
          className={cn(inputCls, 'w-28', !on && 'pointer-events-none opacity-50')}
          value={draft ?? (on ? String(minutes) : String(HIBERNATE_SUGGESTED_MINUTES))}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit()
          }}
        />
      </SettingRow>
    </>
  )
}

/** Typed minutes for a silence threshold, clamped to `range` (a non-number keeps `fallback`). */
export function clampSilenceMinutes(value: string, range: { min: number; max: number }, fallback: number): number {
  const n = Math.round(Number(value))
  if (!value.trim() || !Number.isFinite(n)) return fallback
  return Math.min(range.max, Math.max(range.min, n))
}

/**
 * Silence watch (app 2.7.0, A6; E10-FR-18): the quiet / stalled chip of a
 * working agent with no sign of life. The minutes commit on blur or Enter
 * like hibernation, and go through normalizeSilence (the rule main applies)
 * so stalledMin always stays above quietMin.
 */
function SilenceRows() {
  const t = useT()
  const silence = normalizeSilence(useAppStore((s) => s.settings.agents.silence))
  const updateSettings = useAppStore((s) => s.updateSettings)
  const [quiet, setQuiet] = useState<string | null>(null)
  const [stalled, setStalled] = useState<string | null>(null)
  const save = (patch: Partial<SilenceSettings>): void => {
    const agents = useAppStore.getState().settings.agents
    const prev = normalizeSilence(agents.silence)
    const next = normalizeSilence({ ...prev, ...patch })
    if (next.enabled !== prev.enabled || next.quietMin !== prev.quietMin || next.stalledMin !== prev.stalledMin) {
      updateSettings({ agents: { ...agents, silence: next } })
    }
  }
  const commitQuiet = (): void => {
    if (quiet === null) return
    save({ quietMin: clampSilenceMinutes(quiet, SILENCE_QUIET_MIN, silence.quietMin) })
    setQuiet(null)
  }
  const commitStalled = (): void => {
    if (stalled === null) return
    save({ stalledMin: clampSilenceMinutes(stalled, SILENCE_STALLED_MIN, silence.stalledMin) })
    setStalled(null)
  }
  const off = !silence.enabled
  return (
    <>
      <ToggleRow
        checked={silence.enabled}
        onChange={(v) => save({ enabled: v })}
        searchId="agents.silence"
        title={t('settings.agents.silence')}
        description={t('settings.agents.silenceHint')}
      />
      <SettingRow searchId="agents.silenceQuiet" title={t('settings.agents.silenceQuiet')} description={t('settings.agents.silenceQuietHint')}>
        <input
          type="number"
          min={SILENCE_QUIET_MIN.min}
          max={SILENCE_QUIET_MIN.max}
          step={1}
          data-silence-quiet
          disabled={off}
          aria-label={t('settings.agents.silenceQuiet')}
          className={cn(inputCls, 'w-28', off && 'pointer-events-none opacity-50')}
          value={quiet ?? String(silence.quietMin)}
          onChange={(e) => setQuiet(e.target.value)}
          onBlur={commitQuiet}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commitQuiet()
          }}
        />
      </SettingRow>
      <SettingRow searchId="agents.silenceStalled" title={t('settings.agents.silenceStalled')} description={t('settings.agents.silenceStalledHint')}>
        <input
          type="number"
          min={SILENCE_STALLED_MIN.min}
          max={SILENCE_STALLED_MIN.max}
          step={1}
          data-silence-stalled
          disabled={off}
          aria-label={t('settings.agents.silenceStalled')}
          className={cn(inputCls, 'w-28', off && 'pointer-events-none opacity-50')}
          value={stalled ?? String(silence.stalledMin)}
          onChange={(e) => setStalled(e.target.value)}
          onBlur={commitStalled}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commitStalled()
          }}
        />
      </SettingRow>
    </>
  )
}

/**
 * Agent "Behavior" block (E5-FR-29). Each key joins when its FR lands; today:
 * resume on startup (E5-FR-10), the resume dialog countdown (E5-FR-12) and
 * nudge (E5-FR-13), keep the PC awake and its display variant (E5-FR-23/24),
 * sidebar agent rows and topic as title (E5-FR-19), the sidebar order
 * (E5-FR-22), Ctrl+1..9 (E5-FR-18), hibernation (E5-FR-25), the Claude
 * cache timer (E5-FR-28) and the silence watch (app 2.7.0).
 */
function BehaviorBlock() {
  const t = useT()
  const awakeMode = useAppStore((s) => s.settings.awakeMode)
  const agents = useAppStore((s) => s.settings.agents)
  const updateSettings = useAppStore((s) => s.updateSettings)

  return (
    <section className="space-y-4" aria-labelledby="agents-behavior">
      <h4 id="agents-behavior" className={headingCls}>
        {t('settings.agents.behavior')}
      </h4>
      <SettingRow searchId="agents.resume" title={t('settings.agents.resume')} description={t('settings.agents.resumeHint')}>
        <div role="radiogroup" aria-label={t('settings.agents.resume')} className="flex flex-wrap gap-2">
          {RESUME_POLICIES.map(({ policy, key }) => (
            <button
              key={policy}
              type="button"
              role="radio"
              aria-checked={agents.resumeOnStartup === policy}
              data-resume-policy={policy}
              onClick={() => updateSettings({ agents: { ...agents, resumeOnStartup: policy } })}
              className={cn(
                'rounded-btn border px-3 py-1 text-xs transition-colors',
                agents.resumeOnStartup === policy
                  ? 'border-accent-violet bg-accent-violet text-white'
                  : 'border-border bg-bg-secondary text-text-primary hover:border-accent-violet/40',
              )}
            >
              {t(key)}
            </button>
          ))}
        </div>
      </SettingRow>
      <SettingRow searchId="agents.resumeTimeout" title={t('settings.agents.resumeTimeout')} description={t('settings.agents.resumeTimeoutHint')}>
        <input
          type="number"
          min={0}
          max={600}
          step={5}
          data-resume-timeout
          disabled={agents.resumeOnStartup !== 'ask'}
          className={cn(inputCls, 'w-28', agents.resumeOnStartup !== 'ask' && 'pointer-events-none opacity-50')}
          value={agents.resumeModalTimeoutSec}
          onChange={(e) => updateSettings({ agents: { ...agents, resumeModalTimeoutSec: clampTimeout(e.target.value) } })}
        />
      </SettingRow>
      <ToggleRow
        checked={agents.resumeNudge}
        onChange={(v) => updateSettings({ agents: { ...agents, resumeNudge: v } })}
        searchId="agents.resumeNudge"
        title={t('settings.agents.resumeNudge')}
        description={t('settings.agents.resumeNudgeHint')}
        disabled={agents.resumeOnStartup === 'off'}
      />
      <SettingRow searchId="agents.resumeNudgeText" title={t('settings.agents.resumeNudgeText')} description={t('settings.agents.resumeNudgeTextHint')}>
        <input
          type="text"
          maxLength={500}
          data-resume-nudge-text
          disabled={!agents.resumeNudge || agents.resumeOnStartup === 'off'}
          placeholder={t('agents.nudge.default')}
          className={cn(inputCls, (!agents.resumeNudge || agents.resumeOnStartup === 'off') && 'pointer-events-none opacity-50')}
          value={agents.resumeNudgeText}
          onChange={(e) => updateSettings({ agents: { ...agents, resumeNudgeText: e.target.value.slice(0, 500) } })}
        />
      </SettingRow>
      <SettingRow searchId="agents.awake" title={t('settings.agents.awake')} description={t('settings.agents.awakeHint')}>
        <div role="radiogroup" aria-label={t('settings.agents.awake')} className="flex flex-wrap gap-2">
          {AWAKE_MODES.map(({ mode, key }) => (
            <button
              key={mode}
              type="button"
              role="radio"
              aria-checked={awakeMode === mode}
              data-awake-mode={mode}
              onClick={() => updateSettings({ awakeMode: mode })}
              className={cn(
                'rounded-btn border px-3 py-1 text-xs transition-colors',
                awakeMode === mode
                  ? 'border-accent-violet bg-accent-violet text-white'
                  : 'border-border bg-bg-secondary text-text-primary hover:border-accent-violet/40',
              )}
            >
              {t(key)}
            </button>
          ))}
        </div>
      </SettingRow>
      <ToggleRow
        checked={agents.awakeDisplay}
        onChange={(v) => updateSettings({ agents: { ...agents, awakeDisplay: v } })}
        searchId="agents.awakeDisplay"
        title={t('settings.agents.awakeDisplay')}
        description={t('settings.agents.awakeDisplayHint')}
        disabled={awakeMode === 'never'}
      />
      <ToggleRow
        checked={agents.sidebarAgentRows}
        onChange={(v) => updateSettings({ agents: { ...agents, sidebarAgentRows: v } })}
        searchId="agents.rows"
        title={t('settings.agents.rows')}
        description={t('settings.agents.rowsHint')}
      />
      <SettingRow searchId="agents.sort" title={t('settings.agents.sort')} description={t('settings.agents.sortHint')}>
        <div role="radiogroup" aria-label={t('settings.agents.sort')} className="flex flex-wrap gap-2">
          {SIDEBAR_SORTS.map(({ sort, key }) => (
            <button
              key={sort}
              type="button"
              role="radio"
              aria-checked={agents.sidebarSort === sort}
              data-sidebar-sort={sort}
              onClick={() => updateSettings({ agents: { ...agents, sidebarSort: sort } })}
              className={cn(
                'rounded-btn border px-3 py-1 text-xs transition-colors',
                agents.sidebarSort === sort
                  ? 'border-accent-violet bg-accent-violet text-white'
                  : 'border-border bg-bg-secondary text-text-primary hover:border-accent-violet/40',
              )}
            >
              {t(key)}
            </button>
          ))}
        </div>
      </SettingRow>
      <ToggleRow
        checked={agents.topicAsTitle}
        onChange={(v) => updateSettings({ agents: { ...agents, topicAsTitle: v } })}
        searchId="agents.topicAsTitle"
        title={t('settings.agents.topicAsTitle')}
        description={t('settings.agents.topicAsTitleHint')}
      />
      <ToggleRow
        checked={agents.syncAgentRename !== false}
        onChange={(v) => updateSettings({ agents: { ...agents, syncAgentRename: v } })}
        searchId="agents.syncAgentRename"
        title={t('settings.agents.syncAgentRename')}
        description={t('settings.agents.syncAgentRenameHint')}
      />
      <ToggleRow
        checked={agents.shellAgentDetect !== false}
        onChange={(v) => updateSettings({ agents: { ...agents, shellAgentDetect: v } })}
        searchId="agents.shellAgentDetect"
        title={t('settings.agents.shellAgentDetect')}
        description={t('settings.agents.shellAgentDetectHint')}
      />
      <ToggleRow
        checked={agents.ctrlDigitFocus}
        onChange={(v) => updateSettings({ agents: { ...agents, ctrlDigitFocus: v } })}
        searchId="agents.ctrlDigit"
        title={t('settings.agents.ctrlDigit')}
        description={t('settings.agents.ctrlDigitHint')}
      />
      <HibernateRows />
      <ToggleRow
        checked={agents.cacheTimer.enabled}
        onChange={(v) => updateSettings({ agents: { ...agents, cacheTimer: { ...agents.cacheTimer, enabled: v } } })}
        searchId="agents.cacheTimer"
        title={t('settings.agents.cacheTimer')}
        description={t('settings.agents.cacheTimerHint')}
      />
      <SettingRow searchId="agents.cacheTtl" title={t('settings.agents.cacheTtl')} description={t('settings.agents.cacheTtlHint')}>
        <div role="radiogroup" aria-label={t('settings.agents.cacheTtl')} className="flex flex-wrap gap-2">
          {CACHE_TTLS.map((ttl) => (
            <button
              key={ttl}
              type="button"
              role="radio"
              aria-checked={agents.cacheTimer.ttlMinutes === ttl}
              data-cache-ttl={ttl}
              disabled={!agents.cacheTimer.enabled}
              onClick={() => updateSettings({ agents: { ...agents, cacheTimer: { ...agents.cacheTimer, ttlMinutes: ttl } } })}
              className={cn(
                'rounded-btn border px-3 py-1 text-xs transition-colors',
                !agents.cacheTimer.enabled && 'pointer-events-none opacity-50',
                agents.cacheTimer.ttlMinutes === ttl
                  ? 'border-accent-violet bg-accent-violet text-white'
                  : 'border-border bg-bg-secondary text-text-primary hover:border-accent-violet/40',
              )}
            >
              {t('settings.agents.cacheTtlMin', { min: ttl })}
            </button>
          ))}
        </div>
      </SettingRow>
      <SilenceRows />
    </section>
  )
}

export function AgentsSection() {
  const t = useT()
  const presets = useAppStore((s) => s.presets)
  const savePreset = useAppStore((s) => s.savePreset)
  const deletePreset = useAppStore((s) => s.deletePreset)
  const newPresetId = useAppStore((s) => s.newPresetId)
  const [editing, setEditing] = useState<AgentPreset | null>(null)

  const startNew = (): void =>
    setEditing({
      id: newPresetId(),
      name: '',
      type: 'custom',
      command: '',
      args: [],
      color: '#6366f1',
      icon: 'terminal',
    })

  if (editing) {
    return (
      <PresetEditor
        initial={editing}
        onSave={(p) => {
          savePreset(p)
          setEditing(null)
        }}
        onCancel={() => setEditing(null)}
      />
    )
  }

  return (
    <div className="space-y-6">
      <BehaviorBlock />
      <section className="space-y-2 border-t border-border pt-5">
        <h4 className={headingCls}>{t('settings.agents.presets')}</h4>
        {presets.map((preset) => {
          const Icon = iconFor(preset.icon)
          return (
            <div
              key={preset.id}
              className="flex items-center gap-3 rounded-card border border-border bg-bg-secondary px-3 py-2.5"
            >
              <Icon size={18} style={{ color: preset.color }} className="shrink-0" />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate text-sm text-text-primary">{preset.name}</span>
                  <span className="rounded-full border border-border px-1.5 text-[10px] uppercase tracking-wide text-text-secondary">
                    {preset.type}
                  </span>
                </div>
                {preset.command && (
                  <span className="block truncate font-mono text-[11px] text-text-secondary">
                    {[preset.command, ...preset.args].join(' ')}
                  </span>
                )}
              </div>
              <button
                onClick={() => setEditing(preset)}
                className="rounded p-1.5 text-text-secondary hover:text-text-primary"
                title={t('settings.edit')}
              >
                <Pencil size={15} />
              </button>
              <button
                onClick={() => deletePreset(preset.id)}
                className="rounded p-1.5 text-text-secondary hover:text-red-400"
                title={t('ctx.delete')}
              >
                <Trash2 size={15} />
              </button>
            </div>
          )
        })}

        <button
          onClick={startNew}
          className="flex w-full items-center justify-center gap-2 rounded-card border border-dashed border-border py-2.5 text-sm text-text-secondary transition-colors hover:border-accent-violet/40 hover:text-text-primary"
        >
          <Plus size={16} />
          {t('settings.newPreset')}
        </button>
      </section>
    </div>
  )
}
