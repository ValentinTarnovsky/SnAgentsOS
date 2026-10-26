import { useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react'
import { Check, MessageSquareWarning, X } from 'lucide-react'
import { DECIDE_NOTE_MAX } from '@shared/teams'
import type { ApprovalView, TeamFail, TeamView } from '@shared/team-protocol'
import type { TeamDefinitionDiff } from '@shared/teamDiff'
import { useT, type MessageKey } from '@/i18n'
import { cn } from '@/lib/cn'
import { toast } from '@/lib/toast'
import { approvalWaits, busyKey, decide, decideFailText, useNeedsStore } from '@/lib/teams/needs'
import { visibleName } from '@/lib/teams/issues'
import { ChatMarkdown } from '@/components/chat/Markdown'
import { SMALL_BTN, SMALL_BTN_QUIET, SMALL_BTN_TEXT } from './RunHeader'
import { CHIP, CHIP_NEUTRAL } from './TaskCard'
import { BODY_BAD_RE, useLinkConfirm } from './TaskComments'
import { TeamDiffView } from './TeamDiffView'

/** Where a decision is taken: a row of Te necesita or the plan section of the task drawer (their data-* differ). */
export type DecideScope = 'need' | 'plan'

/** A role by its name in the trusted definition; a role the definition does not have (a hire) by its id, spelled out. */
export function roleLabel(view: TeamView | undefined, roleId: string): string {
  return view?.roles.find((r) => r.id === roleId)?.name ?? visibleName(roleId)
}

/**
 * Aprobar and, beside it, Pedir cambios (plans and final OKs: the note is
 * required and goes to the agent) or Rechazar (hires and permissions: the
 * note is optional). The note opens inline under the buttons; Enter is a new
 * line, Ctrl+Enter or Enviar sends it, Esc closes it. Every button waits while
 * the decision is on its way (and while main applies a hire); a refusal says
 * why in a toast (the row may be gone by then) and keeps the note's draft.
 * `onReply` runs after main answered, either way.
 */
export function DecideControls({ teamId, approval, second, scope, onReply }: { teamId: string; approval: ApprovalView; second: 'changes' | 'reject'; scope: DecideScope; onReply?: () => void }) {
  const t = useT()
  const busy = useNeedsStore((s) => !!s.busy[busyKey(teamId, approval.id)])
  const [open, setOpen] = useState(false)
  const [note, setNote] = useState('')
  const [error, setError] = useState<string | null>(null)
  const areaRef = useRef<HTMLTextAreaElement | null>(null)
  const applying = approval.state === 'applying'
  const disabled = busy || applying
  const attr = (what: string): Record<string, string> => ({ [`data-${scope}-${what}`]: approval.id })

  useLayoutEffect(() => {
    if (open) areaRef.current?.focus({ preventScroll: true })
  }, [open])

  // A refusal in words: a stale permission still in the reloaded view grew under the user (its new rules show now).
  const failText = (fail: TeamFail): string => decideFailText(fail, t, approval.payload.kind, approvalWaits(teamId, approval.id))
  // The rev on screen; a view without one (the field is optional on the wire) reads as 1, as main reads a record.
  const rev = approval.rev ?? 1
  const approve = (): void => {
    void decide(teamId, approval.id, 'approve', undefined, rev).then((fail) => {
      if (fail) toast.error(failText(fail))
      else toast.success(t('teams.approval.approved'))
      onReply?.()
    })
  }
  const send = (): void => {
    const text = note.trim()
    if (second === 'changes' && !text) {
      setError(t('teams.approval.noteRequired'))
      return
    }
    if (BODY_BAD_RE.test(note)) {
      setError(t('teams.approval.noteBad'))
      return
    }
    setError(null)
    void decide(teamId, approval.id, 'reject', text || undefined, rev).then((fail) => {
      if (fail) toast.error(failText(fail))
      else {
        toast.success(t(second === 'changes' ? 'teams.approval.changesSent' : 'teams.approval.rejected'))
        setOpen(false)
        setNote('')
      }
      onReply?.()
    })
  }
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.nativeEvent.isComposing) return
    if (e.key === 'Escape') {
      // A text field, not the overlay: Esc closes the note only.
      e.preventDefault()
      e.stopPropagation()
      setOpen(false)
      setError(null)
    } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey) {
      e.preventDefault()
      send()
    }
  }

  const secondKey: MessageKey = second === 'changes' ? 'teams.approval.changes' : 'teams.approval.reject'
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div className="flex min-w-0 flex-wrap items-center gap-1.5">
        <button type="button" {...attr('approve')} disabled={disabled} onClick={approve} className={cn(SMALL_BTN, SMALL_BTN_TEXT)}>
          <Check size={13} aria-hidden />
          {t('teams.approval.approve')}
        </button>
        <button
          type="button"
          {...attr(second)}
          aria-expanded={open}
          disabled={disabled}
          onClick={() => {
            setOpen((v) => !v)
            setError(null)
          }}
          className={cn(SMALL_BTN, SMALL_BTN_QUIET)}
        >
          {second === 'changes' ? <MessageSquareWarning size={13} aria-hidden /> : <X size={13} aria-hidden />}
          {t(secondKey)}
        </button>
        {applying && (
          <span data-approval-applying className="text-[11px] text-text-secondary" role="status">
            {t('teams.approval.applying')}
          </span>
        )}
      </div>
      {open && (
        <div className="flex min-w-0 flex-col gap-1.5">
          <textarea
            ref={areaRef}
            {...attr('note')}
            value={note}
            rows={3}
            maxLength={DECIDE_NOTE_MAX}
            placeholder={t(second === 'changes' ? 'teams.approval.noteChanges' : 'teams.approval.noteReject')}
            aria-label={t(second === 'changes' ? 'teams.approval.noteChanges' : 'teams.approval.noteReject')}
            aria-invalid={error ? true : undefined}
            onKeyDown={onKey}
            onChange={(e) => {
              setNote(e.target.value)
              if (error) setError(null)
            }}
            className="block max-h-48 min-h-[4.5rem] w-full resize-y rounded-btn border border-border bg-bg-primary px-2.5 py-1.5 text-[13px] leading-[1.45] text-text-primary outline-none focus:border-accent-violet/50"
          />
          {error && (
            <p data-approval-note-error className="text-[11px] text-state-error" role="alert">
              {error}
            </p>
          )}
          <div className="flex min-w-0 items-center justify-end gap-1.5">
            <button
              type="button"
              onClick={() => {
                setOpen(false)
                setError(null)
              }}
              className={cn(SMALL_BTN, SMALL_BTN_QUIET)}
            >
              {t('common.cancel')}
            </button>
            <button type="button" {...attr('note-send')} disabled={disabled} onClick={send} className={cn(SMALL_BTN, SMALL_BTN_TEXT)}>
              {t(second === 'changes' ? 'teams.approval.send' : 'teams.approval.reject')}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

/**
 * A plan's Markdown (the agent's text, never HTML) in a scroll box; "Ver
 * completo" lets it grow to its full height when it does not fit. Links ask
 * before they open (useLinkConfirm).
 */
export function PlanText({ text, truncated, name }: { text: string; truncated?: boolean; name: string }) {
  const t = useT()
  const { onLink, dialog } = useLinkConfirm()
  const [full, setFull] = useState(false)
  const [fits, setFits] = useState(true)
  const boxRef = useRef<HTMLDivElement | null>(null)
  useLayoutEffect(() => {
    const el = boxRef.current
    if (el && !full) setFits(el.scrollHeight <= el.clientHeight + 1)
  }, [text, full])
  if (!text.trim()) {
    return (
      <p data-plan-text={name} data-plan-empty className="text-xs text-text-secondary">
        {t('teams.approval.planEmpty')}
      </p>
    )
  }
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <div ref={boxRef} data-plan-text={name} data-plan-full={full ? 'true' : 'false'} className={cn('min-w-0 overflow-y-auto rounded-btn border border-border bg-card/30 px-3 py-2', !full && 'max-h-64')}>
        <ChatMarkdown text={text} onLink={onLink} />
      </div>
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        {(!fits || full) && (
          <button type="button" data-plan-expand={name} aria-expanded={full} onClick={() => setFull((v) => !v)} className="rounded px-1 text-[11px] text-text-secondary underline-offset-2 hover:text-text-primary hover:underline">
            {t(full ? 'teams.approval.showLess' : 'teams.approval.showAll')}
          </button>
        )}
        {truncated && <span className="text-[11px] text-text-secondary">{t('teams.approval.truncated')}</span>}
      </div>
      {dialog}
    </div>
  )
}

/** Why the last attempt of an approval did not land (a hire cut off by a quit comes back pending with `interrupted`). */
function ApprovalError({ error }: { error?: string }) {
  const t = useT()
  if (!error) return null
  return (
    <p data-approval-error={error === 'interrupted' ? 'interrupted' : 'failed'} className="text-[11px] text-state-action">
      {t(error === 'interrupted' ? 'teams.approval.interrupted' : 'teams.approval.lastFailed')}
    </p>
  )
}

/**
 * The body of an approval in Te necesita (app 2.7.0, E10 B5), by kind: a plan
 * (its Markdown, Aprobar / Pedir cambios), a final OK (the agent's summary
 * and what changed: the view's `stat`, the diff stat main last computed for
 * the task, absent when none was; Aprobar / Pedir cambios), a hire (the role file as a diff
 * through TeamDiffView, so every hidden character shows as `<U+XXXX>`, and its
 * risks; Aprobar / Rechazar) and a permission (the exact rule granted and the
 * commands that were denied, the view's `denied`, all spelled out; Aprobar / Rechazar).
 * A branch ready to integrate is never decided: NeedRow shows IntegrateNeedBody
 * for it (B6, Integrar...). Repo and agent text is never HTML.
 */
export function ApprovalBody({ teamId, approval, view, fromQa }: { teamId: string; approval: ApprovalView; view?: TeamView; fromQa?: boolean }) {
  const t = useT()
  const { onLink, dialog } = useLinkConfirm()
  const p = approval.payload
  switch (p.kind) {
    case 'plan':
      return (
        <div data-approval-body="plan" className="flex min-w-0 flex-col gap-2">
          <div className="flex min-w-0 flex-wrap items-center gap-1">
            <span className={cn(CHIP, CHIP_NEUTRAL)}>{t('teams.approval.rev', { rev: p.planRev })}</span>
            {p.small && <span className={cn(CHIP, CHIP_NEUTRAL)}>{t('teams.approval.small')}</span>}
          </div>
          <PlanText text={p.text} truncated={p.truncated} name={approval.id} />
          <ApprovalError error={approval.error} />
          <DecideControls teamId={teamId} approval={approval} second="changes" scope="need" />
        </div>
      )
    case 'final':
      return (
        <div data-approval-body="final" className="flex min-w-0 flex-col gap-2">
          {/* T8 (QA's verdict) or T10 (`team done` of a research or custom role): only the first one was reviewed by QA. */}
          <p className="text-xs text-text-secondary">{t(fromQa ? 'teams.approval.finalHint' : 'teams.approval.finalHintNoQa')}</p>
          {p.summary.trim() ? (
            <div data-approval-summary className="max-h-48 min-w-0 overflow-y-auto rounded-btn border border-border bg-card/30 px-3 py-2">
              <ChatMarkdown text={p.summary} onLink={onLink} />
            </div>
          ) : (
            <p data-approval-summary className="text-xs text-text-secondary">
              {t('teams.approval.noSummary')}
            </p>
          )}
          {p.stat && (
            <div data-approval-stat className="min-w-0 text-[11px] text-text-secondary">
              <p className="tabular-nums">{t('teams.approval.stat', { files: p.stat.files, add: p.stat.insertions, del: p.stat.deletions })}</p>
              {p.stat.top.length > 0 && (
                <ul className="mt-0.5 space-y-0.5">
                  {p.stat.top.map((f) => (
                    <li key={f.path} className="flex min-w-0 items-center gap-2 font-mono">
                      <span className="min-w-0 truncate">{visibleName(f.path)}</span>
                      <span className="shrink-0 tabular-nums">
                        +{f.add} -{f.del}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
          <ApprovalError error={approval.error} />
          <DecideControls teamId={teamId} approval={approval} second="changes" scope="need" />
          {dialog}
        </div>
      )
    case 'hire': {
      const role = visibleName(p.roleId)
      // One file of the definition, with its risks: the trust dialog's view, every diff line through visibleLine.
      const diff: TeamDefinitionDiff = { files: [p.diff], risks: p.risks, truncated: !!p.diff.truncated }
      return (
        <div data-approval-body="hire" className="flex min-w-0 flex-col gap-2">
          <p data-hire-role={p.roleId} className="text-xs font-medium text-text-primary">
            {t(p.diff.status === 'added' ? 'teams.approval.hireNew' : 'teams.approval.hireChange', { role })}
          </p>
          <p className="text-xs text-text-secondary">{t('teams.approval.hireHint', { role })}</p>
          <TeamDiffView diff={diff} />
          <ApprovalError error={approval.error} />
          <DecideControls teamId={teamId} approval={approval} second="reject" scope="need" />
        </div>
      )
    }
    case 'permission': {
      // The commands the run was denied, as main sends them (redacted and cut, at most DENIED_COMMANDS_MAX); a main
      // that sends none leaves the rule alone to say what is granted.
      const denied = p.denied ?? []
      return (
        <div data-approval-body="permission" className="flex min-w-0 flex-col gap-2">
          <p className="text-xs text-text-secondary">{t('teams.approval.permissionHint', { role: roleLabel(view, p.roleId) })}</p>
          <div className="flex min-w-0 flex-col gap-1">
            <h4 className="text-[11px] font-medium text-text-secondary">{t('teams.approval.permissionRule')}</h4>
            {p.tools.length > 0 ? (
              <ul className="flex min-w-0 flex-wrap gap-1">
                {p.tools.map((tool) => (
                  <li key={tool} data-permission-rule={tool} className="min-w-0 max-w-full break-all rounded border border-state-action/50 bg-state-action/10 px-1.5 py-0.5 font-mono text-[11px] text-text-primary">
                    {visibleName(tool)}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-xs text-text-secondary">{t('teams.approval.permissionNone')}</p>
            )}
          </div>
          {denied.length > 0 && (
            <div className="flex min-w-0 flex-col gap-1">
              <h4 className="text-[11px] font-medium text-text-secondary">{t('teams.approval.permissionDenied')}</h4>
              <ul className="flex min-w-0 flex-col gap-1">
                {denied.map((c, i) => (
                  <li key={i} data-permission-denied className="min-w-0 break-all rounded border border-border bg-bg-primary px-1.5 py-0.5 font-mono text-[11px] text-text-primary">
                    {visibleName(c)}
                  </li>
                ))}
              </ul>
            </div>
          )}
          <ApprovalError error={approval.error} />
          <DecideControls teamId={teamId} approval={approval} second="reject" scope="need" />
        </div>
      )
    }
  }
  // An integrate approval is landed by Integrar alone (IntegrateNeedBody); NeedRow never brings one here.
  return null
}
