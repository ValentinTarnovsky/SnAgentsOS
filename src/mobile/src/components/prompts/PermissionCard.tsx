/**
 * Permission card (E2-FR-19) over the composer and the KeyBar: "Claude wants
 * to use <tool>", the request summary in mono (3 lines, a tap expands it),
 * [Allow] ("1") and [Deny] (Esc), never followed by Enter. A permission that
 * came only from a Notification has no tool: "Claude asks for a permission",
 * no summary.
 *
 * "Always allow" (E2-FR-53) sends "2", also without Enter, and shows only
 * when Claude's menu on screen matches the layout the phone knows ("1. Yes",
 * "2. Yes, <scope>", "3. No"); the button repeats Claude's own scope text so
 * the user sees what "always" covers. The menu is read again at tap time and
 * a change cancels the tap. Without a validated menu the card keeps the hint
 * that "always allow" stays in the terminal.
 *
 * app 2.4.0, Chat view: "Always allow" comes from main's read of the screen
 * (RemotePaneStatus.menu) and goes out as ctl answerMenu, checked against
 * the screen again in main; Allow and Deny stay plain `input` keys. The card
 * is at most 45% of the visible height there and scrolls inside.
 */
import { useState, type ReactNode } from 'react'
import { clsx } from 'clsx'
import { ChevronDown, ShieldQuestion } from 'lucide-react'
import type { PromptCardModel } from '../../lib/promptRules'
import { alwaysOption, sameOption, type MenuOption } from '../../lib/promptMenu'
import { answerCard, answerMenu } from '../../lib/answerLive'
import { selectInChat, store, useRemoteStore } from '../../lib/store'
import { t } from '../../lib/i18n'
import { readCurrentMenu } from './usePromptMenu'

/** app 2.4.0: an answer card in the Chat view takes at most 45% of the visible height. */
export const CHAT_CARD_MAX_HEIGHT = 'calc(var(--vvh, 100dvh) * 0.45)'

type PermissionModel = Extract<PromptCardModel, { kind: 'permission' }>

export function permissionTitle(card: PermissionModel): string {
  return card.generic ? t('prompt.permGeneric') : t('prompt.permTitle', { tool: card.pending.toolName ?? '' })
}

/** The request summary in mono: 3 lines, a tap shows it all. */
export function RequestSummary({ text }: { text: string }): ReactNode {
  const [expanded, setExpanded] = useState(false)
  return (
    <button
      type="button"
      data-prompt-summary
      data-expanded={expanded}
      onClick={() => setExpanded((v) => !v)}
      aria-expanded={expanded}
      aria-label={expanded ? undefined : `${text} - ${t('prompt.summaryExpand')}`}
      className="mt-1.5 block w-full rounded-btn bg-bg-primary px-2 py-1.5 text-left font-mono text-[12px] leading-snug text-text-primary"
    >
      <span data-prompt-summary-text className={clsx('whitespace-pre-wrap break-all', expanded ? 'block' : 'line-clamp-3')}>
        {text}
      </span>
    </button>
  )
}

/** Card header: icon, title and the fold chevron. */
export function CardHeader({ icon, title, onFold }: { icon: ReactNode; title: string; onFold: () => void }): ReactNode {
  return (
    <div className="flex items-start gap-2">
      {icon}
      <span data-prompt-title className="min-w-0 flex-1 break-words text-sm font-semibold leading-snug text-text-primary">
        {title}
      </span>
      <button
        type="button"
        data-prompt-fold
        onClick={onFold}
        aria-label={t('prompt.fold')}
        className="-my-1.5 -mr-1.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-btn text-text-secondary active:bg-card"
      >
        <ChevronDown size={18} />
      </button>
    </div>
  )
}

/** The menu changed between the read and the tap: nothing is sent. */
export function menuChanged(): void {
  store.getState().setToast(t('prompt.menuChanged'))
}

export function PermissionCard({
  paneId,
  card,
  always,
  onFold,
}: {
  paneId: string
  card: PermissionModel
  /** Option 2 of the validated menu on screen, or null (E2-FR-53). */
  always: MenuOption | null
  onFold: () => void
}): ReactNode {
  const inChat = useRemoteStore(selectInChat)
  const summary = card.generic ? '' : card.pending.summary
  const onAlways = (): void => {
    const read = readCurrentMenu(paneId, card.pending.id)
    const fresh = alwaysOption(read?.menu ?? null)
    if (!read || !always || !fresh || !sameOption([fresh], always)) {
      menuChanged()
      return
    }
    if (read.source === 'status') answerMenu(paneId, card.pending.id, { n: fresh.n, label: fresh.label })
    else answerCard(paneId, card.pending.id, { kind: 'always' })
  }
  return (
    <div
      data-prompt-card="permission"
      data-pending={card.pending.id}
      data-chat-card={inChat || undefined}
      role="group"
      aria-label={permissionTitle(card)}
      className={clsx('shrink-0 border-t border-state-action/40 bg-bg-secondary px-3 pb-2 pt-2.5', inChat && 'overflow-y-auto overscroll-contain')}
      style={inChat ? { maxHeight: CHAT_CARD_MAX_HEIGHT } : undefined}
    >
      <CardHeader icon={<ShieldQuestion size={16} className="mt-0.5 shrink-0 text-state-action" />} title={permissionTitle(card)} onFold={onFold} />
      {summary && <RequestSummary text={summary} />}
      <div className="mt-2 flex gap-2">
        <button
          type="button"
          data-prompt-deny
          onClick={() => answerCard(paneId, card.pending.id, { kind: 'deny' })}
          className="h-11 flex-1 rounded-btn border border-border text-sm font-medium text-text-primary active:bg-card"
        >
          {t('prompt.deny')}
        </button>
        <button
          type="button"
          data-prompt-allow
          onClick={() => answerCard(paneId, card.pending.id, { kind: 'allow' })}
          className="h-11 flex-1 rounded-btn bg-accent-violet text-sm font-semibold text-white active:brightness-110"
        >
          {t('prompt.allow')}
        </button>
      </div>
      {always ? (
        <button
          type="button"
          data-prompt-always
          onClick={onAlways}
          className="mt-1.5 block min-h-11 w-full rounded-btn border border-border px-3 py-1.5 text-left active:bg-card"
        >
          <span className="block text-sm font-medium text-text-primary">{t('prompt.always')}</span>
          <span data-prompt-always-scope className="mt-0.5 line-clamp-2 break-words font-mono text-[11px] leading-snug text-text-secondary">
            {always.label}
          </span>
        </button>
      ) : (
        <p data-prompt-always-hint className="mt-1.5 text-[11px] leading-tight text-text-secondary">{t('prompt.alwaysHint')}</p>
      )}
    </div>
  )
}
