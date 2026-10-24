/** B6 ops (app 2.7.0, E10 B6): Integrar. Until B6 lands every one answers `unsupported`. */
import { unsupported, type OpTable } from './types'

export const integrateOps: Pick<OpTable, 'integratePreview' | 'integrate' | 'askRebase' | 'confirmVerify' | 'removeWorktree'> = {
  integratePreview: unsupported,
  integrate: unsupported,
  askRebase: unsupported,
  confirmVerify: unsupported,
  removeWorktree: unsupported,
}
