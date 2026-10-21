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
 *  - plan (ExitPlanMode): the Plan card (E2-FR-54). Its buttons need
 *    Claude's menu validated on screen (promptMenu.ts); until then, or with
 *    a layout the phone does not know, the card shows as the generic strip;
 *  - elicitation and every other tool: no card (the generic "waiting for
 *    your answer" strip covers them, E2-FR-25).
 *
 * Cards are for Claude only (`status.provider`, not the pane type: a shell
 * where `claude` was started by hand gets hooks too) and only while the
 * phone's promptCards preference is on. The tool list follows the one Orca
 * keeps for its interactive tools (idea only, no code copied).
 */
import type { RemotePaneStatus, RemotePending } from '@shared/remote-protocol'
import { askQuestionsValid, type AskQuestion } from '@shared/askAnswerKeys'
import { selectCardRequest } from '@shared/promptTarget'

// The request rules live in src/shared/promptTarget.ts (main's PromptMenuWatcher uses them too).
export { SIMPLE_PERMISSION_TOOLS, isSimplePermissionTool } from '@shared/promptTarget'

export type PromptCardModel =
  | { kind: 'permission'; pending: RemotePending; generic: boolean }
  /** `questions` is null when the phone cannot answer them ("Answer in the terminal"). */
  | { kind: 'question'; pending: RemotePending; questions: AskQuestion[] | null }
  /** ExitPlanMode (E2-FR-54): the buttons come from the menu read off the screen. */
  | { kind: 'plan'; pending: RemotePending }

/** The card for this pane status, or undefined (E2-FR-17, 18). */
export function cardFor(status: RemotePaneStatus | undefined, enabled: boolean): PromptCardModel | undefined {
  if (!enabled || !status || status.provider !== 'claude' || !status.pending?.length) return undefined
  const pick = selectCardRequest(status.pending)
  if (!pick) return undefined
  const pending = pick.pending
  if (pending.kind === 'permission') return { kind: 'permission', pending, generic: pick.generic }
  if (pending.kind === 'question') return { kind: 'question', pending, questions: askQuestionsValid(pending.questions) ? pending.questions : null }
  return { kind: 'plan', pending }
}

/**
 * E2-FR-25: the pane waits on the user but there is no card to show. A plan
 * card whose menu did not validate on screen (`menuOk` false) counts as no
 * card, so the strip is the fallback when Claude changes its layout. v2.3:
 * never once the desktop says the request was answered (attention false).
 */
export function needsGenericStrip(status: RemotePaneStatus | undefined, card: PromptCardModel | undefined, menuOk = true): boolean {
  return !!status && status.state === 'action' && status.attention !== false && (!card || (card.kind === 'plan' && !menuOk))
}
