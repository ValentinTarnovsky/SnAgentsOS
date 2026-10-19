import { useEffect } from 'react'
import { createPortal } from 'react-dom'
import { AlertTriangle, ShieldAlert } from 'lucide-react'
import { useT, type TFn } from '@/i18n'
import { cn } from '@/lib/cn'
import { answerRepoTrust, useRepoConfigUi } from '@/lib/repoConfigFlow'
import type { TrustItem } from '@/lib/repoConfig'

/** One executable line, localized (E8-FR-24). Text is rendered as text, never HTML. */
export function trustLineText(item: TrustItem, t: TFn): string {
  switch (item.kind) {
    case 'profile':
      return t('repo.trust.line.profile', { name: item.name, count: item.count })
    case 'setup':
      return t('repo.trust.line.setup', { command: item.command })
    case 'command':
      return t('repo.trust.line.command', { title: item.title, command: item.command })
    case 'agent':
      return item.prompt
        ? t('repo.trust.line.agentPrompt', { title: item.title, agent: item.agent, prompt: item.prompt })
        : t('repo.trust.line.agent', { title: item.title, agent: item.agent })
    case 'quickSend':
      return t(item.enter ? 'repo.trust.line.quickSendEnter' : 'repo.trust.line.quickSend', { label: item.label, text: item.text })
    case 'quickAgent':
      return t('repo.trust.line.quickAgent', { label: item.label, agent: item.agent, prompt: item.prompt })
  }
}

/**
 * "Trust the commands of this repo" (E8-FR-24): every executable line of the
 * file in a monospaced block, the profile line first in warning style.
 * Cancel holds the focus by default; Enter never confirms on its own.
 */
export function TrustDialog() {
  const t = useT()
  const req = useRepoConfigUi((s) => s.request)

  useEffect(() => {
    if (!req) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        answerRepoTrust(false)
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [req])

  if (!req) return null

  return createPortal(
    <div className="fixed inset-0 z-[75] flex items-center justify-center p-6">
      <div className="absolute inset-0 bg-black/60" onClick={() => answerRepoTrust(false)} />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="repo-trust-title"
        data-repo-trust
        className="relative z-10 flex max-h-[82vh] w-full max-w-xl flex-col overflow-hidden rounded-modal border border-border bg-card shadow-[0_20px_48px_-12px_rgba(0,0,0,0.6)]"
      >
        <div className="flex items-start gap-3 border-b border-border px-5 py-4">
          <ShieldAlert size={18} className="mt-0.5 shrink-0 text-amber-400" />
          <div className="min-w-0">
            {req.changed && (
              <p data-repo-trust-changed className="mb-1 text-xs font-semibold uppercase tracking-wide text-amber-400">
                {t('repo.trust.changed')}
              </p>
            )}
            <h2 id="repo-trust-title" className="text-sm font-semibold text-text-primary">{t('repo.trust.title')}</h2>
            <p className="mt-1 break-all text-xs text-text-secondary">{t('repo.trust.intro', { path: req.dir })}</p>
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          <ul data-repo-trust-lines className="space-y-1 rounded-btn border border-border bg-bg-primary p-3 font-mono text-xs">
            {req.items.map((item, i) => (
              <li
                key={i}
                data-repo-trust-line={item.kind}
                className={cn('whitespace-pre-wrap break-all', item.kind === 'profile' ? 'flex items-start gap-1.5 text-amber-400' : 'text-text-primary')}
              >
                {item.kind === 'profile' && <AlertTriangle size={12} className="mt-0.5 shrink-0" />}
                <span>{trustLineText(item, t)}</span>
              </li>
            ))}
          </ul>
        </div>
        <div className="flex justify-end gap-2 border-t border-border bg-bg-secondary/40 px-5 py-3">
          <button
            autoFocus
            data-repo-trust-cancel
            onClick={() => answerRepoTrust(false)}
            className="rounded-btn border border-border px-4 py-2 text-sm text-text-primary transition-colors hover:bg-card"
          >
            {t('common.cancel')}
          </button>
          <button
            data-repo-trust-confirm
            onClick={() => answerRepoTrust(true)}
            className="rounded-btn bg-amber-500 px-4 py-2 text-sm font-medium text-black transition-[filter] hover:brightness-110"
          >
            {t('repo.trust.confirm')}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
