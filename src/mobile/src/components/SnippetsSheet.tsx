/**
 * Lists the desktop's saved snippets and writes the tapped one straight into
 * the subscribed console (no Enter appended, mirroring insertToConsole on the
 * desktop). No input lives in this sheet - it never introduces a second
 * focusable field while the phone is on the live screen.
 */
import type { ReactNode } from 'react'
import { Sheet } from './Sheet'
import { useRemoteStore } from '../lib/store'
import { client } from '../lib/client'
import { t } from '../lib/i18n'

export function SnippetsSheet({ open, onClose }: { open: boolean; onClose: () => void }): ReactNode {
  const snapshot = useRemoteStore((s) => s.snapshot)
  const snippets = snapshot?.snippets ?? []

  return (
    <Sheet open={open} onClose={onClose} title={t('key.snippets')}>
      {snippets.length === 0 ? (
        <p className="text-xs text-text-secondary">{t('snip.empty')}</p>
      ) : (
        <div className="flex flex-col gap-2">
          {snippets.map((snip) => (
            <button
              key={snip.id}
              onClick={() => {
                client.sendInput(snip.text)
                onClose()
              }}
              className="flex flex-col items-start gap-0.5 rounded-btn border border-border bg-bg-secondary px-3 py-2.5 text-left active:bg-card"
            >
              <span className="text-sm font-medium text-text-primary">{snip.name}</span>
              <span className="line-clamp-1 font-mono text-[11px] text-text-secondary">{snip.text}</span>
            </button>
          ))}
        </div>
      )}
    </Sheet>
  )
}
