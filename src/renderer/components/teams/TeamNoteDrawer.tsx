import { useEffect, useState } from 'react'
import { NotebookText } from 'lucide-react'
import { formatRunWhen } from '@shared/schedule'
import { useLang, useT } from '@/i18n'
import { closeTeamDrawer } from '@/lib/teamsStore'
import { loadNote, noteBody, noteKey, useRoutinesStore } from '@/lib/teams/routines'
import { RightDrawer } from '@/components/ui/RightDrawer'
import { Button } from '@/components/ui/Button'
import { ChatMarkdown } from '@/components/chat/Markdown'
import { useLinkConfirm } from './TaskComments'
import { noteTitle } from './LeadNotesPanel'

/**
 * One team note in a drawer over any tab (app 2.7.0, E10 B7): the Lead's
 * Markdown (`note`) rendered safely (ChatMarkdown: raw HTML shows as text,
 * images never load, a link opens in the browser only after a confirm that
 * shows its whole target), its title and when it was last written; a first
 * `# <title>` line equal to that title is not repeated under it (noteBody).
 * A click on another note of the panel switches it in place (`keepOpenOn`); a
 * `notes` change brings the note on screen again (lib/teams/routines.ts).
 */
export function TeamNoteDrawer({ teamId, noteId }: { teamId: string; noteId: string }) {
  const t = useT()
  const lang = useLang()
  const entry = useRoutinesStore((s) => s.docs[noteKey(teamId, noteId)])
  const meta = useRoutinesStore((s) => s.notes[teamId]?.find((n) => n.id === noteId))
  const [maximized, setMaximized] = useState(false)
  const { onLink, dialog } = useLinkConfirm()
  useEffect(() => {
    void loadNote(teamId, noteId)
  }, [teamId, noteId])

  const doc = entry?.doc
  const title = noteTitle(doc?.title ?? meta?.title, t)
  let body
  if (doc) {
    const text = noteBody(doc.text, doc.title)
    body = (
      <>
        {doc.updatedAt > 0 && (
          <p data-note-updated className="text-[11px] tabular-nums text-text-secondary">
            {t('teams.notes.updated', { when: formatRunWhen(doc.updatedAt, lang, Date.now()) })}
          </p>
        )}
        {text.trim() ? (
          <div data-note-text className="min-w-0 text-sm text-text-primary">
            <ChatMarkdown text={text} onLink={onLink} />
          </div>
        ) : (
          <p data-note-empty className="text-sm text-text-secondary">
            {t('teams.notes.noteEmpty')}
          </p>
        )}
      </>
    )
  } else if (entry?.failed && !entry.loading) {
    const gone = entry.failed === 'not_found'
    body = (
      <div className="flex flex-col items-start gap-3" data-note-failed={entry.failed}>
        <p className="text-sm text-text-secondary">{gone ? t('teams.notes.noteGone') : t('teams.notes.noteFailed')}</p>
        {!gone && (
          <Button variant="ghost" size="sm" data-note-retry onClick={() => void loadNote(teamId, noteId)}>
            {t('teams.notes.retry')}
          </Button>
        )}
      </div>
    )
  } else {
    body = (
      <p className="text-sm text-text-secondary" data-note-loading>
        {t('teams.notes.noteLoading')}
      </p>
    )
  }
  return (
    <RightDrawer
      id="team-note"
      pinScope={teamId}
      keepOpenOn="[data-team-note]"
      title={
        <span data-note-title className="block min-w-0 truncate">
          {title}
        </span>
      }
      icon={<NotebookText size={15} className="shrink-0 text-text-secondary" aria-hidden />}
      defaultWidth="clamp(420px, 40%, 760px)"
      maximized={maximized}
      onMaximize={setMaximized}
      onClose={() => closeTeamDrawer()}
    >
      <div data-note-drawer={noteId} aria-label={t('teams.notes.drawerLabel')} role="document" className="flex min-w-0 flex-1 flex-col gap-2 overflow-y-auto px-4 py-3">
        {body}
      </div>
      {dialog}
    </RightDrawer>
  )
}
