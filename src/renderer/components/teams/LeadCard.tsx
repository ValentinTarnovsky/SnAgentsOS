import type { ReactNode } from 'react'
import type { AgentView } from '@shared/team-protocol'
import { useT } from '@/i18n'
import { AgentCard } from './AgentCard'

/**
 * The Lead on top of the Agentes tab (app 2.7.0, E10 B2), full width: the
 * same card as any agent plus a line on what the Lead does. `children` is
 * the slot for the Lead conversation's last messages (B3).
 */
export function LeadCard({ teamId, agent, children }: { teamId: string; agent: AgentView; children?: ReactNode }) {
  const t = useT()
  return (
    <div data-lead-card={agent.id} className="min-w-0">
      <AgentCard teamId={teamId} agent={agent} wide hint={t('teams.lead.hint')}>
        {children}
      </AgentCard>
    </div>
  )
}
