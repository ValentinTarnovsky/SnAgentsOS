/**
 * Consecutive tool calls folded into one row (E3-FR-28): "Read 3 files",
 * "Bash npm test", "Edit App.tsx +12 -3". A call still waiting shows a
 * pulsing dot and an error turns the row red. Tapping expands every call:
 * its output (monospace, the 4KB preview, "Output cut, full output on the
 * PC" when longer) or its numbered diff when the result carries a patch.
 */
import { useEffect, useState, type ReactNode } from 'react'
import { clsx } from 'clsx'
import { ChevronRight, Wrench } from 'lucide-react'
import { runLabel, runStatus, type ToolCall } from '../../lib/chatModel'
import { t, type MobileMessageKey } from '../../lib/i18n'
import { DiffBlock } from './DiffBlock'

const tr = (key: string, vars?: Record<string, string | number>): string => t(key as MobileMessageKey, vars)

function CallDetail({ call }: { call: ToolCall }): ReactNode {
  const r = call.result
  return (
    <div data-tool-call={call.id} className="flex min-w-0 flex-col gap-1">
      {call.name && (
        <div className="min-w-0 truncate font-mono text-[11px] text-text-secondary">
          {call.name}
          {call.summary ? ` ${call.summary}` : ''}
        </div>
      )}
      {r?.patch && r.patch.hunks.length > 0 ? (
        <DiffBlock hunks={r.patch.hunks} filePath={r.patch.filePath} />
      ) : r ? (
        <pre
          data-scrollable
          data-tool-output
          className={clsx(
            'max-h-72 max-w-full overflow-auto whitespace-pre rounded-btn border border-border bg-bg-primary px-2 py-1.5 font-mono text-[11px] leading-[16px]',
            r.isError ? 'text-red-400' : 'text-text-primary',
          )}
        >
          {r.text || t('chat.noOutput')}
        </pre>
      ) : null}
      {r?.truncated && (
        <div data-tool-cut className="text-[11px] text-text-secondary">
          {t('chat.outputCut')}
        </div>
      )}
    </div>
  )
}

export function ToolRunRow({ calls, expandAll }: { calls: ToolCall[]; expandAll: { open: boolean; v: number } }): ReactNode {
  const [open, setOpen] = useState(false)
  useEffect(() => {
    if (expandAll.v > 0) setOpen(expandAll.open)
  }, [expandAll])
  const status = runStatus(calls)
  const label = runLabel(calls, tr)
  return (
    <div data-tool-run data-status={status} className="min-w-0 px-3">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className={clsx(
          'flex min-h-11 w-full min-w-0 items-center gap-2 rounded-btn border px-2.5 py-1.5 text-left text-xs active:bg-card',
          status === 'error' ? 'border-red-500/50 text-red-400' : 'border-border text-text-secondary',
        )}
      >
        <Wrench size={14} className="shrink-0" aria-hidden />
        <span data-tool-label className="min-w-0 flex-1 truncate font-mono">
          {label}
        </span>
        {status === 'pending' && <span data-tool-pending className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-accent-violet motion-reduce:animate-none" />}
        <ChevronRight size={14} className={clsx('shrink-0 transition-transform motion-reduce:transition-none', open && 'rotate-90')} aria-hidden />
      </button>
      {open && (
        <div data-tool-detail className="mt-1.5 flex min-w-0 flex-col gap-2 pl-1">
          {calls.map((c) => (
            <CallDetail key={c.id} call={c} />
          ))}
        </div>
      )}
    </div>
  )
}
