/**
 * In-memory ring of main's last warn/error lines (E4-FR-24). main writes no
 * general log to disk, so "Copy diagnostics" reads this instead. Wrapping
 * keeps the original console behavior; the ring only remembers a copy.
 */
export const LOG_RING_MAX = 200
const LINE_MAX = 1000

const lines: string[] = []
let installed = false

function fmt(arg: unknown): string {
  // Duck-typed: an Error from another realm (vm, worker) is still an error.
  if (arg && typeof arg === 'object' && typeof (arg as Error).message === 'string' && 'stack' in arg) {
    const e = arg as Error
    return e.stack ?? `${e.name}: ${e.message}`
  }
  if (typeof arg === 'string') return arg
  try {
    return JSON.stringify(arg) ?? String(arg)
  } catch {
    return String(arg)
  }
}

/** Remember one line (exported for tests and for main's own notes). */
export function pushLogLine(level: 'warn' | 'error', args: unknown[], now = Date.now()): void {
  const text = args.map(fmt).join(' ').replace(/\s+$/, '')
  lines.push(`${new Date(now).toISOString()} ${level.toUpperCase()} ${text.slice(0, LINE_MAX)}`)
  if (lines.length > LOG_RING_MAX) lines.splice(0, lines.length - LOG_RING_MAX)
}

/** Wrap console.warn / console.error once. */
export function installLogRing(target: Pick<Console, 'warn' | 'error'> = console): void {
  if (installed) return
  installed = true
  for (const level of ['warn', 'error'] as const) {
    const original = target[level].bind(target)
    target[level] = (...args: unknown[]) => {
      try {
        pushLogLine(level, args)
      } catch {
        /* never break logging */
      }
      original(...args)
    }
  }
}

/** The newest `n` lines, oldest first. */
export function recentLogLines(n = 100): string[] {
  return lines.slice(-n)
}
