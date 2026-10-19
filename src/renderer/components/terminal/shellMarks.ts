import type { IBuffer, IDecoration, IDisposable, IMarker, Terminal } from '@xterm/xterm'

/**
 * OSC 133 prompt marks in the desktop terminal (E6-FR-26..29). The PowerShell
 * integration (src/main/pty/powershellIntegration.ts) writes A before each
 * prompt, B after it, C when a command starts and D;<code> when it ends.
 * Detection is passive: without marks (integration off, ConstrainedLanguage,
 * a ConPTY that eats them, any other shell) every feature here stays inert.
 * Markers never travel in the headless snapshot: after a reattach they come
 * back with the next prompts.
 */

/** Commands kept per pane; the oldest go first (E6-FR-26). */
export const MAX_COMMANDS = 1000
/** "Copy last command output" keeps at most this many UTF-8 bytes (E6-FR-29). */
export const MAX_COPY_BYTES = 1024 * 1024
/** Red bar and overview ruler tick of a command that failed (E6-FR-28). */
export const EXIT_COLOR = '#ef4444'
/** Width the overview ruler gets once the first failure is drawn. */
const RULER_WIDTH = 8

/** A buffer position: the marker's line plus the cursor column when the mark arrived. */
export interface MarkPos {
  marker: IMarker
  x: number
}

export interface ShellCommand {
  /** Line of the prompt (A). */
  prompt: IMarker
  /** Where the command's output starts (C). */
  start?: MarkPos
  /** Where it ends (D), with the exit code. */
  end?: MarkPos
  exitCode?: number
  decoration?: IDecoration
}

export interface ShellMarksOptions {
  /** Tooltip of the red bar ("Exited with code N"). */
  exitTitle: (code: number) => string
  /** Every recorded prompt mark (A), for the agent-end readiness (E6-FR-22). */
  onPrompt?: () => void
}

/**
 * The prompt line a jump lands on, or null when there is none: the closest
 * prompt above the viewport's first row (dir -1), or below it (dir 1, capped at
 * the live bottom). The caller scrolls it to the first row (E6-FR-27).
 */
export function navTarget(lines: readonly number[], viewportY: number, baseY: number, dir: -1 | 1): number | null {
  let best: number | null = null
  for (const line of lines) {
    if (line < 0) continue
    if (dir < 0 ? line < viewportY && (best === null || line > best) : line > viewportY && (best === null || line < best)) best = line
  }
  if (best === null) return null
  return dir > 0 ? Math.min(best, baseY) : best
}

/**
 * The text between two buffer positions, wrapped rows joined, every line
 * right-trimmed, blank lines at both ends dropped, at most `maxBytes` UTF-8
 * bytes (cut at a character boundary).
 */
export function extractRange(buffer: IBuffer, start: { line: number; x: number }, end: { line: number; x: number }, maxBytes = MAX_COPY_BYTES): string {
  if (start.line < 0 || end.line < start.line || (end.line === start.line && end.x <= start.x)) return ''
  const parts: string[] = []
  let size = 0
  for (let y = start.line; y <= end.line; y++) {
    const line = buffer.getLine(y)
    if (!line) break
    const from = y === start.line ? start.x : 0
    const to = y === end.line ? end.x : undefined
    const text = line.translateToString(to === undefined, from, to)
    // A soft-wrapped row continues the previous one: no line break between them.
    if (y > start.line && !line.isWrapped) parts.push('\n')
    parts.push(text)
    size += text.length + 1
    // Enough raw text for the byte cap even if every char is 1 byte (plus slack for trimming).
    if (size > maxBytes * 2) break
  }
  const lines = parts.join('').split('\n').map((l) => l.replace(/\s+$/, ''))
  let a = 0
  let b = lines.length
  while (a < b && lines[a] === '') a++
  while (b > a && lines[b - 1] === '') b--
  return capBytes(lines.slice(a, b).join('\n'), maxBytes)
}

/** `text` cut to `maxBytes` UTF-8 bytes without splitting a character. */
export function capBytes(text: string, maxBytes: number): string {
  const bytes = new TextEncoder().encode(text)
  if (bytes.length <= maxBytes) return text
  return new TextDecoder().decode(bytes.subarray(0, maxBytes)).replace(/�+$/, '')
}

/** Mark parser + command records of one terminal. */
export class ShellMarks implements IDisposable {
  readonly commands: ShellCommand[] = []
  private readonly osc: IDisposable

  constructor(
    private readonly term: Terminal,
    private readonly opts: ShellMarksOptions,
  ) {
    this.osc = term.parser.registerOscHandler(133, (data) => this.handle(data))
  }

  /** One OSC 133 payload ("A", "B", "C", "D;1", extra `;k=v` ignored). Always consumed. */
  handle(data: string): boolean {
    // Shell prompts live in the normal buffer; a mark inside a TUI is noise.
    if (this.term.buffer.active.type !== 'normal') return true
    const [kind, arg] = data.split(';')
    switch (kind) {
      case 'A':
        this.onPrompt()
        break
      case 'C': {
        const cmd = this.commands.at(-1)
        if (cmd && !cmd.start) cmd.start = this.here()
        break
      }
      case 'D': {
        const cmd = this.commands.at(-1)
        if (!cmd || cmd.end) break
        cmd.end = this.here()
        const code = arg !== undefined && /^-?\d+$/.test(arg) ? Number(arg) : undefined
        if (code !== undefined) {
          cmd.exitCode = code
          if (code !== 0) this.decorate(cmd, code)
        }
        break
      }
      default:
        // B (prompt end) and anything else: nothing to record.
        break
    }
    return true
  }

  /** Live prompt lines (oldest first); markers trimmed out of the scrollback are skipped. */
  promptLines(): number[] {
    const out: number[] = []
    for (const c of this.commands) if (!c.prompt.isDisposed && c.prompt.line >= 0) out.push(c.prompt.line)
    return out
  }

  /** Scrolls the previous/next prompt to the first row (E6-FR-27); false when there is none. */
  navigate(dir: -1 | 1): boolean {
    const buf = this.term.buffer.active
    if (buf.type !== 'normal') return false
    const line = navTarget(this.promptLines(), buf.viewportY, buf.baseY, dir)
    if (line === null) return false
    this.term.scrollToLine(line)
    return true
  }

  /** The newest command with both C and D whose markers are still in the buffer. */
  private lastComplete(): ShellCommand | null {
    for (let i = this.commands.length - 1; i >= 0; i--) {
      const c = this.commands[i]
      if (!c.start || !c.end) continue
      if (c.start.marker.isDisposed || c.end.marker.isDisposed || c.start.marker.line < 0) continue
      return c
    }
    return null
  }

  /** Whether "Copy last command output" has something to copy (E6-FR-29). */
  hasLastOutput(): boolean {
    return this.lastComplete() !== null
  }

  /** The output of the newest finished command, trimmed and capped, or null. */
  lastOutput(): string | null {
    const c = this.lastComplete()
    if (!c?.start || !c.end) return null
    return extractRange(
      this.term.buffer.normal,
      { line: c.start.marker.line, x: c.start.x },
      { line: c.end.marker.line, x: c.end.x },
    )
  }

  dispose(): void {
    this.osc.dispose()
    for (const c of this.commands.splice(0)) disposeCommand(c)
  }

  private here(): MarkPos {
    return { marker: this.term.registerMarker(0), x: this.term.buffer.active.cursorX }
  }

  private onPrompt(): void {
    this.commands.push({ prompt: this.term.registerMarker(0) })
    while (this.commands.length > MAX_COMMANDS) {
      const old = this.commands.shift()
      if (old) disposeCommand(old)
    }
    this.opts.onPrompt?.()
  }

  /** 2 px red bar left of the prompt line, with a title, and a red ruler tick (E6-FR-28). */
  private decorate(cmd: ShellCommand, code: number): void {
    if (cmd.prompt.isDisposed) return
    try {
      if (!this.term.options.overviewRulerWidth) this.term.options.overviewRulerWidth = RULER_WIDTH
      const deco = this.term.registerDecoration({
        marker: cmd.prompt,
        x: 0,
        width: 1,
        overviewRulerOptions: { color: EXIT_COLOR, position: 'left' },
      })
      if (!deco) return
      cmd.decoration = deco
      const title = this.opts.exitTitle(code)
      deco.onRender((el) => {
        el.classList.add('snaos-exit-bar')
        el.dataset.exitCode = String(code)
        el.title = title
        el.style.width = '2px'
        el.style.backgroundColor = EXIT_COLOR
      })
    } catch {
      /* decorations unavailable: the code is still recorded */
    }
  }
}

function disposeCommand(c: ShellCommand): void {
  for (const d of [c.decoration, c.prompt, c.start?.marker, c.end?.marker]) {
    try {
      d?.dispose()
    } catch {
      /* already gone */
    }
  }
}
