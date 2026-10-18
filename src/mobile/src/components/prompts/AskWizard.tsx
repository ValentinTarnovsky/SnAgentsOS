/**
 * AskUserQuestion wizard (E2-FR-20): one question per step, tabs on top when
 * there is more than one. A single select tap marks the option and moves on
 * after ASK_AUTO_ADVANCE_MS; a multi select has checkboxes and [Next]. The
 * "Other..." row opens a text field (ASK_OTHER_MAX). On the last step [Send]
 * runs the answer sequence (E2-FR-21). The key groups are built while the
 * user picks, so a sequence over MAX_ANSWER_GROUPS turns the card into
 * "Answer in the terminal" before anything is sent (E2-FR-24).
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { clsx } from 'clsx'
import { Check, ChevronDown, MessageCircleQuestion } from 'lucide-react'
import type { RemotePending } from '@shared/remote-protocol'
import {
  ASK_AUTO_ADVANCE_MS,
  ASK_OTHER_MAX,
  MAX_ANSWER_GROUPS,
  buildAskAnswerKeys,
  selectionAnswered,
  type AskQuestion,
  type AskSelection,
} from '@shared/askAnswerKeys'
import { answerCard } from '../../lib/answerLive'
import { t } from '../../lib/i18n'
import { openTerminalKeyboard } from './PromptStrip'

interface Pick {
  options: number[]
  otherOn: boolean
  other: string
}

export function askTitle(count: number): string {
  return count === 1 ? t('prompt.stripAskOne') : t('prompt.stripAskMany', { n: count })
}

function toSelection(p: Pick): AskSelection {
  return p.otherOn ? { options: p.options, other: p.other } : { options: p.options }
}

/** Card header: icon, title and the fold chevron. */
export function AskHeader({ count, onFold }: { count: number; onFold: () => void }): ReactNode {
  return (
    <div className="flex items-start gap-2">
      <MessageCircleQuestion size={16} className="mt-0.5 shrink-0 text-state-action" />
      <span data-prompt-title className="min-w-0 flex-1 text-sm font-semibold leading-snug text-text-primary">{askTitle(count)}</span>
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

/** The ask the phone cannot answer (limits, or too many key groups). */
export function AnswerInTerminal(): ReactNode {
  return (
    <div data-ask-terminal className="mt-2 flex items-center gap-2">
      <span className="min-w-0 flex-1 text-xs text-text-secondary">{t('prompt.answerInTerminal')}</span>
      <button
        type="button"
        onPointerDown={(e) => e.preventDefault()}
        onClick={openTerminalKeyboard}
        className="h-9 shrink-0 rounded-btn border border-border px-3 text-xs font-medium text-text-primary active:bg-card"
      >
        {t('prompt.openKeyboard')}
      </button>
    </div>
  )
}

export function AskWizard({
  paneId,
  pending,
  questions,
  onFold,
}: {
  paneId: string
  pending: RemotePending
  questions: AskQuestion[]
  onFold: () => void
}): ReactNode {
  const [step, setStep] = useState(0)
  const [picks, setPicks] = useState<Pick[]>(() => questions.map(() => ({ options: [], otherOn: false, other: '' })))
  const advance = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => {
    if (advance.current) clearTimeout(advance.current)
  }, [])

  const selections = useMemo(() => picks.map(toSelection), [picks])
  const groups = useMemo(() => buildAskAnswerKeys({ questions }, selections), [questions, selections])
  const tooLong = groups.length > MAX_ANSWER_GROUPS
  const q = questions[step]
  const pick = picks[step]
  const last = step === questions.length - 1
  const multiQuestion = questions.length > 1

  const goTo = (i: number): void => {
    if (advance.current) clearTimeout(advance.current)
    advance.current = null
    setStep(Math.max(0, Math.min(questions.length - 1, i)))
  }

  const update = (fn: (p: Pick) => Pick): void => setPicks((prev) => prev.map((p, i) => (i === step ? fn(p) : p)))

  const choose = (k: number): void => {
    if (q.multiSelect) {
      update((p) => ({ ...p, options: p.options.includes(k) ? p.options.filter((x) => x !== k) : [...p.options, k] }))
      return
    }
    update((p) => ({ ...p, options: [k], otherOn: false }))
    if (!last) {
      if (advance.current) clearTimeout(advance.current)
      const next = step + 1
      advance.current = setTimeout(() => {
        advance.current = null
        setStep(next)
      }, ASK_AUTO_ADVANCE_MS)
    }
  }

  const toggleOther = (): void => {
    if (advance.current) clearTimeout(advance.current)
    advance.current = null
    update((p) => (q.multiSelect ? { ...p, otherOn: !p.otherOn } : { ...p, options: [], otherOn: true }))
  }

  const send = (): void => {
    if (groups.length === 0 || tooLong) return
    answerCard(paneId, pending.id, { kind: 'ask', selections })
  }

  return (
    <div
      data-prompt-card="question"
      data-pending={pending.id}
      data-step={step}
      role="group"
      aria-label={askTitle(questions.length)}
      className="shrink-0 border-t border-state-action/40 bg-bg-secondary px-3 pb-2 pt-2.5"
    >
      <AskHeader count={questions.length} onFold={onFold} />
      {multiQuestion && (
        <div role="tablist" className="mt-2 flex gap-1.5 overflow-x-auto">
          {questions.map((question, i) => {
            const answered = selectionAnswered(question, selections[i])
            return (
              <button
                key={i}
                type="button"
                role="tab"
                data-ask-tab={i}
                aria-selected={i === step}
                onClick={() => goTo(i)}
                className={clsx(
                  'flex h-8 max-w-[45%] shrink-0 items-center gap-1 rounded-full border px-2.5 text-[11px] font-medium',
                  i === step ? 'border-accent-violet bg-accent-violet/15 text-text-primary' : 'border-border text-text-secondary active:bg-card',
                )}
              >
                {answered && <Check size={12} className="shrink-0 text-accent-violet" />}
                <span className="truncate">{question.header || t('prompt.tab', { n: i + 1 })}</span>
              </button>
            )
          })}
        </div>
      )}
      <div className="mt-2 overflow-y-auto" style={{ maxHeight: 'calc(var(--vvh, 100dvh) * 0.4)' }}>
        <p data-ask-question className="mb-1.5 break-words text-sm text-text-primary">{q.question}</p>
        <div className="flex flex-col gap-1">
          {q.options.map((option, k) => {
            const on = pick.options.includes(k)
            return (
              <button
                key={k}
                type="button"
                data-ask-option={k}
                role={q.multiSelect ? 'checkbox' : 'radio'}
                aria-checked={on}
                onClick={() => choose(k)}
                className={clsx(
                  'flex min-h-11 w-full items-start gap-2.5 rounded-btn border px-3 py-2 text-left',
                  on ? 'border-accent-violet bg-accent-violet/10' : 'border-border active:bg-card',
                )}
              >
                <span
                  className={clsx(
                    'mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center border',
                    q.multiSelect ? 'rounded' : 'rounded-full',
                    on ? 'border-accent-violet bg-accent-violet text-white' : 'border-text-secondary',
                  )}
                >
                  {on && <Check size={11} />}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block break-words text-sm text-text-primary">{option.label}</span>
                  {option.description && <span className="block break-words text-[11px] leading-snug text-text-secondary">{option.description}</span>}
                </span>
              </button>
            )
          })}
          <button
            type="button"
            data-ask-other
            role={q.multiSelect ? 'checkbox' : 'radio'}
            aria-checked={pick.otherOn}
            onClick={toggleOther}
            className={clsx(
              'flex min-h-11 w-full items-center gap-2.5 rounded-btn border px-3 py-2 text-left text-sm text-text-primary',
              pick.otherOn ? 'border-accent-violet bg-accent-violet/10' : 'border-border active:bg-card',
            )}
          >
            <span
              className={clsx(
                'flex h-4 w-4 shrink-0 items-center justify-center border',
                q.multiSelect ? 'rounded' : 'rounded-full',
                pick.otherOn ? 'border-accent-violet bg-accent-violet text-white' : 'border-text-secondary',
              )}
            >
              {pick.otherOn && <Check size={11} />}
            </span>
            {t('prompt.other')}
          </button>
          {pick.otherOn && (
            <textarea
              data-ask-other-input
              data-kb-input="ask"
              value={pick.other}
              maxLength={ASK_OTHER_MAX}
              rows={2}
              placeholder={t('prompt.otherPlaceholder')}
              onChange={(e) => {
                const other = e.target.value
                update((p) => ({ ...p, other }))
              }}
              className="w-full resize-none rounded-btn border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary outline-none focus:border-accent-violet"
            />
          )}
        </div>
      </div>
      {tooLong ? (
        <AnswerInTerminal />
      ) : (
        <div className="mt-2 flex justify-end gap-2">
          {!last ? (
            <button
              type="button"
              data-ask-next
              onClick={() => goTo(step + 1)}
              className="h-10 rounded-btn border border-border px-4 text-sm font-medium text-text-primary active:bg-card"
            >
              {t('prompt.next')}
            </button>
          ) : (
            <button
              type="button"
              data-ask-send
              disabled={groups.length === 0}
              onClick={send}
              className="h-10 rounded-btn bg-accent-violet px-5 text-sm font-semibold text-white active:brightness-110 disabled:opacity-40"
            >
              {t('prompt.send')}
            </button>
          )}
        </div>
      )}
    </div>
  )
}
