// Adaptado de stablyai/orca (MIT) - src/main/powershell-osc133-bootstrap.ts
import { BRAND } from '@shared/brand'

/**
 * PowerShell shell integration (E6-FR-25..31). A Windows PowerShell 5.1 or
 * pwsh console launched without arguments gets a static bootstrap through
 * `-NoExit -EncodedCommand`: it runs after the user's profile, so the final
 * `prompt` (oh-my-posh, starship, posh-git) is the one wrapped. The script
 * carries no user data and only acts in FullLanguage; under
 * ConstrainedLanguage it does nothing and every mark feature stays inert.
 *
 * Marks (OSC 133, BEL terminated): A prompt start, B prompt end, C command
 * start (from PSConsoleHostReadLine, so only with PSReadLine), D;<code>
 * command end, written before the next A.
 */

/** Environment variable a console with the integration gets (and the script sets). */
export const SHELL_INTEGRATION_ENV = `${BRAND.envPrefix}SHELL_INTEGRATION`

/** Start of the prompt mark: the ready-marker PtyManager waits for (E6-FR-30). */
export const OSC133_PROMPT_START = '\x1b]133;A'

/**
 * The bootstrap. Exit code in D (E6-FR-28): 0 when `$?` (the first statement
 * of the prompt) is true; otherwise `$LASTEXITCODE` when it changed since C
 * (a native command), else 1 (a cmdlet). A native command that fails with the
 * same code as the previous one reports 1: still red, accepted. The original
 * prompt is invoked with `$?` and `$LASTEXITCODE` as the user left them.
 */
const SCRIPT = [
  "if ($ExecutionContext.SessionState.LanguageMode -eq 'FullLanguage') {",
  '  try {',
  '    $__snaosEnc = New-Object System.Text.UTF8Encoding($false)',
  '    try { [Console]::OutputEncoding = $__snaosEnc } catch {}',
  '    try { [Console]::InputEncoding = $__snaosEnc } catch {}',
  '    $Global:OutputEncoding = $__snaosEnc',
  '  } catch {}',
  `  $env:${SHELL_INTEGRATION_ENV} = '1'`,
  '  $__snaosPrompt = $function:prompt',
  "  if ($null -eq $__snaosPrompt) { $__snaosPrompt = { 'PS ' + $ExecutionContext.SessionState.Path.CurrentLocation + ('>' * ($NestedPromptLevel + 1)) + ' ' } }",
  '  $Global:__SnaosOsc133 = @{ LecAtC = $null; Ran = $false; First = $true; Prompt = $__snaosPrompt; ReadLine = $null }',
  '  $Global:__SnaosOsc133.Hook = {',
  '    $s = $Global:__SnaosOsc133',
  '    if ($null -ne $s.ReadLine -or -not (Test-Path Function:\\PSConsoleHostReadLine)) { return }',
  '    $s.ReadLine = $function:PSConsoleHostReadLine',
  '    function Global:PSConsoleHostReadLine {',
  '      $s = $Global:__SnaosOsc133',
  '      $line = & $s.ReadLine',
  '      if ($null -ne $line -and ([string]$line).Trim().Length -gt 0) {',
  '        $s.LecAtC = $Global:LASTEXITCODE',
  '        $s.Ran = $true',
  "        [Console]::Write([string][char]27 + ']133;C' + [string][char]7)",
  '      }',
  '      $line',
  '    }',
  '  }',
  '  & $Global:__SnaosOsc133.Hook',
  '  function Global:prompt {',
  '    $ok = $?',
  '    $lec = $Global:LASTEXITCODE',
  '    $s = $Global:__SnaosOsc133',
  '    $e = [string][char]27',
  '    $b = [string][char]7',
  '    if ($s.Ran -or ($null -eq $s.ReadLine -and -not $s.First)) {',
  '      $code = 0',
  '      if (-not $ok) { if ($lec -and $lec -ne $s.LecAtC) { $code = $lec } else { $code = 1 } }',
  "      [Console]::Write($e + ']133;D;' + $code + $b)",
  '    }',
  '    $s.LecAtC = $lec',
  '    $s.Ran = $false',
  '    $s.First = $false',
  '    & $s.Hook',
  "    [Console]::Write($e + ']133;A' + $b)",
  '    $Global:LASTEXITCODE = $lec',
  "    if (-not $ok) { Write-Error 'failure' -ErrorAction Ignore }",
  '    $p = & $s.Prompt',
  '    $Global:LASTEXITCODE = $lec',
  "    return ([string]$p) + $e + ']133;B' + $b",
  '  }',
  '}',
].join('\n')

/** The bootstrap source (tests decode the encoded argument back to this). */
export function integrationScript(): string {
  return SCRIPT
}

let encoded: string[] | null = null

/** `-NoExit -EncodedCommand <base64 UTF-16LE>` for the static bootstrap (E6-FR-25). */
export function buildIntegrationArgs(): string[] {
  if (!encoded) encoded = ['-NoExit', '-EncodedCommand', Buffer.from(SCRIPT, 'utf16le').toString('base64')]
  return [...encoded]
}

/** True for powershell(.exe) and pwsh(.exe), by file name, any case, any folder. */
export function isPowerShellExe(name: string): boolean {
  const base = name.trim().replace(/^"|"$/g, '').replace(/\\/g, '/').split('/').pop() ?? ''
  return /^(powershell|pwsh)(\.exe)?$/i.test(base)
}

export interface IntegrationReq {
  /** The resolved executable node-pty will launch. */
  shell: string
  /** Explicit arguments of the spawn (a repo setup console's command, a custom shell). */
  args?: string | string[] | null
  platform: NodeJS.Platform
  /** `terminalShellIntegration`, as main's engine settings carry it. */
  enabled: boolean
}

/**
 * Whether a spawn gets the integration: on, on Windows, PowerShell, and no
 * arguments of its own (a shell launched with args keeps exactly those).
 */
export function shouldIntegrate(req: IntegrationReq): boolean {
  return req.enabled && req.platform === 'win32' && isPowerShellExe(req.shell) && (!req.args || req.args.length === 0)
}

/** A complete OSC 133 sequence, BEL or ST terminated. */
const OSC133_RE = /\x1b\]133;[^\x07\x1b]*(?:\x07|\x1b\\)/g
/** An OSC 133 cut at the end of the text (the rest arrives with the next chunk). */
const OSC133_TAIL_RE = /\x1b(?:\]1(?:3(?:3(?:;[^\x07\x1b]*)?)?)?)?$/

/**
 * The text without OSC 133 marks (E6-FR-31), so a `waitFor` regex anchored at
 * the end of the prompt (`/> $/`) still matches with the integration on. A
 * mark cut at the very end is dropped too; it completes on the next chunk.
 */
export function stripOsc133(text: string): string {
  if (!text.includes('\x1b')) return text
  return text.replace(OSC133_RE, '').replace(OSC133_TAIL_RE, '')
}
