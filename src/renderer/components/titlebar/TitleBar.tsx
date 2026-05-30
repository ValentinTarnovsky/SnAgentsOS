import { useEffect, useState } from 'react'
import { Copy, Minus, Square, X } from 'lucide-react'
import { LogoMark } from '@/components/ui/Logo'
import { useT } from '@/i18n'

/**
 * Custom frameless title bar. The bar is a drag region; the window controls
 * (no-drag) call into the main process over `window.snApi.window`.
 */
export function TitleBar() {
  const t = useT()
  const [maxed, setMaxed] = useState(false)

  useEffect(() => {
    window.snApi.window
      .isMaximized()
      .then(setMaxed)
      .catch(() => undefined)
    return window.snApi.window.onMaximizeChange(setMaxed)
  }, [])

  return (
    <div className="app-drag flex h-9 shrink-0 select-none items-center justify-between border-b border-border bg-bg-secondary pl-3">
      <div className="flex items-center gap-2">
        <LogoMark size="sm" />
        <span className="text-xs font-medium text-text-secondary">SnMultiCC</span>
      </div>

      <div className="app-no-drag flex h-full items-stretch">
        <button
          onClick={() => window.snApi.window.minimize()}
          title={t('titlebar.minimize')}
          className="flex w-11 items-center justify-center text-text-secondary transition-colors hover:bg-card hover:text-text-primary"
        >
          <Minus size={15} />
        </button>
        <button
          onClick={() => window.snApi.window.maximize()}
          title={maxed ? t('titlebar.restore') : t('titlebar.maximize')}
          className="flex w-11 items-center justify-center text-text-secondary transition-colors hover:bg-card hover:text-text-primary"
        >
          {maxed ? <Copy size={13} /> : <Square size={13} />}
        </button>
        <button
          onClick={() => window.snApi.window.close()}
          title={t('titlebar.close')}
          className="flex w-11 items-center justify-center text-text-secondary transition-colors hover:bg-red-500 hover:text-white"
        >
          <X size={16} />
        </button>
      </div>
    </div>
  )
}
