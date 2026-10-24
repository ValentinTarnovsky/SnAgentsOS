/**
 * The model of the desktop's chat views (app 2.7.0): the share guest's
 * read-only Chat (app 2.4.0, item 8, S5) and the console chat (A7). Its list
 * merges, tool rows and phases, run labels and safe links are shared with the
 * phone in src/shared/chatRows.ts; this file keeps the names the chat rows
 * import and words their labels with the share guest's keys
 * (`shareGuest.chat.*`), which both desktop views use: the same words, and
 * src/shared/chatRows.ts knows that namespace. What only one view says
 * (where older messages or a cut output live) comes from the view.
 */
import type { MessageKey } from '@/i18n'
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

type Translate = (key: MessageKey, vars?: Record<string, string | number>) => string

/** The one line of a tool row: "Read 3 files", "Bash npm test", "Edit App.tsx +12 -3". */
export function runLabel(calls: readonly ToolCall[], t: Translate): string {
  const label = runLabelOf(calls, 'shareGuest.chat.')
  return 'text' in label ? label.text : t(label.key, label.vars)
}

/** A system row's text the view translates (interrupt, skipped record), else null. */
export function systemKey(text: string): 'shareGuest.chat.interrupted' | 'shareGuest.chat.skipped' | null {
  return systemKeyOf(text, 'shareGuest.chat.')
}
