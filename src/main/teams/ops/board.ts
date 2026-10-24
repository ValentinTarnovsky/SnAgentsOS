/** B3 ops (app 2.7.0, E10 B3): board, tasks, comments and the Lead thread. Until B3 lands every one answers `unsupported`. */
import { unsupported, type OpTable } from './types'

export const boardOps: Pick<OpTable, 'board' | 'task' | 'createTask' | 'updateTask' | 'moveTask' | 'releaseOwned' | 'comment' | 'lead' | 'leadSay'> = {
  board: unsupported,
  task: unsupported,
  createTask: unsupported,
  updateTask: unsupported,
  moveTask: unsupported,
  releaseOwned: unsupported,
  comment: unsupported,
  lead: unsupported,
  leadSay: unsupported,
}
