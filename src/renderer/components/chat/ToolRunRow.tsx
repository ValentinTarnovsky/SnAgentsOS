/**
 * Consecutive tool calls folded into one row of a desktop chat (the share
 * guest's, app 2.4.0 item 8 S5; the console chat, app 2.7.0 A7), ported from
 * the phone's ToolRunRow and DiffBlock (src/mobile/src/components/chat):
 * "Read 3 files", "Edit App.tsx +12 -3". A call still waiting shows a pulsing
 * dot, an error turns the row to the error state. A click expands every call:
 * its output preview or its numbered diff, with the +/- prefix kept as text so
 * it reads without color too. `outputCut` names where a cut output is whole
 * (the host, the terminal); the share guest's words by default.
 */
import { useEffect, useState } from 'react'
import { ChevronRight, Layers, Wrench } from 'lucide-react'
import type { ChatPatchHunk } from '@shared/chat-types'
import { toolFamilyKey } from '@shared/toolActivity'
import { useT } from '@/i18n'
import { cn } from '@/lib/cn'
import { phaseCalls, runLabel, runStatus, type ChatPhaseRow, type ToolCall } from './chatModel'

interface Line {
  k: '+' | '-' | ' '
  o: number | null
  n: number | null
  s: string
}

function numberHunk(h: ChatPatchHunk): Line[] {
  let o = h.oldStart
  let n = h.newStart
  return h.lines.map((raw) => {
    const k = raw[0] === '+' || raw[0] === '-' ? raw[0] : ' '
    const s = raw.length && (raw[0] === '+' || raw[0] === '-' || raw[0] === ' ') ? raw.slice(1) : raw
    if (k === '+') return { k, o: null, n: n++, s }
    if (k === '-') return { k, o: o++, n: null, s }
    return { k, o: o++, n: n++, s }
  })
}

const ROW: Record<Line['k'], string> = {
  '+': 'bg-ansi-green/15 text-text-primary',
  '-': 'bg-ansi-red/15 text-text-primary',
  ' ': 'text-text-primary',
}

function PatchBlock({ hunks, filePath }: { hunks: ChatPatchHunk[]; filePath?: string }) {
  return (
    <div data-chat-diff className="min-w-0 max-w-full rounded-btn border border-border bg-bg-primary">
      {filePath && <div className="truncate border-b border-border px-2 py-1 font-mono text-[11px] text-text-secondary">{filePath}</div>}
      <div className="max-w-full overflow-x-auto">
        <table className="w-max min-w-full border-collapse font-mono text-[11px] leading-[16px]">
          <tbody>
            {hunks.map((h, i) => [
              <tr key={`h${i}`} className="text-text-secondary">
                <td colSpan={3} className="px-2 py-0.5">{`@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`}</td>
              </tr>,
              ...numberHunk(h).map((l, j) => (
                <tr key={`${i}.${j}`} data-diff-line={l.k} className={ROW[l.k]}>
                  <td className="select-none px-1 text-right text-text-secondary opacity-70">{l.o ?? ''}</td>
                  <td className="select-none px-1 text-right text-text-secondary opacity-70">{l.n ?? ''}</td>
                  <td className="whitespace-pre pr-2">
                    {l.k}
                    {l.s}
                  </td>
                </tr>
              )),
            ])}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function CallDetail({ call, outputCut }: { call: ToolCall; outputCut?: string }) {
  const t = useT()
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
        <PatchBlock hunks={r.patch.hunks} filePath={r.patch.filePath} />
      ) : r ? (
        <pre
          data-tool-output
          className={cn(
            'max-h-72 max-w-full overflow-auto whitespace-pre rounded-btn border border-border bg-bg-primary px-2 py-1.5 font-mono text-[11px] leading-[16px]',
            r.isError ? 'text-state-error' : 'text-text-primary',
          )}
        >
          {r.text || t('shareGuest.chat.noOutput')}
        </pre>
      ) : null}
      {r?.truncated && (
        <div data-tool-cut className="text-[11px] text-text-secondary">
          {outputCut ?? t('shareGuest.chat.outputCut')}
        </div>
      )}
    </div>
  )
}

export interface ExpandAll {
  open: boolean
  /** Bumped by every expand-all / collapse-all click; 0 = never clicked. */
  v: number
}

export function ToolRunRow({ calls, expandAll, outputCut }: { calls: ToolCall[]; expandAll: ExpandAll; outputCut?: string }) {
  const t = useT()
  const [open, setOpen] = useState(false)
  useEffect(() => {
    if (expandAll.v > 0) setOpen(expandAll.open)
  }, [expandAll])
  const status = runStatus(calls)
  const label = runLabel(calls, t)
  return (
    <div data-tool-run data-status={status} className="min-w-0 px-3">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className={cn(
          'flex min-h-8 w-full min-w-0 items-center gap-2 rounded-btn border px-2.5 py-1 text-left text-xs transition-colors hover:bg-card',
          status === 'error' ? 'border-state-error/50 text-state-error' : 'border-border text-text-secondary',
        )}
      >
        <Wrench size={13} className="shrink-0" aria-hidden />
        <span data-tool-label className="min-w-0 flex-1 truncate font-mono">
          {label}
        </span>
        {status === 'pending' && <span data-tool-pending className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-state-working motion-reduce:animate-none" />}
        <ChevronRight size={13} className={cn('shrink-0 transition-transform motion-reduce:transition-none', open && 'rotate-90')} aria-hidden />
      </button>
      {open && (
        <div data-tool-detail className="mt-1.5 flex min-w-0 flex-col gap-2 pl-1">
          {calls.map((c) => (
            <CallDetail key={c.id} call={c} outputCut={outputCut} />
          ))}
        </div>
      )}
    </div>
  )
}

/**
 * app 2.7.0: tool rows of one family folded into a phase ("Search 3 (a.ts)",
 * src/shared/chatRows.ts). Minimal for now: the family label, the count and
 * the files; a click shows its tool rows, each expandable as usual.
 */
export function ToolPhaseRow({ row, expandAll, outputCut }: { row: ChatPhaseRow; expandAll: ExpandAll; outputCut?: string }) {
  const t = useT()
  const [open, setOpen] = useState(false)
  useEffect(() => {
    if (expandAll.v > 0) setOpen(expandAll.open)
  }, [expandAll])
  const status = runStatus(phaseCalls(row))
  const files = row.files.length ? ` (${row.files.join(', ')})` : ''
  return (
    <div data-tool-phase={row.family} data-status={status} className="min-w-0">
      <div className="px-3">
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
          className="flex min-h-8 w-full min-w-0 items-center gap-2 rounded-btn border border-border px-2.5 py-1 text-left text-xs text-text-secondary transition-colors hover:bg-card"
        >
          <Layers size={13} className="shrink-0" aria-hidden />
          <span data-phase-label className="min-w-0 flex-1 truncate font-mono">
            {`${t(toolFamilyKey(row.family))} ${row.count}${files}`}
          </span>
          {status === 'pending' && <span data-phase-pending className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-state-working motion-reduce:animate-none" />}
          <ChevronRight size={13} className={cn('shrink-0 transition-transform motion-reduce:transition-none', open && 'rotate-90')} aria-hidden />
        </button>
      </div>
      {open && (
        <div data-phase-items className="mt-1.5 flex min-w-0 flex-col gap-1.5 pl-3">
          {row.items.map((r) => (
            <ToolRunRow key={r.id} calls={r.calls} expandAll={expandAll} outputCut={outputCut} />
          ))}
        </div>
      )}
    </div>
  )
}
