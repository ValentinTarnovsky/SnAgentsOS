import { Check } from 'lucide-react'
import { useAppStore } from '@/lib/store'
import { useT } from '@/i18n'
import { THEME_LIST, UI_TOKENS, resolveTokens } from '@/themes'
import { SettingRow, ToggleRow } from '../ui'
import { sidebarBlockOn, type SidebarBlockKey } from '@shared/sidebarBlocks'
import { cn } from '@/lib/cn'

export function AppearanceSection() {
  const t = useT()
  const settings = useAppStore((s) => s.settings)
  const updateSettings = useAppStore((s) => s.updateSettings)

  const effective = resolveTokens(settings.theme, settings.customColors)

  // App 2.8.0: one literal row per sidebar block (the catalog integrity check counts literal searchId attributes).
  const blockOn = (key: SidebarBlockKey): boolean => sidebarBlockOn(settings, key)
  const setBlock = (key: SidebarBlockKey, v: boolean): void => {
    const current = useAppStore.getState().settings.sidebarBlocks
    updateSettings({ sidebarBlocks: { ...current, [key]: v } })
  }

  const onColorChange = (token: string, value: string): void => {
    // Seed the full current palette so switching to Custom preserves the look.
    const next = { ...resolveTokens(settings.theme, settings.customColors), [token]: value }
    updateSettings({ theme: 'custom', customColors: next })
  }

  return (
    <div className="space-y-6">
      <SettingRow searchId="appearance.theme" title={t('settings.theme')} description={t('settings.themeHint')}>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {THEME_LIST.map((theme) => {
            const selected = settings.theme === theme.name
            return (
              <button
                key={theme.name}
                onClick={() => updateSettings({ theme: theme.name })}
                className={cn(
                  'flex items-center gap-3 rounded-card border p-2.5 text-left transition-colors',
                  selected
                    ? 'border-accent-violet bg-accent-violet/5'
                    : 'border-border hover:border-accent-violet/40',
                )}
              >
                <span
                  className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-border"
                  style={{ backgroundColor: theme.tokens['bg-primary'] }}
                >
                  <span className="flex gap-0.5">
                    <span
                      className="h-2.5 w-2.5 rounded-full"
                      style={{ backgroundColor: theme.tokens.accent }}
                    />
                    <span
                      className="h-2.5 w-2.5 rounded-full"
                      style={{ backgroundColor: theme.tokens['accent-2'] }}
                    />
                  </span>
                </span>
                <span className="min-w-0 flex-1 truncate text-sm text-text-primary">
                  {theme.label}
                </span>
                {selected && <Check size={15} className="shrink-0 text-accent-violet" />}
              </button>
            )
          })}
        </div>
      </SettingRow>

      <SettingRow searchId="appearance.customColors" title={t('settings.customColors')} description={t('settings.customColorsHint')}>
        <div className="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-3">
          {UI_TOKENS.map(({ key, label }) => {
            const value = effective[key] ?? '#000000'
            return (
              <label
                key={key}
                className="flex items-center gap-2.5 rounded-btn border border-border bg-bg-secondary px-2.5 py-1.5"
              >
                <input
                  type="color"
                  value={value}
                  onChange={(e) => onColorChange(key, e.target.value)}
                  className="h-6 w-6 shrink-0 cursor-pointer rounded border-0 bg-transparent p-0"
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-xs text-text-primary">{label}</span>
                  <span className="block truncate font-mono text-[10px] uppercase text-text-secondary">
                    {value}
                  </span>
                </span>
              </label>
            )
          })}
        </div>
      </SettingRow>

      <section className="space-y-3 border-t border-border pt-5" aria-labelledby="appearance-sidebar" data-sidebar-blocks>
        <h4 id="appearance-sidebar" className="text-xs font-semibold uppercase tracking-wide text-text-secondary">
          {t('settings.sidebarBlocks.group')}
        </h4>
        <p className="text-xs text-text-secondary">{t('settings.sidebarBlocks.intro')}</p>
        <ToggleRow searchId="appearance.sidebarAgentsBoard" checked={blockOn('agentsBoard')} onChange={(v) => setBlock('agentsBoard', v)} title={t('settings.sidebarBlocks.agentsBoard')} />
        <ToggleRow searchId="appearance.sidebarTeams" checked={blockOn('teams')} onChange={(v) => setBlock('teams', v)} title={t('settings.sidebarBlocks.teams')} description={t('settings.sidebarBlocks.teamsHint')} />
        <ToggleRow searchId="appearance.sidebarSharedWithMe" checked={blockOn('sharedWithMe')} onChange={(v) => setBlock('sharedWithMe', v)} title={t('settings.sidebarBlocks.sharedWithMe')} />
        <ToggleRow searchId="appearance.sidebarShareIndicator" checked={blockOn('shareIndicator')} onChange={(v) => setBlock('shareIndicator', v)} title={t('settings.sidebarBlocks.shareIndicator')} />
        <ToggleRow searchId="appearance.sidebarRemoteIndicator" checked={blockOn('remoteIndicator')} onChange={(v) => setBlock('remoteIndicator', v)} title={t('settings.sidebarBlocks.remoteIndicator')} />
        <ToggleRow searchId="appearance.sidebarUsageBars" checked={blockOn('usageBars')} onChange={(v) => setBlock('usageBars', v)} title={t('settings.sidebarBlocks.usageBars')} description={t('settings.sidebarBlocks.usageBarsHint')} />
      </section>
    </div>
  )
}
