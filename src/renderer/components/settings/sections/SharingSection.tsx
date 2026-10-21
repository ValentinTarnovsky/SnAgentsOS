import { useEffect, useState } from 'react'
import { Copy, KeyRound, Lock, LogOut, Pause, Play, RefreshCw, Trash2, Users } from 'lucide-react'
import type { ShareExpiryChoice, ShareHostGrantView, ShareHostSessionView, ShareOpRes, ShareInviteRes } from '@shared/ipc-contract'
import type { SharePerm } from '@shared/types'
import { BRAND } from '@shared/brand'
import { useAppStore } from '@/lib/store'
import {
  ENDPOINT_KIND_KEY,
  EXPIRY_KEY,
  PERM_KEY,
  SHARE_EXPIRIES,
  SHARE_PASSWORD_MAX,
  SHARE_PERMS,
  formatUntil,
  listenErrorText,
  passwordProblem,
  shareErrorKey,
  shortFingerprint,
  useShareHostStore,
} from '@/lib/shareHostStore'
import { formatSince } from '@/lib/formatSince'
import { useLang, useT, type MessageKey } from '@/i18n'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { FirewallStatusRow } from '@/components/remote/FirewallStatusRow'
import { SettingRow, ToggleRow, inputCls, labelCls } from '../ui'
import { toast } from '@/lib/toast'
import { cn } from '@/lib/cn'

const MIN_PORT = 1024
const MAX_PORT = 65535
const GUEST_NAME_MAX = 48

const LISTEN_DOT: Record<string, string> = {
  off: 'bg-text-secondary/50',
  starting: 'bg-amber-400',
  running: 'bg-emerald-400',
  error: 'bg-red-400',
}

const LISTEN_KEY: Record<string, MessageKey> = {
  off: 'shareHost.listen.off',
  starting: 'shareHost.listen.starting',
  running: 'shareHost.listen.running',
  error: 'shareHost.listen.error',
}

const smallBtn =
  'flex items-center gap-1.5 rounded-btn border border-border bg-card px-2 py-1 text-[11px] text-text-primary transition-colors hover:border-accent-violet/40 disabled:cursor-not-allowed disabled:opacity-40'
const selectCls =
  'rounded-btn border border-border bg-bg-secondary px-2 py-1 text-xs text-text-primary outline-none focus:border-accent-violet/60 disabled:cursor-not-allowed disabled:opacity-50'

/**
 * Settings > Sharing (app 2.4.0, item 8, S4): the host side of desktop to
 * desktop sharing. settings.share (switch, port, name as a guest, default
 * permission) lives in config; every grant, guest and listener fact comes
 * from main (ShareHostState) and each action goes back by id.
 */
export function SharingSection() {
  const t = useT()
  const share = useAppStore((s) => s.settings.share)
  const updateSettings = useAppStore((s) => s.updateSettings)
  const host = useShareHostStore((s) => s.state)
  const [portDraft, setPortDraft] = useState(String(share.port))
  const [nameDraft, setNameDraft] = useState(share.guestName)

  useEffect(() => setPortDraft(String(share.port)), [share.port])
  useEffect(() => setNameDraft(share.guestName), [share.guestName])

  const patch = (p: Partial<typeof share>): void => updateSettings({ share: { ...useAppStore.getState().settings.share, ...p } })

  const commitPort = (): void => {
    const n = Number(portDraft)
    if (Number.isInteger(n) && n >= MIN_PORT && n <= MAX_PORT) {
      if (n !== share.port) patch({ port: n })
    } else setPortDraft(String(share.port))
  }
  const commitName = (): void => {
    const v = nameDraft.trim().slice(0, GUEST_NAME_MAX)
    if (v !== share.guestName) patch({ guestName: v })
    setNameDraft(v)
  }

  const hasTs = host.endpoints.some((e) => e.t === 'ts')
  const listenError = listenErrorText(t, host)

  return (
    <div className="space-y-5" data-sharing-section>
      <p className="text-xs leading-relaxed text-text-secondary">{t('shareHost.settings.hint', { app: BRAND.productName })}</p>

      <ToggleRow
        checked={share.enabled}
        onChange={(enabled) => patch({ enabled })}
        searchId="share.enable"
        title={t('shareHost.settings.enable')}
        description={t('shareHost.settings.enableHint')}
      />

      <ToggleRow
        checked={host.pausedAll}
        disabled={host.grants.length === 0}
        onChange={(on) => void window.snApi.share.host.pauseAll(on)}
        searchId="share.pauseAll"
        title={t('shareHost.settings.pauseAll')}
        description={t('shareHost.settings.pauseAllHint')}
      />

      <div className="space-y-2" data-share-listen={host.listening}>
        <div className="flex items-center gap-2">
          <span className={cn('h-2 w-2 shrink-0 rounded-full', LISTEN_DOT[host.listening])} />
          <span className="text-sm font-medium text-text-primary">{t(LISTEN_KEY[host.listening] ?? 'shareHost.listen.off')}</span>
        </div>
        {listenError && <p className="text-xs text-red-400">{listenError}</p>}
        {host.listening === 'off' && share.enabled && host.grants.length === 0 && (
          <p className="text-[11px] text-text-secondary">{t('shareHost.listen.noGrants')}</p>
        )}
      </div>

      <SettingRow searchId="share.port" title={t('shareHost.settings.port')} description={t('shareHost.settings.portHint')}>
        <input
          type="number"
          min={MIN_PORT}
          max={MAX_PORT}
          data-share-port
          className={cn(inputCls, 'max-w-[200px]')}
          value={portDraft}
          onChange={(e) => setPortDraft(e.target.value)}
          onBlur={commitPort}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur()
          }}
        />
      </SettingRow>

      {share.enabled && (
        <div className="space-y-1.5">
          <label className={labelCls}>{t('shareHost.endpoints')}</label>
          {host.endpoints.length === 0 ? (
            <p className="text-xs text-text-secondary">{t('shareHost.err.noEndpoint')}</p>
          ) : (
            host.endpoints.map((e) => (
              <div key={`${e.a}:${e.p}`} data-share-endpoint={e.t} className="flex items-center gap-2 rounded-btn border border-border bg-bg-secondary px-2.5 py-1.5">
                <span className="rounded bg-card px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-text-secondary">{t(ENDPOINT_KIND_KEY[e.t])}</span>
                <span className="min-w-0 flex-1 truncate font-mono text-xs text-text-primary">
                  {e.a}:{e.p}
                </span>
              </div>
            ))
          )}
          {host.endpoints.length > 0 && !hasTs && (
            <p data-share-no-tailscale className="text-[11px] leading-relaxed text-amber-300">
              {t('shareHost.noTailscale')}
            </p>
          )}
          {window.snApi.platform === 'win32' && <FirewallStatusRow api={window.snApi.share.host} className="mt-2" />}
        </div>
      )}

      <SettingRow searchId="share.guestName" title={t('shareHost.settings.guestName')} description={t('shareHost.settings.guestNameHint')}>
        <input
          data-share-guest-name
          maxLength={GUEST_NAME_MAX}
          className={cn(inputCls, 'max-w-[280px]')}
          value={nameDraft}
          placeholder={t('shareHost.settings.guestNamePlaceholder')}
          onChange={(e) => setNameDraft(e.target.value)}
          onBlur={commitName}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur()
          }}
        />
      </SettingRow>

      <SettingRow searchId="share.defaultPerm" title={t('shareHost.settings.defaultPerm')} description={t('shareHost.settings.defaultPermHint')}>
        <select
          data-share-default-perm
          className={cn(inputCls, 'max-w-[280px]')}
          value={share.defaultPerm}
          onChange={(e) => patch({ defaultPerm: e.target.value as SharePerm })}
        >
          {SHARE_PERMS.map((p) => (
            <option key={p} value={p}>
              {t(PERM_KEY[p])}
            </option>
          ))}
        </select>
      </SettingRow>

      <div className="space-y-1">
        {host.fingerprint && (
          <p data-share-host-fp className="text-[11px] text-text-secondary">
            {t('shareHost.settings.fingerprint')} <span className="font-mono text-text-primary">{host.fingerprint}</span>
          </p>
        )}
        {!host.encryption && (
          <p data-share-no-encryption className="text-[11px] leading-relaxed text-amber-300">
            {t('shareHost.settings.noEncryption')}
          </p>
        )}
      </div>

      <div className="space-y-2 border-t border-border pt-5" data-share-grants>
        <label className={labelCls}>{t('shareHost.settings.grants')}</label>
        {host.grants.length === 0 ? (
          <p className="text-xs text-text-secondary">{t('shareHost.settings.noGrants')}</p>
        ) : (
          <div className="space-y-2">
            {host.grants.map((g) => (
              <GrantCard key={g.id} grant={g} encryption={host.encryption} />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function GrantCard({ grant: g, encryption }: { grant: ShareHostGrantView; encryption: boolean }) {
  const t = useT()
  const lang = useLang()
  const api = window.snApi.share.host
  const [error, setError] = useState<MessageKey | null>(null)
  const [pwOpen, setPwOpen] = useState(false)
  const [pw, setPw] = useState('')
  const [confirm, setConfirm] = useState<'revoke' | 'rotate' | null>(null)
  const now = Date.now()

  const run = async (op: () => Promise<ShareOpRes>): Promise<boolean> => {
    setError(null)
    try {
      const res = await op()
      if (!res.ok) setError(shareErrorKey(res.error))
      return res.ok
    } catch {
      setError('shareHost.err.invalid')
      return false
    }
  }
  const copyInvite = async (get: () => Promise<ShareInviteRes>, doneKey: MessageKey): Promise<void> => {
    setError(null)
    try {
      const res = await get()
      if (!res.ok) return setError(shareErrorKey(res.error))
      window.snApi.clipboard.writeText(res.invite)
      toast.success(t(doneKey), { dedupeKey: 'share-invite' })
    } catch {
      setError('shareHost.err.invalid')
    }
  }
  const savePassword = async (): Promise<void> => {
    if (passwordProblem(pw) || !pw) return
    if (await run(() => api.setPassword(g.id, pw))) {
      setPw('')
      setPwOpen(false)
    }
  }

  const expiryText = g.expired
    ? t('shareHost.grant.expired')
    : g.expiresAt !== undefined
      ? t('shareHost.grant.expires', { when: formatUntil(g.expiresAt, now, lang) })
      : t('shareHost.expiry.never')
  const pwProblem = passwordProblem(pw)

  return (
    <div data-share-grant={g.id} className="space-y-2 rounded-card border border-border bg-bg-secondary px-3 py-2.5">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <span className="block truncate text-sm text-text-primary">{g.label}</span>
          <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-text-secondary">
            <span>{t(g.scope.kind === 'workspace' ? 'shareHost.scope.workspace' : 'shareHost.scope.pane')}</span>
            <span>{expiryText}</span>
            {g.hasPassword && (
              <span className="flex items-center gap-1" data-share-grant-pw>
                <Lock size={11} />
                {t('shareHost.grant.password')}
              </span>
            )}
            {g.paused && <span data-share-grant-paused className="text-amber-300">{t('shareHost.grant.paused')}</span>}
            {g.suspended && <span data-share-grant-suspended>{t('shareHost.grant.suspended')}</span>}
            {g.knownGuests > 0 && <span>{t('shareHost.grant.known', { count: g.knownGuests })}</span>}
          </span>
        </div>
        <select
          aria-label={t('shareHost.dialog.perm')}
          data-share-grant-perm
          className={selectCls}
          value={g.perm}
          onChange={(e) => void run(() => api.update({ grantId: g.id, perm: e.target.value as SharePerm }))}
        >
          {SHARE_PERMS.map((p) => (
            <option key={p} value={p}>
              {t(PERM_KEY[p])}
            </option>
          ))}
        </select>
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        <button type="button" data-share-grant-copy className={smallBtn} disabled={g.expired} onClick={() => void copyInvite(() => api.invite(g.id), 'shareHost.grant.inviteCopied')}>
          <Copy size={13} />
          {t('shareHost.grant.copyInvite')}
        </button>
        <button type="button" data-share-grant-rotate className={smallBtn} onClick={() => setConfirm('rotate')}>
          <RefreshCw size={13} />
          {t('shareHost.grant.rotate')}
        </button>
        <button type="button" data-share-grant-pause className={smallBtn} onClick={() => void run(() => api.update({ grantId: g.id, paused: !g.paused }))}>
          {g.paused ? <Play size={13} /> : <Pause size={13} />}
          {g.paused ? t('shareHost.grant.resume') : t('shareHost.grant.pause')}
        </button>
        <button type="button" data-share-grant-pw-open className={smallBtn} disabled={!encryption && !g.hasPassword} onClick={() => setPwOpen((v) => !v)}>
          <KeyRound size={13} />
          {g.hasPassword ? t('shareHost.grant.changePassword') : t('shareHost.grant.setPassword')}
        </button>
        <select
          aria-label={t('shareHost.dialog.expiry')}
          data-share-grant-expiry
          className={selectCls}
          value=""
          onChange={(e) => {
            const v = e.target.value as ShareExpiryChoice
            if (v) void run(() => api.update({ grantId: g.id, expiry: v }))
          }}
        >
          <option value="" disabled>
            {t('shareHost.grant.changeExpiry')}
          </option>
          {SHARE_EXPIRIES.map((x) => (
            <option key={x} value={x}>
              {t(EXPIRY_KEY[x])}
            </option>
          ))}
        </select>
        <button type="button" data-share-grant-revoke className={cn(smallBtn, 'ml-auto hover:border-red-500/50 hover:text-red-400')} onClick={() => setConfirm('revoke')}>
          <Trash2 size={13} />
          {t('shareHost.grant.revoke')}
        </button>
      </div>

      {pwOpen && (
        <div data-share-grant-pw-form className="space-y-1.5">
          {!encryption ? (
            <p className="text-[11px] text-amber-300">{t('shareHost.dialog.noEncryption')}</p>
          ) : (
            <div className="flex items-center gap-1.5">
              <input
                type="password"
                autoComplete="new-password"
                data-share-grant-pw-input
                maxLength={SHARE_PASSWORD_MAX}
                value={pw}
                onChange={(e) => setPw(e.target.value)}
                placeholder={t('shareHost.dialog.passwordPlaceholder')}
                className={cn(inputCls, 'h-8 flex-1 text-xs')}
              />
              <button type="button" data-share-grant-pw-save className={smallBtn} disabled={!pw || !!pwProblem} onClick={() => void savePassword()}>
                {t('common.save')}
              </button>
            </div>
          )}
          {pwProblem && <p className="text-[11px] text-red-400">{t(pwProblem)}</p>}
          {g.hasPassword && (
            <button
              type="button"
              data-share-grant-pw-clear
              className={smallBtn}
              onClick={() =>
                void run(() => api.setPassword(g.id, null)).then((ok) => {
                  if (ok) setPwOpen(false)
                })
              }
            >
              {t('shareHost.grant.clearPassword')}
            </button>
          )}
        </div>
      )}

      {error && (
        <p data-share-grant-error role="alert" className="text-[11px] text-red-400">
          {t(error)}
        </p>
      )}

      {g.sessions.length > 0 && (
        <div className="space-y-1.5 border-t border-border pt-2" data-share-sessions>
          {g.sessions.map((s) => (
            <SessionRow key={s.id} session={s} onError={setError} />
          ))}
        </div>
      )}

      <ConfirmDialog
        open={confirm === 'revoke'}
        title={t('shareHost.grant.revokeTitle')}
        message={t('shareHost.grant.revokeBody', { name: g.label })}
        confirmLabel={t('shareHost.grant.revoke')}
        cancelLabel={t('common.cancel')}
        danger
        onConfirm={() => {
          setConfirm(null)
          void run(() => api.revoke(g.id))
        }}
        onCancel={() => setConfirm(null)}
      />
      <ConfirmDialog
        open={confirm === 'rotate'}
        title={t('shareHost.grant.rotateTitle')}
        message={t('shareHost.grant.rotateBody')}
        confirmLabel={t('shareHost.grant.rotate')}
        cancelLabel={t('common.cancel')}
        onConfirm={() => {
          setConfirm(null)
          void copyInvite(() => api.rotate(g.id), 'shareHost.grant.rotated')
        }}
        onCancel={() => setConfirm(null)}
      />
    </div>
  )
}

function SessionRow({ session: s, onError }: { session: ShareHostSessionView; onError: (k: MessageKey | null) => void }) {
  const t = useT()
  const lang = useLang()
  const api = window.snApi.share.host
  const op = async (fn: () => Promise<ShareOpRes>): Promise<void> => {
    onError(null)
    try {
      const res = await fn()
      if (!res.ok) onError(shareErrorKey(res.error))
    } catch {
      onError('shareHost.err.invalid')
    }
  }
  return (
    <div data-share-session={s.id} className="flex items-center gap-2">
      <Users size={13} className="shrink-0 text-text-secondary" />
      <div className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5 truncate text-xs text-text-primary">
          {s.name}
          {s.typing && (
            <span data-share-session-typing className="text-[11px] text-text-secondary">
              {t('shareHost.session.typing')}
            </span>
          )}
        </span>
        <span className="block truncate text-[11px] text-text-secondary">
          <span className="font-mono" title={s.fingerprint}>
            {shortFingerprint(s.fingerprint)}
          </span>
          {' · '}
          <span className="font-mono">{s.ip}</span>
          {' · '}
          {formatSince(s.since, Date.now(), lang)}
          {' · '}
          {t('shareHost.session.watching', { count: s.watching })}
        </span>
      </div>
      <select
        aria-label={t('shareHost.session.perm')}
        data-share-session-perm
        className={selectCls}
        value={s.perm}
        onChange={(e) => void op(() => api.sessionPerm(s.id, e.target.value as SharePerm))}
      >
        {SHARE_PERMS.map((p) => (
          <option key={p} value={p}>
            {t(PERM_KEY[p])}
          </option>
        ))}
      </select>
      <button type="button" data-share-session-kick className={cn(smallBtn, 'hover:border-red-500/50 hover:text-red-400')} onClick={() => void op(() => api.kick(s.id))}>
        <LogOut size={13} />
        {t('shareHost.session.kick')}
      </button>
    </div>
  )
}
