/**
 * Action menu for the current workspace/console, plus the confirm / global
 * prompt / settings sub-sheets it opens. All actions go through the WS control
 * plane (client.sendCtl) and reflect their ack: New console auto-subscribes to
 * the pane id returned in the ack; Global prompt shows a "sent to N" toast.
 */
import { useState, type ReactNode } from 'react'
import { clsx } from 'clsx'
import { Megaphone, Plus, RotateCcw, Settings as SettingsIcon, Trash2, Minus, Plus as PlusSmall, LogOut } from 'lucide-react'
import { Sheet } from './Sheet'
import { PrimaryButton } from './InfoScreen'
import { useRemoteStore } from '../lib/store'
import { client } from '../lib/client'
import { getActiveTerm } from '../lib/terminalBus'
import { MAX_FONT, MIN_FONT } from '../lib/fit'
import { t } from '../lib/i18n'

function Row({
  icon,
  label,
  onClick,
  danger,
}: {
  icon: ReactNode
  label: string
  onClick: () => void
  danger?: boolean
}): ReactNode {
  return (
    <button
      onClick={onClick}
      className="flex w-full items-center gap-3 rounded-btn border border-border bg-bg-secondary px-3 py-3 text-left active:bg-card"
    >
      <span className={clsx('flex h-8 w-8 items-center justify-center rounded-btn', danger ? 'text-red-400' : 'text-accent-violet')}>
        {icon}
      </span>
      <span className={clsx('text-sm font-medium', danger ? 'text-red-400' : 'text-text-primary')}>{label}</span>
    </button>
  )
}

interface ConfirmState {
  message: string
  onConfirm: () => void
}

function ConfirmSheet({
  state,
  onClose,
}: {
  state: ConfirmState | null
  onClose: () => void
}): ReactNode {
  return (
    <Sheet open={state != null} onClose={onClose} title={t('act.confirm')}>
      <p className="mb-5 text-sm leading-relaxed text-text-secondary">{state?.message}</p>
      <div className="flex gap-2">
        <button
          onClick={onClose}
          className="h-12 flex-1 rounded-btn border border-border bg-bg-secondary text-sm font-medium text-text-primary active:bg-card"
        >
          {t('act.cancel')}
        </button>
        <button
          onClick={() => {
            state?.onConfirm()
            onClose()
          }}
          className="h-12 flex-1 rounded-btn bg-red-500 text-sm font-semibold text-white active:brightness-110"
        >
          {t('act.confirm')}
        </button>
      </div>
    </Sheet>
  )
}

function GlobalPromptSheet({
  open,
  onClose,
  workspaceId,
}: {
  open: boolean
  onClose: () => void
  workspaceId: string | null
}): ReactNode {
  const [text, setText] = useState('')
  const setToast = useRemoteStore((s) => s.setToast)

  const submit = async (): Promise<void> => {
    if (!workspaceId || !text) return
    const res = await client.sendCtl({ kind: 'globalPrompt', workspaceId, text })
    if (res.ok) setToast(t('act.promptSent', { n: res.info ?? 0 }))
    setText('')
    onClose()
  }

  return (
    <Sheet open={open} onClose={onClose} title={t('act.globalPrompt')}>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={t('act.promptPlaceholder')}
        rows={4}
        className="mb-4 w-full resize-none rounded-btn border border-border bg-bg-secondary px-3 py-2 text-sm text-text-primary outline-none focus:border-accent-violet"
      />
      <PrimaryButton onClick={() => void submit()} disabled={text.length === 0}>
        {t('act.send')}
      </PrimaryButton>
    </Sheet>
  )
}

function SettingsSheet({ open, onClose }: { open: boolean; onClose: () => void }): ReactNode {
  const fontOverride = useRemoteStore((s) => s.fontOverride)
  const setFontOverride = useRemoteStore((s) => s.setFontOverride)
  const [confirmUnpair, setConfirmUnpair] = useState(false)

  const currentSize = (): number => {
    if (fontOverride != null) return fontOverride
    const term = getActiveTerm()
    const raw = term ? Number(term.options.fontSize) : 14
    return Number.isFinite(raw) ? Math.round(raw) : 14
  }
  const bump = (delta: number): void => {
    const next = Math.max(MIN_FONT, Math.min(MAX_FONT, currentSize() + delta))
    setFontOverride(next)
  }

  return (
    <>
      <Sheet open={open} onClose={onClose} title={t('act.settings')}>
        <div className="mb-5 flex items-center justify-between">
          <span className="text-sm text-text-primary">{t('act.fontSize')}</span>
          <div className="flex items-center gap-3">
            <button
              onPointerDown={(e) => {
                e.preventDefault()
                bump(-1)
              }}
              className="flex h-10 w-10 items-center justify-center rounded-btn border border-border bg-bg-secondary text-text-primary active:bg-card"
              aria-label="Smaller"
            >
              <Minus size={16} />
            </button>
            <span className="w-8 text-center text-sm font-medium text-text-primary">{currentSize()}</span>
            <button
              onPointerDown={(e) => {
                e.preventDefault()
                bump(1)
              }}
              className="flex h-10 w-10 items-center justify-center rounded-btn border border-border bg-bg-secondary text-text-primary active:bg-card"
              aria-label="Larger"
            >
              <PlusSmall size={16} />
            </button>
          </div>
        </div>
        <Row icon={<LogOut size={18} />} label={t('act.unpair')} danger onClick={() => setConfirmUnpair(true)} />
      </Sheet>
      <ConfirmSheet
        state={confirmUnpair ? { message: t('act.unpairConfirm'), onConfirm: () => client.unpair() } : null}
        onClose={() => setConfirmUnpair(false)}
      />
    </>
  )
}

export function ActionSheet({ open, onClose }: { open: boolean; onClose: () => void }): ReactNode {
  const snapshot = useRemoteStore((s) => s.snapshot)
  const activePaneId = useRemoteStore((s) => s.activePaneId)
  const [confirm, setConfirm] = useState<ConfirmState | null>(null)
  const [promptOpen, setPromptOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)

  const workspaceId = snapshot?.activeWorkspaceId ?? null

  const newConsole = async (): Promise<void> => {
    if (!workspaceId) return
    onClose()
    const res = await client.sendCtl({ kind: 'createPane', workspaceId })
    if (res.ok && res.paneId) client.viewPane(res.paneId)
  }

  const restart = (): void => {
    if (!workspaceId || !activePaneId) return
    setConfirm({
      message: t('act.restartConfirm'),
      onConfirm: () => void client.sendCtl({ kind: 'restartPane', workspaceId, paneId: activePaneId }),
    })
  }

  const close = (): void => {
    if (!workspaceId || !activePaneId) return
    setConfirm({
      message: t('act.closeConfirm'),
      onConfirm: () => void client.sendCtl({ kind: 'closePane', workspaceId, paneId: activePaneId }),
    })
  }

  return (
    <>
      <Sheet open={open} onClose={onClose} title={t('main.actions')}>
        <div className="flex flex-col gap-2">
          <Row icon={<Plus size={18} />} label={t('act.newConsole')} onClick={() => void newConsole()} />
          <Row
            icon={<Megaphone size={18} />}
            label={t('act.globalPrompt')}
            onClick={() => {
              onClose()
              setPromptOpen(true)
            }}
          />
          <Row
            icon={<RotateCcw size={18} />}
            label={t('act.restart')}
            onClick={() => {
              onClose()
              restart()
            }}
          />
          <Row
            icon={<Trash2 size={18} />}
            label={t('act.close')}
            danger
            onClick={() => {
              onClose()
              close()
            }}
          />
          <Row
            icon={<SettingsIcon size={18} />}
            label={t('act.settings')}
            onClick={() => {
              onClose()
              setSettingsOpen(true)
            }}
          />
        </div>
      </Sheet>

      <ConfirmSheet state={confirm} onClose={() => setConfirm(null)} />
      <GlobalPromptSheet open={promptOpen} onClose={() => setPromptOpen(false)} workspaceId={workspaceId} />
      <SettingsSheet open={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </>
  )
}
