import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { Megaphone } from 'lucide-react'
import { useAppStore } from '@/lib/store'
import { broadcastToWorkspace } from '@/lib/broadcastPrompt'
import { useT } from '@/i18n'

/**
 * Global prompt broadcaster: mounted once at the app level, gated on the store's
 * `globalPromptOpen`. It always targets the ACTIVE workspace and inserts the same
 * text into every active (non-minimized) console of that workspace, WITHOUT Enter,
 * so the user reviews and runs it in each console.
 */
export function GlobalPromptDialog() {
  const t = useT()
  const open = useAppStore((s) => s.globalPromptOpen)
  const setOpen = useAppStore((s) => s.setGlobalPromptOpen)
  const workspaces = useAppStore((s) => s.workspaces)
  const activeId = useAppStore((s) => s.activeWorkspaceId)
  const minimizedMap = useAppStore((s) => s.minimized)
  const [prompt, setPrompt] = useState('')

  const workspace = workspaces.find((w) => w.id === activeId) ?? null
  const minimizedIds = workspace ? (minimizedMap[workspace.id] ?? []) : []
  const activeCount = workspace
    ? workspace.panes.filter((p) => !minimizedIds.includes(p.id)).length
    : 0
  const canSend = prompt.trim().length > 0 && activeCount > 0

  // Start each session with an empty prompt.
  useEffect(() => {
    if (open) setPrompt('')
  }, [open])

  if (!open || !workspace) return null

  const close = (): void => setOpen(false)
  const send = (): void => {
    if (!canSend) return
    broadcastToWorkspace(workspace, prompt.trim())
    close()
  }

  return createPortal(
    <div className="fixed inset-0 z-[75] flex items-center justify-center p-6">
      <div className="absolute inset-0 bg-black/60" onClick={close} />
      <div className="relative z-10 w-full max-w-md overflow-hidden rounded-modal border border-border bg-card shadow-[0_20px_48px_-12px_rgba(0,0,0,0.6)]">
        <div className="space-y-4 p-5">
          <div className="flex items-center gap-2">
            <Megaphone size={16} className="text-accent-violet" />
            <h2 className="text-sm font-semibold text-text-primary">{t('globalPrompt.title')}</h2>
          </div>

          <textarea
            autoFocus
            rows={5}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                e.preventDefault()
                send()
              } else if (e.key === 'Escape') {
                e.preventDefault()
                close()
              }
            }}
            placeholder={t('globalPrompt.placeholder')}
            className="w-full resize-none rounded-btn border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary outline-none focus:border-accent-violet/60"
          />

          <p className="text-xs text-text-secondary/80">
            {activeCount > 0 ? t('globalPrompt.target', { count: activeCount }) : t('globalPrompt.empty')}
          </p>
          <p className="-mt-2 text-xs text-text-secondary/60">{t('globalPrompt.hint')}</p>
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-border bg-bg-secondary/40 px-5 py-3">
          <button
            onClick={close}
            className="rounded-btn border border-border px-4 py-2 text-sm text-text-primary transition-colors hover:bg-card"
          >
            {t('common.cancel')}
          </button>
          <button
            onClick={send}
            disabled={!canSend}
            className="rounded-btn bg-[linear-gradient(135deg,var(--color-accent-violet),var(--color-accent-blue))] px-4 py-2 text-sm font-medium text-white transition-[filter] hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {t('globalPrompt.send')}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
