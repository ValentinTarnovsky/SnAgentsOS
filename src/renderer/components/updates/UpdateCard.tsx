import { useEffect } from 'react'
import { AlertTriangle, ChevronDown, Download, ExternalLink, Loader2, RotateCw, Sparkles, X } from 'lucide-react'
import { BRAND } from '@shared/brand'
import { useT, type TFn } from '@/i18n'
import { useAppStore } from '@/lib/store'
import { toast } from '@/lib/toast'
import { installErrorText, notesExcerpt, useUpdaterStore } from '@/lib/updater'
import { cn } from '@/lib/cn'
import { closesConsoles, isUpdateCardVisible, needsDoubleConfirm, newerLabel } from './update-card-visibility'
import { impactText, useDoubleConfirm, useUpdateImpact } from './useUpdateImpact'

/** dedupeKey of the card in the toast stack (one card, refreshed in place). */
export const UPDATE_CARD_KEY = 'update'

const primaryCls =
  'inline-flex items-center gap-1.5 rounded-btn px-3 py-1.5 text-xs font-medium text-white transition-[filter] hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-60 bg-[linear-gradient(135deg,var(--color-accent-violet),var(--color-accent-blue))]'
const dangerCls =
  'inline-flex items-center gap-1.5 rounded-btn bg-red-500 px-3 py-1.5 text-xs font-medium text-white transition-[filter] hover:brightness-110'
const ghostCls =
  'inline-flex items-center gap-1.5 rounded-btn border border-border px-3 py-1.5 text-xs font-medium text-text-primary transition-colors hover:border-accent-violet/40 hover:bg-bg-secondary'
const linkCls = 'text-xs text-text-secondary underline-offset-2 transition-colors hover:text-text-primary hover:underline'
const iconBtnCls =
  'rounded-btn p-0.5 text-text-secondary transition-colors hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:text-text-secondary'

/**
 * Whether the update card belongs in the toast stack right now (E4-FR-12, 13,
 * 16). It steps aside while ReleaseNotesModal is open: the stack sits above
 * the modals and the card would cover the notes it links to.
 */
export function useUpdateCardVisible(): boolean {
  const dismissed = useAppStore((s) => s.settings.updateDismissedVersion)
  return useUpdaterStore((s) =>
    !s.notesOpen &&
    isUpdateCardVisible({
      phase: s.phase,
      latest: s.info?.available ? s.info.latestVersion : null,
      dismissed,
      sessionDismissed: s.sessionDismissed,
      collapsed: s.cardCollapsed,
      userInitiated: s.userInitiated,
      installable: !!s.info?.installable,
    }),
  )
}

/**
 * Keeps the update card in the toast stack while it is visible: one
 * persistent, top-priority card that reads the updater store itself, so a
 * re-check or the download progress refresh it in place (E4-FR-18).
 */
export function UpdateCardHost() {
  const visible = useUpdateCardVisible()
  useEffect(() => {
    if (!visible) {
      toast.dismissByKey(UPDATE_CARD_KEY)
      return
    }
    if (!toast.has(UPDATE_CARD_KEY)) {
      toast.card(<UpdateCard />, { dedupeKey: UPDATE_CARD_KEY, durationMs: null, priority: 3, hideClose: true })
    }
  }, [visible])
  useEffect(() => () => toast.dismissByKey(UPDATE_CARD_KEY), [])
  return null
}

function openRelease(url: string | null | undefined): void {
  if (url) void window.snApi.system.openExternal(url)
}

type NoteKey = 'update.portableNote' | 'update.installerNote' | 'update.openHint' | 'update.manualHint'

/** How the update is applied on this machine, shown as the [Update] tooltip. */
export function installNoteKey(kind: string): NoteKey {
  if (kind === 'win-portable' || kind === 'linux-appimage') return 'update.portableNote'
  if (kind === 'win-installer') return 'update.installerNote'
  if (kind === 'mac-dmg' || kind === 'linux-deb') return 'update.openHint'
  return 'update.manualHint'
}

function confirmLabel(t: TFn, consoles: number): string {
  return consoles === 1 ? t('update.impact.confirmOne') : t('update.impact.confirm', { count: consoles })
}

/**
 * The update card (E4-FR-12..17): offer with a 3-line excerpt, "+N versions",
 * the console impact notice and the double confirm, then the download with a
 * collapse chevron, the error with [Retry], or the opened installer.
 */
export function UpdateCard() {
  const t = useT()
  const info = useUpdaterStore((s) => s.info)
  const phase = useUpdaterStore((s) => s.phase)
  const progress = useUpdaterStore((s) => s.progress)
  const installError = useUpdaterStore((s) => s.installError)
  const install = useUpdaterStore((s) => s.install)
  const dismissCard = useUpdaterStore((s) => s.dismissCard)
  const collapseCard = useUpdaterStore((s) => s.collapseCard)
  const setNotesOpen = useUpdaterStore((s) => s.setNotesOpen)
  const updateSettings = useAppStore((s) => s.updateSettings)
  const openSettings = useAppStore((s) => s.openSettings)

  const kind = info?.installKind ?? 'none'
  const offer = phase === 'available'
  const busyPhase = phase === 'downloading' || phase === 'installing'
  const impactActive = (offer && closesConsoles(kind)) || (phase === 'opened' && kind === 'win-installer')
  const { consoles, busy } = useUpdateImpact(impactActive)
  const confirm = useDoubleConfirm(offer && needsDoubleConfirm({ kind, busyAgents: busy }))

  if (!info) return null
  const latest = info.latestVersion ?? ''
  const excerpt = notesExcerpt(info.notes)
  const newer = newerLabel(info.newerCount ?? 0)
  const percent = progress?.percent ?? 0

  const onUpdate = (): void => {
    if (confirm.click()) void install()
  }
  const onClose = (): void => {
    if (offer) dismissCard((version) => updateSettings({ updateDismissedVersion: version }))
    else collapseCard()
  }

  return (
    <div data-update-card="" data-update-phase={phase} className="flex flex-col gap-2">
      <div className="flex items-start gap-2.5">
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-btn bg-[linear-gradient(135deg,var(--color-accent-violet),var(--color-accent-blue))] text-white">
          <Sparkles size={14} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="break-words font-medium leading-snug">
            {t('update.card.title', { product: BRAND.productName, version: latest })}
          </p>
          <p className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-text-secondary">
            <span className="font-mono tabular-nums">
              {info.currentVersion} → {latest}
            </span>
            {newer && (
              <span data-update-newer={newer.count} className="text-accent-violet">
                {newer.more ? t('update.card.newerMore', { count: newer.count }) : t('update.card.newer', { count: newer.count })}
              </span>
            )}
          </p>
        </div>
        <div className="-mr-1 -mt-0.5 flex shrink-0 items-center gap-0.5">
          {busyPhase && (
            <button type="button" onClick={collapseCard} aria-label={t('update.card.collapse')} title={t('update.card.collapse')} data-update-collapse="" className={iconBtnCls}>
              <ChevronDown size={14} />
            </button>
          )}
          <button
            type="button"
            onClick={onClose}
            disabled={busyPhase}
            aria-label={offer ? t('update.card.dismiss') : t('update.card.close')}
            title={offer ? t('update.card.dismiss') : t('update.card.close')}
            data-update-close=""
            className={iconBtnCls}
          >
            <X size={14} />
          </button>
        </div>
      </div>

      {offer && (
        <>
          {excerpt.length > 0 && (
            <p data-update-excerpt="" className="line-clamp-3 whitespace-pre-line break-words text-xs leading-relaxed text-text-secondary">
              {excerpt.join('\n')}
            </p>
          )}
          <button type="button" onClick={() => setNotesOpen(true)} className={cn(linkCls, 'self-start')}>
            {t('update.card.fullNotes')}
          </button>
          {closesConsoles(kind) && info.installable && consoles !== null && (
            <p data-update-impact="" className={cn('text-xs', busy > 0 ? 'text-amber-400' : 'text-text-secondary')}>
              {impactText(t, consoles, busy)}
            </p>
          )}
          <div className="flex flex-wrap items-center gap-2">
            {info.installable ? (
              <button
                type="button"
                onClick={onUpdate}
                title={t(installNoteKey(kind))}
                data-update-primary={confirm.armed ? 'confirm' : 'update'}
                className={confirm.armed ? dangerCls : primaryCls}
              >
                <Download size={13} />
                {confirm.armed ? confirmLabel(t, Math.max(consoles ?? 0, busy)) : t('update.card.update')}
              </button>
            ) : (
              <button
                type="button"
                onClick={() => openRelease(info.releaseUrl)}
                title={t('update.manualHint')}
                data-update-primary="release"
                className={primaryCls}
              >
                <ExternalLink size={13} />
                {t('update.viewRelease')}
              </button>
            )}
            <button type="button" onClick={onClose} className={ghostCls}>
              {t('update.later')}
            </button>
          </div>
          <button type="button" onClick={() => openSettings('updates#autoCheck')} className={cn(linkCls, 'self-start')}>
            {t('update.card.disableAuto')}
          </button>
        </>
      )}

      {busyPhase && (
        <div className="space-y-1.5" data-update-progress={percent}>
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-bg-secondary">
            <div
              className="h-full rounded-full bg-[linear-gradient(135deg,var(--color-accent-violet),var(--color-accent-blue))] transition-[width] duration-150"
              style={{ width: `${phase === 'installing' ? 100 : percent}%` }}
            />
          </div>
          <p className="flex items-center gap-1.5 text-xs tabular-nums text-text-secondary">
            {phase === 'installing' ? (
              <>
                <Loader2 size={12} className="animate-spin" />
                {t('update.card.installing')}
              </>
            ) : (
              t('update.card.downloading', { percent })
            )}
          </p>
        </div>
      )}

      {phase === 'failed' && (
        <>
          <p className="flex items-start gap-1.5 text-xs text-red-400" role="alert">
            <AlertTriangle size={13} className="mt-px shrink-0" />
            <span className="break-words">
              {installError ? installErrorText(t, installError) : t('update.card.failedTitle')}
            </span>
          </p>
          <div className="flex flex-wrap items-center gap-2">
            {info.installable && (
              <button type="button" onClick={() => void install()} data-update-retry="" className={primaryCls}>
                <RotateCw size={13} />
                {t('update.card.retry')}
              </button>
            )}
            <button type="button" onClick={() => openRelease(info.releaseUrl)} className={ghostCls}>
              <ExternalLink size={13} />
              {t('update.viewRelease')}
            </button>
          </div>
        </>
      )}

      {phase === 'opened' && (
        <p className="text-xs text-emerald-400">
          {kind === 'win-installer' && consoles
            ? consoles === 1
              ? t('update.card.openedConsolesOne')
              : t('update.card.openedConsoles', { count: consoles })
            : t('update.openedInstaller')}
        </p>
      )}
    </div>
  )
}
