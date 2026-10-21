// Codex `/rename` on the App Server connection a TUI drives (v2.4), for the
// CodexProtocol case of test-status.cjs. The shapes come from
// `codex app-server generate-ts` of codex-cli 0.163.0:
//   ClientRequest  { method: "thread/name/set", id, params: ThreadSetNameParams }
//   ThreadSetNameParams = { threadId: string, name: string }
//   ThreadSetNameResponse = Record<string, never>
//   ServerNotification { method: "thread/name/updated", params: ThreadNameUpdatedNotification }
//   ThreadNameUpdatedNotification = { threadId: string, threadName?: string }
//   Thread.name: string | null
// UNVERIFIED: that the TUI sends exactly this on `/rename` was not captured
// from live traffic (no throwaway CODEX_HOME session was logged yet). The
// parser reads both `name` and `threadName` in every place for that reason.
const thread = '019a1b2c-3d4e-7f80-9a1b-2c3d4e5f6a7b'

module.exports = {
  thread,
  resume: [
    ['client', { id: 1, method: 'thread/resume', params: { threadId: thread } }],
    ['server', { id: 1, result: { thread: { id: thread, name: 'Login fix', preview: 'arregla el login', status: { type: 'idle' }, turns: [] } } }],
  ],
  start: [
    ['client', { id: 1, method: 'thread/start', params: {} }],
    ['server', { id: 1, result: { thread: { id: thread, name: null, preview: '', status: { type: 'idle' }, turns: [] } } }],
  ],
  rename: (id, name) => [
    ['client', { id, method: 'thread/name/set', params: { threadId: thread, name } }],
    ['server', { method: 'thread/name/updated', params: { threadId: thread, threadName: name } }],
    ['server', { id, result: {} }],
  ],
  renameFailed: (id, name) => [
    ['client', { id, method: 'thread/name/set', params: { threadId: thread, name } }],
    ['server', { id, error: { code: -32600, message: 'invalid' } }],
  ],
}
