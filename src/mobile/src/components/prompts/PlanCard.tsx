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
 *  - The free text row ("Type here to tell Claude what to change") sends
 *    nothing: its button brings the keyboard up on the terminal, where the
 *    user picks it and types.
 *  - Known labels are translated; an approval the phone does not know keeps
 *    Claude's text. The menu is read again at tap time and a change cancels
 *    the tap.
 */
import type { ReactNode } from 'react'
import { clsx } from 'clsx'
import { ClipboardList } from 'lucide-react'
import type { PromptCardModel } from '../../lib/promptRules'
import { planOptions, sameOption, type PlanOption } from '../../lib/promptMenu'
import { answerCard } from '../../lib/answerLive'
import { t, type MobileMessageKey } from '../../lib/i18n'
import { CardHeader, RequestSummary, menuChanged } from './PermissionCard'
import { openTerminalKeyboard } from './PromptStrip'
import { currentMenu } from './usePromptMenu'

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
  const firstApprove = options.find((o) => o.cls === 'approve')?.n
  const pick = (option: PlanOption): void => {
    if (!sameOption(planOptions(currentMenu(paneId)), option)) {
      menuChanged()
      return
    }
    answerCard(paneId, card.pending.id, { kind: 'menu', option: option.n })
  }
  return (
    <div
      data-prompt-card="plan"
      data-pending={card.pending.id}
      role="group"
      aria-label={t('prompt.planTitle')}
      className="shrink-0 border-t border-state-action/40 bg-bg-secondary px-3 pb-2 pt-2.5"
    >
      <CardHeader icon={<ClipboardList size={16} className="mt-0.5 shrink-0 text-state-action" />} title={t('prompt.planTitle')} onFold={onFold} />
      {card.pending.summary && <RequestSummary text={card.pending.summary} />}
      <p className="mt-1.5 text-[11px] leading-tight text-text-secondary">{t('prompt.planHint')}</p>
      <div className="mt-2 flex flex-col gap-1.5">
        {options.map((option) =>
          option.cls === 'feedback' ? (
            <button
              key={option.n}
              type="button"
              data-plan-feedback={option.n}
              onPointerDown={(e) => e.preventDefault()}
              onClick={openTerminalKeyboard}
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
    </div>
  )
}
