import { useState } from 'react'
import { ChevronDown, ChevronsDownUp, FileDiff, FolderTree, Loader2, MessageSquare, Plus, RefreshCw, StickyNote } from 'lucide-react'
import type { ShareLinkView } from '@shared/share-guest'
import type { SharePaneInfo, SharePresetInfo, ShareState } from '@shared/share-protocol'
import { useT, type MessageKey } from '@/i18n'
import { cn } from '@/lib/cn'
import { iconFor } from '@/lib/icons'
import { toast } from '@/lib/toast'
import { paneStatusOf, useShareGuestStore } from '@/lib/shareGuestStore'
import { chatCapable, createSharedPane, panelAllowed, shareFilesKey, useShareExtrasStore } from '@/lib/shareGuestExtras'
import { collapseAll, reloadTree } from '@/lib/filesStore'
import { RightDrawer } from '@/components/ui/RightDrawer'
import { Tooltip } from '@/components/ui/Tooltip'
import { SharedChatView } from './chat/ChatView'
import { SharedNotesView } from './SharedNotesView'
import { SharedChangesView } from './SharedChangesView'
import { SharedFilesView } from './SharedFilesView'

/** i18n of a refused or failed ctl (createPane / closePane). */
export const CTL_ERR_KEY: Record<string, MessageKey> = {
  denied: 'shareGuest.ctl.err.denied',
  rate: 'shareGuest.ctl.err.rate',
  bad_preset: 'shareGuest.ctl.err.bad_preset',
  out_of_scope: 'shareGuest.ctl.err.out_of_scope',
  offline: 'shareGuest.ctl.err.offline',
  timeout: 'shareGuest.ctl.err.timeout',
  busy: 'shareGuest.ctl.err.busy',
}

export function ctlErrorText(t: (k: MessageKey) => string, error: string): string {
  return t(CTL_ERR_KEY[error] ?? 'shareGuest.ctl.err.failed')
}

const headerBtn =
  'inline-flex h-8 items-center gap-1.5 rounded-btn border border-border px-2.5 text-xs text-text-primary transition-colors hover:border-accent-violet/40 hover:bg-card disabled:cursor-not-allowed disabled:opacity-40'
const pressedBtn = 'border-accent-violet/60 bg-accent-violet/15'

/** The first pane of the grid that has a transcript to read, or null. */
export function firstChatPane(panes: SharePaneInfo[], statuses: Parameters<typeof paneStatusOf>[0], linkId: string): SharePaneInfo | null {
  return panes.find((p) => chatCapable(p, paneStatusOf(statuses, linkId, p))) ?? null
}

/**
 * The header extras of a shared workspace (app 2.4.0, item 8, S5; per guest
 * rights from app 2.6.0), each shown only with its cap: New console (the
 * host's presets only; the ack's pane shows at once), the read-only Chat,
 * Changes and Files drawers and the Notes drawer (editable with notesWrite).
 * Everything is relayed through main, which checks it again, and the host
 * enforces the caps once more.
 */
export function SharedExtrasBar({ link, state, panes }: { link: ShareLinkView; state: ShareState; panes: SharePaneInfo[] }) {
  const t = useT()
  const linkId = link.id
  const caps = state.caps
  const live = link.status === 'connected'
  const panel = useShareExtrasStore((s) => s.panel[linkId] ?? null)
  const busy = useShareExtrasStore((s) => s.ctlBusy[linkId] === true)
  const togglePanel = useShareExtrasStore((s) => s.togglePanel)
  const openPanel = useShareExtrasStore((s) => s.openPanel)
  const statuses = useShareGuestStore((s) => s.statuses)
  const [menu, setMenu] = useState(false)
  const presets = state.presets ?? []
  const chatPane = firstChatPane(panes, statuses, linkId)

  const create = async (preset: SharePresetInfo): Promise<void> => {
    setMenu(false)
    const res = await createSharedPane(linkId, preset)
    if (res.ok) {
      if (res.paneId) useShareGuestStore.getState().requestFocus(linkId, res.paneId)
      return
    }
    toast.error(t('shareGuest.ctl.createFailed'), { body: ctlErrorText(t, res.error), dedupeKey: `share-ctl:${linkId}` })
  }

  return (
    <div data-shared-extras className="contents">
      {caps.chat && (
        <button
          type="button"
          data-shared-extra="chat"
          aria-pressed={panel?.kind === 'chat'}
          disabled={!live || (!chatPane && panel?.kind !== 'chat')}
          onClick={() => {
            if (panel?.kind === 'chat') openPanel(linkId, null)
            else if (chatPane) openPanel(linkId, { kind: 'chat', paneId: chatPane.id })
          }}
          className={cn(headerBtn, panel?.kind === 'chat' && pressedBtn)}
        >
          <MessageSquare size={15} />
          {t('shareGuest.view.chat')}
        </button>
      )}
      {caps.notes && (
        <button
          type="button"
          data-shared-extra="notes"
          aria-pressed={panel?.kind === 'notes'}
          disabled={!live && panel?.kind !== 'notes'}
          onClick={() => togglePanel(linkId, { kind: 'notes' })}
          className={cn(headerBtn, panel?.kind === 'notes' && pressedBtn)}
        >
          <StickyNote size={15} />
          {t('shareGuest.view.notes')}
        </button>
      )}
      {caps.files && (
        <button
          type="button"
          data-shared-extra="files"
          aria-pressed={panel?.kind === 'files'}
          disabled={!live && panel?.kind !== 'files'}
          onClick={() => togglePanel(linkId, { kind: 'files' })}
          className={cn(headerBtn, panel?.kind === 'files' && pressedBtn)}
        >
          <FolderTree size={15} />
          {t('shareGuest.view.files')}
        </button>
      )}
      {caps.git && (
        <button
          type="button"
          data-shared-extra="changes"
          aria-pressed={panel?.kind === 'changes'}
          disabled={!live && panel?.kind !== 'changes'}
          onClick={() => togglePanel(linkId, { kind: 'changes' })}
          className={cn(headerBtn, panel?.kind === 'changes' && pressedBtn)}
        >
          <FileDiff size={15} />
          {t('shareGuest.view.changes')}
        </button>
      )}
      {caps.createPane && (
        // z-30 keeps the menu and its backdrop over the drawers (z-20).
        <div className="relative z-30">
          <button
            type="button"
            data-shared-extra="newConsole"
            aria-expanded={menu}
            aria-haspopup="menu"
            disabled={!live || busy}
            onClick={() => setMenu((v) => !v)}
            className={headerBtn}
          >
            {busy ? <Loader2 size={15} className="animate-spin motion-reduce:animate-none" /> : <Plus size={15} />}
            {t('shareGuest.view.newConsole')}
            <ChevronDown size={13} className="text-text-secondary" />
          </button>
          {menu && (
            <>
              <div className="fixed inset-0 z-10" onClick={() => setMenu(false)} />
              <div role="menu" data-shared-new-menu className="absolute right-0 z-20 mt-1.5 w-60 overflow-hidden rounded-card border border-border bg-card py-1 shadow-[0_8px_24px_-12px_rgba(0,0,0,0.6)]">
                {presets.map((preset) => {
                  const Icon = iconFor(preset.icon)
                  return (
                    <button
                      key={preset.id}
                      type="button"
                      role="menuitem"
                      data-shared-preset={preset.id}
                      onClick={() => void create(preset)}
                      className="flex w-full min-w-0 items-center gap-2.5 px-3 py-2 text-left text-sm text-text-primary transition-colors hover:bg-bg-secondary"
                    >
                      <Icon size={15} style={{ color: preset.color }} className="shrink-0" />
                      <span className="min-w-0 flex-1 truncate">{preset.name}</span>
                    </button>
                  )
                })}
                {presets.length === 0 && <p className="px-3 py-2 text-xs text-text-secondary">{t('shareGuest.ctl.noPresets')}</p>}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  )
}

/**
 * The open drawer of a shared workspace (one at a time), over the shared
 * grid like the local Notes/Changes drawers. A drawer whose cap went away
 * (perm changed) is not drawn and the store closes it.
 */
export function SharedDrawer({ link, state, panes, hostLabel }: { link: ShareLinkView; state: ShareState; panes: SharePaneInfo[]; hostLabel: string }) {
  const t = useT()
  const linkId = link.id
  const panel = useShareExtrasStore((s) => s.panel[linkId] ?? null)
  const maximized = useShareExtrasStore((s) => s.panelMax)
  const setPanelMax = useShareExtrasStore((s) => s.setPanelMax)
  const openPanel = useShareExtrasStore((s) => s.openPanel)
  const statuses = useShareGuestStore((s) => s.statuses)
  const [reloadSeq, setReloadSeq] = useState(0)
  if (!panelAllowed(panel, state.caps) || !panel) return null

  const close = (opts?: { refocus?: boolean }): void => {
    openPanel(linkId, null)
    const first = panes[0]
    if (opts?.refocus !== false && first) useShareGuestStore.getState().requestFocus(linkId, first.id)
  }

  if (panel.kind === 'chat') {
    const pane = panes.find((p) => p.id === panel.paneId)
    const chatPanes = panes.filter((p) => chatCapable(p, paneStatusOf(statuses, linkId, p)))
    if (!pane) return null
    return (
      <RightDrawer
        id="share-chat"
        title={t('shareGuest.chat.title', { pane: pane.title })}
        icon={<MessageSquare size={15} className="shrink-0 text-text-secondary" />}
        defaultWidth="clamp(420px, 42%, 820px)"
        maximized={maximized}
        onMaximize={setPanelMax}
        onClose={close}
        actions={
          chatPanes.length > 1 ? (
            <select
              aria-label={t('shareGuest.chat.pickPane')}
              data-shared-chat-pick
              value={pane.id}
              onChange={(e) => openPanel(linkId, { kind: 'chat', paneId: e.target.value })}
              className="h-7 max-w-[180px] rounded-btn border border-border bg-bg-secondary px-1.5 text-xs text-text-primary"
            >
              {chatPanes.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.title}
                </option>
              ))}
            </select>
          ) : null
        }
      >
        <SharedChatView key={pane.id} link={link} pane={pane} status={paneStatusOf(statuses, linkId, pane)} hostLabel={hostLabel} />
      </RightDrawer>
    )
  }

  if (panel.kind === 'files') {
    const key = shareFilesKey(linkId)
    const iconBtn = 'flex h-7 w-7 shrink-0 items-center justify-center rounded-btn text-text-secondary transition-colors hover:bg-card hover:text-text-primary'
    return (
      <RightDrawer
        id="share-files"
        title={state.title ? `${t('shareGuest.files.title')} - ${state.title}` : t('shareGuest.files.title')}
        icon={<FolderTree size={15} className="shrink-0 text-text-secondary" />}
        defaultWidth="clamp(640px, 62%, 1400px)"
        maximized={maximized}
        onMaximize={setPanelMax}
        onClose={close}
        actions={
          <>
            <Tooltip label={t('files.refresh')} side="bottom">
              <button type="button" aria-label={t('files.refresh')} data-shared-files-refresh onClick={() => void reloadTree(key)} className={iconBtn}>
                <RefreshCw size={13} />
              </button>
            </Tooltip>
            <Tooltip label={t('files.collapse')} side="bottom">
              <button type="button" aria-label={t('files.collapse')} data-shared-files-collapse onClick={() => collapseAll(key)} className={iconBtn}>
                <ChevronsDownUp size={14} />
              </button>
            </Tooltip>
          </>
        }
      >
        <SharedFilesView link={link} hostLabel={hostLabel} />
      </RightDrawer>
    )
  }

  if (panel.kind === 'notes') {
    return (
      <RightDrawer
        id="share-notes"
        title={state.caps.notesWrite ? t('shareGuest.notes.titleEdit') : t('shareGuest.notes.title')}
        icon={<StickyNote size={15} className="shrink-0 text-text-secondary" />}
        defaultWidth={state.caps.notesWrite ? 'clamp(620px, 52%, 1100px)' : 'clamp(520px, 46%, 980px)'}
        maximized={maximized}
        onMaximize={setPanelMax}
        onClose={close}
      >
        <SharedNotesView link={link} hostLabel={hostLabel} canWrite={state.caps.notesWrite === true} />
      </RightDrawer>
    )
  }

  return (
    <RightDrawer
      id="share-changes"
      title={t('shareGuest.changes.title')}
      icon={<FileDiff size={15} className="shrink-0 text-text-secondary" />}
      defaultWidth="clamp(560px, 55%, 1100px)"
      maximized={maximized}
      onMaximize={setPanelMax}
      onClose={close}
      actions={
        <Tooltip label={t('changes.refresh')} side="bottom">
          <button
            type="button"
            aria-label={t('changes.refresh')}
            data-shared-changes-refresh
            onClick={() => setReloadSeq((n) => n + 1)}
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-btn text-text-secondary transition-colors hover:bg-card hover:text-text-primary"
          >
            <RefreshCw size={14} />
          </button>
        </Tooltip>
      }
    >
      <SharedChangesView link={link} reloadSeq={reloadSeq} />
    </RightDrawer>
  )
}
