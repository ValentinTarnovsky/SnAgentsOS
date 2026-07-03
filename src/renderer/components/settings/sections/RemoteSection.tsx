import { useEffect, useState } from 'react'
import { Copy, QrCode, Smartphone, Trash2 } from 'lucide-react'
import type { RemoteServerState } from '@shared/ipc-contract'
import type { RemoteEndpointKind } from '@shared/remote-protocol'
import { useAppStore } from '@/lib/store'
import { useRemoteStore } from '@/lib/remoteStore'
import { useT, useLang, type MessageKey } from '@/i18n'
import { useAppInfo } from '@/lib/useAppInfo'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { ToggleRow, inputCls, labelCls } from '../ui'
import { cn } from '@/lib/cn'

const MIN_PORT = 1024
const MAX_PORT = 65535

const STATE_DOT: Record<RemoteServerState, string> = {
  stopped: 'bg-text-secondary/50',
  starting: 'bg-amber-400',
  running: 'bg-emerald-400',
  error: 'bg-red-400',
}

const STATE_KEY: Record<RemoteServerState, MessageKey> = {
  stopped: 'remote.state.stopped',
  starting: 'remote.state.starting',
  running: 'remote.state.running',
  error: 'remote.state.error',
}

const KIND_KEY: Record<RemoteEndpointKind, MessageKey> = {
  lan: 'remote.kind.lan',
  tailscale: 'remote.kind.tailscale',
  other: 'remote.kind.other',
}

/** Localized relative "last seen" without extra i18n keys. */
function fmtLastSeen(ms: number, lang: string): string {
  const diff = ms - Date.now()
  const abs = Math.abs(diff)
  const rtf = new Intl.RelativeTimeFormat(lang, { numeric: 'auto' })
  const minute = 60_000
  const hour = 3_600_000
  const day = 86_400_000
  if (abs < minute) return rtf.format(0, 'minute')
  if (abs < hour) return rtf.format(Math.round(diff / minute), 'minute')
  if (abs < day) return rtf.format(Math.round(diff / hour), 'hour')
  return rtf.format(Math.round(diff / day), 'day')
}

export function RemoteSection() {
  const t = useT()
  const lang = useLang()
  const settings = useAppStore((s) => s.settings.remote)
  const updateSettings = useAppStore((s) => s.updateSettings)
  const status = useRemoteStore((s) => s.status)
  const devices = useRemoteStore((s) => s.devices)
  const setQrOpen = useRemoteStore((s) => s.setQrOpen)
  const revoke = useRemoteStore((s) => s.revoke)
  const info = useAppInfo()

  const [portDraft, setPortDraft] = useState(String(settings.port))
  const [revoking, setRevoking] = useState<string | null>(null)

  // Follow external port changes (import, another edit) into the input.
  useEffect(() => {
    setPortDraft(String(settings.port))
  }, [settings.port])

  const setEnabled = (enabled: boolean): void => {
    updateSettings({ remote: { ...settings, enabled } })
  }

  const commitPort = (): void => {
    const n = Number(portDraft)
    if (Number.isInteger(n) && n >= MIN_PORT && n <= MAX_PORT) {
      if (n !== settings.port) updateSettings({ remote: { ...settings, port: n } })
    } else {
      setPortDraft(String(settings.port))
    }
  }

  const running = status.state === 'running'
  const revokingDevice = devices.find((d) => d.id === revoking)

  return (
    <div className="space-y-5">
      <p className="text-xs leading-relaxed text-text-secondary">{t('remote.hint')}</p>

      <ToggleRow
        checked={settings.enabled}
        onChange={setEnabled}
        title={t('remote.enable')}
        description={t('remote.enableHint')}
      />

      <div className="max-w-[200px]">
        <label className={labelCls}>{t('remote.port')}</label>
        <input
          type="number"
          min={MIN_PORT}
          max={MAX_PORT}
          className={inputCls}
          value={portDraft}
          onChange={(e) => setPortDraft(e.target.value)}
          onBlur={commitPort}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur()
          }}
        />
        <p className="mt-1 text-[11px] text-text-secondary">{t('remote.portHint')}</p>
      </div>

      {/* Status */}
      <div className="space-y-2 border-t border-border pt-5">
        <div className="flex items-center gap-2">
          <span className={cn('h-2 w-2 shrink-0 rounded-full', STATE_DOT[status.state])} />
          <span className="text-sm font-medium text-text-primary">{t(STATE_KEY[status.state])}</span>
          <button
            onClick={() => setQrOpen(true)}
            disabled={!running}
            className="ml-auto flex items-center gap-1.5 rounded-btn border border-border bg-card px-2.5 py-1.5 text-xs text-text-primary transition-colors hover:border-accent-violet/40 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <QrCode size={14} className="text-accent-violet" />
            {t('remote.showQr')}
          </button>
        </div>

        {status.state === 'error' && status.error && (
          <p className="text-xs text-red-400">{status.error}</p>
        )}

        {running && status.endpoints.length > 0 && (
          <div className="space-y-1.5">
            {status.endpoints.map((ep) => (
              <div
                key={ep.url}
                className="flex items-center gap-2 rounded-btn border border-border bg-bg-secondary px-2.5 py-1.5"
              >
                <span className="rounded bg-card px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-text-secondary">
                  {t(KIND_KEY[ep.kind])}
                </span>
                <span className="min-w-0 flex-1 truncate font-mono text-xs text-text-primary">
                  {ep.url}
                </span>
                <button
                  onClick={() => window.snApi.clipboard.writeText(ep.url)}
                  title={t('remote.copy')}
                  className="shrink-0 rounded p-1 text-text-secondary transition-colors hover:text-text-primary"
                >
                  <Copy size={14} />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Paired devices */}
      <div className="space-y-2 border-t border-border pt-5">
        <label className={labelCls}>{t('remote.devices')}</label>
        {devices.length === 0 ? (
          <p className="text-xs text-text-secondary">{t('remote.noDevices')}</p>
        ) : (
          <div className="space-y-2">
            {devices.map((d) => (
              <div
                key={d.id}
                className="flex items-center gap-3 rounded-card border border-border bg-bg-secondary px-3 py-2.5"
              >
                <Smartphone size={16} className="shrink-0 text-text-secondary" />
                <div className="min-w-0 flex-1">
                  <span className="block truncate text-sm text-text-primary">{d.name}</span>
                  <span className="flex items-center gap-1.5 text-[11px] text-text-secondary">
                    {d.connected && (
                      <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
                    )}
                    {d.connected ? t('remote.connected') : fmtLastSeen(d.lastSeen, lang)}
                  </span>
                </div>
                <button
                  onClick={() => setRevoking(d.id)}
                  className="rounded p-1.5 text-text-secondary transition-colors hover:text-red-400"
                  title={t('remote.revoke')}
                >
                  <Trash2 size={15} />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Platform hints */}
      <div className="space-y-1.5 border-t border-border pt-5">
        {info?.platform === 'win32' && (
          <p className="text-[11px] leading-relaxed text-text-secondary">{t('remote.firewallHint')}</p>
        )}
        {info?.portable && (
          <p className="text-[11px] leading-relaxed text-text-secondary">{t('remote.portableHint')}</p>
        )}
        <p className="text-[11px] leading-relaxed text-text-secondary">{t('remote.securityHint')}</p>
      </div>

      {revokingDevice && (
        <ConfirmDialog
          open
          title={t('remote.revokeTitle')}
          message={t('remote.revokeMessage', { name: revokingDevice.name })}
          confirmLabel={t('remote.revoke')}
          cancelLabel={t('common.cancel')}
          danger
          onConfirm={() => {
            void revoke(revokingDevice.id)
            setRevoking(null)
          }}
          onCancel={() => setRevoking(null)}
        />
      )}
    </div>
  )
}
