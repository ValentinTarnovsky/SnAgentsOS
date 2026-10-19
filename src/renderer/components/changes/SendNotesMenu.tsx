import { useEffect, useMemo, useRef, useState } from 'react'
import { Send, Sparkles } from 'lucide-react'
import type { ReviewNote } from '@shared/review-notes'
import type { Pane, Workspace } from '@shared/types'
import { useT } from '@/i18n'
import { cn } from '@/lib/cn'
import { useAppStore } from '@/lib/store'
import { iconFor } from '@/lib/icons'
import { toast } from '@/lib/toast'
import { getFocusHistoryForWorkspace } from '@/lib/focus'
import { checkBatch, firstBatch, toPayload } from '@/lib/reviewNotesStore'
import { claudePresetFor, MAX_WORKSPACE_PANES, notesTargetOf, sendReviewNotes, sendReviewNotesToNewClaude, type NotesTarget } from '@/lib/sendReviewNotes'
import { buildReviewNotesText } from '@shared/review-notes-format'
import { PaneStatusDot } from '@/components/ui/StatusDot'

const NEW_CLAUDE = '__new_claude__'

function orderedPanes(ws: Workspace): Pane[] {
  const order = ws.layout?.order ?? []
  const byId = new Map(ws.panes.map((p) => [p.id, p]))
  const out = order.map((id) => byId.get(id)).filter((p): p is Pane => !!p)
  for (const p of ws.panes) if (!out.includes(p)) out.push(p)
  return out
}

/**
 * "Send N notes to..." (E7-FR-19, 21): a picker with the workspace's
 * consoles (status dot, icon, title). Consoles without bracketed paste are
 * listed disabled; the last agent console focused in the workspace comes
 * preselected; "Send with Enter" starts unchecked on every open and only
 * applies to agent consoles. "New Claude console" opens one in the same
 * folder (`cwd`: the worktree of a pane target) and pastes once it is ready.
 */
export function SendNotesMenu({ workspace, pending, cwd }: { workspace: Workspace; pending: ReviewNote[]; cwd?: string }) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const [choice, setChoice] = useState<string | null>(null)
  const [enter, setEnter] = useState(false)
  const [parts, setParts] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  // Re-render on status changes: the agent/safe split and the dots follow them.
  useAppStore((s) => s.paneStatus)
  const presets = useAppStore((s) => s.presets)
  const settings = useAppStore((s) => s.settings)
  const panes = orderedPanes(workspace)
  const kinds = new Map<string, NotesTarget>(panes.map((p) => [p.id, notesTargetOf(p)]))
  const full = workspace.panes.length >= MAX_WORKSPACE_PANES
  const claudePreset = claudePresetFor({ presets, settings })
  const count = pending.length
  const batch = useMemo(() => checkBatch(pending.map(toPayload)), [pending])
  const part = useMemo(() => (batch.ok ? pending : firstBatch(pending)), [batch.ok, pending])

  const openMenu = (): void => {
    const agents = panes.filter((p) => kinds.get(p.id) === 'agent').map((p) => p.id)
    const recent = getFocusHistoryForWorkspace(workspace.id).find((id) => agents.includes(id))
    setChoice(recent ?? agents[0] ?? null)
    setEnter(false)
    setParts(false)
    setOpen(true)
  }

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    // Esc closes the picker first wherever the focus is (never the panel behind it).
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopPropagation()
      setOpen(false)
    }
    window.addEventListener('mousedown', onDown, true)
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('mousedown', onDown, true)
      window.removeEventListener('keydown', onKey, true)
    }
  }, [open])

  const chosenKind: NotesTarget | 'new' | null = choice === NEW_CLAUDE ? 'new' : choice ? kinds.get(choice) ?? null : null
  const enterAllowed = chosenKind === 'agent' || chosenKind === 'new'
  const sendable = (chosenKind === 'agent' || chosenKind === 'safe' || chosenKind === 'new') && (batch.ok || parts) && part.length > 0

  const copyAction = (ids: string[]) => {
    const text = buildReviewNotesText(pending.filter((n) => ids.includes(n.id)).map(toPayload))
    return [{ label: t('notes.toast.copy'), run: () => window.snApi.clipboard.writeText(text) }]
  }

  const send = (): void => {
    if (!sendable || !choice) return
    const ids = (batch.ok ? pending : part).map((n) => n.id)
    const submit = enter && enterAllowed
    setOpen(false)
    if (choice === NEW_CLAUDE) {
      toast.info(t('notes.toast.opening'), { dedupeKey: 'review-notes' })
      void sendReviewNotesToNewClaude(workspace.id, { noteIds: ids, submit, ...(cwd ? { cwd } : {}) }).then((res) => {
        const title = res.paneId ? useAppStore.getState().workspaces.flatMap((w) => w.panes).find((p) => p.id === res.paneId)?.title ?? '' : ''
        if (res.ok) {
          if ('late' in res && res.late) toast.warning(t('notes.toast.sentLate', { pane: title }), { dedupeKey: 'review-notes' })
          else toast.success(t('notes.toast.sent', { pane: title }), { dedupeKey: 'review-notes' })
        } else {
          toast.error(t(`notes.toast.newFailed.${res.error}` as 'notes.toast.newFailed.timeout'), { dedupeKey: 'review-notes', actions: copyAction(ids) })
        }
      })
      return
    }
    const res = sendReviewNotes(workspace.id, choice, { noteIds: ids, submit })
    const title = panes.find((p) => p.id === choice)?.title ?? ''
    if (res.ok) toast.success(t('notes.toast.sent', { pane: title }), { dedupeKey: 'review-notes' })
    else toast.error(t(`notes.toast.failed.${res.error}` as 'notes.toast.failed.not_agent'), { dedupeKey: 'review-notes', actions: copyAction(ids) })
  }

  const reason = (kind: NotesTarget | undefined): string | null => {
    if (kind === 'plain') return t('notes.menu.noSafePaste')
    if (kind === 'unmounted') return t('notes.menu.notRunning')
    return null
  }

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => (open ? setOpen(false) : openMenu())}
        disabled={count === 0}
        aria-haspopup="dialog"
        aria-expanded={open}
        className="flex items-center gap-1 rounded-btn bg-accent-violet px-2 py-0.5 text-[11px] font-medium text-white hover:opacity-90 disabled:opacity-40"
        data-notes-send
      >
        <Send size={11} />
        {count === 1 ? t('notes.sendOne') : t('notes.sendMany', { count })}
      </button>
      {open && (
        <div
          role="dialog"
          aria-label={t('notes.menu.title')}
          className="absolute right-0 top-full z-30 mt-1 w-72 rounded-modal border border-border bg-card p-2 text-xs shadow-[0_12px_32px_-8px_rgba(0,0,0,0.6)]"
          onKeyDown={(e) => {
            e.stopPropagation()
            if (e.key === 'Escape') {
              e.preventDefault()
              setOpen(false)
            } else if (e.key === 'Enter' && (e.target as HTMLElement).tagName !== 'BUTTON') {
              e.preventDefault()
              send()
            }
          }}
          data-notes-menu
        >
          <p className="px-1 pb-1 text-[11px] font-semibold uppercase tracking-wide text-text-secondary">{t('notes.menu.title')}</p>
          <div role="radiogroup" className="flex max-h-64 flex-col gap-0.5 overflow-y-auto">
            {panes.map((p) => {
              const kind = kinds.get(p.id)
              const why = reason(kind)
              const Icon = iconFor(p.icon)
              return (
                <button
                  key={p.id}
                  type="button"
                  role="radio"
                  aria-checked={choice === p.id}
                  disabled={!!why}
                  onClick={() => {
                    setChoice(p.id)
                    if (kind !== 'agent') setEnter(false)
                  }}
                  className={cn(
                    'flex w-full items-center gap-2 rounded-btn px-1.5 py-1 text-left',
                    choice === p.id ? 'bg-accent-violet/15 text-text-primary' : 'text-text-primary hover:bg-bg-secondary',
                    why && 'cursor-not-allowed opacity-50 hover:bg-transparent',
                  )}
                  title={why ?? undefined}
                  data-notes-target={p.id}
                  data-notes-kind={kind}
                >
                  <span className="flex w-2 shrink-0 justify-center">
                    <PaneStatusDot paneId={p.id} size={7} noTooltip />
                  </span>
                  <Icon size={13} className="shrink-0" style={{ color: p.color }} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">{p.title}</span>
                    {why && <span className="block truncate text-[10px] text-text-secondary">{why}</span>}
                  </span>
                </button>
              )
            })}
            <button
              type="button"
              role="radio"
              aria-checked={choice === NEW_CLAUDE}
              disabled={full || !claudePreset}
              onClick={() => setChoice(NEW_CLAUDE)}
              className={cn(
                'mt-0.5 flex w-full items-center gap-2 rounded-btn border-t border-border/60 px-1.5 py-1 text-left',
                choice === NEW_CLAUDE ? 'bg-accent-violet/15 text-text-primary' : 'text-text-primary hover:bg-bg-secondary',
                (full || !claudePreset) && 'cursor-not-allowed opacity-50 hover:bg-transparent',
              )}
              data-notes-target={NEW_CLAUDE}
            >
              <span className="w-2 shrink-0" />
              <Sparkles size={13} className="shrink-0 text-accent-violet" />
              <span className="min-w-0 flex-1">
                <span className="block truncate">{t('notes.menu.newClaude')}</span>
                {(full || !claudePreset) && <span className="block truncate text-[10px] text-text-secondary">{full ? t('notes.menu.full') : t('notes.menu.noPreset')}</span>}
              </span>
            </button>
          </div>
          <label className={cn('mt-2 flex items-center gap-2 px-1', !enterAllowed && 'opacity-50')} title={enterAllowed ? undefined : t('notes.menu.enterHint')}>
            <input type="checkbox" checked={enter && enterAllowed} disabled={!enterAllowed} onChange={(e) => setEnter(e.target.checked)} data-notes-enter />
            <span>{t('notes.menu.enter')}</span>
          </label>
          {!batch.ok && (
            <div className="mt-2 rounded-btn border border-state-action/40 bg-state-action/10 p-1.5 text-[11px] text-text-primary" data-notes-toolarge>
              <p>{t('notes.menu.tooLarge')}</p>
              <label className="mt-1 flex items-center gap-2">
                <input type="checkbox" checked={parts} onChange={(e) => setParts(e.target.checked)} data-notes-parts />
                <span>{t('notes.menu.sendPart', { count: part.length, total: count })}</span>
              </label>
            </div>
          )}
          <div className="mt-2 flex justify-end gap-1.5">
            <button type="button" onClick={() => setOpen(false)} className="rounded-btn border border-border px-2 py-0.5 text-text-primary hover:bg-bg-secondary">
              {t('common.cancel')}
            </button>
            <button type="button" onClick={send} disabled={!sendable} className="rounded-btn bg-accent-violet px-2 py-0.5 font-medium text-white hover:opacity-90 disabled:opacity-40" data-notes-confirm>
              {t('notes.menu.send')}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
