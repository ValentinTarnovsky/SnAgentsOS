import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { History, Timer } from 'lucide-react'
import { formatAge } from '@shared/agents'
import { useAppStore } from '@/lib/store'
import { useAgentStore, type ResumeModalState } from '@/lib/agentStore'
import { applyResumeChoice } from '@/lib/agentLaunch'
import { countdownLeft, formatCountdown, groupCheck, resumeGroups, triggerKey, type ResumeGroup } from '@/lib/resumeModal'
import { iconFor } from '@/lib/icons'
import { ariaKeyshortcuts } from '@/lib/keymap'
import { KeyHint } from '@/components/ui/KeyHint'
import { useT } from '@/i18n'
import { cn } from '@/lib/cn'

const RESUME_KEYS = ['Enter']
const FOCUSABLE = 'button:not([disabled]), input:not([disabled])'

/**
 * "Resume interrupted chats?" (E5-FR-12). Opens after hydrate when the
 * `ask` policy finds chats the previous run cut off mid-turn or waiting on
 * the user; their consoles wait behind a placeholder until it is decided.
 * Esc does not close it; left alone it resumes the selection when its
 * countdown ends, and any interaction cancels the countdown.
 */
export function ResumeDialog() {
  const modal = useAgentStore((s) => s.modal)
  if (!modal) return null
  return <ResumeDialogBody key={modal.openedAt} modal={modal} />
}

function GroupCheckbox({ group, selected, onToggle, label }: { group: ResumeGroup; selected: ReadonlySet<string>; onToggle: () => void; label: string }) {
  const ref = useRef<HTMLInputElement>(null)
  const state = groupCheck(group.rows, selected)
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = state === 'some'
  }, [state])
  return (
    <input
      ref={ref}
      type="checkbox"
      checked={state === 'all'}
      onChange={onToggle}
      aria-label={label}
      aria-checked={state === 'some' ? 'mixed' : state === 'all'}
      data-resume-group={group.workspaceId}
      className="h-3.5 w-3.5 shrink-0 accent-[var(--color-accent-violet)]"
    />
  )
}

function ResumeDialogBody({ modal }: { modal: ResumeModalState }) {
  const t = useT()
  const workspaces = useAppStore((s) => s.workspaces)
  const agentSettings = useAppStore((s) => s.settings.agents)
  const sessions = useAgentStore((s) => s.sessions)
  const groups = useMemo(() => resumeGroups(modal.paneIds, workspaces, sessions), [modal.paneIds, workspaces, sessions])
  const rows = groups.flatMap((g) => g.rows)
  const [selected, setSelected] = useState<Set<string>>(() => new Set(modal.paneIds))
  const [nudge, setNudge] = useState(!!agentSettings?.resumeNudge)
  const [dontAsk, setDontAsk] = useState(false)
  const [cancelled, setCancelled] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  const dialogRef = useRef<HTMLDivElement>(null)
  const timeoutSec = agentSettings?.resumeModalTimeoutSec ?? 60
  const left = countdownLeft(modal.openedAt, timeoutSec, now, cancelled)
  const anyWorking = rows.some((r) => r.working)

  // The latest choice, for the countdown and the window key handler.
  const choice = {
    resume: [...selected],
    dontAskAgain: dontAsk,
    nudge: anyWorking ? nudge : undefined,
  }
  const choiceRef = useRef(choice)
  choiceRef.current = choice

  const resume = (): void => applyResumeChoice(choiceRef.current)
  const startFresh = (): void => applyResumeChoice({ ...choiceRef.current, resume: [], startFresh: true })

  // Countdown tick; at 0 the current selection resumes by itself.
  useEffect(() => {
    if (left === null) return
    if (left <= 0) {
      applyResumeChoice(choiceRef.current)
      return
    }
    const timer = setTimeout(() => setNow(Date.now()), Math.min(250, left))
    return () => clearTimeout(timer)
  }, [left])

  // Keys while open: Esc never closes, Enter resumes (a focused button keeps
  // its own Enter), Tab stays inside, and nothing reaches the console below.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const root = dialogRef.current
      if (!root) return
      setCancelled(true)
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        return
      }
      if (e.key === 'Enter' && !(e.target instanceof HTMLButtonElement && root.contains(e.target))) {
        e.preventDefault()
        e.stopPropagation()
        if (choiceRef.current.resume.length > 0) applyResumeChoice(choiceRef.current)
        return
      }
      if (e.key === 'Tab') {
        const items = [...root.querySelectorAll<HTMLElement>(FOCUSABLE)]
        if (items.length === 0) return
        const at = items.indexOf(document.activeElement as HTMLElement)
        const next = e.shiftKey ? (at <= 0 ? items.length - 1 : at - 1) : at < 0 || at === items.length - 1 ? 0 : at + 1
        e.preventDefault()
        items[next].focus()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  const toggleRow = (paneId: string): void =>
    setSelected((s) => {
      const next = new Set(s)
      if (next.has(paneId)) next.delete(paneId)
      else next.add(paneId)
      return next
    })
  const toggleGroup = (group: ResumeGroup): void =>
    setSelected((s) => {
      const next = new Set(s)
      const all = groupCheck(group.rows, s) === 'all'
      for (const r of group.rows) {
        if (all) next.delete(r.paneId)
        else next.add(r.paneId)
      }
      return next
    })

  const count = rows.filter((r) => selected.has(r.paneId)).length

  return createPortal(
    <div className="fixed inset-0 z-[70] flex items-center justify-center p-4" data-resume-dialog>
      <div className="absolute inset-0 bg-black/60" onPointerDown={() => setCancelled(true)} />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="resume-dialog-title"
        onPointerDownCapture={() => setCancelled(true)}
        className="relative z-10 flex max-h-full w-full max-w-lg flex-col overflow-hidden rounded-modal border border-border bg-card shadow-[0_20px_48px_-12px_rgba(0,0,0,0.6)]"
      >
        <div className="flex shrink-0 items-start gap-3 border-b border-border px-5 py-3">
          <History size={18} className="mt-0.5 shrink-0 text-accent-violet" />
          <div className="min-w-0">
            <h2 id="resume-dialog-title" className="text-sm font-semibold text-text-primary">
              {t('agents.modal.title')}
            </h2>
            <p className="text-xs text-text-secondary" data-resume-subtitle>
              {t(triggerKey(modal.trigger))}
            </p>
          </div>
        </div>

        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-5 py-3">
          {groups.map((group) => (
            <section key={group.workspaceId} data-resume-ws={group.workspaceId}>
              <label className="flex min-w-0 items-center gap-2 pb-1 text-xs font-semibold uppercase tracking-wide text-text-secondary">
                <GroupCheckbox
                  group={group}
                  selected={selected}
                  onToggle={() => toggleGroup(group)}
                  label={t('agents.modal.selectGroup', { name: group.name })}
                />
                <span className="truncate">{group.name}</span>
              </label>
              <ul className="space-y-1">
                {group.rows.map((row) => {
                  const Icon = iconFor(row.provider === 'codex' ? 'openai' : 'claude')
                  return (
                    <li key={row.paneId}>
                      <label
                        data-resume-row={row.paneId}
                        className="flex min-w-0 cursor-pointer items-start gap-2 rounded-btn border border-border bg-bg-secondary/40 px-2.5 py-1.5 hover:border-accent-violet/40"
                      >
                        <input
                          type="checkbox"
                          checked={selected.has(row.paneId)}
                          onChange={() => toggleRow(row.paneId)}
                          className="mt-0.5 h-3.5 w-3.5 shrink-0 accent-[var(--color-accent-violet)]"
                        />
                        <Icon size={14} className="mt-0.5 shrink-0 text-text-secondary" />
                        <span className="flex min-w-0 flex-1 flex-col">
                          <span className="flex min-w-0 items-baseline gap-2">
                            <span className="min-w-0 flex-1 truncate text-sm text-text-primary">{row.title}</span>
                            <span className="shrink-0 text-[11px] text-text-secondary">
                              {t('agents.row.ago', {
                                age: formatAge(now - row.updatedAt),
                              })}
                            </span>
                          </span>
                          <span className="truncate text-xs text-text-secondary">{t(row.stateKey)}</span>
                          {row.lastPrompt && <span className="truncate text-xs text-text-secondary/60">{row.lastPrompt}</span>}
                        </span>
                      </label>
                    </li>
                  )
                })}
              </ul>
            </section>
          ))}
        </div>

        <div className="shrink-0 space-y-2 border-t border-border bg-bg-secondary/40 px-5 py-3">
          {anyWorking && (
            <label className="flex min-w-0 cursor-pointer items-start gap-2 text-xs text-text-primary">
              <input
                type="checkbox"
                checked={nudge}
                onChange={(e) => setNudge(e.target.checked)}
                data-resume-nudge
                className="mt-0.5 h-3.5 w-3.5 shrink-0 accent-[var(--color-accent-violet)]"
              />
              <span className="min-w-0 break-words">
                {t('agents.modal.nudge', {
                  text: agentSettings?.resumeNudgeText?.trim() || t('agents.nudge.default'),
                })}
              </span>
            </label>
          )}
          <label className="flex min-w-0 cursor-pointer items-start gap-2 text-xs text-text-primary">
            <input
              type="checkbox"
              checked={dontAsk}
              onChange={(e) => setDontAsk(e.target.checked)}
              data-resume-dontask
              className="mt-0.5 h-3.5 w-3.5 shrink-0 accent-[var(--color-accent-violet)]"
            />
            <span className="min-w-0 break-words">{t('agents.modal.dontAsk')}</span>
          </label>
          {/* The buttons stay together; the countdown takes the rest of the line or its own. */}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2 pt-1">
            {left !== null && (
              <span className="flex min-w-0 flex-1 basis-40 items-center gap-1 text-xs text-text-secondary" role="timer" aria-live="off" data-resume-countdown>
                <Timer size={12} className="shrink-0" />
                {t('agents.modal.countdown', { time: formatCountdown(left) })}
              </span>
            )}
            <div className="ml-auto flex shrink-0 gap-2">
              <button
                type="button"
                onClick={startFresh}
                data-resume-fresh
                className="rounded-btn border border-border px-4 py-2 text-sm text-text-primary transition-colors hover:bg-card"
              >
                {t('agents.modal.startFresh')}
              </button>
              <button
                type="button"
                autoFocus
                disabled={count === 0}
                onClick={resume}
                aria-keyshortcuts={ariaKeyshortcuts(RESUME_KEYS)}
                data-resume-apply
                className={cn(
                  'inline-flex items-center gap-2 rounded-btn px-4 py-2 text-sm font-medium text-white transition-[filter]',
                  'bg-[linear-gradient(135deg,var(--color-accent-violet),var(--color-accent-blue))] hover:brightness-110 disabled:opacity-50',
                )}
              >
                {t('agents.modal.resume', { count })}
                <KeyHint keys={RESUME_KEYS} tone="onAccent" />
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  )
}
