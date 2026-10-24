/** B2 ops (app 2.7.0, E10 B2): runs (roster, Ejecutar ahora, stop, run log pages). Until B2 lands every one answers `unsupported`. */
import { unsupported, type OpTable } from './types'

export const runOps: Pick<OpTable, 'roster' | 'runNow' | 'stop' | 'pauseAgent' | 'runs' | 'runPage' | 'watchRun'> = {
  roster: unsupported,
  runNow: unsupported,
  stop: unsupported,
  pauseAgent: unsupported,
  runs: unsupported,
  runPage: unsupported,
  watchRun: unsupported,
}
