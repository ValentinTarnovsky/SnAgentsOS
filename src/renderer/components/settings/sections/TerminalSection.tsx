import { useCallback, useEffect, useState } from 'react'
import { useAppStore } from '@/lib/store'
import { useT } from '@/i18n'
import { SettingRow, ToggleRow, inputCls } from '../ui'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { cn } from '@/lib/cn'
import type { ScrollbackStats } from '@shared/ipc-contract'
import type { TerminalSnapshotMode } from '@shared/types'
import { PERSIST_LINES_MAX, PERSIST_LINES_MIN } from '@shared/terminalEngine'
import { DictationSettingsBlock } from './DictationSettingsBlock'

/** Megabytes with one decimal, never "0.0" for a non-empty folder. */
function formatMb(bytes: number): string {
  if (bytes <= 0) return '0'
  return Math.max(0.1, Math.round((bytes / (1024 * 1024)) * 10) / 10).toFixed(1)
}

export function TerminalSection() {
  const t = useT()
  const settings = useAppStore((s) => s.settings)
  const updateSettings = useAppStore((s) => s.updateSettings)
  // Saved scrollback (E6-FR-08/12): 'off' snapshots turn persistence off as a whole.
  const snapshotOff = settings.terminalSnapshotMode === 'off'
  const [stats, setStats] = useState<ScrollbackStats | null>(null)
  const [confirm, setConfirm] = useState<'clearAll' | 'turnOff' | null>(null)
  const refreshStats = useCallback(() => {
    const api = window.snApi.scrollback
    if (!api) return
    Promise.resolve()
      .then(() => api.stats())
      .then(
        (r) => setStats(r && typeof r.files === 'number' && typeof r.bytes === 'number' ? { files: r.files, bytes: r.bytes } : null),
        () => setStats(null),
      )
  }, [])
  useEffect(refreshStats, [refreshStats])
  // Typed freely and clamped on blur/Enter: clamping each keystroke would turn
  // the "3" of "3000" into 200 before the zeros arrive.
  const [linesDraft, setLinesDraft] = useState(String(settings.persistScrollbackLines))
  useEffect(() => setLinesDraft(String(settings.persistScrollbackLines)), [settings.persistScrollbackLines])
  const commitLines = (): void => {
    const n = Math.round(Number(linesDraft))
    if (!linesDraft.trim() || !Number.isFinite(n) || n <= 0) {
      setLinesDraft(String(settings.persistScrollbackLines))
      return
    }
    const clamped = Math.min(PERSIST_LINES_MAX, Math.max(PERSIST_LINES_MIN, n))
    if (clamped !== settings.persistScrollbackLines) updateSettings({ persistScrollbackLines: clamped })
    setLinesDraft(String(clamped))
  }
  const clearAll = (): void => {
    const api = window.snApi.scrollback
    if (!api) return
    void Promise.resolve()
      .then(() => api.clearAll())
      .catch(() => undefined)
      .finally(refreshStats)
  }

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <SettingRow searchId="terminal.shellWin" title={t('settings.shellWin')}>
          <input
            className={cn(inputCls, 'font-mono')}
            placeholder="powershell.exe"
            value={settings.defaultShell.win32 ?? ''}
            onChange={(e) =>
              updateSettings({
                defaultShell: { ...settings.defaultShell, win32: e.target.value || undefined },
              })
            }
          />
        </SettingRow>
        <SettingRow searchId="terminal.shellMac" title={t('settings.shellMac')}>
          <input
            className={cn(inputCls, 'font-mono')}
            placeholder="/bin/zsh"
            value={settings.defaultShell.darwin ?? ''}
            onChange={(e) =>
              updateSettings({
                defaultShell: { ...settings.defaultShell, darwin: e.target.value || undefined },
              })
            }
          />
        </SettingRow>
        <SettingRow searchId="terminal.shellLinux" title={t('settings.shellLinux')}>
          <input
            className={cn(inputCls, 'font-mono')}
            placeholder="/bin/bash"
            value={settings.defaultShell.linux ?? ''}
            onChange={(e) =>
              updateSettings({
                defaultShell: { ...settings.defaultShell, linux: e.target.value || undefined },
              })
            }
          />
        </SettingRow>
      </div>

      <SettingRow searchId="terminal.fontFamily" title={t('settings.fontFamily')}>
        <input
          className={cn(inputCls, 'font-mono')}
          value={settings.fontFamily}
          onChange={(e) => updateSettings({ fontFamily: e.target.value })}
        />
      </SettingRow>

      <div className="grid grid-cols-2 gap-4">
        <SettingRow searchId="terminal.fontSize" title={t('settings.fontSize')}>
          <input
            type="number"
            min={8}
            max={32}
            className={inputCls}
            value={settings.fontSize}
            onChange={(e) => updateSettings({ fontSize: Number(e.target.value) || 13 })}
          />
        </SettingRow>
        <SettingRow searchId="terminal.scrollback" title={t('settings.scrollback')}>
          <input
            type="number"
            min={500}
            max={100000}
            step={500}
            disabled={settings.infiniteScrollback}
            className={cn(inputCls, settings.infiniteScrollback && 'pointer-events-none opacity-50')}
            value={settings.scrollback}
            onChange={(e) => updateSettings({ scrollback: Number(e.target.value) || 5000 })}
          />
        </SettingRow>
      </div>

      <ToggleRow
        checked={settings.infiniteScrollback}
        onChange={(v) => updateSettings({ infiniteScrollback: v })}
        searchId="terminal.infiniteScrollback"
        title={t('settings.infiniteScrollback')}
        description={t('settings.infiniteScrollbackHint')}
      />

      <SettingRow searchId="terminal.renderer" title={t('settings.renderer')} description={t('settings.rendererHint')}>
        <select
          className={inputCls}
          value={settings.terminalRenderer}
          onChange={(e) =>
            updateSettings({ terminalRenderer: e.target.value as 'canvas' | 'webgl' })
          }
        >
          <option value="canvas">{t('settings.rendererCanvas')}</option>
          <option value="webgl">{t('settings.rendererWebgl')}</option>
        </select>
      </SettingRow>

      <ToggleRow
        checked={settings.terminalSelectionOverride}
        onChange={(v) => updateSettings({ terminalSelectionOverride: v })}
        searchId="terminal.selectionOverride"
        title={t('settings.selectionOverride')}
        description={t('settings.selectionOverrideHint')}
      />

      <ToggleRow
        checked={settings.terminalUnicode11}
        onChange={(v) => updateSettings({ terminalUnicode11: v })}
        searchId="terminal.unicode11"
        title={t('settings.unicode11')}
        description={t('settings.unicode11Hint')}
      />

      <ToggleRow
        checked={settings.terminalAgentEndChip !== false}
        onChange={(v) => updateSettings({ terminalAgentEndChip: v })}
        searchId="terminal.agentEndChip"
        title={t('settings.agentEndChip')}
        description={t('settings.agentEndChipHint')}
      />

      <ToggleRow
        checked={settings.terminalShellIntegration !== false}
        onChange={(v) => updateSettings({ terminalShellIntegration: v })}
        searchId="terminal.shellIntegration"
        title={t('settings.shellIntegration')}
        description={t('settings.shellIntegrationHint')}
      />

      <section className="space-y-3 border-t border-border pt-5" aria-labelledby="terminal-persist" data-persist-scrollback>
        <h4 id="terminal-persist" className="text-xs font-semibold uppercase tracking-wide text-text-secondary">
          {t('settings.persistGroup')}
        </h4>
        <ToggleRow
          checked={settings.persistScrollback && !snapshotOff}
          disabled={snapshotOff}
          onChange={(v) => {
            // Turning it off deletes what is saved, so it asks first.
            if (v) updateSettings({ persistScrollback: true })
            else setConfirm('turnOff')
          }}
          searchId="terminal.persistScrollback"
          title={t('settings.persistScrollback')}
          description={snapshotOff ? t('settings.persistScrollbackOff') : t('settings.persistScrollbackHint')}
        />
        <SettingRow searchId="terminal.persistLines" title={t('settings.persistLines')}>
          <input
            type="number"
            min={PERSIST_LINES_MIN}
            max={PERSIST_LINES_MAX}
            step={100}
            disabled={!settings.persistScrollback || snapshotOff}
            className={cn(inputCls, 'max-w-[10rem]', (!settings.persistScrollback || snapshotOff) && 'pointer-events-none opacity-50')}
            value={linesDraft}
            onChange={(e) => setLinesDraft(e.target.value)}
            onBlur={commitLines}
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.currentTarget.blur()
            }}
          />
        </SettingRow>
        <div>
          <button
            type="button"
            data-clear-scrollback
            disabled={!stats || stats.files === 0}
            onClick={() => setConfirm('clearAll')}
            className="max-w-full rounded-btn border border-border px-3 py-1.5 text-left text-sm text-text-primary transition-colors hover:border-red-400/50 hover:text-red-400 disabled:pointer-events-none disabled:opacity-50"
          >
            {t('settings.clearScrollbackAll', { count: stats?.files ?? 0, mb: formatMb(stats?.bytes ?? 0) })}
          </button>
        </div>
      </section>

      <DictationSettingsBlock />

      <section className="space-y-3 border-t border-border pt-5" aria-labelledby="terminal-advanced">
        <h4 id="terminal-advanced" className="text-xs font-semibold uppercase tracking-wide text-text-secondary">
          {t('settings.terminalAdvanced')}
        </h4>
        <SettingRow searchId="terminal.snapshotMode" title={t('settings.snapshotMode')} description={t('settings.snapshotModeHint')}>
          <select
            className={inputCls}
            value={settings.terminalSnapshotMode}
            onChange={(e) => updateSettings({ terminalSnapshotMode: e.target.value as TerminalSnapshotMode })}
          >
            <option value="auto">{t('settings.snapshotAuto')}</option>
            <option value="lazy">{t('settings.snapshotLazy')}</option>
            <option value="off">{t('settings.snapshotOff')}</option>
          </select>
        </SettingRow>
      </section>

      {confirm && (
        <ConfirmDialog
          open
          title={confirm === 'turnOff' ? t('settings.persistOffTitle') : t('settings.clearScrollbackTitle')}
          message={confirm === 'turnOff' ? t('settings.persistOffMessage') : t('settings.clearScrollbackMessage')}
          confirmLabel={confirm === 'turnOff' ? t('settings.persistOffConfirm') : t('settings.clearScrollbackConfirm')}
          cancelLabel={t('common.cancel')}
          danger
          onConfirm={() => {
            if (confirm === 'turnOff') updateSettings({ persistScrollback: false })
            clearAll()
            setConfirm(null)
          }}
          onCancel={() => setConfirm(null)}
        />
      )}
    </div>
  )
}
