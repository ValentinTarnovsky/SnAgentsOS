/**
 * Phone settings as a pushed screen (E1-FR-37) instead of a sheet over the
 * action sheet. Sections: Appearance (desktop theme, font size), Alerts
 * (in-page alerts, E1-FR-40) and This device (unpair). The Input section of
 * E1-FR-22/30 (AI consoles start in Composer, composer autocorrect) sits
 * between Appearance and Alerts.
 */
import { useState, type ReactNode } from 'react'
import { clsx } from 'clsx'
import { LogOut, Minus, Plus as PlusSmall } from 'lucide-react'
import type { ThemeName } from '@shared/types'
import { PushScreen } from './PushScreen'
import { ActionList } from './ActionList'
import { ConfirmSheet } from './ConfirmSheet'
import { useRemoteStore } from '../lib/store'
import { client } from '../lib/client'
import { getActiveTerm } from '../lib/terminalBus'
import { MAX_FONT, MIN_FONT } from '../lib/fit'
import { t, type MobileMessageKey } from '../lib/i18n'

const THEMES = ['midnight', 'light', 'nord', 'dracula', 'solarized'] as const
const THEME_KEY: Record<(typeof THEMES)[number], MobileMessageKey> = {
  midnight: 'theme.midnight',
  light: 'theme.light',
  nord: 'theme.nord',
  dracula: 'theme.dracula',
  solarized: 'theme.solarized',
}

export function SettingsSection({ id, title, children }: { id: string; title: string; children: ReactNode }): ReactNode {
  return (
    <section data-settings-section={id} className="mb-6">
      <h3 className="mb-2 px-1 text-xs font-semibold uppercase tracking-wide text-text-secondary">{title}</h3>
      {children}
    </section>
  )
}

/** One on/off preference row: label, grey hint and a switch. */
export function PrefToggle({
  pref,
  label,
  hint,
  checked,
  onChange,
}: {
  pref: string
  label: string
  hint?: string
  checked: boolean
  onChange: (on: boolean) => void
}): ReactNode {
  return (
    <button
      role="switch"
      aria-checked={checked}
      data-pref={pref}
      onClick={() => onChange(!checked)}
      className="flex min-h-12 w-full items-center gap-3 rounded-card border border-border bg-bg-secondary px-4 py-3 text-left active:bg-card"
    >
      <span className="min-w-0 flex-1">
        <span className="block text-sm text-text-primary">{label}</span>
        {hint && <span className="block text-[11px] text-text-secondary">{hint}</span>}
      </span>
      <span className={clsx('relative h-6 w-10 shrink-0 rounded-full transition-colors', checked ? 'bg-accent-violet' : 'bg-border')}>
        <span
          className={clsx(
            'absolute top-0.5 h-5 w-5 rounded-full bg-white transition-transform',
            checked ? 'translate-x-[18px]' : 'translate-x-0.5',
          )}
        />
      </span>
    </button>
  )
}

export function SettingsScreen({ open, onClose }: { open: boolean; onClose: () => void }): ReactNode {
  const fontOverride = useRemoteStore((s) => s.fontOverride)
  const setFontOverride = useRemoteStore((s) => s.setFontOverride)
  const themeName = useRemoteStore((s) => s.snapshot?.themeName)
  const inPageAlerts = useRemoteStore((s) => s.inPageAlerts)
  const setInPageAlerts = useRemoteStore((s) => s.setInPageAlerts)
  const composerDefaultForAgents = useRemoteStore((s) => s.composerDefaultForAgents)
  const composerAutocorrect = useRemoteStore((s) => s.composerAutocorrect)
  const setComposerPref = useRemoteStore((s) => s.setComposerPref)
  const [confirmUnpair, setConfirmUnpair] = useState(false)

  const currentSize = (): number => {
    if (fontOverride != null) return fontOverride
    const term = getActiveTerm()
    const raw = term ? Number(term.options.fontSize) : 14
    return Number.isFinite(raw) ? Math.round(raw) : 14
  }
  const bump = (delta: number): void => {
    const next = Math.max(MIN_FONT, Math.min(MAX_FONT, currentSize() + delta))
    setFontOverride(next)
  }
  const setTheme = (theme: ThemeName): void => {
    void client.sendCtl({ kind: 'setTheme', theme })
  }

  return (
    <>
      <PushScreen id="settings" open={open} onClose={onClose} title={t('act.settings')}>
        <SettingsSection id="appearance" title={t('set.appearance')}>
          <div className="rounded-card border border-border bg-bg-secondary px-4 py-3">
            <span className="mb-2 block text-sm text-text-primary">{t('act.theme')}</span>
            <div className="mb-4 flex flex-wrap gap-2">
              {THEMES.map((id) => (
                <button
                  key={id}
                  onClick={() => setTheme(id)}
                  className={clsx(
                    'rounded-btn border px-3 py-1.5 text-xs font-medium transition',
                    themeName === id
                      ? 'border-accent-violet bg-accent-violet text-white'
                      : 'border-border bg-card text-text-primary active:bg-bg-primary',
                  )}
                >
                  {t(THEME_KEY[id])}
                </button>
              ))}
              {themeName === 'custom' && (
                <span className="rounded-btn border border-border bg-card px-3 py-1.5 text-xs font-medium text-text-secondary opacity-60">
                  {t('theme.custom')}
                </span>
              )}
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm text-text-primary">{t('act.fontSize')}</span>
              <div className="flex items-center gap-3">
                <button
                  onPointerDown={(e) => {
                    e.preventDefault()
                    bump(-1)
                  }}
                  className="flex h-10 w-10 items-center justify-center rounded-btn border border-border bg-card text-text-primary active:bg-bg-primary"
                  aria-label={t('set.fontSmaller')}
                >
                  <Minus size={16} />
                </button>
                <span className="w-8 text-center text-sm font-medium text-text-primary">{currentSize()}</span>
                <button
                  onPointerDown={(e) => {
                    e.preventDefault()
                    bump(1)
                  }}
                  className="flex h-10 w-10 items-center justify-center rounded-btn border border-border bg-card text-text-primary active:bg-bg-primary"
                  aria-label={t('set.fontLarger')}
                >
                  <PlusSmall size={16} />
                </button>
              </div>
            </div>
          </div>
        </SettingsSection>
        <SettingsSection id="input" title={t('input.title')}>
          <div className="flex flex-col gap-2">
            <PrefToggle
              pref="composerDefaultForAgents"
              label={t('input.agentsDefault')}
              hint={t('input.agentsDefaultHint')}
              checked={composerDefaultForAgents}
              onChange={(on) => setComposerPref('composerDefaultForAgents', on)}
            />
            <PrefToggle
              pref="composerAutocorrect"
              label={t('input.autocorrect')}
              hint={t('input.autocorrectHint')}
              checked={composerAutocorrect}
              onChange={(on) => setComposerPref('composerAutocorrect', on)}
            />
          </div>
        </SettingsSection>
        <SettingsSection id="alerts" title={t('alerts.title')}>
          <PrefToggle
            pref="inPageAlerts"
            label={t('alerts.inPage')}
            hint={t('alerts.inPageHint')}
            checked={inPageAlerts}
            onChange={setInPageAlerts}
          />
        </SettingsSection>
        <SettingsSection id="device" title={t('set.device')}>
          <ActionList
            items={[
              {
                id: 'unpair',
                icon: <LogOut size={16} />,
                label: t('act.unpair'),
                destructive: true,
                onSelect: () => setConfirmUnpair(true),
              },
            ]}
          />
        </SettingsSection>
      </PushScreen>
      <ConfirmSheet
        state={confirmUnpair ? { message: t('act.unpairConfirm'), onConfirm: () => client.unpair() } : null}
        onClose={() => setConfirmUnpair(false)}
      />
    </>
  )
}
