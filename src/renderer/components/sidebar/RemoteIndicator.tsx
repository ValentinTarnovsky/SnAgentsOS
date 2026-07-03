import { Smartphone } from 'lucide-react'
import type { RemoteServerState } from '@shared/ipc-contract'
import { useAppStore } from '@/lib/store'
import { useRemoteStore } from '@/lib/remoteStore'
import { useT, type MessageKey } from '@/i18n'
import { Tooltip } from '@/components/ui/Tooltip'
import { cn } from '@/lib/cn'

const STATE_KEY: Record<RemoteServerState, MessageKey> = {
  stopped: 'remote.state.stopped',
  starting: 'remote.state.starting',
  running: 'remote.state.running',
  error: 'remote.state.error',
}

/**
 * Sidebar status row for the remote-control server, docked just above the
 * usage bars. Hidden unless the server is enabled. Click opens the QR modal
 * when running, otherwise deep-links to the remote settings.
 */
export function RemoteIndicator() {
  const t = useT()
  const enabled = useAppStore((s) => s.settings.remote.enabled)
  const collapsed = useAppStore((s) => s.sidebarCollapsed)
  const openSettings = useAppStore((s) => s.openSettings)
  const status = useRemoteStore((s) => s.status)
  const setQrOpen = useRemoteStore((s) => s.setQrOpen)

  if (!enabled) return null

  const running = status.state === 'running'
  const connected = status.connectedCount
  const dot =
    status.state === 'error'
      ? 'bg-red-400'
      : running
        ? connected > 0
          ? 'bg-emerald-400'
          : 'bg-sky-400'
        : 'bg-text-secondary/50'

  const label = running ? t('remote.indicator.connected', { count: connected }) : t(STATE_KEY[status.state])

  const onClick = (): void => {
    if (running) setQrOpen(true)
    else openSettings('remote')
  }

  if (collapsed) {
    return (
      <div className="shrink-0 border-t border-border px-2 py-3">
        <Tooltip label={`${t('settings.cat.remote')} · ${label}`} side="right">
          <button
            onClick={onClick}
            className="relative mx-auto flex h-8 w-8 items-center justify-center rounded-btn text-text-secondary transition-colors hover:bg-card hover:text-text-primary"
          >
            <Smartphone size={16} />
            <span
              className={cn(
                'absolute right-1 top-1 h-2 w-2 rounded-full ring-2 ring-bg-secondary',
                dot,
              )}
            />
          </button>
        </Tooltip>
      </div>
    )
  }

  return (
    <div className="shrink-0 border-t border-border px-2.5 py-2.5">
      <button
        onClick={onClick}
        className="flex w-full items-center gap-2 rounded-btn px-1.5 py-1 text-text-secondary transition-colors hover:bg-card hover:text-text-primary"
      >
        <Smartphone size={15} className="shrink-0" />
        <span className="min-w-0 flex-1 truncate text-left text-xs">{label}</span>
        <span className={cn('h-2 w-2 shrink-0 rounded-full', dot)} />
      </button>
    </div>
  )
}
