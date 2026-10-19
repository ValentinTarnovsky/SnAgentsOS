/**
 * Per-pane prompt mark actions (E6-FR-27/29), registered by useXterm on mount
 * so the global keymap and the pane menu can reach a pane's terminal without
 * its controller. Every call is a no-op for a pane without marks.
 */
export interface ShellMarksApi {
  /** Scroll the previous (-1) or next (1) prompt to the first row. */
  prompt: (dir: -1 | 1) => boolean
  /** Copy the newest finished command's output; false when there is none. */
  copyLastOutput: () => boolean
  /** Whether a finished command (C and D) exists. */
  hasLastOutput: () => boolean
}

const apis = new Map<string, ShellMarksApi>()

export function registerShellMarks(paneId: string, api: ShellMarksApi): void {
  apis.set(paneId, api)
}

/** Drops the pane's entry, only if it is still `api` (a remount may have replaced it). */
export function unregisterShellMarks(paneId: string, api: ShellMarksApi): void {
  if (apis.get(paneId) === api) apis.delete(paneId)
}

export function promptNav(paneId: string, dir: -1 | 1): boolean {
  return apis.get(paneId)?.prompt(dir) ?? false
}

export function copyLastOutput(paneId: string): boolean {
  return apis.get(paneId)?.copyLastOutput() ?? false
}

export function hasLastOutput(paneId: string): boolean {
  return apis.get(paneId)?.hasLastOutput() ?? false
}
