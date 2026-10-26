import { useEffect, type ReactNode } from 'react'
import { MessageCircle } from 'lucide-react'
import type { AgentView } from '@shared/team-protocol'
import { useT } from '@/i18n'
import { cn } from '@/lib/cn'
import { openAgentDrawer } from '@/lib/teamsStore'
import { loadLead, threadMessages, useLeadStore } from '@/lib/teams/lead'
import { AgentCard } from './AgentCard'
import { LeadMessage } from './LeadThreadView'
import { SMALL_BTN, SMALL_BTN_TEXT } from './RunHeader'
import { useLinkConfirm } from './TaskComments'

/**
 * The Lead on top of the Agentes tab (app 2.7.0, E10 B2), full width: the
 * same card as any agent plus a line on what the Lead does, and (B3) the
 * last two messages of the conversation with "Escribile al Líder", which
 * opens the Lead's drawer on the conversation. `children` goes under them.
 */
export function LeadCard({ teamId, agent, children }: { teamId: string; agent: AgentView; children?: ReactNode }) {
  const t = useT()
  const thread = useLeadStore((s) => s.threads[teamId])
  const { onLink, dialog } = useLinkConfirm()
  useEffect(() => {
    if (!useLeadStore.getState().threads[teamId]) void loadLead(teamId)
  }, [teamId])
  const last = threadMessages(thread).slice(-2)
  return (
    <div data-lead-card={agent.id} className="min-w-0">
      <AgentCard teamId={teamId} agent={agent} wide hint={t('teams.lead.hint')}>
        {last.length > 0 && (
          <ol data-lead-last aria-label={t('teams.lead.lastMessages')} className="flex flex-col gap-2 border-t border-border pt-2">
            {last.map((m) => (
              <LeadMessage key={m.id} m={m} onLink={onLink} compact />
            ))}
          </ol>
        )}
        <div className={cn('flex', last.length > 0 ? 'pt-0' : 'border-t border-border pt-2')}>
          <button type="button" data-lead-write onClick={() => openAgentDrawer(agent.id, undefined, 'thread')} className={cn(SMALL_BTN, SMALL_BTN_TEXT)}>
            <MessageCircle size={13} aria-hidden />
            {t('teams.lead.write')}
          </button>
        </div>
        {children}
      </AgentCard>
      {dialog}
    </div>
  )
}
