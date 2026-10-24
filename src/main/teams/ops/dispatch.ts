/** B4 ops (app 2.7.0, E10 B4): the Por despachar queue and the kickoff. Until B4 lands every one answers `unsupported`. */
import { unsupported, type OpTable } from './types'

export const dispatchOps: Pick<OpTable, 'dispatch' | 'kickoff'> = {
  dispatch: unsupported,
  kickoff: unsupported,
}
