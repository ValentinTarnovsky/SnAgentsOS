/**
 * The phone's Chat view model (E3-FR-26..30). The rules (list merges, tool
 * rows and phases, run labels, which links may open) live in
 * src/shared/chatRows.ts since app 2.7.0, shared with the share guest's
 * Chat; this file keeps the names the phone imports and puts its labels
 * under `chat.*`.
 */
import { runLabelOf, systemKeyOf, type ToolCall } from '@shared/chatRows'

export {
  CHAT_MEMORY_MAX,
  EMPTY_LIST,
  appendList,
  buildRows,
  messageText,
  needsFold,
  patchCounts,
  phaseCalls,
  prependList,
  replaceList,
  runStatus,
  safeHref,
  USER_FOLD_LINES,
} from '@shared/chatRows'
export type { ChatList, ChatPageIn, ChatPhaseRow, ChatRow, ChatToolsRow, ToolCall, ToolResultBlock } from '@shared/chatRows'

type Translate = (key: string, vars?: Record<string, string | number>) => string

/**
 * The one line of a tool row (FR-28): "Read 3 files", "Bash npm test",
 * "Edit App.tsx +12 -3", "4 tools: Read, Edit, Bash".
 */
export function runLabel(calls: readonly ToolCall[], t: Translate): string {
  const label = runLabelOf(calls, 'chat.')
  return 'text' in label ? label.text : t(label.key, label.vars)
}

/** A system row's text the phone translates (interrupt, skipped record), else null. */
export function systemKey(text: string): 'chat.interrupted' | 'chat.skipped' | null {
  return systemKeyOf(text, 'chat.')
}
