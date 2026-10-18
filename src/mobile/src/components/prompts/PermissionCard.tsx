/**
 * Permission card (E2-FR-19) over the composer and the KeyBar: "Claude wants
 * to use <tool>", the request summary in mono (3 lines, a tap expands it),
 * [Allow] ("1") and [Deny] (Esc), never followed by Enter, and the hint that
 * "always allow" stays in the terminal. A permission that came only from a
 * Notification has no tool: "Claude asks for a permission", no summary.
 */
import { useState, type ReactNode } from 'react'
import { clsx } from 'clsx'
import { ChevronDown, ShieldQuestion } from 'lucide-react'
import type { PromptCardModel } from '../../lib/promptRules'
import { answerCard } from '../../lib/answerLive'
import { t } from '../../lib/i18n'

type PermissionModel = Extract<PromptCardModel, { kind: 'permission' }>

export function permissionTitle(card: PermissionModel): string {
  return card.generic ? t('prompt.permGeneric') : t('prompt.permTitle', { tool: card.pending.toolName ?? '' })
}

export function PermissionCard({ paneId, card, onFold }: { paneId: string; card: PermissionModel; onFold: () => void }): ReactNode {
  const [expanded, setExpanded] = useState(false)
  const summary = card.generic ? '' : card.pending.summary
  return (
    <div
      data-prompt-card="permission"
      data-pending={card.pending.id}
      role="group"
      aria-label={permissionTitle(card)}
      className="shrink-0 border-t border-state-action/40 bg-bg-secondary px-3 pb-2 pt-2.5"
    >
      <div className="flex items-start gap-2">
        <ShieldQuestion size={16} className="mt-0.5 shrink-0 text-state-action" />
        <span data-prompt-title className="min-w-0 flex-1 break-words text-sm font-semibold leading-snug text-text-primary">
          {permissionTitle(card)}
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
      {summary && (
        <button
          type="button"
          data-prompt-summary
          data-expanded={expanded}
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          aria-label={expanded ? undefined : `${summary} - ${t('prompt.summaryExpand')}`}
          className="mt-1.5 block w-full rounded-btn bg-bg-primary px-2 py-1.5 text-left font-mono text-[12px] leading-snug text-text-primary"
        >
          <span data-prompt-summary-text className={clsx('whitespace-pre-wrap break-all', expanded ? 'block' : 'line-clamp-3')}>
            {summary}
          </span>
        </button>
      )}
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
      <p className="mt-1.5 text-[11px] leading-tight text-text-secondary">{t('prompt.alwaysHint')}</p>
    </div>
  )
}
