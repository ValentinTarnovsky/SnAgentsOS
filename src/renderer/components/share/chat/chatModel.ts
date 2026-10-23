/**
 * The read-only Chat of a shared console (app 2.4.0, item 8, S5). Its model
 * (list merges, tool rows and phases, run labels, safe links) is shared with
 * the phone in src/shared/chatRows.ts (app 2.7.0); this file keeps the names
 * the share chat imports and puts its labels under `shareGuest.chat.*`.
 * Links are only offered, always through the guest's ConfirmLinkDialog,
 * never opened from here.
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

/** A system row's text the guest translates (interrupt, skipped record), else null. */
export function systemKey(text: string): 'shareGuest.chat.interrupted' | 'shareGuest.chat.skipped' | null {
  return systemKeyOf(text, 'shareGuest.chat.')
}
