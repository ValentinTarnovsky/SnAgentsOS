/**
 * Teams (app 2.7.0, E10 B; Labs teams): the renderer catalogs of every area,
 * spread once into en.ts and es.ts. One file per area so parallel milestones
 * never edit the same catalog; each area types its es as
 * Record<keyof typeof <area>En, string>, so a missing key fails typecheck.
 */
import { coreEn, coreEs } from './core'
import { setupEn, setupEs } from './setup'
import { agentsEn, agentsEs } from './agents'
import { boardEn, boardEs } from './board'
import { dispatchEn, dispatchEs } from './dispatch'
import { needsEn, needsEs } from './needs'
import { integrateEn, integrateEs } from './integrate'
import { routinesEn, routinesEs } from './routines'
import { takeoverEn, takeoverEs } from './takeover'

export const teamsEn = {
  ...coreEn,
  ...setupEn,
  ...agentsEn,
  ...boardEn,
  ...dispatchEn,
  ...needsEn,
  ...integrateEn,
  ...routinesEn,
  ...takeoverEn,
}

export const teamsEs: Record<keyof typeof teamsEn, string> = {
  ...coreEs,
  ...setupEs,
  ...agentsEs,
  ...boardEs,
  ...dispatchEs,
  ...needsEs,
  ...integrateEs,
  ...routinesEs,
  ...takeoverEs,
}
