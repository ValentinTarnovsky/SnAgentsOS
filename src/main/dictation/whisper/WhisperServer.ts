import { execFile } from 'child_process'
import { randomBytes } from 'crypto'
import { connect, createServer } from 'net'
import { win32 } from 'path'
import type { Readable } from 'stream'
import { ClientError, getHealth, multipartBody, postInference, type InferenceParams } from './serverClient'
import { parseVerbose, type VerboseSegment } from './verbose'
import { isVcRuntimeExit } from './vcRuntime'

/**
 * One whisper-server.exe sidecar (official whisper.cpp b5454, app 2.5.0).
 *
 *  - Bound to 127.0.0.1 on a random free port, every route under a secret
 *    `/<32 hex>` request path (CORS is `*`, so the token is the lock). The
 *    token is never logged.
 *  - The token goes out only once the port is known to be the child's: the
 *    port is free again between freeLocalPort() and the child's bind (after
 *    the model loads), so another local process could take it. Until then
 *    the start only makes bare TCP connects (no byte sent); once one is
 *    accepted, the TCP table (netstat.exe) must show the listener owned by
 *    the child's pid, or the child is killed and the start retries on a new
 *    port.
 *  - `--public` points at an empty folder, so no static file is served.
 *  - `-l auto`: the language goes per request, and so does the prompt; no
 *    user text is ever on the command line.
 *  - Env whitelist with PATH = System32 only (no DLL planting through the
 *    user PATH); CUDA_CACHE_PATH under the whisper folder.
 *  - Stderr is matched line by line against the two GPU lines (and the bind
 *    failure) until /health answers, then drained unread. Never logged.
 *  - A GPU start counts only with "using CUDA0 backend"; anything else that
 *    is not the VC++ runtime is `gpu_failed`, so the caller can fall back.
 */

export interface ServerSpec {
  device: 'gpu' | 'cpu'
  exe: string
  /** The runtime folder (its DLLs load from here). */
  cwd: string
  model: string
  vadModel: string
  /** An empty folder, so `--public` serves nothing. */
  publicDir: string
  threads: number
  /** CUDA_CACHE_PATH (GPU only). */
  cudaCache?: string
}

export const HEALTH_TIMEOUT_MS = 30_000
export const HEALTH_POLL_MS = 100
/** One /health probe. */
export const HEALTH_PROBE_MS = 2000
/** /health can win the race against the stderr pipe: the GPU line gets this long to arrive. */
export const GPU_LINE_GRACE_MS = 1500
export const REQ_TIMEOUT_GPU_MS = 15_000
export const REQ_TIMEOUT_CPU_MS = 30_000
/** A cold CUDA cache (first run, driver update) recompiles the kernels on the first request. */
export const FIRST_GPU_REQ_TIMEOUT_MS = 120_000
/** How long stop() waits for the process to be gone. */
export const STOP_WAIT_MS = 5000
export const CUDA_CACHE_MAXSIZE = 1073741824

export const GPU_OK_RE = /whisper_backend_init_gpu: using CUDA\d+ backend/
export const NO_GPU_RE = /whisper_backend_init_gpu: no GPU found/
export const BIND_FAIL_RE = /couldn't bind to server socket/

export { EXIT_DLL_NOT_FOUND, EXIT_ACCESS_VIOLATION } from './vcRuntime'

export function serverArgs(spec: ServerSpec, port: number, token: string): string[] {
  return [
    '-m', spec.model,
    '--host', '127.0.0.1',
    '--port', String(port),
    '--request-path', `/${token}`,
    '--public', spec.publicDir,
    '-l', 'auto',
    '-nt',
    '-t', String(Math.max(1, Math.trunc(spec.threads) || 1)),
    '--vad-model', spec.vadModel,
    ...(spec.device === 'cpu' ? ['-ng'] : []),
  ]
}

const ENV_KEEP = ['SystemRoot', 'windir', 'SystemDrive', 'TEMP', 'TMP', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE']

/** The server's whole environment: a short whitelist, PATH = System32 + Windows, the CUDA cache. */
export function serverEnv(src: NodeJS.ProcessEnv, cudaCache?: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const k of ENV_KEEP) {
    const v = src[k]
    if (typeof v === 'string') env[k] = v
  }
  const root = env.SystemRoot || env.windir || 'C:\\Windows'
  env.PATH = `${root}\\System32;${root}`
  if (cudaCache) {
    env.CUDA_CACHE_PATH = cudaCache
    env.CUDA_CACHE_MAXSIZE = String(CUDA_CACHE_MAXSIZE)
  }
  return env
}

export function sameSpec(a: ServerSpec | null, b: ServerSpec | null): boolean {
  if (!a || !b) return false
  return a.device === b.device && a.exe === b.exe && a.cwd === b.cwd && a.model === b.model && a.vadModel === b.vadModel &&
    a.publicDir === b.publicDir && a.threads === b.threads && (a.cudaCache ?? '') === (b.cudaCache ?? '')
}

/** Per-request timeout: the first GPU request pays the PTX JIT. */
export function requestTimeoutMs(device: 'gpu' | 'cpu', served: number): number {
  if (device === 'cpu') return REQ_TIMEOUT_CPU_MS
  return served === 0 ? FIRST_GPU_REQ_TIMEOUT_MS : REQ_TIMEOUT_GPU_MS
}

/** The slice of a ChildProcess the server uses (a fake one in the tests). */
export interface ServerChild {
  pid?: number
  stderr: Readable | null
  kill(): boolean
  on(event: 'exit', cb: (code: number | null) => void): unknown
  on(event: 'error', cb: (err: Error) => void): unknown
}

export interface ServerSpawnOpts {
  cwd: string
  env: NodeJS.ProcessEnv
  windowsHide: true
  stdio: ['ignore', 'ignore', 'pipe']
}

export interface WhisperServerDeps {
  spawn: (exe: string, args: string[], opts: ServerSpawnOpts) => ServerChild
  freePort: () => Promise<number>
  token: () => string
  /** Codes only. */
  log?: (line: string) => void
  /** Records the live pid (server.json) so a crash of main leaves no orphan behind; null when gone. */
  writePid?: (pid: number | null) => void
  env?: () => NodeJS.ProcessEnv
  health?: (port: number, token: string, timeoutMs: number) => Promise<boolean>
  /** Something accepts a TCP connection on 127.0.0.1:port (a bare connect, no byte sent). */
  listening?: (port: number, timeoutMs: number) => Promise<boolean>
  /** PIDs listening on the port (127.0.0.1, 0.0.0.0 or [::]); null when the table cannot be read. */
  portOwners?: (port: number) => Promise<number[] | null>
  post?: (port: number, token: string, body: Buffer, boundary: string, timeoutMs: number) => Promise<string>
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}

export type ServerStartError = 'spawn' | 'exit' | 'vcredist' | 'gpu_failed'
export type ServerStartResult = { ok: true } | { ok: false; error: ServerStartError }

export type InferErrorCode = 'timeout' | 'exit' | 'internal'

/** infer() failed: `timeout` (the server may still be busy: restart it), `exit` (gone or refused), `internal` (bad answer). */
export class InferError extends Error {
  constructor(readonly code: InferErrorCode) {
    super(code)
  }
}

type Attempt = ServerStartResult | { ok: false; error: 'retry' }

export class WhisperServer {
  private child: ServerChild | null = null
  private port = 0
  private secret = ''
  private _spec: ServerSpec | null = null
  private ready = false
  private exitWait: Promise<void> = Promise.resolve()
  private _served = 0
  private _exitCode: number | null = null
  /** Called when the process dies on its own after a successful start (not after stop()). */
  onExit: ((code: number | null) => void) | null = null

  constructor(private readonly deps: WhisperServerDeps) {}

  get spec(): ServerSpec | null {
    return this.ready ? this._spec : null
  }

  get running(): boolean {
    return this.ready && this.child !== null
  }

  /** Successful inferences since this process started (0 means the first answer is still pending). */
  get served(): number {
    return this._served
  }

  /** Exit code of the last process, once it is gone. */
  get exitCode(): number | null {
    return this._exitCode
  }

  /** Starts (or keeps, when the same spec is already up) the server. One retry on a port race. */
  async start(spec: ServerSpec): Promise<ServerStartResult> {
    if (this.running && sameSpec(this._spec, spec)) return { ok: true }
    await this.stop()
    for (let attempt = 0; attempt < 2; attempt++) {
      const r = await this.startOnce(spec)
      if (r.ok || r.error !== 'retry') {
        this.log(r.ok ? `server ready device=${spec.device}` : `server failed device=${spec.device} error=${r.error}`)
        return r
      }
      this.log('server port busy, retry')
    }
    return { ok: false, error: spec.device === 'gpu' ? 'gpu_failed' : 'exit' }
  }

  private async startOnce(spec: ServerSpec): Promise<Attempt> {
    const gpu = spec.device === 'gpu'
    const failed = (error: ServerStartError | 'retry'): Attempt => ({ ok: false, error })
    let port: number
    try {
      port = await this.deps.freePort()
    } catch {
      return failed(gpu ? 'gpu_failed' : 'spawn')
    }
    const token = this.deps.token()
    let child: ServerChild
    try {
      child = this.deps.spawn(spec.exe, serverArgs(spec, port, token), {
        cwd: spec.cwd,
        env: serverEnv(this.deps.env?.() ?? process.env, spec.cudaCache),
        windowsHide: true,
        stdio: ['ignore', 'ignore', 'pipe'],
      })
    } catch {
      return failed(gpu ? 'gpu_failed' : 'spawn')
    }
    this.child = child
    this.port = port
    this.secret = token
    this._spec = spec
    this.ready = false
    this._served = 0
    this._exitCode = null
    this.writePid(typeof child.pid === 'number' ? child.pid : null)

    let parsing = true
    let gpuOk = false
    let noGpu = false
    let bindFail = false
    let buf = ''
    const scan = (line: string): void => {
      if (GPU_OK_RE.test(line)) gpuOk = true
      else if (NO_GPU_RE.test(line)) noGpu = true
      else if (BIND_FAIL_RE.test(line)) bindFail = true
    }
    // Stays attached for the life of the process, so the pipe never fills; read only while parsing.
    child.stderr?.on('data', (d: Buffer | string) => {
      if (!parsing) return
      buf += typeof d === 'string' ? d : d.toString('utf8')
      let i: number
      while ((i = buf.indexOf('\n')) >= 0) {
        scan(buf.slice(0, i))
        buf = buf.slice(i + 1)
      }
      if (buf.length > 16 * 1024) buf = buf.slice(-1024)
    })
    child.stderr?.on('error', () => undefined)

    let exited = false
    let spawnError = false
    let resolveExit: () => void = () => undefined
    this.exitWait = new Promise<void>((r) => {
      resolveExit = r
    })
    const gone = (code: number | null, viaError: boolean): void => {
      if (exited) return
      exited = true
      if (viaError) spawnError = true
      this._exitCode = code
      const wasReady = this.ready && this.child === child
      if (this.child === child) {
        this.child = null
        this.ready = false
        this.writePid(null)
      }
      resolveExit()
      if (wasReady) {
        this.log(`server exit code=${code ?? 'null'}`)
        try {
          this.onExit?.(code)
        } catch {
          /* the owner handles it */
        }
      }
    }
    child.on('exit', (code) => gone(typeof code === 'number' ? code : null, false))
    child.on('error', () => gone(null, true))

    const now = this.deps.now ?? Date.now
    const sleep = this.deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
    const health = this.deps.health ?? getHealth
    const listening = this.deps.listening ?? tcpListening
    const portOwners = this.deps.portOwners ?? ((p: number) => listenerPids(p))
    const deadline = now() + HEALTH_TIMEOUT_MS
    /** The listener on the port is the child (checked before the token is ever sent). */
    let owned = false
    const killNow = async (): Promise<void> => {
      parsing = false
      try {
        child.kill()
      } catch {
        /* already gone */
      }
      await this.waitExit()
      if (this.child === child) {
        this.child = null
        this.writePid(null)
      }
    }
    for (;;) {
      if (exited) {
        parsing = false
        if (bindFail) return failed('retry')
        if (isVcRuntimeExit(this._exitCode, false)) return failed('vcredist')
        if (spawnError) return failed(gpu ? 'gpu_failed' : 'spawn')
        return failed(gpu ? 'gpu_failed' : 'exit')
      }
      if (this.child !== child) return failed(gpu ? 'gpu_failed' : 'exit') // stop() during the start
      if (gpu && noGpu) {
        await killNow()
        return failed('gpu_failed')
      }
      if (bindFail) {
        await killNow()
        return failed('retry')
      }
      if (now() > deadline) {
        await killNow()
        return failed(gpu ? 'gpu_failed' : 'exit')
      }
      if (!owned) {
        if (await listening(port, HEALTH_PROBE_MS)) {
          const owners = await portOwners(port).catch(() => null)
          if (exited || this.child !== child) continue
          if (owners === null || typeof child.pid !== 'number') {
            // The TCP table cannot be read: the token is never sent blind.
            this.log('server port owner unknown')
            await killNow()
            return failed(gpu ? 'gpu_failed' : 'exit')
          }
          if (owners.some((p) => p !== child.pid)) {
            // Another process took the port before the child bound it.
            this.log('server port taken')
            await killNow()
            return failed('retry')
          }
          owned = owners.length > 0
        }
        if (!owned) {
          await sleep(HEALTH_POLL_MS)
          continue
        }
      }
      if (await health(port, token, HEALTH_PROBE_MS)) {
        if (gpu && !gpuOk) {
          const until = now() + GPU_LINE_GRACE_MS
          while (!gpuOk && !noGpu && !exited && now() < until) await sleep(50)
          if (!gpuOk) {
            await killNow()
            return failed('gpu_failed')
          }
        }
        if (exited || this.child !== child) continue
        parsing = false
        buf = ''
        this.ready = true
        return { ok: true }
      }
      await sleep(HEALTH_POLL_MS)
    }
  }

  /**
   * POSTs one clip. Throws InferError: `timeout` (the request may still run
   * inside the server: the caller restarts it), `exit`, `internal`.
   */
  async infer(wav: Buffer, p: InferenceParams, timeoutMs?: number): Promise<VerboseSegment[]> {
    const spec = this._spec
    if (!this.running || !spec) throw new InferError('exit')
    const boundary = `----snaos${randomBytes(12).toString('hex')}`
    const body = multipartBody(wav, p, boundary)
    const post = this.deps.post ?? postInference
    let text: string
    try {
      text = await post(this.port, this.secret, body, boundary, timeoutMs ?? requestTimeoutMs(spec.device, this._served))
    } catch (e) {
      const code = e instanceof ClientError || (e && typeof (e as { code?: unknown }).code === 'string') ? (e as { code: string }).code : 'exit'
      throw new InferError(code === 'timeout' ? 'timeout' : code === 'exit' ? 'exit' : 'internal')
    }
    const segs = parseVerbose(text)
    if (!segs) throw new InferError('internal')
    this._served++
    return segs
  }

  /** Kills the process and waits (capped) until it is gone, so its DLLs can be deleted. */
  async stop(): Promise<void> {
    const child = this.child
    this.ready = false
    if (!child) return
    this.child = null
    try {
      child.kill()
    } catch {
      /* already gone */
    }
    await this.waitExit()
    this.writePid(null)
  }

  private async waitExit(): Promise<void> {
    let t: ReturnType<typeof setTimeout> | null = null
    await Promise.race([this.exitWait, new Promise<void>((r) => { t = setTimeout(r, STOP_WAIT_MS) })])
    if (t) clearTimeout(t)
  }

  private writePid(pid: number | null): void {
    try {
      this.deps.writePid?.(pid)
    } catch {
      /* best effort */
    }
  }

  private log(line: string): void {
    try {
      this.deps.log?.(line)
    } catch {
      /* best effort */
    }
  }
}

/** A free 127.0.0.1 port, released before the spawn (start() retries once on a race). */
export function freeLocalPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.unref()
    srv.on('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      const port = addr && typeof addr === 'object' ? addr.port : 0
      srv.close(() => (port ? resolve(port) : reject(new Error('no port'))))
    })
  })
}

/** A bare TCP connect to 127.0.0.1:port: true when accepted. Sends nothing (the token never goes to an unknown listener). */
export function tcpListening(port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false
    const sock = connect({ host: '127.0.0.1', port })
    const finish = (ok: boolean): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      sock.destroy()
      resolve(ok)
    }
    const timer = setTimeout(() => finish(false), timeoutMs)
    sock.once('connect', () => finish(true))
    sock.once('error', () => finish(false))
  })
}

const LISTEN_LOCAL = (port: number): string[] => [`127.0.0.1:${port}`, `0.0.0.0:${port}`, `[::]:${port}`, `[::ffff:127.0.0.1]:${port}`]
const LISTEN_REMOTE = new Set(['0.0.0.0:0', '[::]:0'])

/**
 * `netstat -ano` output: the PIDs of the TCP listeners that a connect to
 * 127.0.0.1:port can reach. A listener is told by its remote address
 * (0.0.0.0:0 or [::]:0), never by the state column, which Windows translates.
 */
export function parseListenerPids(text: string, port: number): number[] {
  const locals = new Set(LISTEN_LOCAL(port))
  const out = new Set<number>()
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const cols = line.trim().split(/\s+/)
    if (cols.length < 4 || cols[0].toUpperCase() !== 'TCP') continue
    if (!locals.has(cols[1]) || !LISTEN_REMOTE.has(cols[2])) continue
    const pid = Number(cols[cols.length - 1])
    if (Number.isInteger(pid) && pid >= 0) out.add(pid)
  }
  return [...out]
}

/** The real portOwners: `%SystemRoot%\System32\NETSTAT.EXE -ano` (no admin needed), by absolute path. Null when it fails. */
export function listenerPids(port: number, env: NodeJS.ProcessEnv = process.env): Promise<number[] | null> {
  const exe = win32.join(env.SystemRoot || 'C:\\Windows', 'System32', 'NETSTAT.EXE')
  return new Promise((resolve) => {
    try {
      execFile(exe, ['-ano'], { windowsHide: true, timeout: 10_000, encoding: 'latin1', maxBuffer: 16 * 1024 * 1024 }, (err, out) => {
        resolve(err ? null : parseListenerPids(String(out ?? ''), port))
      })
    } catch {
      resolve(null)
    }
  })
}

/** 128-bit random request path. */
export function newServerToken(): string {
  return randomBytes(16).toString('hex')
}

// --- Orphans --------------------------------------------------------------------

export interface OrphanDeps {
  readText: (file: string) => string | null
  /** Absolute image path of a live pid, or null when it is gone or unknown. */
  processPath: (pid: number) => Promise<string | null>
  kill: (pid: number) => void
  remove: (file: string) => void
  log?: (line: string) => void
}

/** The pids recorded in server.json: `{ servers: [{ pid }] }` (or a single `{ pid }`). */
export function orphanPids(text: string | null): number[] {
  if (!text) return []
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return []
  }
  const list: unknown[] = []
  if (raw && typeof raw === 'object') {
    const r = raw as { pid?: unknown; servers?: unknown }
    if (Array.isArray(r.servers)) for (const s of r.servers.slice(0, 8)) list.push(s && typeof s === 'object' ? (s as { pid?: unknown }).pid : null)
    else list.push(r.pid)
  }
  return list.filter((p): p is number => typeof p === 'number' && Number.isInteger(p) && p > 0 && p !== process.pid)
}

/** True when `exe` is a whisper-server.exe inside `dir` (case-insensitive, Windows paths). */
export function isOurServerExe(exe: string | null, dir: string): boolean {
  if (!exe || !dir) return false
  const p = win32.resolve(exe).toLowerCase()
  const d = win32.resolve(dir).toLowerCase().replace(/\\+$/, '')
  return win32.basename(p) === 'whisper-server.exe' && p.startsWith(d + '\\')
}

/**
 * Boot: kills a whisper-server left behind by a crash of main. Only a pid
 * from `<dir>/server.json` whose image is a whisper-server.exe under `dir`
 * (another profile's server, or a reused pid, is left alone). Never throws.
 */
export async function killOrphan(dir: string, deps: OrphanDeps): Promise<number> {
  const file = win32.join(dir, 'server.json')
  let killed = 0
  try {
    for (const pid of orphanPids(deps.readText(file))) {
      const exe = await deps.processPath(pid).catch(() => null)
      if (!isOurServerExe(exe, dir)) continue
      try {
        deps.kill(pid)
        killed++
      } catch {
        /* already gone */
      }
    }
    deps.remove(file)
  } catch {
    /* best effort */
  }
  if (killed) deps.log?.(`orphan killed count=${killed}`)
  return killed
}

/** The real processPath: Win32_Process.ExecutablePath through powershell.exe by absolute path. */
export function processExePath(pid: number, env: NodeJS.ProcessEnv = process.env): Promise<string | null> {
  if (!Number.isInteger(pid) || pid <= 0) return Promise.resolve(null)
  const ps = win32.join(env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const cmd = `(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}').ExecutablePath`
  return new Promise((resolve) => {
    try {
      execFile(ps, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', cmd], { windowsHide: true, timeout: 15_000, encoding: 'utf8' }, (err, out) => {
        const p = String(out ?? '').trim()
        resolve(err || !p ? null : p)
      })
    } catch {
      resolve(null)
    }
  })
}
