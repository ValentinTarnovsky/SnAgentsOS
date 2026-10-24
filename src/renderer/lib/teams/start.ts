/**
 * Teams (app 2.7.0, E10 B; Labs teams): the core store plus every area sync,
 * for as long as the lab is on. App.tsx calls only this; each later milestone
 * adds its area's `init<Area>Sync()` as one line below.
 */
import { initTeams } from '@/lib/teamsStore'
import { initRosterSync } from './roster'
import { initRunChatSync } from './runChat'

export function startTeams(): () => void {
  const offs: Array<() => void> = [initTeams()]
  // Area syncs (B2..B9) register here, after the core.
  offs.push(initRosterSync(), initRunChatSync())
  return () => {
    // Areas first, the core last (its teardown closes the overlay and clears the store).
    for (const off of offs.reverse()) off()
  }
}
