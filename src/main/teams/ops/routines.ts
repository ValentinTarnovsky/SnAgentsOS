/** B7 ops (app 2.7.0, E10 B7): routines, team notes and run silence. Until B7 lands every one answers `unsupported`. */
import { unsupported, type OpTable } from './types'

export const routineOps: Pick<OpTable, 'routines' | 'routineRun' | 'notes' | 'note' | 'runSilenceAck'> = {
  routines: unsupported,
  routineRun: unsupported,
  notes: unsupported,
  note: unsupported,
  runSilenceAck: unsupported,
}
