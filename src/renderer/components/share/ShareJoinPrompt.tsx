import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { AlertTriangle, Users } from 'lucide-react'
import type { ShareHostApproval } from '@shared/ipc-contract'
import type { SharePerm } from '@shared/types'
import { PERM_KEY, SHARE_PERMS, shortFingerprint, useShareHostStore } from '@/lib/shareHostStore'
import { useT } from '@/i18n'
import { Button } from '@/components/ui/Button'

/**
 * Allow / Deny for a guest asking to join a share (app 2.4.0, item 8, S4),
 * after the pattern of RemotePairingPrompt. Security prompt: Enter never
 * confirms and nothing is focused by default. Main allows 3 pending requests
 * at a time, so the cards stack; each one counts down its own 60 s and goes
 * away when main drops it (answered, timed out or the guest left).
 */
export function ShareJoinPrompt() {
  const approvals = useShareHostStore((s) => s.state.approvals)
  const answered = useShareHostStore((s) => s.answered)
  const [now, setNow] = useState(() => Date.now())

  const open = approvals.filter((a) => !answered.includes(a.requestId) && a.expiresAt > now)

  useEffect(() => {
    if (approvals.length === 0) return
    setNow(Date.now())
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [approvals.length])

  if (open.length === 0) return null

  return createPortal(
    <div className="fixed inset-0 z-[85] flex items-center justify-center p-6">
      <div className="absolute inset-0 bg-black/60" />
      <div data-share-prompts className="relative z-10 flex max-h-full w-full max-w-sm flex-col gap-3 overflow-y-auto">
        {open.map((a) => (
          <JoinCard key={a.requestId} approval={a} now={now} />
        ))}
      </div>
    </div>,
    document.body,
  )
}

function JoinCard({ approval: a, now }: { approval: ShareHostApproval; now: number }) {
  const t = useT()
  const resolve = useShareHostStore((s) => s.resolve)
  const [perm, setPerm] = useState<SharePerm>(a.perm)
  const secondsLeft = Math.max(0, Math.ceil((a.expiresAt - now) / 1000))
  return (
    <div
      role="alertdialog"
      aria-labelledby={`share-join-${a.requestId}`}
      data-share-prompt={a.requestId}
      className="overflow-hidden rounded-modal border border-border bg-card shadow-[0_20px_48px_-12px_rgba(0,0,0,0.6)]"
    >
      <div className="flex flex-col items-center gap-3 px-6 pb-4 pt-6 text-center">
        <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full border border-border bg-bg-secondary text-text-primary">
          <Users size={18} />
        </span>
        <div className="min-w-0">
          <h2 id={`share-join-${a.requestId}`} className="text-sm font-semibold text-text-primary">
            {t('shareHost.join.title')}
          </h2>
          <p className="mt-1 break-words text-sm text-text-secondary">
            {t(a.scopeKind === 'workspace' ? 'shareHost.join.wantsWorkspace' : 'shareHost.join.wantsPane', { name: a.guestName, scope: a.grantLabel })}
          </p>
        </div>
        <div className="flex flex-wrap items-center justify-center gap-2 text-xs text-text-secondary">
          <span data-share-prompt-fp title={a.fingerprint} className="rounded-btn border border-border bg-bg-secondary px-2 py-0.5 font-mono">
            {shortFingerprint(a.fingerprint)}
          </span>
          <span data-share-prompt-known={a.known ? 'yes' : 'no'}>{t(a.known ? 'shareHost.join.known' : 'shareHost.join.new')}</span>
          <span className="rounded-btn border border-border bg-bg-secondary px-2 py-0.5 font-mono">{a.ip}</span>
        </div>
        {a.passwordFailed && (
          <p data-share-prompt-pwfail className="flex items-start gap-1.5 text-left text-xs text-amber-300">
            <AlertTriangle size={13} className="mt-0.5 shrink-0" />
            {t('shareHost.join.passwordFailed')}
          </p>
        )}
        <label className="flex w-full items-center justify-between gap-3 text-xs text-text-secondary">
          <span>{t('shareHost.dialog.perm')}</span>
          <select
            data-share-prompt-perm
            value={perm}
            onChange={(e) => setPerm(e.target.value as SharePerm)}
            className="rounded-btn border border-border bg-bg-primary px-2 py-1 text-xs text-text-primary outline-none focus:border-accent-violet/60"
          >
            {SHARE_PERMS.map((p) => (
              <option key={p} value={p}>
                {t(PERM_KEY[p])}
              </option>
            ))}
          </select>
        </label>
        <span data-share-prompt-left className="text-[11px] text-text-secondary">
          {t('remote.pairing.expiresIn', { seconds: secondsLeft })}
        </span>
      </div>
      <div className="flex justify-center gap-2 border-t border-border bg-bg-secondary/40 px-5 py-3">
        <Button variant="ghost" size="sm" data-share-prompt-deny onClick={() => resolve(a.requestId, false)}>
          {t('remote.pairing.deny')}
        </Button>
        <Button size="sm" data-share-prompt-allow onClick={() => resolve(a.requestId, true, perm)}>
          {t('remote.pairing.allow')}
        </Button>
      </div>
    </div>
  )
}
