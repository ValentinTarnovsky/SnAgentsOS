/**
 * The one exhaustive op table (decision 55): every TeamOp has a handler, so a
 * new op without one fails to compile. Each milestone replaces its stubs in
 * its own file; this composition never changes.
 */
import { boardOps } from './board'
import { coreOps } from './core'
import { dispatchOps } from './dispatch'
import { integrateOps } from './integrate'
import { needsOps } from './needs'
import { routineOps } from './routines'
import { runOps } from './runs'
import { takeoverOps } from './takeover'
import type { OpTable } from './types'

export const OPS: OpTable = { ...coreOps, ...runOps, ...boardOps, ...dispatchOps, ...needsOps, ...integrateOps, ...routineOps, ...takeoverOps }
