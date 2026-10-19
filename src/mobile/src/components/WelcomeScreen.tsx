/** Shown when the phone has no stored credentials and no pairing code: offer
 * the in-app scanner (button) or the classic scan-with-the-OS-camera path,
 * with the three "How it works" steps (E2-FR-15). */
import type { ReactNode } from 'react'
import { QrCode } from 'lucide-react'
import { InfoScreen } from './InfoScreen'
import { LinkDeviceButton } from './ScanScreen'
import { t, type MobileMessageKey } from '../lib/i18n'

const STEPS: MobileMessageKey[] = ['welcome.step1', 'welcome.step2', 'welcome.step3']

export function WelcomeScreen(): ReactNode {
  return (
    <InfoScreen
      tone="accent"
      icon={<QrCode size={30} />}
      title={t('welcome.title')}
      body={t('welcome.body')}
    >
      <LinkDeviceButton />
      <section data-how-it-works className="mt-6 text-left">
        <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-text-secondary">{t('welcome.howTitle')}</h2>
        <ol className="flex flex-col gap-2">
          {STEPS.map((key, i) => (
            <li key={key} data-step={i + 1} className="flex items-center gap-3">
              <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-accent-violet/15 text-xs font-bold text-accent-violet">
                {i + 1}
              </span>
              <span className="text-sm text-text-primary">{t(key)}</span>
            </li>
          ))}
        </ol>
      </section>
    </InfoScreen>
  )
}
