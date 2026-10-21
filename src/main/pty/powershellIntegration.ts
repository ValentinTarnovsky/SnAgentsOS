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
 * command end, written before the next A. Before each A, an OSC 7 with the
 * current folder (file system locations only) feeds the console's git chip.
 *
 * v2.4: a C whose first token is `claude` or `codex` (a literal alias to one
 * counts) carries `;agent=<name>`, and A, D and that C carry `;k=<nonce>`:
 * the per-pty secret main passed in SHELL_MARK_ENV, which the bootstrap
 * keeps and removes from the environment so no child (or ssh) inherits it.
 * Only the enum leaves the shell, never the command line.
 */

/** Environment variable a console with the integration gets (and the script sets). */
export const SHELL_INTEGRATION_ENV = `${BRAND.envPrefix}SHELL_INTEGRATION`

/** v2.4: the per-pty nonce of the marks (hex), read once and removed by the bootstrap. */
export const SHELL_MARK_ENV = `${BRAND.envPrefix}SHELL_MARK`

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
  "  $Global:__SnaosOsc133 = @{ LecAtC = $null; Ran = $false; First = $true; Prompt = $__snaosPrompt; ReadLine = $null; Mark = '' }",
  // v2.4: the marks' nonce lives in the state only; no child process inherits it.
  `  if ($env:${SHELL_MARK_ENV} -match '^[0-9a-f]{16,64}$') { $Global:__SnaosOsc133.Mark = ';k=' + $env:${SHELL_MARK_ENV} }`,
  `  Remove-Item -LiteralPath 'Env:${SHELL_MARK_ENV}' -ErrorAction Ignore`,
  // -EncodedCommand runs in the global scope: drop the temporaries so they never show up in the session.
  "  Remove-Variable -Name '__snaosEnc', '__snaosPrompt' -ErrorAction Ignore",
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
  "        [Console]::Write([string][char]27 + ']133;C' + (& $s.Agent ([string]$line)) + [string][char]7)",
  '      }',
  '      $line',
  '    }',
  '  }',
  // v2.4: ';agent=claude|codex' plus the nonce when the first token, or a
  // literal alias of it (never a wildcard, never Get-Command), names one; else ''.
  '  $Global:__SnaosOsc133.Agent = {',
  '    param($l)',
  "    $r = ''",
  '    try {',
  '      $s = $Global:__SnaosOsc133',
  '      if ($s.Mark) {',
  "        $t = (($l.TrimStart() -split '\\s+', 2)[0]).Trim([char]34, [char]39)",
  '        $n = [IO.Path]::GetFileNameWithoutExtension($t)',
  "        if ($t.Length -gt 0 -and $n -notmatch '^(claude|codex)$') {",
  "          $n = ''",
  "          $a = Get-Item -LiteralPath ('Alias:' + $t) -ErrorAction Ignore",
  '          if ($null -ne $a) { $n = [IO.Path]::GetFileNameWithoutExtension([string]$a.Definition) }',
  '        }',
  "        if ($n -match '^(claude|codex)$') { $r = ';agent=' + $n.ToLowerInvariant() + $s.Mark }",
  '      }',
  '    } catch {}',
  '    $r',
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
  "      [Console]::Write($e + ']133;D;' + $code + $s.Mark + $b)",
  '    }',
  '    $s.LecAtC = $lec',
  '    $s.Ran = $false',
  '    $s.First = $false',
  '    & $s.Hook',
  '    $loc = $ExecutionContext.SessionState.Path.CurrentLocation',
  "    if ($loc.Provider.Name -eq 'FileSystem') {",
  "      $u = (($loc.ProviderPath -replace '\\\\', '/') -replace '%', '%25') -replace ' ', '%20'",
  "      [Console]::Write($e + ']7;file://localhost/' + $u + $b)",
  '    }',
  "    [Console]::Write($e + ']133;A' + $s.Mark + $b)",
  '    $Global:LASTEXITCODE = $lec',
  "    if (-not $ok) { Write-Error 'failure' -ErrorAction Ignore }",
  '    $p = & $s.Prompt',
  '    $Global:LASTEXITCODE = $lec',
  "    return ([string]$p) + $e + ']133;B' + $b",
  '  }',
  // Under ConstrainedLanguage the marks stay inert, and the nonce still leaves the environment.
  `} else { Remove-Item -LiteralPath 'Env:${SHELL_MARK_ENV}' -ErrorAction Ignore }`,
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

/** A complete OSC 133 (or the OSC 7 the prompt writes next to it), BEL or ST terminated. */
const OSC133_RE = /\x1b\](?:133|7);[^\x07\x1b]*(?:\x07|\x1b\\)/g
/** An OSC 133 or OSC 7 cut at the end of the text (the rest arrives with the next chunk). */
const OSC133_TAIL_RE = /\x1b(?:\](?:1(?:3(?:3(?:;[^\x07\x1b]*)?)?)?|7(?:;[^\x07\x1b]*)?)?)?$/

/**
 * The text without OSC 133 marks (E6-FR-31), so a `waitFor` regex anchored at
 * the end of the prompt (`/> $/`) still matches with the integration on. A
 * mark cut at the very end is dropped too; it completes on the next chunk.
 */
export function stripOsc133(text: string): string {
  if (!text.includes('\x1b')) return text
  return text.replace(OSC133_RE, '').replace(OSC133_TAIL_RE, '')
}
