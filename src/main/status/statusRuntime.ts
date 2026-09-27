// Executed by Electron in Node mode from the per-terminal Codex launcher.
import { spawn } from 'child_process'
import { WebSocket } from 'ws'

const prepareOnly = process.argv[2] === '--snmulticc-prepare'
const ending = process.argv[2] === '--snmulticc-end'
const args = process.argv.slice(prepareOnly || ending ? 3 : 2)
const executable = process.env.SNMULTICC_REAL_CODEX
if (!executable) { console.error('SnMultiCC: Codex executable unavailable'); process.exit(1) }
const subcommands = new Set(['agents', 'exec', 'e', 'review', 'login', 'logout', 'mcp', 'plugin', 'app-server', 'remote-control', 'app', 'completion', 'update', 'doctor', 'sandbox', 'debug', 'apply', 'a', 'queue', 'archive', 'delete', 'migrate-rollouts', 'unarchive', 'cloud', 'exec-server', 'features', 'help'])
const valueOptions = new Set(['-c', '--config', '-m', '--model', '-i', '--image', '-C', '--cd', '--add-dir', '-p', '--profile', '-s', '--sandbox', '-a', '--ask-for-approval', '--enable', '--disable', '--remote-auth-token-env'])
let passthrough = false
let positional = false
for (let i = 0; i < args.length; i++) {
  const arg = args[i]
  if (arg === '--') break
  if (['--help', '-h', '--version', '-V', '--remote', '--no-daemon'].includes(arg) || arg.startsWith('--remote=')) { passthrough = true; break }
  if (valueOptions.has(arg)) { i++; continue }
  if (!arg.startsWith('-') && !positional) { positional = true; passthrough = subcommands.has(arg); if (passthrough) break }
}
const endpoint = process.env.SNMULTICC_CODEX_URL
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
// Child tools must not recursively enter the TUI launcher.
const pathKey = Object.keys(env).find(k => k.toLowerCase() === 'path') ?? 'PATH'
env[pathKey] = (env[pathKey] ?? '').split(process.platform === 'win32' ? ';' : ':').filter(p => p !== env.SNMULTICC_CODEX_SHIM).join(process.platform === 'win32' ? ';' : ':')
async function sendContext(context: object): Promise<void> {
  if (endpoint) {
    await new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(endpoint, { headers: { Authorization: `Launch ${env.SNMULTICC_CODEX_TOKEN}` } })
      const timer = setTimeout(() => { socket.terminate(); reject(new Error('Launch timed out')) }, 3000)
      socket.once('open', () => socket.send(JSON.stringify(context)))
      socket.once('message', data => {
        if (data.toString() === '{"ok":true}') { clearTimeout(timer); resolve() }
        socket.close()
      })
      socket.once('error', () => { clearTimeout(timer); reject(new Error('Launch unavailable')) })
      socket.once('close', () => { clearTimeout(timer); reject(new Error('Launch closed')) })
    })
  }
}
async function launch(): Promise<void> {
  if (ending) { await sendContext({ exitCode: Number(env.SNMULTICC_CODEX_EXIT) || 0 }); return }
  if (!passthrough && endpoint) await sendContext({ cwd: process.cwd(), env })
  // Windows GUI executables cannot relay interactive console handles reliably.
  // The batch launcher executes the real CLI directly after this preparation.
  if (prepareOnly) { process.exitCode = passthrough || !endpoint ? 10 : 0; return }
  const child = spawn(executable!, !passthrough && endpoint ? ['--remote', endpoint, '--remote-auth-token-env', 'SNMULTICC_CODEX_TOKEN', ...args] : args, { env, stdio: 'inherit', windowsHide: true })
  child.on('error', () => { console.error('SnMultiCC: could not start Codex'); process.exitCode = 1 })
  child.on('exit', code => {
    process.exitCode = code ?? 1
    if (!passthrough && endpoint) void sendContext({ exitCode: code ?? 1 }).catch(() => {})
  })
}
void launch().catch(() => { console.error('SnMultiCC: local Codex integration unavailable; restart the console or disable the integration'); process.exitCode = 1 })
