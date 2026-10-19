import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import type { WorkspaceTaskState } from '@shared/types'
import { TASK_STATES, WORKSPACE_NOTE_MAX } from '@shared/workspaceNote'
import { useAppStore } from '@/lib/store'
import { useT, type MessageKey } from '@/i18n'
import { cn } from '@/lib/cn'

/** Chip text of each task state (E8-FR-10). */
export const TASK_LABEL_KEY: Record<WorkspaceTaskState, MessageKey> = {
  todo: 'task.todo',
  doing: 'task.doing',
  review: 'task.review',
  done: 'task.done',
}

/** Small text chip right of the workspace name: neutral, amber for review. */
export function TaskStateChip({ state }: { state: WorkspaceTaskState }) {
  const t = useT()
  return (
    <span
      data-task-chip={state}
      className={cn(
        'shrink-0 whitespace-nowrap rounded border px-1 py-px text-[10px] font-medium leading-tight',
        state === 'review' ? 'border-amber-400/30 bg-amber-400/15 text-amber-400' : 'border-border text-text-secondary',
      )}
    >
      {t(TASK_LABEL_KEY[state])}
    </span>
  )
}

const segBtn = (on: boolean): string =>
  cn(
    'whitespace-nowrap rounded-[6px] px-2 py-1 text-xs font-medium transition-colors',
    on ? 'bg-accent-violet text-white' : 'text-text-secondary hover:text-text-primary',
  )

/**
 * "Note and status..." (E8-FR-10): a note input (140 max), the four task
 * states plus "No status", Save and Remove. Anchored at the context menu's
 * point and clamped to the window; Enter saves, Esc or a click outside
 * cancels.
 */
export function WorkspaceNotePopover({ wsId, x, y, onClose }: { wsId: string; x: number; y: number; onClose: () => void }) {
  const t = useT()
  const ws = useAppStore((s) => s.workspaces.find((w) => w.id === wsId))
  const setWorkspaceNote = useAppStore((s) => s.setWorkspaceNote)
  const setWorkspaceTaskState = useAppStore((s) => s.setWorkspaceTaskState)
  const [note, setNote] = useState(ws?.note ?? '')
  const [state, setState] = useState<WorkspaceTaskState | null>(ws?.taskState ?? null)
  const ref = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const [pos, setPos] = useState({ x, y })

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const r = el.getBoundingClientRect()
    const pad = 8
    const nx = x + r.width + pad > window.innerWidth ? window.innerWidth - r.width - pad : x
    const ny = y + r.height + pad > window.innerHeight ? window.innerHeight - r.height - pad : y
    setPos({ x: Math.max(pad, nx), y: Math.max(pad, ny) })
  }, [x, y])

  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [])

  // The workspace was deleted while open.
  useEffect(() => {
    if (!ws) onClose()
  }, [ws, onClose])

  if (!ws) return null

  const save = (): void => {
    setWorkspaceNote(wsId, note)
    setWorkspaceTaskState(wsId, state)
    onClose()
  }
  const clear = (): void => {
    setWorkspaceNote(wsId, null)
    setWorkspaceTaskState(wsId, null)
    onClose()
  }
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      onClose()
    } else if (e.key === 'Enter' && (e.target as HTMLElement).tagName === 'INPUT' && !e.nativeEvent.isComposing) {
      e.preventDefault()
      e.stopPropagation()
      save()
    }
  }

  const options: Array<WorkspaceTaskState | null> = [null, ...TASK_STATES]
  return createPortal(
    <div className="fixed inset-0 z-[60]" onMouseDown={onClose} onContextMenu={(e) => e.preventDefault()}>
      <div
        ref={ref}
        role="dialog"
        aria-label={t('note.title')}
        data-note-popover={wsId}
        style={{ left: pos.x, top: pos.y }}
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
        className="fixed w-[340px] max-w-[calc(100vw-16px)] space-y-3 rounded-card border border-border bg-card p-3 shadow-[0_12px_32px_-12px_rgba(0,0,0,0.7)]"
      >
        <div className="flex items-baseline justify-between gap-2">
          <span className="truncate text-sm font-semibold text-text-primary">{t('note.title')}</span>
          <span className="shrink-0 font-mono text-[10px] text-text-secondary" data-note-count>
            {note.length}/{WORKSPACE_NOTE_MAX}
          </span>
        </div>
        <input
          ref={inputRef}
          data-note-input
          aria-label={t('note.inline')}
          value={note}
          maxLength={WORKSPACE_NOTE_MAX}
          onChange={(e) => setNote(e.target.value)}
          placeholder={t('note.placeholder')}
          className="w-full rounded-btn border border-border bg-bg-primary px-2.5 py-1.5 text-sm text-text-primary outline-none transition-colors focus:border-accent-violet/50 placeholder:text-text-secondary"
        />
        <div role="radiogroup" aria-label={t('note.state')} className="flex flex-wrap gap-1 rounded-btn border border-border bg-bg-primary p-1">
          {options.map((opt) => (
            <button
              key={opt ?? 'none'}
              type="button"
              role="radio"
              aria-checked={state === opt}
              data-note-state={opt ?? 'none'}
              onClick={() => setState(opt)}
              className={segBtn(state === opt)}
            >
              {t(opt ? TASK_LABEL_KEY[opt] : 'task.none')}
            </button>
          ))}
        </div>
        <div className="flex justify-end gap-2">
          <button
            type="button"
            data-note-clear
            onClick={clear}
            className="rounded-btn border border-border px-3 py-1 text-xs text-text-primary transition-colors hover:border-accent-violet/40 hover:bg-bg-secondary"
          >
            {t('note.clear')}
          </button>
          <button
            type="button"
            data-note-save
            onClick={save}
            className="rounded-btn bg-[linear-gradient(135deg,var(--color-accent-violet),var(--color-accent-blue))] px-3 py-1 text-xs font-medium text-white transition-[filter] hover:brightness-110"
          >
            {t('note.save')}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}

/**
 * Inline note editor for the row's second line (E8-FR-10): Enter saves, Esc
 * cancels, leaving the field saves like the rename input.
 */
export function NoteInlineEditor({ initial, onCommit, onCancel }: { initial: string; onCommit: (note: string) => void; onCancel: () => void }) {
  const t = useT()
  const [value, setValue] = useState(initial)
  const done = useRef(false)
  const inputRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [])
  const finish = (save: boolean): void => {
    if (done.current) return
    done.current = true
    if (save) onCommit(value)
    else onCancel()
  }
  return (
    <input
      ref={inputRef}
      data-note-inline
      aria-label={t('note.inline')}
      value={value}
      maxLength={WORKSPACE_NOTE_MAX}
      placeholder={t('note.placeholder')}
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => finish(true)}
      onKeyDown={(e) => {
        if (e.nativeEvent.isComposing) return
        if (e.key === 'Enter') {
          e.preventDefault()
          finish(true)
        } else if (e.key === 'Escape') {
          e.preventDefault()
          e.stopPropagation()
          finish(false)
        }
      }}
      className="mt-0.5 w-full min-w-0 rounded border border-accent-violet/50 bg-bg-primary px-1.5 py-0.5 text-[11px] text-text-primary outline-none placeholder:text-text-secondary"
    />
  )
}
