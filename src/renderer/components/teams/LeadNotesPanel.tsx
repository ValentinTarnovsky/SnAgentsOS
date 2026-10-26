import { useEffect, useId, useMemo, useState } from 'react'
import { NotebookText } from 'lucide-react'
import { formatRunWhen } from '@shared/schedule'
import type { WsNoteMeta } from '@shared/ws-notes'
import { useLang, useT, type TFn } from '@/i18n'
import { cn } from '@/lib/cn'
import { useTeamsStore } from '@/lib/teamsStore'
import { loadNotes, openTeamNote, useRoutinesStore } from '@/lib/teams/routines'
import { visibleName } from '@/lib/teams/issues'
import { Button } from '@/components/ui/Button'
import { PANEL_TITLE } from './RoutinesPanel'

/** Notes the panel lists before "Ver todas". */
const NOTES_SHOWN = 8
const NO_NOTES: readonly WsNoteMeta[] = []

/** A note's title as the Lead wrote it (agent text: hiding characters spelled out), or "Nota sin título". */
export function noteTitle(title: string | undefined, t: TFn): string {
  return title ? visibleName(title) : t('teams.notes.untitled')
}

/**
 * The team notes under the Agentes roster (app 2.7.0, E10 B7): what the Lead
 * wrote with `snaos team note` (the daily summary of the `daily-summary`
 * routine among them), newest first, each with its title and when it was
 * last written (`formatRunWhen`: the date when it is not today's); a row opens
 * it in TeamNoteDrawer. Read only here: the notes are the Lead's.
 */
export function LeadNotesPanel({ teamId }: { teamId: string }) {
  const t = useT()
  const lang = useLang()
  const headId = useId()
  const notes = useRoutinesStore((s) => s.notes[teamId])
  const failed = useRoutinesStore((s) => !!s.notesFailed[teamId])
  const openId = useTeamsStore((s) => (s.drawer?.kind === 'note' ? s.drawer.noteId : null))
  const [all, setAll] = useState(false)
  useEffect(() => {
    void loadNotes(teamId)
  }, [teamId])
  const sorted = useMemo(() => [...(notes ?? NO_NOTES)].sort((a, b) => b.updatedAt - a.updatedAt), [notes])

  const now = Date.now()
  let body
  if (!notes) {
    body = failed ? (
      <div className="flex flex-col items-start gap-2" data-notes-failed>
        <p className="text-sm text-text-secondary">{t('teams.notes.loadFailed')}</p>
        <Button variant="ghost" size="sm" data-notes-retry onClick={() => void loadNotes(teamId)}>
          {t('teams.notes.retry')}
        </Button>
      </div>
    ) : (
      <p className="text-sm text-text-secondary" data-notes-loading>
        {t('teams.notes.loading')}
      </p>
    )
  } else if (sorted.length === 0) {
    body = (
      <p className="text-sm text-text-secondary" data-notes-empty>
        {t('teams.notes.empty')}
      </p>
    )
  } else {
    const shown = all ? sorted : sorted.slice(0, NOTES_SHOWN)
    body = (
      <>
        <ul className="flex min-w-0 flex-col divide-y divide-border overflow-hidden rounded-card border border-border bg-card/40">
          {shown.map((n) => (
            <li key={n.id} className="min-w-0">
              <button
                type="button"
                data-team-note={n.id}
                aria-current={openId === n.id ? 'true' : undefined}
                onClick={() => openTeamNote(n.id)}
                className={cn(
                  'flex w-full min-w-0 items-center gap-2 px-3 py-2 text-left outline-none transition-colors hover:bg-card focus-visible:bg-card focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-accent-violet/60',
                  openId === n.id && 'bg-accent-violet/10',
                )}
              >
                <NotebookText size={13} className="shrink-0 text-text-secondary" aria-hidden />
                <span data-team-note-title className={cn('min-w-0 flex-1 truncate text-sm', n.title ? 'text-text-primary' : 'text-text-secondary')}>
                  {noteTitle(n.title, t)}
                </span>
                <span data-team-note-when className="shrink-0 text-[11px] tabular-nums text-text-secondary">
                  {formatRunWhen(n.updatedAt, lang, now)}
                </span>
              </button>
            </li>
          ))}
        </ul>
        {sorted.length > NOTES_SHOWN && (
          <Button variant="ghost" size="sm" data-notes-all={all ? 'on' : 'off'} className="self-start" onClick={() => setAll(!all)}>
            {all ? t('teams.notes.fewer') : t('teams.notes.all', { count: sorted.length })}
          </Button>
        )}
      </>
    )
  }
  return (
    <section data-notes-panel={teamId} aria-labelledby={headId} className="flex min-w-0 flex-col gap-2 pt-2">
      <div className="flex min-w-0 flex-col gap-0.5">
        <h3 id={headId} className={PANEL_TITLE}>
          {t('teams.notes.title')}
        </h3>
        <p className="text-[11px] text-text-secondary">{t('teams.notes.hint')}</p>
      </div>
      {body}
    </section>
  )
}
