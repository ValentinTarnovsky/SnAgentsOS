import { useEffect, useState } from 'react'
import { Copy, Pencil, Plus, QrCode, Smartphone, Trash2 } from 'lucide-react'
import type { RemoteServerState } from '@shared/ipc-contract'
import type { RemoteEndpointKind } from '@shared/remote-protocol'
import type { KeyButton } from '@shared/types'
import { BASE_KEYS, comboToSeq, type BaseKeyId } from '@shared/keyseq'
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

/** Renders control bytes in caret notation (^J, ^[, ^?) so a sequence is readable. */
function caretNotation(seq: string): string {
  let out = ''
  for (const ch of seq) {
    const code = ch.charCodeAt(0)
    if (code === 0x7f) out += '^?'
    else if (code < 0x20) out += '^' + String.fromCharCode(code + 64)
    else out += ch
  }
  return out
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

  const keyButtons = useAppStore((s) => s.keyButtons)
  const saveKeyButton = useAppStore((s) => s.saveKeyButton)
  const deleteKeyButton = useAppStore((s) => s.deleteKeyButton)
  const newKeyButtonId = useAppStore((s) => s.newKeyButtonId)
  const [editingButton, setEditingButton] = useState<KeyButton | null>(null)

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

      {/* Phone KeyBar custom shortcuts */}
      <div className="space-y-2 border-t border-border pt-5">
        <label className={labelCls}>{t('remote.keybar.title')}</label>
        <p className="text-xs leading-relaxed text-text-secondary">{t('remote.keybar.hint')}</p>

        {editingButton ? (
          <KeyButtonEditor
            initial={editingButton}
            onSave={(button) => {
              saveKeyButton(button)
              setEditingButton(null)
            }}
            onCancel={() => setEditingButton(null)}
          />
        ) : (
          <>
            {keyButtons.length === 0 && (
              <p className="text-xs text-text-secondary">{t('remote.keybar.empty')}</p>
            )}
            {keyButtons.length > 0 && (
              <div className="space-y-2">
                {keyButtons.map((btn) => (
                  <div
                    key={btn.id}
                    className="flex items-center gap-3 rounded-card border border-border bg-bg-secondary px-3 py-2.5"
                  >
                    <div className="min-w-0 flex-1">
                      <span className="block truncate text-sm text-text-primary">{btn.label}</span>
                      <span className="block truncate font-mono text-[11px] text-text-secondary">
                        {caretNotation(btn.seq)}
                      </span>
                    </div>
                    <button
                      onClick={() => setEditingButton(btn)}
                      className="rounded p-1.5 text-text-secondary hover:text-text-primary"
                      title={t('settings.edit')}
                    >
                      <Pencil size={15} />
                    </button>
                    <button
                      onClick={() => deleteKeyButton(btn.id)}
                      className="rounded p-1.5 text-text-secondary hover:text-red-400"
                      title={t('ctx.delete')}
                    >
                      <Trash2 size={15} />
                    </button>
                  </div>
                ))}
              </div>
            )}
            <button
              onClick={() => setEditingButton({ id: newKeyButtonId(), label: '', seq: '' })}
              className="flex w-full items-center justify-center gap-2 rounded-card border border-dashed border-border py-2.5 text-sm text-text-secondary transition-colors hover:border-accent-violet/40 hover:text-text-primary"
            >
              <Plus size={16} />
              {t('remote.keybar.new')}
            </button>
          </>
        )}
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

const chipCls =
  'rounded-btn border border-border bg-bg-secondary px-2.5 py-1 text-xs text-text-primary transition-colors hover:border-accent-violet/40'

function KeyButtonEditor({
  initial,
  onSave,
  onCancel,
}: {
  initial: KeyButton
  onSave: (button: KeyButton) => void
  onCancel: () => void
}) {
  const t = useT()
  const [label, setLabel] = useState(initial.label)
  const [seq, setSeq] = useState(initial.seq)
  const [literal, setLiteral] = useState('')
  const [combo, setCombo] = useState({ ctrl: false, shift: false, alt: false })
  const [base, setBase] = useState<BaseKeyId>('char')
  const [comboChar, setComboChar] = useState('a')

  const addLiteral = (): void => {
    if (!literal) return
    setSeq(seq + literal)
    setLiteral('')
  }
  const addCombo = (): void => {
    const s = comboToSeq({ ...combo, base, char: comboChar })
    if (s) setSeq(seq + s)
  }

  return (
    <div className="space-y-4 rounded-card border border-border bg-bg-secondary p-3">
      <div>
        <label className={labelCls}>{t('remote.keybar.label')}</label>
        <input className={inputCls} value={label} onChange={(e) => setLabel(e.target.value)} />
      </div>

      <div className="space-y-2">
        <label className={labelCls}>{t('remote.keybar.literal')}</label>
        <div className="flex gap-2">
          <input
            className={cn(inputCls, 'flex-1')}
            value={literal}
            onChange={(e) => setLiteral(e.target.value)}
          />
          <button onClick={addLiteral} className={chipCls}>
            {t('remote.keybar.addText')}
          </button>
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        <button onClick={() => setSeq(seq + '\r')} className={chipCls}>
          {t('remote.keybar.enter')}
        </button>
        <button onClick={() => setSeq(seq + '\n')} className={chipCls}>
          {t('remote.keybar.newline')}
        </button>
        <button onClick={() => setSeq(seq + '\t')} className={chipCls}>
          {t('remote.keybar.tab')}
        </button>
        <button onClick={() => setSeq(seq + '\x1b')} className={chipCls}>
          {t('remote.keybar.esc')}
        </button>
        <button onClick={() => setSeq('')} className={chipCls}>
          {t('remote.keybar.clear')}
        </button>
      </div>

      {/* Modifier combo builder: pick Ctrl/Shift/Alt + a base key. */}
      <div className="space-y-2">
        <label className={labelCls}>{t('remote.keybar.combo')}</label>
        <div className="flex flex-wrap items-center gap-2">
          {(['ctrl', 'shift', 'alt'] as const).map((m) => (
            <button
              key={m}
              onClick={() => setCombo({ ...combo, [m]: !combo[m] })}
              className={cn(
                'rounded-btn border px-2.5 py-1 text-xs transition-colors',
                combo[m]
                  ? 'border-accent-violet bg-accent-violet text-white'
                  : 'border-border bg-bg-secondary text-text-primary hover:border-accent-violet/40',
              )}
            >
              {m === 'ctrl' ? 'Ctrl' : m === 'shift' ? 'Shift' : 'Alt'}
            </button>
          ))}
          <span className="text-xs text-text-secondary">+</span>
          <select
            value={base}
            onChange={(e) => setBase(e.target.value as BaseKeyId)}
            className={cn(inputCls, 'w-auto')}
            aria-label={t('remote.keybar.base')}
          >
            {BASE_KEYS.map((k) => (
              <option key={k.id} value={k.id}>
                {k.label}
              </option>
            ))}
          </select>
          {base === 'char' && (
            <input
              maxLength={1}
              value={comboChar}
              onChange={(e) => setComboChar(e.target.value.slice(-1) || 'a')}
              className={cn(inputCls, 'w-10 px-2 text-center')}
              aria-label={t('remote.keybar.char')}
            />
          )}
          <button onClick={addCombo} className={chipCls}>
            {t('remote.keybar.addCombo')}
          </button>
        </div>
      </div>

      <div>
        <label className={labelCls}>{t('remote.keybar.preview')}</label>
        <p className="rounded-btn border border-border bg-card px-3 py-2 font-mono text-sm text-text-primary">
          {caretNotation(seq) || ' '}
        </p>
      </div>

      <div className="flex justify-end gap-2 pt-1">
        <button
          onClick={onCancel}
          className="rounded-btn border border-border px-4 py-2 text-sm text-text-secondary hover:text-text-primary"
        >
          {t('common.cancel')}
        </button>
        <button
          disabled={seq.length === 0 || label.trim().length === 0}
          onClick={() => onSave({ id: initial.id, label: label.trim(), seq })}
          className="rounded-btn bg-[linear-gradient(135deg,var(--color-accent-violet),var(--color-accent-blue))] px-4 py-2 text-sm font-medium text-white hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {t('common.save')}
        </button>
      </div>
    </div>
  )
}
