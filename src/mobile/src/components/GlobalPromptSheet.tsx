/**
 * "Prompt to every console" (E2-FR-09), moved from the old action sheet. It
 * targets the workspace of the kebab that opened it, never the desktop's
 * active one: `ctl globalPrompt` for that workspace, then the "Sent to N"
 * toast from the ack.
 */
import { useState, type ReactNode } from 'react'
import { Sheet } from './Sheet'
import { MicButton, VoiceInterim } from './MicButton'
import { spaced, stopDictation } from '../lib/voice'
import { PrimaryButton } from './InfoScreen'
import { useRemoteStore } from '../lib/store'
import { client } from '../lib/client'
import { t } from '../lib/i18n'

export function GlobalPromptSheet({
  open,
  onClose,
  workspaceId,
}: {
  open: boolean
  onClose: () => void
  workspaceId: string | null
}): ReactNode {
  const [text, setText] = useState('')
  const setToast = useRemoteStore((s) => s.setToast)
  const wsName = useRemoteStore((s) => s.snapshot?.workspaces.find((w) => w.id === workspaceId)?.name ?? '')

  const submit = async (): Promise<void> => {
    if (!workspaceId || !text) return
    stopDictation('globalPrompt', true)
    const res = await client.sendCtl({ kind: 'globalPrompt', workspaceId, text })
    setToast(res.ok ? t('act.promptSent', { n: res.info ?? 0 }) : t('toast.actionFailed'))
    setText('')
    onClose()
  }

  return (
    <Sheet open={open} onClose={onClose} title={wsName ? `${t('home.promptAll')} - ${wsName}` : t('home.promptAll')}>
      <VoiceInterim owner="globalPrompt" />
      <div className="mb-4 flex items-start gap-2">
        <textarea
          data-global-prompt={workspaceId ?? ''}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={t('act.promptPlaceholder')}
          rows={4}
          maxLength={16384}
          className="min-w-0 flex-1 resize-none rounded-btn border border-border bg-bg-secondary px-3 py-2 text-base text-text-primary outline-none focus:border-accent-violet"
        />
        {/* v2.2: dictation appends to the prompt, never sends it. */}
        {open && <MicButton owner="globalPrompt" resetKey={workspaceId} onFinal={(chunk) => setText((prev) => (prev + spaced(prev, chunk)).slice(0, 16384))} />}
      </div>
      <PrimaryButton onClick={() => void submit()} disabled={text.length === 0}>
        {t('act.send')}
      </PrimaryButton>
    </Sheet>
  )
}
