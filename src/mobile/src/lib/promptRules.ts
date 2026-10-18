/**
 * Which answer card the phone shows for a pane (E2-FR-17, 18). The phone
 * derives nothing from the raw tool input: it reads RemotePaneStatus.pending[]
 * as main built it (E4) and picks the first request that makes a card.
 *
 *  - permission with a toolName in SIMPLE_PERMISSION_TOOLS (or an mcp__ tool):
 *    the Allow / Deny card;
 *  - permission without toolName (it came only from a permission_prompt
 *    Notification): the generic card, unless the pane also waits on a plan,
 *    a question or an elicitation (so an ExitPlanMode menu never gets "Allow");
 *  - question: the AskUserQuestion wizard when the questions pass the phone's
 *    limits, else the card only says "Answer in the terminal";
 *  - plan (ExitPlanMode), elicitation and every other tool: no card (the
 *    generic "waiting for your answer" strip covers them, E2-FR-25).
 *
 * Cards are for Claude only (`status.provider`, not the pane type: a shell
 * where `claude` was started by hand gets hooks too) and only while the
 * phone's promptCards preference is on. The tool list follows the one Orca
 * keeps for its interactive tools (idea only, no code copied).
 */
import type { RemotePaneStatus, RemotePending } from '@shared/remote-protocol'
import { askQuestionsValid, type AskQuestion } from '@shared/askAnswerKeys'

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

export type PromptCardModel =
  | { kind: 'permission'; pending: RemotePending; generic: boolean }
  /** `questions` is null when the phone cannot answer them ("Answer in the terminal"). */
  | { kind: 'question'; pending: RemotePending; questions: AskQuestion[] | null }

/** The card for this pane status, or undefined (E2-FR-17, 18). */
export function cardFor(status: RemotePaneStatus | undefined, enabled: boolean): PromptCardModel | undefined {
  if (!enabled || !status || status.provider !== 'claude' || !status.pending?.length) return undefined
  const blocking = status.pending.some((p) => p.kind === 'plan' || p.kind === 'question' || p.kind === 'elicitation')
  for (const pending of status.pending) {
    if (pending.kind === 'permission') {
      if (pending.toolName) {
        if (isSimplePermissionTool(pending.toolName)) return { kind: 'permission', pending, generic: false }
      } else if (!blocking) {
        return { kind: 'permission', pending, generic: true }
      }
    } else if (pending.kind === 'question') {
      return { kind: 'question', pending, questions: askQuestionsValid(pending.questions) ? pending.questions : null }
    }
  }
  return undefined
}

/** E2-FR-25: the pane waits on the user but there is no card to show. */
export function needsGenericStrip(status: RemotePaneStatus | undefined, card: PromptCardModel | undefined): boolean {
  return !!status && status.state === 'action' && !card
}
