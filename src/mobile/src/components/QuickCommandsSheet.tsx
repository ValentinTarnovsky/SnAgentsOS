/**
 * Quick Commands on the phone (E8-FR-07, replaces SnippetsSheet). Rows are
 * grouped in "This workspace" (the workspace of the console open on the
 * phone) and "Global". A row runs by id through `ctl runQuickCommand`: the
 * desktop resolves the text, a `send` goes to the console open here (never
 * the desktop's focus) and an `agent` opens a new console in this workspace
 * without moving the desktop; the phone then views it. Every row is disabled
 * with a spinner until the ack, so a double tap runs once.
 *
 * In Composer mode a `send` without Enter is inserted at the composer's caret
 * instead, as snippets did (E1-FR-31): the user reviews and sends it.
 *
 * From a Home workspace kebab (E2-FR-51) `workspaceId` names that workspace:
 * its own commands are listed, and a `send` reaches the console open on the
 * phone only when it belongs to that workspace.
 */
import { useRef, useState, type ReactNode } from 'react'
import { clsx } from 'clsx'
import { Bot, Loader2, Type } from 'lucide-react'
import type { QuickCommand } from '@shared/types'
import { Sheet } from './Sheet'
import { selectInputMode, store, useRemoteStore } from '../lib/store'
import { client } from '../lib/client'
import { getComposerHandle } from '../lib/terminalBus'
import { viewedWorkspaceId } from '../lib/workspace'
import { t, type MobileMessageKey } from '../lib/i18n'

const ERRORS: Record<string, MobileMessageKey> = {
  not_found: 'quick.err.notFound',
  not_running: 'quick.err.notRunning',
  multiline_unsafe: 'quick.err.multiline',
  awaiting_user: 'quick.err.awaitingUser',
  enter_held: 'quick.err.enterHeld',
  no_preset: 'quick.err.noPreset',
}

/** Toast text for a failed run. */
export function quickErrorText(error: string | undefined): string {
  return t(ERRORS[error ?? ''] ?? 'quick.err.generic')
}

export function QuickCommandsSheet({
  open,
  onClose,
  workspaceId,
}: {
  open: boolean
  onClose: () => void
  /** A Home section's workspace; absent = the workspace of the console open here. */
  workspaceId?: string | null
}): ReactNode {
  const snapshot = useRemoteStore((s) => s.snapshot)
  const viewedPaneId = useRemoteStore((s) => s.activePaneId)
  const [busy, setBusy] = useState<string | null>(null)
  // Read synchronously: a second tap can land before React re-renders `busy`.
  const inFlight = useRef(false)
  const list = snapshot?.quickCommands ?? []
  const viewedWs = snapshot ? viewedWorkspaceId(snapshot, viewedPaneId) : null
  const wsId = workspaceId ?? viewedWs
  const activePaneId = viewedWs === wsId ? viewedPaneId : null
  const own = wsId ? list.filter((c) => c.workspaceId === wsId) : []
  const globals = list.filter((c) => !c.workspaceId)

  const run = async (cmd: QuickCommand): Promise<void> => {
    if (inFlight.current) return
    const s = store.getState()
    const composer = getComposerHandle()
    if (!workspaceId && cmd.action === 'send' && !cmd.enter && composer && selectInputMode(s) === 'composer') {
      composer.insert(cmd.text)
      onClose()
      return
    }
    if (!wsId || (cmd.action === 'send' && !activePaneId)) {
      s.setToast(t('quick.err.notRunning'))
      return
    }
    inFlight.current = true
    setBusy(cmd.id)
    const res = await client.sendCtl({
      kind: 'runQuickCommand',
      workspaceId: wsId,
      id: cmd.id,
      ...(cmd.action === 'send' && activePaneId ? { paneId: activePaneId } : {}),
    })
    inFlight.current = false
    setBusy(null)
    if (!res.ok) {
      store.getState().setToast(quickErrorText(res.error))
      return
    }
    onClose()
    if (cmd.action === 'agent' && res.paneId) client.showPane(res.paneId)
    else store.getState().setToast(t('quick.sent', { label: cmd.name }))
  }

  const row = (cmd: QuickCommand): ReactNode => {
    const Icon = cmd.action === 'agent' ? Bot : Type
    const spinning = busy === cmd.id
    return (
      <button
        key={cmd.id}
        data-qc-row={cmd.id}
        data-qc-action={cmd.action}
        disabled={busy !== null}
        aria-busy={spinning || undefined}
        onClick={() => void run(cmd)}
        className={clsx(
          'flex min-h-[48px] w-full items-center gap-3 rounded-btn border border-border bg-bg-secondary px-3 py-2 text-left active:bg-card',
          busy !== null && !spinning && 'opacity-50',
        )}
      >
        {spinning ? (
          <Loader2 size={18} className="shrink-0 animate-spin text-accent-violet" />
        ) : (
          <Icon size={18} className="shrink-0 text-text-secondary" aria-label={t(cmd.action === 'agent' ? 'quick.agent' : 'quick.send')} />
        )}
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-sm font-medium text-text-primary">{cmd.name}</span>
          <span className="line-clamp-1 font-mono text-[11px] text-text-secondary">{cmd.text.split(/\r?\n/)[0]}</span>
        </span>
      </button>
    )
  }

  return (
    <Sheet open={open} onClose={onClose} title={t('quick.title')}>
      {own.length === 0 && globals.length === 0 ? (
        <p className="text-xs text-text-secondary" data-qc-empty>{t('quick.empty')}</p>
      ) : (
        <div className="flex flex-col gap-3">
          {own.length > 0 && (
            <section data-qc-group="workspace" className="flex flex-col gap-2">
              <h3 className="text-[11px] font-semibold uppercase tracking-wide text-text-secondary">{t('quick.thisWorkspace')}</h3>
              {own.map(row)}
            </section>
          )}
          {globals.length > 0 && (
            <section data-qc-group="global" className="flex flex-col gap-2">
              <h3 className="text-[11px] font-semibold uppercase tracking-wide text-text-secondary">{t('quick.globals')}</h3>
              {globals.map(row)}
            </section>
          )}
        </div>
      )}
    </Sheet>
  )
}
