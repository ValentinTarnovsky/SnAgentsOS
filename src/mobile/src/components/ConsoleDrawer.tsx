/**
 * Bottom-sheet workspace + console picker. Lists every workspace (active one
 * highlighted) and its panes. Tapping a pane in the active workspace just
 * subscribes; tapping a pane in another workspace asks the desktop to switch
 * workspace first (triggering any lazy pty spawns) then subscribes - a
 * not-yet-running pane shows a spinner until the server pushes its replay.
 */
import type { ReactNode } from 'react'
import { clsx } from 'clsx'
import { Loader2 } from 'lucide-react'
import { Sheet } from './Sheet'
import { useRemoteStore } from '../lib/store'
import { client } from '../lib/client'
import { t } from '../lib/i18n'

export function ConsoleDrawer({ open, onClose }: { open: boolean; onClose: () => void }): ReactNode {
  const snapshot = useRemoteStore((s) => s.snapshot)
  const activePaneId = useRemoteStore((s) => s.activePaneId)

  if (!snapshot) return null

  const pickPane = (workspaceId: string, paneId: string): void => {
    if (workspaceId === snapshot.activeWorkspaceId) client.viewPane(paneId)
    else void client.switchWorkspaceAndView(workspaceId, paneId)
    onClose()
  }

  return (
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
                    <button
                      key={pane.id}
                      onClick={() => pickPane(ws.id, pane.id)}
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
                    </button>
                  )
                })}
              </div>
            </div>
          )
        })}
      </div>
    </Sheet>
  )
}
