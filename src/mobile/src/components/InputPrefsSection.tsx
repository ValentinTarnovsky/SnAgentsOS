/**
 * "Input" settings (E1-FR-22, FR-30): AI consoles start in Composer, and the
 * composer's autocorrect. Self-contained so the settings surface (today the
 * settings sheet, the SettingsScreen of E1-FR-37 later) only mounts it.
 */
import type { ReactNode } from 'react'
import { clsx } from 'clsx'
import { useRemoteStore } from '../lib/store'
import type { ComposerPref } from '../lib/prefs'
import { t, type MobileMessageKey } from '../lib/i18n'

function PrefSwitch({ pref, label, hint }: { pref: ComposerPref; label: MobileMessageKey; hint: MobileMessageKey }): ReactNode {
  const on = useRemoteStore((s) => s[pref])
  const setComposerPref = useRemoteStore((s) => s.setComposerPref)
  return (
    <button
      role="switch"
      aria-checked={on}
      data-pref={pref}
      onClick={() => setComposerPref(pref, !on)}
      className="flex w-full items-center gap-3 rounded-btn border border-border bg-bg-secondary px-3 py-3 text-left active:bg-card"
    >
      <span className="min-w-0 flex-1">
        <span className="block text-sm text-text-primary">{t(label)}</span>
        <span className="block text-[11px] text-text-secondary">{t(hint)}</span>
      </span>
      <span className={clsx('relative h-6 w-10 shrink-0 rounded-full transition-colors', on ? 'bg-accent-violet' : 'bg-border')}>
        <span
          className={clsx(
            'absolute top-0.5 h-5 w-5 rounded-full bg-white transition-transform',
            on ? 'translate-x-[18px]' : 'translate-x-0.5',
          )}
        />
      </span>
    </button>
  )
}

export function InputPrefsSection(): ReactNode {
  return (
    <div className="mb-5" data-section="input">
      <span className="mb-2 block text-xs font-semibold uppercase tracking-wide text-text-secondary">{t('input.title')}</span>
      <div className="flex flex-col gap-2">
        <PrefSwitch pref="composerDefaultForAgents" label="input.agentsDefault" hint="input.agentsDefaultHint" />
        <PrefSwitch pref="composerAutocorrect" label="input.autocorrect" hint="input.autocorrectHint" />
      </div>
    </div>
  )
}
