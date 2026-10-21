import { existsSync } from 'fs'
import { join } from 'path'
import type { WebContents } from 'electron'
import { CLI_ENV } from '@shared/brand'
import type { CliUiState, SkillOp, SkillStatus, SkillTarget, SnaosRuntimeFile } from '@shared/ctl-protocol'
import type { ConfigFile } from '@shared/types'
import type { PtyExitInfo, PtySink } from '../pty/PtyManager'
import type { CustomNotice } from '../status/events'
import { CtlServer, ctlEndpoint } from './CtlServer'
import { CtlTokens, newToken } from './CtlTokens'
import { CtlHandlers, type CtlHandlerDeps, type CtlPtyView, type CtlServices, type CtlStatusView } from './handlers'
import { IpcRendererBus } from './rendererBus'
import { removeRuntimeFileIfOwned, writeRuntimeFile } from './runtimeFile'
import { writeShim } from './shim'
import { installSkill, refreshSkillOnStartup, removeSkill, repairSkill, skillStatus } from './skillInstaller'
import { addToUserPath, isInUserPath, realRegistry, removeFromUserPath, type RegistryOps } from './userPath'

export interface CliServiceDeps {
  /** dataDir() (respects the portable). */
  dataDir: () => string
  appVersion: string
  /** process.execPath: the exe the shim runs with ELECTRON_RUN_AS_NODE. */
  execPath: string
  /** out/main/cli.js. */
  cliPath: string
  portable: boolean
  getSender: () => WebContents | null
  pty: CtlPtyView
  status: CtlStatusView & { notifyCustom(paneId: string | null, title: string, body: string): boolean }
  config: () => ConfigFile | null
  /** noticeRouter.routeCustom: Discord / ntfy (kind custom). */
  routeCustom: (notice: CustomNotice) => void
  registry?: RegistryOps
  /** Env the skill paths are read from (CLAUDE_CONFIG_DIR, CODEX_HOME); tests point it at a temp tree. */
  skillEnv?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  /** Test seam for the handlers' clock and timings. */
  handlerOverrides?: Partial<Pick<CtlHandlerDeps, 'now' | 'timing' | 'isDir'>>
}

/**
 * The snaos CLI in main (E8-FR-12, 13, 21, 22): the control server, the
 * console tokens, runtime.json, the shim, the env each pty gets, the skill
 * and the user PATH. Endpoint and master token are made once per run and
 * reused when the CLI is switched off and on again, so consoles created in
 * between keep working. Off = no server, no runtime.json, no env in new ptys.
 */
export class CliService {
  readonly tokens: CtlTokens
  readonly bus: IpcRendererBus
  readonly handlers: CtlHandlers
  readonly transport: SnaosRuntimeFile['transport']
  private readonly master: string
  private server: CtlServer | null = null
  private enabled = false
  private startedAt: number | null = null
  private error: string | undefined
  private shimFile = ''
  private transition: Promise<void> = Promise.resolve()
  /** Built later in bootstrap (notes store, transcript locator); a missing one answers `disabled`. */
  private readonly services: CtlServices = {}

  constructor(private readonly deps: CliServiceDeps) {
    this.master = newToken()
    this.tokens = new CtlTokens(this.master)
    this.bus = new IpcRendererBus(deps.getSender)
    this.transport = ctlEndpoint(deps.dataDir(), deps.platform ?? process.platform)
    this.handlers = new CtlHandlers({
      bus: this.bus,
      pty: deps.pty,
      status: deps.status,
      config: deps.config,
      appVersion: deps.appVersion,
      platform: deps.platform ?? process.platform,
      services: () => this.services,
      notify: (n) => {
        deps.status.notifyCustom(n.paneId, n.title, n.body)
        if (!n.local) deps.routeCustom({ kind: 'custom', paneId: n.paneId, title: n.title, body: n.body })
      },
      ...deps.handlerOverrides,
    })
  }

  /** Wires main services the CLI reaches (app 2.3.0: notes, chat, usage, accounts). */
  attach(services: Partial<CtlServices>): void {
    Object.assign(this.services, services)
  }

  binDir(): string {
    return join(this.deps.dataDir(), 'bin')
  }

  runtimePath(): string {
    return join(this.deps.dataDir(), 'runtime.json')
  }

  get running(): boolean {
    return this.server?.running === true
  }

  /**
   * Startup work that does not depend on the switch: rewrite the shim (the
   * portable's execPath changes per run), refresh an installed skill of
   * another version (Claude and Codex), and re-add the PATH entry when the setting is on (an
   * update's uninstaller may have removed it).
   */
  init(): void {
    try {
      this.shimFile = writeShim(this.binDir(), { execPath: this.deps.execPath, cliPath: this.deps.cliPath, runtimePath: this.runtimePath() }, this.deps.platform ?? process.platform)
    } catch (error) {
      this.error = `shim: ${error instanceof Error ? error.message : String(error)}`
      console.warn('[cli] could not write the snaos shim:', this.error)
    }
    try {
      refreshSkillOnStartup(this.deps.appVersion, this.deps.skillEnv ?? process.env)
    } catch {
      /* the skill row reports it */
    }
    if (this.userPathAvailable() && this.deps.config()?.settings?.automation?.cliUserPath === true) {
      void addToUserPath(this.binDir(), this.deps.registry ?? realRegistry).catch(() => undefined)
    }
  }

  /** settings.cliEnabled (cli:setEnabled and the startup value). Serialized: toggles never overlap. */
  setEnabled(on: boolean): Promise<void> {
    this.enabled = on
    this.transition = this.transition.then(() => (this.enabled ? this.start() : this.stop())).catch(() => undefined)
    return this.transition
  }

  private async start(): Promise<void> {
    if (this.server?.running) return
    const server = new CtlServer(this.transport, (token) => this.tokens.resolve(token), this.handlers.handle)
    try {
      await server.start()
    } catch (error) {
      this.error = `server: ${error instanceof Error ? error.message : String(error)}`
      console.warn('[cli] control server did not start:', this.error)
      return
    }
    if (!this.enabled) {
      await server.stop()
      return
    }
    this.server = server
    this.startedAt = Date.now()
    this.error = undefined
    try {
      writeRuntimeFile(this.runtimePath(), {
        version: 1,
        pid: process.pid,
        appVersion: this.deps.appVersion,
        startedAt: this.startedAt,
        transport: this.transport,
        token: this.master,
      })
    } catch (error) {
      this.error = `runtime.json: ${error instanceof Error ? error.message : String(error)}`
      console.warn('[cli] could not write runtime.json:', this.error)
    }
  }

  private async stop(): Promise<void> {
    const server = this.server
    this.server = null
    this.startedAt = null
    removeRuntimeFileIfOwned(this.runtimePath())
    this.handlers.dispose()
    if (server) await server.stop()
  }

  /**
   * Env of a new pty (PtyManager env provider): a console token bound to the
   * pane, the endpoint, the shim, the workspace. Nothing while the CLI is off.
   * Never logged.
   */
  envFor(ptyId: string, paneId: string, workspaceId?: string): Record<string, string> {
    if (!this.enabled || !this.shimFile) return {}
    const ws = workspaceId || this.workspaceOf(paneId)
    const token = this.tokens.issue(ptyId, paneId, ws)
    const env: Record<string, string> = {
      [CLI_ENV.ctlEndpoint]: this.transport.endpoint,
      [CLI_ENV.ctlToken]: token,
      [CLI_ENV.cli]: this.shimFile,
    }
    if (ws) env[CLI_ENV.workspaceId] = ws
    return env
  }

  private workspaceOf(paneId: string): string {
    for (const ws of this.deps.config()?.workspaces ?? []) if (ws.panes.some((p) => p.id === paneId)) return ws.id
    return ''
  }

  /** Pty lifecycle: tokens die with their pty; waits and status lines follow the pane. */
  readonly sink: PtySink = {
    id: 'cli',
    onSpawn: (_ptyId, paneId) => this.handlers.onPtySpawn(paneId),
    onData: () => {},
    onExit: (ptyId: string, paneId: string, _code: number, info: PtyExitInfo) => {
      this.tokens.revoke(ptyId)
      if (info.current) this.handlers.onPtyExit(paneId)
    },
  }

  private userPathAvailable(): boolean {
    return (this.deps.platform ?? process.platform) === 'win32' && !this.deps.portable
  }

  async uiState(): Promise<CliUiState> {
    let inUserPath = false
    if (this.userPathAvailable()) {
      try {
        inUserPath = await isInUserPath(this.binDir(), this.deps.registry ?? realRegistry)
      } catch {
        inUserPath = false
      }
    }
    return {
      enabled: this.enabled,
      running: this.running,
      endpoint: this.running ? this.transport.endpoint : null,
      startedAt: this.startedAt,
      shimPath: this.shimFile || join(this.binDir(), 'snaos'),
      binDir: this.binDir(),
      portable: this.deps.portable,
      inUserPath,
      ...(this.error ? { error: this.error } : {}),
    }
  }

  /** Skill op on one agent's skills folder (Claude Code by default, or Codex). */
  skill(op: SkillOp, target: SkillTarget = 'claude'): SkillStatus {
    const v = this.deps.appVersion
    const env = this.deps.skillEnv ?? process.env
    switch (op) {
      case 'install':
        return installSkill(target, v, env)
      case 'remove':
        return removeSkill(target, v, env)
      case 'repair':
        return repairSkill(target, v, env)
      default:
        return skillStatus(target, v, env)
    }
  }

  /** Adds or removes <dataDir>\bin in the user PATH. False when unavailable (portable, not Windows) or failed. */
  async setUserPath(on: boolean): Promise<boolean> {
    if (!this.userPathAvailable()) return false
    try {
      return on ? await addToUserPath(this.binDir(), this.deps.registry ?? realRegistry) : await removeFromUserPath(this.binDir(), this.deps.registry ?? realRegistry)
    } catch (error) {
      console.warn('[cli] user PATH update failed:', error instanceof Error ? error.message : String(error))
      return false
    }
  }

  /** before-quit: runtime.json goes (only ours), the server closes, waits end. */
  shutdown(): void {
    this.enabled = false
    removeRuntimeFileIfOwned(this.runtimePath())
    this.handlers.dispose()
    this.bus.dispose()
    const server = this.server
    this.server = null
    if (server) void server.stop()
  }

  /** True when the shim file exists (Settings shows the copy example only then). */
  shimExists(): boolean {
    return !!this.shimFile && existsSync(this.shimFile)
  }
}
