/**
 * Bottom-sheet workspace + console picker. Lists every workspace (active one
 * highlighted) and its panes. Tapping a pane in the active workspace just
 * subscribes; tapping a pane in another workspace asks the desktop to switch
 * workspace first (triggering any lazy pty spawns) then subscribes - a
 * not-yet-running pane shows a spinner until the server pushes its replay.
 */
import { useState, type ReactNode } from 'react'
import { clsx } from 'clsx'
import { Loader2, Pencil } from 'lucide-react'
import { Sheet } from './Sheet'
import { RenameSheet } from './RenameSheet'
import { useRemoteStore } from '../lib/store'
import { client } from '../lib/client'
import { t } from '../lib/i18n'

interface RenameTarget {
  workspaceId: string
  paneId: string
  title: string
}

export function ConsoleDrawer({ open, onClose }: { open: boolean; onClose: () => void }): ReactNode {
  const snapshot = useRemoteStore((s) => s.snapshot)
  const activePaneId = useRemoteStore((s) => s.activePaneId)
  const [renameTarget, setRenameTarget] = useState<RenameTarget | null>(null)

  if (!snapshot) return null

  const pickPane = (workspaceId: string, paneId: string): void => {
    if (workspaceId === snapshot.activeWorkspaceId) client.viewPane(paneId)
    else void client.switchWorkspaceAndView(workspaceId, paneId)
    onClose()
  }

  return (
    <>
    <Sheet open={open} onClose={onClose} title={t('main.workspaces')}>
      <div className="flex flex-col gap-4">
        {snapshot.workspaces.map((ws) => {
          const isActiveWs = ws.id === snapshot.activeWorkspaceId
          return (
            <div key={ws.id}>
              <div className="mb-1.5 flex items-center gap-2 px-1">
                <span
                  className={clsx('text-xs font-semibold uppercase tracking-wide', isActiveWs ? 'text-accent-violet' : 'text-text-secondary')}
                >
                  {ws.name}
                </span>
              </div>
              <div className="flex flex-col gap-1">
                {ws.panes.length === 0 && (
                  <div className="px-3 py-2 text-xs text-text-secondary">-</div>
                )}
                {ws.panes.map((pane) => {
                  const selected = pane.id === activePaneId
                  return (
                    <div
                      key={pane.id}
                      role="button"
                      tabIndex={0}
                      onClick={() => pickPane(ws.id, pane.id)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault()
                          pickPane(ws.id, pane.id)
                        }
                      }}
                      className={clsx(
                        'flex items-center gap-3 rounded-btn border px-3 py-2.5 text-left transition',
                        selected
                          ? 'border-accent-violet bg-accent-violet/10'
                          : 'border-transparent bg-bg-secondary active:bg-card',
                      )}
                    >
                      <span
                        className="h-2.5 w-2.5 shrink-0 rounded-full"
                        style={{ background: pane.color || 'var(--color-accent-violet)' }}
                      />
                      <span className="min-w-0 flex-1 truncate text-sm text-text-primary">{pane.title}</span>
                      {pane.running ? (
                        <span className="text-[10px] font-medium uppercase text-green-400">{t('main.running')}</span>
                      ) : (
                        <span className="text-[10px] font-medium uppercase text-text-secondary">{t('main.stopped')}</span>
                      )}
                      {selected && !pane.running && <Loader2 size={14} className="spin text-accent-violet" />}
                      <button
                        onClick={(e) => {
                          e.stopPropagation()
                          setRenameTarget({ workspaceId: ws.id, paneId: pane.id, title: pane.title })
                        }}
                        onKeyDown={(e) => e.stopPropagation()}
                        className="shrink-0 rounded p-1 text-text-secondary transition-colors hover:text-text-primary"
                        title={t('act.rename')}
                      >
                        <Pencil size={14} />
                      </button>
                    </div>
                  )
                })}
              </div>
            </div>
          )
        })}
      </div>
    </Sheet>
    <RenameSheet
      open={renameTarget != null}
      initial={renameTarget?.title ?? ''}
      onClose={() => setRenameTarget(null)}
      onSave={(title) => {
        if (renameTarget) {
          void client.sendCtl({
            kind: 'renamePane',
            workspaceId: renameTarget.workspaceId,
            paneId: renameTarget.paneId,
            title,
          })
        }
      }}
    />
    </>
  )
}
