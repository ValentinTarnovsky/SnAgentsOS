/**
 * Which pending request of a Claude pane gets the answer card (E2-FR-17, 18).
 * Shared by the phone's cardFor (src/mobile/src/lib/promptRules.ts) and
 * main's PromptMenuWatcher.menuTarget, so the menu main reads off the screen
 * is always for the request the phone's card shows. Pure: no Node, no DOM.
 *
 *  - permission with a toolName in SIMPLE_PERMISSION_TOOLS (or an mcp__ tool);
 *  - permission without toolName, unless the pane also waits on a plan, a
 *    question or an elicitation;
 *  - question; plan (ExitPlanMode);
 *  - everything else (elicitation, other tools) makes no card and is skipped.
 * The first request in pending[] order that makes a card wins.
 */

/** Tools whose permission prompt is a plain "1. Yes / Esc No" menu. */
export const SIMPLE_PERMISSION_TOOLS: readonly string[] = [
  'Bash',
  'PowerShell',
  'Edit',
  'MultiEdit',
  'Write',
  'NotebookEdit',
  'Read',
  'Glob',
  'Grep',
  'WebFetch',
  'WebSearch',
]

export function isSimplePermissionTool(toolName: string | undefined): boolean {
  return !!toolName && (SIMPLE_PERMISSION_TOOLS.includes(toolName) || toolName.startsWith('mcp__'))
}

/** The request that gets the card, or null; `generic` = a permission with no toolName. */
export function selectCardRequest<P extends { kind: string; toolName?: string }>(pending: readonly P[] | undefined): { pending: P; generic: boolean } | null {
  if (!pending?.length) return null
  const blocking = pending.some((p) => p.kind === 'plan' || p.kind === 'question' || p.kind === 'elicitation')
  for (const p of pending) {
    if (p.kind === 'permission') {
      if (p.toolName) {
        if (isSimplePermissionTool(p.toolName)) return { pending: p, generic: false }
      } else if (!blocking) {
        return { pending: p, generic: true }
      }
    } else if (p.kind === 'question' || p.kind === 'plan') {
      return { pending: p, generic: false }
    }
  }
  return null
}
