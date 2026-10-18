/**
 * Tiny module-level handle to the live xterm Terminal so the KeyBar can read
 * cursor-key mode, focus/blur the input, and paste - without threading the
 * imperative Terminal instance through React props/context. RemoteTerminal owns
 * the lifecycle and sets/clears this on mount/unmount.
 */
import type { Terminal } from '@xterm/xterm'

let active: Terminal | null = null

export function setActiveTerm(term: Terminal | null): void {
  active = term
}

export function getActiveTerm(): Terminal | null {
  return active
}

// --- composer (E1-FR-29, FR-31) ---

let composerPasting = false

/**
 * Run a composer paste through xterm. In Composer mode RemoteTerminal drops
 * xterm's own input (the helper textarea is readOnly, but a hardware keyboard
 * still produces keydown data); data emitted inside this call is let through.
 */
export function withComposerPaste(fn: () => void): void {
  composerPasting = true
  try {
    fn()
  } finally {
    composerPasting = false
  }
}

export function isComposerPasting(): boolean {
  return composerPasting
}

/** The mounted composer, so SnippetsSheet can insert at its caret. */
export interface ComposerHandle {
  insert(text: string): void
  focus(): void
}

let composerHandle: ComposerHandle | null = null

export function setComposerHandle(handle: ComposerHandle | null): void {
  composerHandle = handle
}

export function getComposerHandle(): ComposerHandle | null {
  return composerHandle
}
