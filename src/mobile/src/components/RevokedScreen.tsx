/** Shown after close code 4403: the desktop revoked this device and the stored
 * secret has been wiped. The user must pair again (in-app scanner or QR). */
import type { ReactNode } from 'react'
import { ShieldX } from 'lucide-react'
import { InfoScreen } from './InfoScreen'
import { LinkDeviceButton } from './ScanScreen'
import { t } from '../lib/i18n'

export function RevokedScreen(): ReactNode {
  return (
    <InfoScreen
      tone="danger"
      icon={<ShieldX size={30} />}
      title={t('conn.revoked')}
      body={t('conn.revokedBody')}
    >
      <LinkDeviceButton />
    </InfoScreen>
  )
}
