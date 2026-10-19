/**
 * Phone settings as a pushed screen over Home (E1-FR-37, E2-FR-13), opened
 * from the Home header. Sections: Appearance (desktop theme, text size
 * presets of E2-FR-34), Phone mode (E3-FR-13/14: the phoneFitDefault switch
 * and the phone-mode text size), Chat (E3-FR-24: the chatDefault switch), Input
 * (E1-FR-22/30: AI consoles start in Composer, composer autocorrect), Alerts
 * (E2-FR-44: on-screen alerts, vibrate, turn end), About (desktop and bundle versions) and This
 * device (Diagnostics, E2-FR-36, and unpair with confirmation). The Key bar
 * row (E2-FR-45) pushes KeyLayoutScreen over this screen. Answers holds the
 * answer cards switch (promptCards, E2-FR-13; default on).
 */
import { useState, type ReactNode } from 'react'
import { clsx } from 'clsx'
import { Activity, Keyboard, LogOut } from 'lucide-react'
import type { ThemeName } from '@shared/types'
import { PushScreen } from './PushScreen'
import { ActionList } from './ActionList'
import { ConfirmSheet } from './ConfirmSheet'
import { KeyLayoutScreen } from './KeyLayoutScreen'
import { useRemoteStore } from '../lib/store'
import { client } from '../lib/client'
import { FontScaleRow } from './FontScaleRow'
import { PHONE_FONT_SIZES } from '../lib/fit'
import { openDiagnostics } from '../lib/connLog'
import { t, type MobileMessageKey } from '../lib/i18n'

/** This page's version, baked in by vite.config.ts. */
const BUNDLE_VERSION: string = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : ''

const THEMES = ['midnight', 'light', 'nord', 'dracula', 'solarized'] as const
const THEME_KEY: Record<(typeof THEMES)[number], MobileMessageKey> = {
  midnight: 'theme.midnight',
  light: 'theme.light',
  nord: 'theme.nord',
  dracula: 'theme.dracula',
  solarized: 'theme.solarized',
}

/** iOS Safari has no navigator.vibrate: the Vibrate row hides there (E2-FR-44). */
function canVibrate(): boolean {
  return typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function'
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
  const themeName = useRemoteStore((s) => s.snapshot?.themeName)
  const inPageAlerts = useRemoteStore((s) => s.inPageAlerts)
  const setInPageAlerts = useRemoteStore((s) => s.setInPageAlerts)
  const alertVibrate = useRemoteStore((s) => s.alertVibrate)
  const alertDone = useRemoteStore((s) => s.alertDone)
  const setPagePref = useRemoteStore((s) => s.setPagePref)
  const promptCards = useRemoteStore((s) => s.promptCards)
  const setPromptCards = useRemoteStore((s) => s.setPromptCards)
  const composerDefaultForAgents = useRemoteStore((s) => s.composerDefaultForAgents)
  const composerAutocorrect = useRemoteStore((s) => s.composerAutocorrect)
  const setComposerPref = useRemoteStore((s) => s.setComposerPref)
  const phoneFitDefault = useRemoteStore((s) => s.phoneFitDefault)
  const setPhoneFitDefault = useRemoteStore((s) => s.setPhoneFitDefault)
  const phoneFontSize = useRemoteStore((s) => s.phoneFontSize)
  const setPhoneFontSize = useRemoteStore((s) => s.setPhoneFontSize)
  const chatDefault = useRemoteStore((s) => s.chatDefault)
  const setChatDefault = useRemoteStore((s) => s.setChatDefault)
  const [confirmUnpair, setConfirmUnpair] = useState(false)
  const desktopVersion = useRemoteStore((s) => s.appVersion)
  const [keyLayoutOpen, setKeyLayoutOpen] = useState(false)
  // Settings closing takes the Key bar screen with it, so reopening starts at Settings.
  if (!open && keyLayoutOpen) setKeyLayoutOpen(false)

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
            <FontScaleRow />
          </div>
        </SettingsSection>
        <SettingsSection id="phoneFit" title={t('fit.settings.title')}>
          <div className="flex flex-col gap-2">
            <PrefToggle
              pref="phoneFitDefault"
              label={t('fit.settings.default')}
              hint={t('fit.settings.defaultHint')}
              checked={phoneFitDefault}
              onChange={setPhoneFitDefault}
            />
            <div data-phone-font={phoneFontSize} className="rounded-card border border-border bg-bg-secondary px-4 py-3">
              <span className="mb-2 block text-sm text-text-primary">{t('fit.settings.fontSize', { px: phoneFontSize })}</span>
              <div className="flex flex-wrap gap-2" role="radiogroup" aria-label={t('fit.settings.title')}>
                {PHONE_FONT_SIZES.map((px) => (
                  <button
                    key={px}
                    role="radio"
                    aria-checked={phoneFontSize === px}
                    data-px={px}
                    onClick={() => setPhoneFontSize(px)}
                    className={clsx(
                      'min-h-10 min-w-12 rounded-btn border px-2.5 py-1.5 text-xs font-medium transition',
                      phoneFontSize === px
                        ? 'border-accent-violet bg-accent-violet text-white'
                        : 'border-border bg-card text-text-primary active:bg-bg-primary',
                    )}
                  >
                    {px}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </SettingsSection>
        <SettingsSection id="chat" title={t('chat.settings.title')}>
          <PrefToggle
            pref="chatDefault"
            label={t('chat.settings.default')}
            hint={t('chat.settings.defaultHint')}
            checked={chatDefault}
            onChange={(on) => {
              setChatDefault(on)
              // The console on screen follows at once when it has no choice of its own.
              client.syncView()
            }}
          />
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
        {/* E2-FR-45: Key bar layout */}
        <SettingsSection id="keybar" title={t('keybar.title')}>
          <ActionList
            items={[
              {
                id: 'keybar',
                icon: <Keyboard size={16} />,
                label: t('keybar.title'),
                hint: t('keybar.entryHint'),
                onSelect: () => setKeyLayoutOpen(true),
              },
            ]}
          />
        </SettingsSection>
        <SettingsSection id="alerts" title={t('alerts.title')}>
          <div className="flex flex-col gap-2">
            <PrefToggle
              pref="inPageAlerts"
              label={t('alerts.inPage')}
              hint={t('alerts.inPageHint')}
              checked={inPageAlerts}
              onChange={setInPageAlerts}
            />
            {canVibrate() && (
              <PrefToggle
                pref="vibrate"
                label={t('alerts.vibrate')}
                hint={t('alerts.vibrateHint')}
                checked={alertVibrate}
                onChange={(on) => setPagePref('vibrate', on)}
              />
            )}
            <PrefToggle
              pref="toastDone"
              label={t('alerts.done')}
              hint={t('alerts.doneHint')}
              checked={alertDone}
              onChange={(on) => setPagePref('toastDone', on)}
            />
          </div>
        </SettingsSection>
        <SettingsSection id="prompts" title={t('prompt.settingsTitle')}>
          <PrefToggle
            pref="promptCards"
            label={t('prompt.settingsToggle')}
            hint={t('prompt.settingsHint')}
            checked={promptCards}
            onChange={setPromptCards}
          />
        </SettingsSection>
        <SettingsSection id="about" title={t('set.about')}>
          <div className="rounded-card border border-border bg-bg-secondary px-4 py-1">
            <div data-version="desktop" className="flex min-h-11 items-center justify-between text-sm">
              <span className="text-text-primary">{t('set.desktopVersion')}</span>
              <span className="font-mono text-xs text-text-secondary">{desktopVersion || '-'}</span>
            </div>
            <div data-version="bundle" className="flex min-h-11 items-center justify-between border-t-[0.5px] border-border text-sm">
              <span className="text-text-primary">{t('set.bundleVersion')}</span>
              <span className="font-mono text-xs text-text-secondary">{BUNDLE_VERSION || '-'}</span>
            </div>
          </div>
        </SettingsSection>
        <SettingsSection id="device" title={t('set.device')}>
          <ActionList
            items={[
              {
                // E2-FR-36: Diagnostics opens over Settings (it is mounted after it).
                id: 'diagnostics',
                icon: <Activity size={16} />,
                label: t('diag.title'),
                onSelect: openDiagnostics,
              },
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
      <KeyLayoutScreen open={keyLayoutOpen} onClose={() => setKeyLayoutOpen(false)} />
      <ConfirmSheet
        state={confirmUnpair ? { message: t('act.unpairConfirm'), onConfirm: () => client.unpair() } : null}
        onClose={() => setConfirmUnpair(false)}
      />
    </>
  )
}
