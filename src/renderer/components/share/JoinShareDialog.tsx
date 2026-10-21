import { useEffect, useRef, useState } from 'react'
import { AlertTriangle } from 'lucide-react'
import type { SharePreview, SharePreviewRes } from '@shared/share-guest'
import { SHARE_INVITE_PREFIX, SHARE_LIMITS } from '@shared/share-protocol'
import { Modal } from '@/components/common/Modal'
import { Button } from '@/components/ui/Button'
import { useAppStore } from '@/lib/store'
import { snapshotConfig } from '@/lib/persist'
import { linkLive, useShareGuestStore } from '@/lib/shareGuestStore'
import { useT, type MessageKey } from '@/i18n'
import { JOIN_ERR_KEY, PERM_KEY, SCOPE_KEY } from './shareLabels'
import { LinkStatusPanel } from './LinkStatusPanel'

const EP_KEY: Record<SharePreview['endpoints'][number]['kind'], MessageKey> = {
  ts: 'shareGuest.join.ep.ts',
  lan: 'shareGuest.join.ep.lan',
  loop: 'shareGuest.join.ep.loop',
}

/** Invites are long single lines: whitespace a chat client wrapped in is dropped. */
const cleanInvite = (s: string): string => s.replace(/\s+/g, '')

/**
 * "Join a share" (app 2.4.0, item 8, S3): paste an invite, see what it is
 * (host, key fingerprint, scope, the permission it hints, where it connects)
 * from main's strict parse, set the name the host sees, Join. Then the same
 * dialog waits for the host's approval (password field when the share has
 * one) and opens the shared view once connected.
 */
export function JoinShareDialog() {
  const t = useT()
  const join = useShareGuestStore((s) => s.join)
  const closeJoin = useShareGuestStore((s) => s.closeJoin)
  const activate = useShareGuestStore((s) => s.activate)
  const share = useAppStore((s) => s.settings.share)
  const [invite, setInvite] = useState('')
  const [preview, setPreview] = useState<SharePreviewRes | null>(null)
  const [name, setName] = useState('')
  const [error, setError] = useState<MessageKey | null>(null)
  const [busy, setBusy] = useState(false)
  const [linkId, setLinkId] = useState<string | null>(null)
  const link = useShareGuestStore((s) => (linkId ? s.links[linkId] : undefined))
  const seq = useRef(0)

  // Fresh form on every open; a sidebar row opens it straight on its link's wait.
  useEffect(() => {
    if (!join.open) return
    setInvite('')
    setPreview(null)
    setError(null)
    setBusy(false)
    setName(share?.guestName ?? '')
    setLinkId(join.linkId ?? null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [join.open, join.linkId])

  // main's strict parse, debounced; nothing is saved until Join.
  useEffect(() => {
    const text = cleanInvite(invite)
    const n = ++seq.current
    if (!text) {
      setPreview(null)
      return
    }
    const id = setTimeout(() => {
      void window.snApi.share.guest.preview(text).then((r) => {
        if (n === seq.current) setPreview(r)
      })
    }, 200)
    return () => clearTimeout(id)
  }, [invite])

  // Connected: the dialog's work is done, the shared view takes over.
  useEffect(() => {
    if (!join.open || !link || !linkLive(link)) return
    closeJoin()
    activate(link.id)
  }, [join.open, link, closeJoin, activate])

  if (!join.open) return null

  const onJoin = async (): Promise<void> => {
    const text = cleanInvite(invite)
    if (!text || busy) return
    setBusy(true)
    setError(null)
    try {
      const trimmed = name.trim().slice(0, SHARE_LIMITS.guestNameMax)
      if (share && trimmed !== share.guestName) {
        useAppStore.getState().updateSettings({ share: { ...share, guestName: trimmed } })
        // main reads the name from config.json when it says hello: write it now, not after the debounce.
        await Promise.resolve(window.snApi.config.save(snapshotConfig())).catch(() => undefined)
      }
      const r = await window.snApi.share.guest.join(text)
      if (!r.ok) {
        setError(JOIN_ERR_KEY[r.error])
        return
      }
      useShareGuestStore.setState((s) => ({
        links: { ...s.links, [r.link.id]: s.links[r.link.id] ?? r.link },
        order: s.order.includes(r.link.id) ? s.order : [...s.order, r.link.id],
      }))
      setLinkId(r.link.id)
    } finally {
      setBusy(false)
    }
  }

  const p = preview?.ok ? preview.preview : null
  const previewErr = preview && !preview.ok ? JOIN_ERR_KEY[preview.error] : null
  const looksLikeInvite = cleanInvite(invite).startsWith(SHARE_INVITE_PREFIX)

  return (
    <Modal open onClose={closeJoin} title={t('shareGuest.join.title')} className="max-w-lg">
      <div className="space-y-4 p-5" data-join-share>
        {link ? (
          <LinkStatusPanel link={link} />
        ) : (
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault()
              void onJoin()
            }}
          >
            <label className="flex flex-col gap-1 text-xs text-text-secondary">
              {t('shareGuest.join.invite')}
              <textarea
                autoFocus
                data-join-invite
                rows={3}
                spellCheck={false}
                value={invite}
                maxLength={4096}
                placeholder={t('shareGuest.join.invitePlaceholder')}
                onChange={(e) => setInvite(e.target.value)}
                className="resize-none rounded-btn border border-border bg-bg-primary px-3 py-2 font-mono text-xs text-text-primary outline-none placeholder:text-text-secondary/60 focus:border-accent-violet/60"
              />
            </label>
            {previewErr && looksLikeInvite && (
              <p className="text-xs text-state-error" data-join-preview-error>
                {t(previewErr)}
              </p>
            )}
            {previewErr && !looksLikeInvite && cleanInvite(invite).length > 0 && (
              <p className="text-xs text-state-error" data-join-preview-error>
                {t('shareGuest.join.err.format')}
              </p>
            )}
            {p && (
              <dl data-join-preview className="grid grid-cols-[auto,1fr] gap-x-3 gap-y-1.5 rounded-card border border-border bg-bg-secondary/40 p-3 text-xs">
                <dt className="text-text-secondary">{t('shareGuest.join.host')}</dt>
                <dd className="min-w-0 truncate text-text-primary" data-join-host>
                  {p.hostLabel}
                </dd>
                <dt className="text-text-secondary">{t('shareGuest.join.fingerprint')}</dt>
                <dd className="font-mono text-text-primary">{p.hostFingerprint}</dd>
                <dt className="text-text-secondary">{t('shareGuest.join.scope')}</dt>
                <dd className="min-w-0 truncate text-text-primary">
                  {t(SCOPE_KEY[p.scope.kind])}: {p.scope.label}
                </dd>
                <dt className="text-text-secondary">{t('shareGuest.join.perm')}</dt>
                <dd className="text-text-primary">
                  {t(PERM_KEY[p.perm])} <span className="text-text-secondary">({t('shareGuest.join.permNote')})</span>
                </dd>
                <dt className="text-text-secondary">{t('shareGuest.join.endpoints')}</dt>
                <dd className="min-w-0 text-text-primary">
                  {p.endpoints.map((e) => (
                    <span key={`${e.address}:${e.port}`} className="mr-2 inline-block font-mono">
                      {e.address}:{e.port} <span className="font-sans text-text-secondary">({t(EP_KEY[e.kind])})</span>
                    </span>
                  ))}
                </dd>
              </dl>
            )}
            {p?.expired && (
              <p className="flex items-start gap-1.5 text-xs text-state-action">
                <AlertTriangle size={13} className="mt-px shrink-0" />
                {t('shareGuest.join.expired')}
              </p>
            )}
            {p?.existingId && <p className="text-xs text-text-secondary">{t('shareGuest.join.existing')}</p>}
            <label className="flex flex-col gap-1 text-xs text-text-secondary">
              {t('shareGuest.join.name')}
              <input
                data-join-name
                value={name}
                maxLength={SHARE_LIMITS.guestNameMax}
                placeholder={t('shareGuest.join.namePlaceholder')}
                onChange={(e) => setName(e.target.value)}
                className="h-9 rounded-btn border border-border bg-bg-primary px-3 text-sm text-text-primary outline-none placeholder:text-text-secondary/60 focus:border-accent-violet/60"
              />
            </label>
            {error && (
              <p className="text-xs text-state-error" data-join-error>
                {t(error)}
              </p>
            )}
            <div className="flex justify-end gap-2">
              <Button type="button" variant="ghost" size="sm" onClick={closeJoin}>
                {t('common.cancel')}
              </Button>
              <Button type="submit" size="sm" disabled={!p || busy} data-join-submit>
                {t('shareGuest.join.submit')}
              </Button>
            </div>
          </form>
        )}
      </div>
    </Modal>
  )
}
