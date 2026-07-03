/** Shown when the phone has no stored credentials and no pairing code: tell the
 * user to scan the QR from the desktop. */
import type { ReactNode } from 'react'
import { QrCode } from 'lucide-react'
import { InfoScreen } from './InfoScreen'
import { t } from '../lib/i18n'

export function WelcomeScreen(): ReactNode {
  return (
    <InfoScreen
      tone="accent"
      icon={<QrCode size={30} />}
      title={t('welcome.title')}
      body={t('welcome.body')}
    />
  )
}
