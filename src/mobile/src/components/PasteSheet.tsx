/**
 * Paste fallback. navigator.clipboard.readText is unavailable on http origins,
 * so instead of reading the clipboard we give the user a textarea to type/paste
 * into, then route the text through xterm's term.paste() - which normalizes
 * newlines and, when the inner app enabled bracketed-paste mode, wraps it so a
 * multi-line block is inserted literally instead of each line auto-running.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Sheet } from './Sheet'
import { PrimaryButton } from './InfoScreen'
import { getActiveTerm } from '../lib/terminalBus'
import { client } from '../lib/client'
import { useRemoteStore } from '../lib/store'
import { t } from '../lib/i18n'

export function PasteSheet({ open, onClose }: { open: boolean; onClose: () => void }): ReactNode {
  const [text, setText] = useState('')
  const ref = useRef<HTMLTextAreaElement | null>(null)
  const connected = useRemoteStore((s) => s.connected)

  useEffect(() => {
    if (open) {
      setText('')
      // Defer focus until after the slide-up so the caret lands correctly.
      const id = setTimeout(() => ref.current?.focus(), 60)
      return () => clearTimeout(id)
    }
  }, [open])

  const submit = (): void => {
    // term.paste reaches the socket through onData, which drops the result of
    // sendInput: check first so an offline paste keeps the text (E1-FR-14).
    if (!client.isOpen()) return
    const term = getActiveTerm()
    if (term && text) term.paste(text)
    onClose()
  }

  return (
    <Sheet open={open} onClose={onClose} title={t('key.paste')}>
      <label className="mb-2 block text-xs font-medium text-text-secondary">{t('act.pasteLabel')}</label>
      <textarea
        ref={ref}
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={t('act.pastePlaceholder')}
        rows={5}
        className="mb-4 w-full resize-none rounded-btn border border-border bg-bg-secondary px-3 py-2 font-mono text-sm text-text-primary outline-none focus:border-accent-violet"
      />
      <PrimaryButton onClick={submit} disabled={text.length === 0 || !connected}>
        {connected ? t('key.paste') : t('conn.sendOffline')}
      </PrimaryButton>
    </Sheet>
  )
}
