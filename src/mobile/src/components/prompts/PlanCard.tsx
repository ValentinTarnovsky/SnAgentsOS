/**
 * Plan card (E2-FR-54) for an ExitPlanMode request: "Claude has a plan
 * ready", the first line of the plan in mono (3 lines, a tap expands it), a
 * pointer to the full plan in the terminal, and one button per option of
 * Claude's menu as the screen shows it. PromptCard only renders this card
 * once planOptions validated that menu; any other layout stays the generic
 * strip.
 *
 *  - An approval or a rejection ("No, keep planning") sends its digit, one
 *    group, no Enter. The first approval is the primary button.
 *  - The free text row ("Type here to tell Claude what to change") also
 *    sends its digit, so Claude's cursor leaves the first approval, and then
 *    brings the keyboard up where the user types the feedback. Without the
 *    digit, the composer's Send ends in an Enter that would pick option 1
 *    and approve the plan the user wanted to change.
 *  - Known labels are translated; an approval the phone does not know keeps
 *    Claude's text. The menu is read again at tap time and a change cancels
 *    the tap.
 *  - app 2.4.0, Chat view: the options come from main's read of the screen
 *    (RemotePaneStatus.menu) and a tap sends ctl answerMenu, which main
 *    checks against the screen again before it writes the digit. There the
 *    free text row focuses the composer. In Chat the card is at most 45% of
 *    the visible height and scrolls inside.
 *  - app 2.7.0 (A8): while live with a desktop >= 2.7.0, "View full plan"
 *    takes the place of the pointer to the terminal and opens PlanSheet
 *    (planReq). It only reads: nothing is answered from there.
 */
import { useState, type ReactNode } from 'react'
import { clsx } from 'clsx'
import { ClipboardList, FileText } from 'lucide-react'
import { APP_2_7_0, appVersionAtLeast } from '@shared/agentTune'
import type { PromptCardModel } from '../../lib/promptRules'
import { planOptions, sameOption, type PlanOption } from '../../lib/promptMenu'
import { answerCard, answerMenu } from '../../lib/answerLive'
import { t, type MobileMessageKey } from '../../lib/i18n'
import { selectInChat, useRemoteStore } from '../../lib/store'
import { CHAT_CARD_MAX_HEIGHT, CardHeader, RequestSummary, menuChanged } from './PermissionCard'
import { openTerminalKeyboard } from './PromptStrip'
import { readCurrentMenu } from './usePromptMenu'
import { PlanSheet } from './PlanSheet'

type PlanModel = Extract<PromptCardModel, { kind: 'plan' }>

/** Claude's plan menu labels the phone translates (lower case, key hint dropped). */
const KNOWN_LABELS: Record<string, MobileMessageKey> = {
  'yes, and auto-accept edits': 'prompt.planAutoAccept',
  'yes, auto-accept edits': 'prompt.planAutoAccept',
  'yes, and manually approve edits': 'prompt.planManual',
  'yes, manually approve edits': 'prompt.planManual',
  'yes, clear context and auto-accept edits': 'prompt.planClearAuto',
  'yes, and bypass permissions': 'prompt.planBypass',
  'yes, bypass permissions': 'prompt.planBypass',
  'no, keep planning': 'prompt.planKeep',
  'yes, and use auto mode': 'prompt.planAutoMode',
  'yes, use auto mode': 'prompt.planAutoMode',
}

export function planLabel(option: PlanOption): string {
  if (option.cls === 'feedback') return t('prompt.planFeedback')
  const key = KNOWN_LABELS[option.label.toLowerCase().replace(/[.\s]+$/, '')]
  return key ? t(key) : option.label
}

export function PlanCard({
  paneId,
  card,
  options,
  onFold,
}: {
  paneId: string
  card: PlanModel
  /** The validated menu on screen (planOptions). */
  options: PlanOption[]
  onFold: () => void
}): ReactNode {
  const inChat = useRemoteStore(selectInChat)
  // planReq is a 2.7.0 frame (an older desktop strikes it) and needs the socket.
  const canRead = useRemoteStore((s) => s.phase === 'live' && s.connected && appVersionAtLeast(s.appVersion, APP_2_7_0))
  const [planOpen, setPlanOpen] = useState(false)
  const firstApprove = options.find((o) => o.cls === 'approve')?.n
  const pick = (option: PlanOption): void => {
    const read = readCurrentMenu(paneId, card.pending.id)
    if (!read || !sameOption(planOptions(read.menu), option)) {
      menuChanged()
      return
    }
    // Main's read (Chat): main checks the screen again and writes the digit.
    const sent =
      read.source === 'status'
        ? answerMenu(paneId, card.pending.id, { n: option.n, label: option.label })
        : answerCard(paneId, card.pending.id, { kind: 'menu', option: option.n })
    // Same tap (the gesture iOS needs for the keyboard), only once the digit went out.
    if (option.cls === 'feedback' && sent === 'started') openTerminalKeyboard()
  }
  return (
    <div
      data-prompt-card="plan"
      data-pending={card.pending.id}
      data-chat-card={inChat || undefined}
      role="group"
      aria-label={t('prompt.planTitle')}
      className={clsx('shrink-0 border-t border-state-action/40 bg-bg-secondary px-3 pb-2 pt-2.5', inChat && 'overflow-y-auto overscroll-contain')}
      style={inChat ? { maxHeight: CHAT_CARD_MAX_HEIGHT } : undefined}
    >
      <CardHeader icon={<ClipboardList size={16} className="mt-0.5 shrink-0 text-state-action" />} title={t('prompt.planTitle')} onFold={onFold} />
      {card.pending.summary && <RequestSummary text={card.pending.summary} />}
      {canRead ? (
        <button
          type="button"
          data-plan-read={card.pending.id}
          onClick={() => setPlanOpen(true)}
          className="mt-1.5 flex h-9 max-w-full items-center gap-1.5 rounded-btn border border-border bg-bg-secondary px-3 text-xs font-medium text-text-primary active:bg-card"
        >
          <FileText size={14} className="shrink-0 text-text-secondary" />
          <span className="truncate">{t('plan.read')}</span>
        </button>
      ) : (
        <p className="mt-1.5 text-[11px] leading-tight text-text-secondary">{t('prompt.planHint')}</p>
      )}
      <div className="mt-2 flex flex-col gap-1.5">
        {options.map((option) =>
          option.cls === 'feedback' ? (
            <button
              key={option.n}
              type="button"
              data-plan-feedback={option.n}
              onPointerDown={(e) => e.preventDefault()}
              onClick={() => pick(option)}
              className="h-10 w-full truncate rounded-btn border border-dashed border-border px-3 text-sm font-medium text-text-secondary active:bg-card"
            >
              {planLabel(option)}
            </button>
          ) : (
            <button
              key={option.n}
              type="button"
              data-plan-option={option.n}
              data-plan-class={option.cls}
              onClick={() => pick(option)}
              className={clsx(
                'h-10 w-full truncate rounded-btn px-3 text-sm',
                option.n === firstApprove
                  ? 'bg-accent-violet font-semibold text-white active:brightness-110'
                  : 'border border-border font-medium text-text-primary active:bg-card',
              )}
            >
              {planLabel(option)}
            </button>
          ),
        )}
      </div>
      <PlanSheet paneId={paneId} requestId={card.pending.id} summary={card.pending.summary} open={planOpen} onClose={() => setPlanOpen(false)} />
    </div>
  )
}
