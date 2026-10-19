/**
 * Phone mode chip in the terminal header (E3-FR-13/16). Smartphone = phone
 * mode (the PC console takes this screen's grid), Monitor = desktop mode (the
 * phone renders the PC's grid). A tap switches and saves the choice per pane;
 * leaving phone mode gives the size back (releaseFit) when this phone holds
 * it. When another phone controls the size, the chip says so and a tap takes
 * control back.
 */
import type { ReactNode } from 'react'
import { clsx } from 'clsx'
import { Monitor, Smartphone } from 'lucide-react'
import { client } from '../lib/client'
import { requestPhoneFit } from '../lib/phoneFit'
import { selectPaneMode, store, useRemoteStore } from '../lib/store'
import { t } from '../lib/i18n'

export function FitModeChip(): ReactNode {
  const paneId = useRemoteStore((s) => s.activePaneId)
  const mode = useRemoteStore((s) => selectPaneMode(s, s.activePaneId))
  const other = useRemoteStore((s) => (s.activePaneId ? s.sizeInfo[s.activePaneId]?.other === true : false))
  if (!paneId) return null

  if (mode === 'phone' && other) {
    return (
      <button
        type="button"
        data-fit-mode="other"
        onClick={() => requestPhoneFit('take')}
        className="flex h-8 max-w-[9.5rem] shrink-0 items-center gap-1 rounded-full border border-border bg-card px-2 text-[11px] leading-tight text-text-secondary active:bg-bg-primary"
      >
        <Smartphone size={14} className="shrink-0 text-amber-400" />
        <span className="min-w-0 truncate">{t('fit.other')}</span>
      </button>
    )
  }

  const toggle = (): void => {
    const s = store.getState()
    if (mode === 'phone') {
      const info = s.sizeInfo[paneId]
      const sent = s.lastFitSent[paneId]
      const mine = !!info && !!sent && info.owner === 'phone' && info.cols === sent.cols && info.rows === sent.rows
      s.setPaneMode(paneId, 'desktop')
      if (mine) void client.releaseFit(paneId)
    } else {
      s.setPaneMode(paneId, 'phone')
    }
  }
  const label = t(mode === 'phone' ? 'fit.modePhone' : 'fit.modeDesktop')
  return (
    <button
      type="button"
      data-fit-mode={mode}
      onClick={toggle}
      aria-label={label}
      title={label}
      className={clsx(
        'flex h-10 w-10 shrink-0 items-center justify-center rounded-btn active:bg-card',
        mode === 'phone' ? 'text-accent-violet' : 'text-text-secondary',
      )}
    >
      {mode === 'phone' ? <Smartphone size={19} /> : <Monitor size={19} />}
    </button>
  )
}
