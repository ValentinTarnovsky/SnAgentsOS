/**
 * A tool result's patch as a numbered red/green diff (E3-FR-28): one header
 * per hunk, old and new line numbers, and the +/- prefix kept as text so the
 * change reads without color too (NFR). Long lines scroll sideways inside the
 * block, never the page.
 */
import type { ReactNode } from 'react'
import type { ChatPatchHunk } from '@shared/chat-types'

interface Line {
  k: '+' | '-' | ' '
  o: number | null
  n: number | null
  s: string
}

/** Numbered lines of one hunk. */
export function numberHunk(h: ChatPatchHunk): Line[] {
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
  // A tint behind the theme's own text color keeps AA contrast on every theme.
  '+': 'bg-green-500/20 text-text-primary',
  '-': 'bg-red-500/20 text-text-primary',
  ' ': 'text-text-primary',
}

export function DiffBlock({ hunks, filePath }: { hunks: ChatPatchHunk[]; filePath?: string }): ReactNode {
  return (
    <div data-chat-diff className="min-w-0 max-w-full rounded-btn border border-border bg-bg-primary">
      {filePath && <div className="truncate border-b border-border px-2 py-1 font-mono text-[11px] text-text-secondary">{filePath}</div>}
      <div data-scrollable className="max-w-full overflow-x-auto">
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
