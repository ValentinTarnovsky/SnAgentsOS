import { Plus, RefreshCw, Trash2 } from 'lucide-react'
import type { UsageCustomRow, UsageSettings } from '@shared/types'
import { useAppStore } from '@/lib/store'
import { useUsageStore } from '@/lib/usageStore'
import { useT, type MessageKey } from '@/i18n'
import { cn } from '@/lib/cn'
import { UsageMeter } from '@/components/ui/UsageMeter'
import { viewRow } from '@/components/sidebar/UsageBars'
import { inputCls, labelCls, SettingRow, Toggle, ToggleRow } from '../ui'

type RowKey = keyof UsageSettings['rows']

const BUILTIN_ROWS: Array<{ key: RowKey; labelKey: MessageKey }> = [
  { key: 'claude5h', labelKey: 'aiusage.row.claude5h' },
  { key: 'claude7d', labelKey: 'aiusage.row.claude7d' },
  { key: 'claudeOpus7d', labelKey: 'aiusage.row.claudeOpus7d' },
  { key: 'claudeSonnet7d', labelKey: 'aiusage.row.claudeSonnet7d' },
  { key: 'codex5h', labelKey: 'aiusage.row.codex5h' },
  { key: 'codex7d', labelKey: 'aiusage.row.codex7d' },
]

export function AiUsageSection() {
  const t = useT()
  const usage = useAppStore((s) => s.settings.usage)
  const updateSettings = useAppStore((s) => s.updateSettings)
  const snapshot = useUsageStore((s) => s.snapshot)
  const refreshing = useUsageStore((s) => s.refreshing)
  const refresh = useUsageStore((s) => s.refresh)

  const patch = (p: Partial<UsageSettings>): void => updateSettings({ usage: { ...usage, ...p } })
  const patchRows = (r: Partial<UsageSettings['rows']>): void => patch({ rows: { ...usage.rows, ...r } })

  const updateCustom = (id: string, p: Partial<UsageCustomRow>): void =>
    patch({ custom: usage.custom.map((c) => (c.id === id ? { ...c, ...p } : c)) })
  const removeCustom = (id: string): void => patch({ custom: usage.custom.filter((c) => c.id !== id) })
  const addCustom = (): void =>
    patch({
      custom: [
        ...usage.custom,
        {
          id: crypto.randomUUID().slice(0, 8),
          label: '',
          source: 'claude',
          modelMatch: '',
          window: 'session5h',
          enabled: true,
        },
      ],
    })

  const secInput = (ms: number): number => Math.round(ms / 1000)
  const previewRows = snapshot?.rows ?? []

  return (
    <div className="space-y-6">
      <p className="text-xs text-text-secondary">{t('aiusage.hint')}</p>

      <ToggleRow
        checked={usage.enabled}
        onChange={(v) => patch({ enabled: v })}
        title={t('aiusage.enable')}
        description={t('aiusage.enableHint')}
      />

      {/* Which bars */}
      <section className={cn('space-y-3', !usage.enabled && 'pointer-events-none opacity-50')}>
        <h4 className="text-xs font-semibold uppercase tracking-wide text-text-secondary">
          {t('aiusage.bars')}
        </h4>
        <div className="space-y-2.5">
          {BUILTIN_ROWS.map((r) => (
            <div key={r.key} className="flex items-center justify-between gap-4">
              <span className="text-sm text-text-primary">{t(r.labelKey)}</span>
              <Toggle checked={usage.rows[r.key]} onChange={(v) => patchRows({ [r.key]: v })} />
            </div>
          ))}
        </div>
        <ToggleRow
          checked={usage.showStatus}
          onChange={(v) => patch({ showStatus: v })}
          title={t('aiusage.showStatus')}
          description={t('aiusage.showStatusHint')}
        />
      </section>

      {/* Refresh */}
      <section className={cn('space-y-3', !usage.enabled && 'pointer-events-none opacity-50')}>
        <h4 className="text-xs font-semibold uppercase tracking-wide text-text-secondary">
          {t('aiusage.refreshSection')}
        </h4>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className={labelCls}>{t('aiusage.claudeInterval')}</label>
            <input
              type="number"
              min={30}
              className={inputCls}
              value={secInput(usage.claudeIntervalMs)}
              onChange={(e) =>
                patch({ claudeIntervalMs: Math.max(30, Number(e.target.value) || 60) * 1000 })
              }
            />
          </div>
          <div>
            <label className={labelCls}>{t('aiusage.codexInterval')}</label>
            <input
              type="number"
              min={3}
              className={inputCls}
              value={secInput(usage.codexIntervalMs)}
              onChange={(e) =>
                patch({ codexIntervalMs: Math.max(3, Number(e.target.value) || 10) * 1000 })
              }
            />
          </div>
        </div>
        <ToggleRow
          checked={usage.refreshOnFocus}
          onChange={(v) => patch({ refreshOnFocus: v })}
          title={t('aiusage.refreshOnFocus')}
          description={t('aiusage.refreshOnFocusHint')}
        />
        <button
          onClick={() => void refresh()}
          disabled={refreshing}
          className="flex items-center gap-2 rounded-btn border border-border bg-bg-secondary px-3 py-2 text-sm text-text-primary transition-colors hover:border-accent-violet/40 disabled:opacity-50"
        >
          <RefreshCw size={15} className={cn(refreshing && 'animate-spin')} />
          {t('aiusage.refreshNow')}
        </button>
      </section>

      {/* Custom models */}
      <section className={cn('space-y-3', !usage.enabled && 'pointer-events-none opacity-50')}>
        <SettingRow title={t('aiusage.customTitle')} description={t('aiusage.customHint')} />
        {usage.custom.map((row) => (
          <div key={row.id} className="space-y-3 rounded-card border border-border bg-bg-secondary p-3">
            <div className="flex items-center gap-2">
              <input
                className={cn(inputCls, 'flex-1')}
                placeholder={t('aiusage.customLabelPlaceholder')}
                value={row.label}
                onChange={(e) => updateCustom(row.id, { label: e.target.value })}
              />
              <Toggle checked={row.enabled} onChange={(v) => updateCustom(row.id, { enabled: v })} />
              <button
                onClick={() => removeCustom(row.id)}
                className="rounded p-1.5 text-text-secondary hover:text-red-400"
                title={t('common.delete')}
              >
                <Trash2 size={15} />
              </button>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className={labelCls}>{t('aiusage.customSource')}</label>
                <select
                  className={inputCls}
                  value={row.source}
                  onChange={(e) => updateCustom(row.id, { source: e.target.value as UsageCustomRow['source'] })}
                >
                  <option value="claude">{t('aiusage.sourceClaude')}</option>
                  <option value="codex">{t('aiusage.sourceCodex')}</option>
                </select>
              </div>
              <div>
                <label className={labelCls}>{t('aiusage.customWindow')}</label>
                <select
                  className={inputCls}
                  value={row.window}
                  onChange={(e) => updateCustom(row.id, { window: e.target.value as UsageCustomRow['window'] })}
                >
                  <option value="session5h">{t('aiusage.window.session5h')}</option>
                  <option value="weekly7d">{t('aiusage.window.weekly7d')}</option>
                  <option value="today">{t('aiusage.window.today')}</option>
                  <option value="all">{t('aiusage.window.all')}</option>
                </select>
              </div>
              <div>
                <label className={labelCls}>{t('aiusage.customModelMatch')}</label>
                <input
                  className={inputCls}
                  placeholder={t('aiusage.customModelMatchPlaceholder')}
                  value={row.modelMatch}
                  onChange={(e) => updateCustom(row.id, { modelMatch: e.target.value })}
                />
              </div>
              <div>
                <label className={labelCls}>{t('aiusage.customBudget')}</label>
                <input
                  type="number"
                  min={0}
                  className={inputCls}
                  placeholder={t('aiusage.customBudgetPlaceholder')}
                  value={row.tokenBudget ?? ''}
                  onChange={(e) => {
                    const n = Number(e.target.value)
                    updateCustom(row.id, { tokenBudget: e.target.value && n > 0 ? n : undefined })
                  }}
                />
              </div>
            </div>
          </div>
        ))}
        <button
          onClick={addCustom}
          className="flex w-full items-center justify-center gap-2 rounded-card border border-dashed border-border py-2.5 text-sm text-text-secondary transition-colors hover:border-accent-violet/40 hover:text-text-primary"
        >
          <Plus size={16} />
          {t('aiusage.customNew')}
        </button>
      </section>

      {/* Live preview */}
      <section className="space-y-3 border-t border-border pt-5">
        <h4 className="text-xs font-semibold uppercase tracking-wide text-text-secondary">
          {t('aiusage.preview')}
        </h4>
        {previewRows.length > 0 ? (
          <div className="space-y-2.5 rounded-card border border-border bg-bg-secondary p-3.5">
            {previewRows.map((r) => (
              <UsageMeter key={r.id} {...viewRow(r, t)} />
            ))}
          </div>
        ) : (
          <p className="text-xs text-text-secondary">{t('aiusage.previewEmpty')}</p>
        )}
      </section>
    </div>
  )
}
