/** Shown when the phone has no stored credentials and no pairing code: offer
 * the in-app scanner (button) or the classic scan-with-the-OS-camera path. */
import type { ReactNode } from 'react'
import { QrCode } from 'lucide-react'
import { InfoScreen } from './InfoScreen'
import { LinkDeviceButton } from './ScanScreen'
import { t } from '../lib/i18n'

export function WelcomeScreen(): ReactNode {
  return (
    <InfoScreen
      tone="accent"
      icon={<QrCode size={30} />}
      title={t('welcome.title')}
      body={t('welcome.body')}
    >
      <LinkDeviceButton />
    </InfoScreen>
  )
}
