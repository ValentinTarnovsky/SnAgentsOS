import { useEffect, useMemo, useState, type KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { Bot, Plus, Type, Zap } from 'lucide-react'
import type { QuickCommand } from '@shared/types'
import { matchesFilter, numbered, orderQuickCommands, popoverKey } from '@shared/quickCommands'
import { visiblePaneIds } from '@shared/status'
import { useAppStore } from '@/lib/store'
import { focusPane, getFocusedPane } from '@/lib/focus'
import { createQuickCommand, runQuickCommand } from '@/lib/quickCommands'
import { useT } from '@/i18n'
import { cn } from '@/lib/cn'

const WIDTH = 360
const MARGIN = 8

interface Anchor {
  /** Console the popover sits over (focus goes back to it on Esc). */
  paneId: string | null
  left: number
  top: number
}

/** The focused console when it is visible in the active workspace, else null. */
function anchorPane(): string | null {
  const s = useAppStore.getState()
  const focused = getFocusedPane()
  const ws = s.workspaces.find((w) => w.id === s.activeWorkspaceId)
  if (!focused || !ws) return null
  return visiblePaneIds(ws, s.minimized[ws.id] ?? [], s.maximized[ws.id]).includes(focused) ? focused : null
}

/** Centered over the focused console's cell, or over the window without one. */
function computeAnchor(): Anchor {
  const paneId = anchorPane()
  const vw = window.innerWidth
  const cell = paneId ? document.querySelector<HTMLElement>(`[data-pane-cell="${CSS.escape(paneId)}"]`) : null
  const rect = cell?.getBoundingClientRect()
  const center = rect && rect.width > 0 ? rect.left + rect.width / 2 : vw / 2
  const left = Math.max(MARGIN, Math.min(center - WIDTH / 2, vw - WIDTH - MARGIN))
  const top = rect && rect.height > 0 ? Math.max(MARGIN, rect.top + 40) : Math.round(window.innerHeight * 0.12)
  return { paneId, left, top }
}

/**
 * Ctrl+Shift+Q popover (E8-FR-04): this workspace's commands, then the
 * globals, each in Settings order; the first 9 carry 1-9. With the filter
 * empty a digit runs its item; any other key filters (subsequence, like the
 * palette). Arrows + Enter run, Esc closes and gives the console its focus back.
 */
export function QuickCommandPopover() {
  const t = useT()
  const open = useAppStore((s) => s.quickPopoverOpen)
  const setOpen = useAppStore((s) => s.setQuickPopoverOpen)
  const commands = useAppStore((s) => s.quickCommands)
  const activeId = useAppStore((s) => s.activeWorkspaceId)
  const [filter, setFilter] = useState('')
  const [idx, setIdx] = useState(0)
  const [anchor, setAnchor] = useState<Anchor | null>(null)

  useEffect(() => {
    if (!open) return
    setFilter('')
    setIdx(0)
    setAnchor(computeAnchor())
  }, [open])

  const items = useMemo(() => numbered(orderQuickCommands(commands, activeId)), [commands, activeId])
  const visible = useMemo(() => items.filter(({ cmd }) => matchesFilter(cmd, filter)), [items, filter])
  const own = visible.filter(({ cmd }) => !!cmd.workspaceId)
  const globals = visible.filter(({ cmd }) => !cmd.workspaceId)
  const flat = [...own, ...globals]

  useEffect(() => {
    setIdx(0)
  }, [filter])

  if (!open || !anchor) return null

  const close = (refocus: boolean): void => {
    setOpen(false)
    setFilter('')
    const target = anchor.paneId
    // After the popover unmounts (its input held the focus until then).
    if (refocus && target) setTimeout(() => focusPane(target), 0)
  }
  const run = (cmd: QuickCommand | undefined): void => {
    if (!cmd) return
    // runQuickCommand gives the focus to the console that got the text (or the new agent).
    close(false)
    void runQuickCommand(cmd)
  }
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>): void => {
    const action = popoverKey(e.key, filter, { ctrl: e.ctrlKey, alt: e.altKey, meta: e.metaKey })
    switch (action.kind) {
      case 'close':
        e.preventDefault()
        close(true)
        return
      case 'move':
        e.preventDefault()
        setIdx((n) => Math.max(0, Math.min(flat.length - 1, n + action.delta)))
        return
      case 'runSelected':
        e.preventDefault()
        run(flat[idx]?.cmd)
        return
      case 'run':
        e.preventDefault()
        run(items[action.index]?.cmd)
        return
      default:
    }
  }

  const row = ({ cmd, digit }: { cmd: QuickCommand; digit: number | null }) => {
    const i = flat.findIndex((x) => x.cmd.id === cmd.id)
    const Icon = cmd.action === 'agent' ? Bot : Type
    return (
      <button
        key={cmd.id}
        data-quick-item={cmd.id}
        onMouseEnter={() => setIdx(i)}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => run(cmd)}
        className={cn('flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm transition-colors', i === idx ? 'bg-bg-secondary' : 'hover:bg-bg-secondary/50')}
      >
        <kbd
          data-quick-digit={digit ?? undefined}
          className={cn('w-5 shrink-0 rounded border text-center font-mono text-[10px]', digit ? 'border-border text-text-secondary' : 'border-transparent')}
        >
          {digit ?? ''}
        </kbd>
        <Icon size={14} className="shrink-0 text-text-secondary" />
        <span className="min-w-0 flex-1 truncate text-text-primary">{cmd.name}</span>
        <span className="max-w-[40%] shrink truncate font-mono text-[11px] text-text-secondary">{cmd.text.split(/\r?\n/)[0]}</span>
      </button>
    )
  }

  return createPortal(
    <div className="fixed inset-0 z-[72]" data-quick-popover>
      <div className="absolute inset-0" onMouseDown={() => close(true)} />
      <div
        role="dialog"
        aria-label={t('quick.title')}
        className="absolute flex max-h-[60vh] flex-col overflow-hidden rounded-modal border border-border bg-card shadow-[0_20px_48px_-12px_rgba(0,0,0,0.6)]"
        style={{ left: anchor.left, top: anchor.top, width: WIDTH }}
      >
        <div className="flex items-center gap-2 border-b border-border px-3">
          <Zap size={14} className="shrink-0 text-accent-violet" />
          <input
            autoFocus
            value={filter}
            data-quick-filter
            onChange={(e) => setFilter(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={t('quick.filter')}
            aria-label={t('quick.filter')}
            className="h-10 min-w-0 flex-1 bg-transparent text-sm text-text-primary outline-none placeholder:text-text-secondary"
          />
        </div>
        <div className="min-h-0 overflow-y-auto py-1">
          {items.length === 0 ? (
            <div className="flex flex-col items-center gap-2 px-4 py-5 text-sm text-text-secondary" data-quick-empty>
              <span>{t('quick.empty')}</span>
              <button
                data-quick-create
                onClick={() => {
                  close(false)
                  createQuickCommand(activeId)
                }}
                className="flex items-center gap-1.5 rounded-btn border border-border px-3 py-1.5 text-xs text-text-primary hover:border-accent-violet/40"
              >
                <Plus size={13} />
                {t('quick.create')}
              </button>
            </div>
          ) : flat.length === 0 ? (
            <p className="px-4 py-5 text-center text-sm text-text-secondary">{t('palette.empty')}</p>
          ) : (
            <>
              {own.length > 0 && (
                <div role="group" aria-label={t('quick.thisWorkspace')} data-quick-group="workspace">
                  <p className="px-3 pb-1 pt-1.5 text-[11px] font-semibold uppercase tracking-wide text-text-secondary/70">{t('quick.thisWorkspace')}</p>
                  {own.map(row)}
                </div>
              )}
              {globals.length > 0 && (
                <div role="group" aria-label={t('quick.globals')} data-quick-group="global">
                  <p className="px-3 pb-1 pt-1.5 text-[11px] font-semibold uppercase tracking-wide text-text-secondary/70">{t('quick.globals')}</p>
                  {globals.map(row)}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>,
    document.body,
  )
}
