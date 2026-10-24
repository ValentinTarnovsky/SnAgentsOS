/** B9 ops (app 2.7.0, E10 B9): Tomar el control. Until B9 lands every one answers `unsupported`. */
import { unsupported, type OpTable } from './types'

export const takeoverOps: Pick<OpTable, 'takeover' | 'takeoverBound' | 'takeoverAbort' | 'release'> = {
  takeover: unsupported,
  takeoverBound: unsupported,
  takeoverAbort: unsupported,
  release: unsupported,
}
