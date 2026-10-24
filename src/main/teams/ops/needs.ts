/** B5 ops (app 2.7.0, E10 B5): Te necesita, approvals and cards. Until B5 lands every one answers `unsupported`. */
import { unsupported, type OpTable } from './types'

export const needsOps: Pick<OpTable, 'needs' | 'decide' | 'answer'> = {
  needs: unsupported,
  decide: unsupported,
  answer: unsupported,
}
