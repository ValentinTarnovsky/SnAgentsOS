/**
 * Single source of truth for the product identity (main, renderer and mobile).
 * No other file under src/ (except src/main/migration/*) may spell the legacy
 * name: everything reads it from LEGACY_BRAND. electron-builder.yml cannot
 * import TS, so scripts/test-rebrand.cjs checks it against these values.
 */
export const BRAND = {
  productName: 'SnAgentsOS',
  packageName: 'snagentsos',
  appId: 'com.sndevelopment.snagentsos',
  repo: 'ValentinTarnovsky/SnAgentsOS',
  cliBin: 'snaos', // CLI epic (idea 18)
  repoConfigFile: '.snagentsos.json', // idea 19
  skillDir: 'snagentsos', // ~/.claude/skills/snagentsos
  envPrefix: 'SNAOS_',
  mobileTitle: 'SnAgentsOS Remote',
  portableDataDir: 'snagentsos-data',
  devUserDataDir: 'snagentsos-dev', // E0-FR-26
  mobileStoragePrefix: 'snagentsos.',
  hookStatusMessage: 'SnAgentsOS session status',
  exportFileName: 'snagentsos-config.json',
  tempPrefix: 'snagentsos-',
} as const

/** Identity of 1.x, only for detecting, migrating and cleaning its leftovers. */
export const LEGACY_BRAND = {
  productName: 'SnMultiCC',
  packageName: 'snmulticc',
  appId: 'com.sndevelopment.snmulticc',
  nsisGuid: '8c5f793e-c93a-5e95-add6-ae90c4af8c04',
  winExe: 'SnMultiCC.exe',
  macProcess: 'SnMultiCC',
  linuxProcess: 'snmulticc', // executableName = sanitizedName.toLowerCase()
  envPrefix: 'SNMULTICC_',
  portableDataDir: 'snmulticc-data',
  mobileStoragePrefix: 'snmulticc.',
  hookStatusMessage: 'SnMultiCC session status',
  tempPrefix: 'snmulticc-',
  updaterCacheDir: 'snmulticc-updater',
  portableUnpackDir: 'SnMultiCC', // %TEMP%\SnMultiCC
} as const

/** Environment variables each pty receives (E0-FR-05). */
export const AGENT_ENV = {
  consoleId: 'SNAOS_CONSOLE_ID',
  ptyId: 'SNAOS_PTY_ID',
  codexUrl: 'SNAOS_CODEX_URL',
  codexToken: 'SNAOS_CODEX_TOKEN',
  realCodex: 'SNAOS_REAL_CODEX',
  codexShim: 'SNAOS_CODEX_SHIM',
  codexExit: 'SNAOS_CODEX_EXIT',
  /**
   * `codex:<paneId>` in the environment of the commands a console's Codex
   * runs, so a `claude -p` it starts reports its hooks as a sub-session.
   */
  agentParent: 'SNAOS_AGENT_PARENT',
} as const

/** Extra environment of each pty while the snaos CLI is on (E8-FR-13); its bin folder goes first in PATH. */
export const CLI_ENV = {
  workspaceId: 'SNAOS_WORKSPACE_ID',
  ctlEndpoint: 'SNAOS_CTL_ENDPOINT',
  ctlToken: 'SNAOS_CTL_TOKEN',
  cli: 'SNAOS_CLI',
  /**
   * App 2.7.0 (Teams): the run id, only in a team run's environment. With it
   * set, the CLI never falls back to runtime.json (a lost team token gives
   * `unauthorized`, never the master token).
   */
  teamRun: 'SNAOS_TEAM_RUN',
} as const

/**
 * Values build/installer.nsh writes under SHCTX\<key> (HKCU per-user, HKLM
 * per-machine) during the 1.x upgrade. The legacy cleanup reads both hives and
 * deletes the values once L04 and L08 are terminal (E0-FR-15, FR-31, FR-32,
 * FR-34). NSIS cannot import TS: scripts/test-rebrand.cjs checks the names.
 */
export const INSTALLER_REG = {
  key: `Software\\${LEGACY_BRAND.nsisGuid}`,
  legacyInstallLocation: 'LegacyInstallLocation',
  legacyTaskbarPinned: 'LegacyTaskbarPinned',
} as const
