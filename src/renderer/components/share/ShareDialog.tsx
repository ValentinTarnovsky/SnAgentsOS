import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { Check, Copy, Loader2, Lock, Share2 } from 'lucide-react'
import type { ShareCreateReq, ShareExpiryChoice, ShareHostGrantView, ShareHostState } from '@shared/ipc-contract'
import type { SharePerm, ShareRights } from '@shared/types'
import { shareDefaultRights } from '@shared/shareRights'
import { BRAND } from '@shared/brand'
import { useAppStore } from '@/lib/store'
import {
  ENDPOINT_KIND_KEY,
  EXPIRY_KEY,
  PERM_HINT_KEY,
  PERM_KEY,
  SHARE_EXPIRIES,
  SHARE_PASSWORD_MAX,
  SHARE_PERMS,
  grantsForScope,
  listenErrorText,
  passwordProblem,
  shareErrorKey,
  shareRightsSummary,
  syncShareHostConfig,
  useShareHostStore,
  type ShareDialogScope,
} from '@/lib/shareHostStore'
import { useT, type MessageKey } from '@/i18n'
import { Button } from '@/components/ui/Button'
import { FirewallStatusRow } from '@/components/remote/FirewallStatusRow'
import { ShareRightsEditor } from './ShareRightsEditor'
import { toast } from '@/lib/toast'
import { cn } from '@/lib/cn'

const fieldCls =
  'w-full rounded-btn border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary outline-none focus:border-accent-violet/60 disabled:cursor-not-allowed disabled:opacity-50'

/**
 * "Share console..." / "Share workspace..." (app 2.4.0, item 8, S4). One
 * global dialog opened from the pane menu, the workspace header or the
 * sidebar menu. Creating a share is the explicit action that turns
 * settings.share.enabled on; a workspace scope mounts the workspace first so
 * its consoles have a pty to share. A workspace also picks what else guests may
 * use (app 2.6.0 rights); a level preselects its defaults and the host adjusts
 * each one. The result step shows the invite with Copy, the endpoints it
 * carries and the share port's firewall row.
 */
export function ShareDialog() {
  const scope = useShareHostStore((s) => s.dialog)
  if (!scope) return null
  const key = scope.kind === 'pane' ? `p:${scope.paneId}` : `w:${scope.workspaceId}`
  return <ShareDialogBody key={key} scope={scope} />
}

function ShareDialogBody({ scope }: { scope: ShareDialogScope }) {
  const t = useT()
  const close = useShareHostStore((s) => s.closeDialog)
  const host = useShareHostStore((s) => s.state)
  const defaultPerm = useAppStore((s) => s.settings.share.defaultPerm)
  const name = useAppStore((s) => {
    if (scope.kind === 'workspace') return s.workspaces.find((w) => w.id === scope.workspaceId)?.name ?? null
    for (const w of s.workspaces) {
      const p = w.panes.find((x) => x.id === scope.paneId)
      if (p) return p.title
    }
    return null
  })

  const [perm, setPerm] = useState<SharePerm>(defaultPerm)
  const [rights, setRights] = useState<ShareRights>(() => shareDefaultRights(defaultPerm))
  const [password, setPassword] = useState('')
  const [expiry, setExpiry] = useState<ShareExpiryChoice>('never')
  const [label, setLabel] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<MessageKey | null>(null)
  const [done, setDone] = useState<{ grant: ShareHostGrantView; invite: string } | null>(null)

  // The console or workspace went away while the dialog was open: nothing left to share.
  const gone = name === null
  useEffect(() => {
    if (gone && !done) close()
  }, [gone, done, close])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        close()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [close])

  if (gone && !done) return null

  const pwProblem = passwordProblem(password)
  const existing = grantsForScope(host, scope).length

  // Picking another level resets the extras to that level's defaults; picking the current one keeps the host's edits.
  const pickPerm = (p: SharePerm): void => {
    if (p === perm) return
    setPerm(p)
    setRights(shareDefaultRights(p))
  }

  const create = async (): Promise<void> => {
    if (busy || pwProblem) return
    setBusy(true)
    setError(null)
    const app = useAppStore.getState()
    const share = app.settings.share
    // Creating a share is the explicit opt-in: settings.share.enabled goes on here, and main
    // gets it before the create call so the listener starts with the new grant.
    if (!share.enabled) app.updateSettings({ share: { ...share, enabled: true } })
    syncShareHostConfig({ enabled: true, port: share.port })
    if (scope.kind === 'workspace') app.ensureMounted(scope.workspaceId)
    const req: ShareCreateReq = {
      scope: scope.kind === 'pane' ? { kind: 'pane', paneId: scope.paneId } : { kind: 'workspace', workspaceId: scope.workspaceId },
      perm,
      ...(scope.kind === 'workspace' ? { rights } : {}),
      expiry,
      ...(label.trim() ? { label: label.trim() } : {}),
      ...(password && host.encryption ? { password } : {}),
    }
    try {
      const res = await window.snApi.share.host.create(req)
      if (res.ok) {
        setDone({ grant: res.grant, invite: res.invite })
        setPassword('')
      } else setError(shareErrorKey(res.error))
    } catch {
      setError('shareHost.err.invalid')
    } finally {
      setBusy(false)
    }
  }

  const title = scope.kind === 'pane' ? t('shareHost.dialog.titlePane') : t('shareHost.dialog.titleWorkspace')

  return createPortal(
    <div className="fixed inset-0 z-[75] flex items-center justify-center p-6">
      <div className="absolute inset-0 bg-black/60" onClick={close} />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="share-dialog-title"
        data-share-dialog={scope.kind}
        className="relative z-10 flex max-h-full w-full max-w-md flex-col overflow-hidden rounded-modal border border-border bg-card shadow-[0_20px_48px_-12px_rgba(0,0,0,0.6)]"
      >
        <div className="min-h-0 space-y-4 overflow-y-auto p-5">
          <div className="flex items-center gap-2">
            <Share2 size={18} className="text-accent-violet" />
            <h2 id="share-dialog-title" className="text-sm font-semibold text-text-primary">
              {title}
            </h2>
          </div>
          {name !== null && <p className="-mt-2 truncate text-xs text-text-secondary">{name}</p>}

          {done ? (
            <ShareResult host={host} grant={done.grant} invite={done.invite} />
          ) : (
            <>
              <div className="space-y-2">
                <span className="block text-xs font-medium text-text-secondary">{t('shareHost.dialog.perm')}</span>
                <div role="radiogroup" aria-label={t('shareHost.dialog.perm')} className="space-y-1.5">
                  {SHARE_PERMS.map((p) => (
                    <button
                      key={p}
                      type="button"
                      role="radio"
                      aria-checked={perm === p}
                      data-share-perm={p}
                      onClick={() => pickPerm(p)}
                      className={cn(
                        'flex w-full items-start gap-2.5 rounded-btn border px-3 py-2 text-left transition-colors',
                        perm === p ? 'border-accent-violet bg-accent-violet/10' : 'border-border hover:bg-bg-secondary',
                      )}
                    >
                      <span
                        className={cn(
                          'mt-0.5 flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full border',
                          perm === p ? 'border-accent-violet' : 'border-text-secondary/60',
                        )}
                      >
                        {perm === p && <span className="h-1.5 w-1.5 rounded-full bg-accent-violet" />}
                      </span>
                      <span className="min-w-0">
                        <span className="block text-sm text-text-primary">{t(PERM_KEY[p])}</span>
                        <span className="block text-xs text-text-secondary">{t(PERM_HINT_KEY[p])}</span>
                      </span>
                    </button>
                  ))}
                </div>
              </div>

              {scope.kind === 'workspace' && (
                <div data-share-rights-section className="space-y-2">
                  <div>
                    <span className="block text-xs font-medium text-text-secondary">{t('shareHost.rights.title')}</span>
                    <span className="block text-[11px] text-text-secondary">{t('shareHost.rights.hint')}</span>
                  </div>
                  <ShareRightsEditor value={rights} onChange={setRights} />
                </div>
              )}

              <label className="block space-y-1.5">
                <span className="flex items-center gap-1.5 text-xs font-medium text-text-secondary">
                  <Lock size={13} />
                  {t('shareHost.dialog.password')}
                </span>
                <input
                  type="password"
                  autoComplete="new-password"
                  data-share-password
                  maxLength={SHARE_PASSWORD_MAX}
                  disabled={!host.encryption}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder={t('shareHost.dialog.passwordPlaceholder')}
                  className={fieldCls}
                />
                <span data-share-password-note className={cn('block text-[11px]', pwProblem ? 'text-red-400' : 'text-text-secondary')}>
                  {!host.encryption ? t('shareHost.dialog.noEncryption') : pwProblem ? t(pwProblem) : t('shareHost.dialog.passwordHint')}
                </span>
              </label>

              <div className="grid grid-cols-2 gap-3">
                <label className="block space-y-1.5">
                  <span className="text-xs font-medium text-text-secondary">{t('shareHost.dialog.expiry')}</span>
                  <select data-share-expiry value={expiry} onChange={(e) => setExpiry(e.target.value as ShareExpiryChoice)} className={fieldCls}>
                    {SHARE_EXPIRIES.map((x) => (
                      <option key={x} value={x}>
                        {t(EXPIRY_KEY[x])}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="block space-y-1.5">
                  <span className="text-xs font-medium text-text-secondary">{t('shareHost.dialog.label')}</span>
                  <input
                    data-share-label
                    maxLength={64}
                    value={label}
                    onChange={(e) => setLabel(e.target.value)}
                    placeholder={name ?? ''}
                    className={fieldCls}
                  />
                </label>
              </div>

              {existing > 0 && (
                <p data-share-existing className="text-[11px] text-text-secondary">
                  {t(existing === 1 ? 'shareHost.dialog.existingOne' : 'shareHost.dialog.existingMany', { count: existing })}
                </p>
              )}

              {error && (
                <p data-share-error role="alert" className="text-xs text-red-400">
                  {t(error, { port: host.port })}
                </p>
              )}
            </>
          )}
        </div>

        <div className="flex shrink-0 justify-end gap-2 border-t border-border bg-bg-secondary/40 px-5 py-3">
          {done ? (
            <>
              <Button
                variant="ghost"
                size="sm"
                data-share-manage
                onClick={() => {
                  close()
                  useAppStore.getState().openSettings('share')
                }}
              >
                {t('shareHost.dialog.manage')}
              </Button>
              <Button variant="ghost" size="sm" data-share-close onClick={close}>
                {t('common.close')}
              </Button>
            </>
          ) : (
            <>
              <Button variant="ghost" size="sm" data-share-cancel onClick={close}>
                {t('common.cancel')}
              </Button>
              <Button size="sm" data-share-create disabled={busy || !!pwProblem} onClick={() => void create()} className="min-w-[96px]">
                {busy ? <Loader2 size={16} className="animate-spin" /> : null}
                {busy ? t('shareHost.dialog.creating') : t('shareHost.dialog.create')}
              </Button>
            </>
          )}
        </div>
      </div>
    </div>,
    document.body,
  )
}

/** The invite, how it travels (endpoints), and what may block it (firewall, no Tailscale). */
function ShareResult({ host, grant, invite }: { host: ShareHostState; grant: ShareHostGrantView; invite: string }) {
  const t = useT()
  const [copied, setCopied] = useState(false)
  const hasTs = host.endpoints.some((e) => e.t === 'ts')
  const listenError = listenErrorText(t, host)
  const copy = (): void => {
    window.snApi.clipboard.writeText(invite)
    setCopied(true)
    toast.success(t('toast.copied'), { dedupeKey: 'copied' })
  }
  return (
    <div data-share-result className="space-y-3">
      <p className="text-xs leading-relaxed text-text-secondary">{t('shareHost.result.hint', { app: BRAND.productName })}</p>
      <div className="space-y-1.5">
        <div data-share-invite className="max-h-24 select-all overflow-y-auto break-all rounded-btn border border-border bg-bg-primary px-3 py-2 font-mono text-[11px] leading-relaxed text-text-primary">
          {invite}
        </div>
        <Button size="sm" data-share-copy onClick={copy} className="w-full">
          {copied ? <Check size={16} /> : <Copy size={16} />}
          {copied ? t('shareHost.result.copied') : t('shareHost.result.copy')}
        </Button>
      </div>

      <p data-share-summary className="text-[11px] text-text-secondary">
        {t(PERM_KEY[grant.perm])}
        {' · '}
        {grant.hasPassword ? t('shareHost.result.withPassword') : t('shareHost.result.withApproval')}
      </p>
      {grant.scope.kind === 'workspace' && (
        <p data-share-rights-summary className="text-[11px] text-text-secondary">
          {t('shareHost.rights.summary', { list: shareRightsSummary(t, grant.rights) })}
        </p>
      )}

      <div className="space-y-1.5">
        <span className="block text-xs font-medium text-text-secondary">{t('shareHost.endpoints')}</span>
        {host.endpoints.map((e) => (
          <div key={`${e.a}:${e.p}`} data-share-endpoint={e.t} className="flex items-center gap-2 rounded-btn border border-border bg-bg-secondary px-2.5 py-1.5">
            <span className="rounded bg-card px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-text-secondary">{t(ENDPOINT_KIND_KEY[e.t])}</span>
            <span className="min-w-0 flex-1 truncate font-mono text-xs text-text-primary">
              {e.a}:{e.p}
            </span>
          </div>
        ))}
        {!hasTs && (
          <p data-share-no-tailscale className="text-[11px] leading-relaxed text-amber-300">
            {t('shareHost.noTailscale')}
          </p>
        )}
      </div>

      {listenError && (
        <p data-share-listen-error className="text-xs text-red-400">
          {listenError}
        </p>
      )}

      {window.snApi.platform === 'win32' && <FirewallStatusRow api={window.snApi.share.host} />}
    </div>
  )
}
