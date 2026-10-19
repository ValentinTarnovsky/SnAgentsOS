/**
 * "N notes" in the header of Changes and of a diff (E3-FR-54): the
 * workspace's notes still to send. A tap opens the notes list; nothing shows
 * without pending notes.
 */
import { useEffect, type ReactNode } from 'react'
import { MessageSquareText } from 'lucide-react'
import { useNotesStore, isSent } from '../../lib/notesStore'
import { openNotesUi } from '../../lib/changes'
import { t } from '../../lib/i18n'

export function NotesBadge({ workspaceId }: { workspaceId: string }): ReactNode {
  const pending = useNotesStore((s) => (s.byWs[workspaceId] ?? []).filter((n) => !isSent(n)).length)
  const hasAny = useNotesStore((s) => (s.byWs[workspaceId]?.length ?? 0) > 0)
  useEffect(() => {
    useNotesStore.getState().ensure(workspaceId)
  }, [workspaceId])
  if (!pending && !hasAny) return null
  const label = pending === 1 ? t('notes.badge1') : t('notes.badge', { n: pending })
  return (
    <button
      type="button"
      data-notes-badge={pending}
      onClick={() => openNotesUi('list')}
      aria-label={label}
      className="flex h-9 shrink-0 items-center gap-1 rounded-full border border-border px-2.5 text-xs font-medium text-text-primary active:bg-card"
    >
      <MessageSquareText size={14} className="text-accent-violet" />
      {label}
    </button>
  )
}
