// Adaptado de stablyai/orca (MIT) - src/main/runtime/windows-mobile-firewall.ts
/**
 * Windows firewall check and one-click fix for the remote-control server
 * (E2-FR-38/39). Windows only; every other platform reports 'unsupported'.
 *
 * Inspection (remote:firewallCheck) runs a read-only PowerShell 5.1 script
 * (-NoProfile -NonInteractive -EncodedCommand, UTF-8 output forced) that
 * reports the network profile of every endpoint the phone can use and the
 * enabled inbound rules that could matter: rules on the current exe (and on
 * any exe with the same file name), rules on the pre-rebrand exe, and
 * program-less rules whose TCP port filter covers the port or Any. Main then
 * classifies them here, never by rule name:
 *  - an Allow counts only for the exact current exe path or for the port, so
 *    a rule on the exe from before the rebrand never counts as found;
 *  - a Block on the 1.x exe is inert (that exe is gone, E0 Q12) and ignored;
 *  - other Blocks are currentProgram / otherProgram / port. A Block on another
 *    path never applies to this exe, so it is listed but does not block;
 *  - a rule applies to an endpoint only when its profile covers the
 *    endpoint's network category (Block wins over Allow, as in Windows).
 *
 * Fix (remote:firewallFix) runs a script built here from fixed values (the
 * port and exe never come from the renderer) through an unelevated wrapper
 * that starts it with Start-Process -Verb RunAs -Wait and maps a cancelled
 * UAC prompt to exit code 1223. The script removes the enabled inbound Block
 * rules on the current exe (TCP or Any, profile Private or Any, plus Public
 * when the Tailscale rule is made and Domain on a domain network, the port or
 * Any) and recreates our own Allow rule under a stable -Name, so running it
 * twice never duplicates rules. The installed app scopes the rule to its exe
 * and port; portable and dev builds scope it to the port only (their exe
 * lives in a temp folder). A Tailscale endpoint adds a second rule limited to
 * RemoteAddress 100.64.0.0/10 on any profile. Port Blocks are never removed:
 * they make the state not fixable. After the fix the status is re-checked
 * without the cache.
 */
import type { FirewallBlockingRule, FirewallEndpointCheck, FirewallFixRes, FirewallProfile, FirewallStatus, RemoteEndpoint } from '@shared/ipc-contract'
import { BRAND, LEGACY_BRAND } from '@shared/brand'
import { isVirtualAdapter } from './network'

export const FIREWALL_CHECK_TIMEOUT_MS = 10_000
/** The fix waits for the user on the UAC prompt. */
export const FIREWALL_FIX_TIMEOUT_MS = 180_000
export const FIREWALL_CACHE_MS = 60_000
export const FW_RULE_LAN = `${BRAND.productName}.Remote.TCP`
export const FW_RULE_TAILNET = `${BRAND.productName}.Remote.Tailnet`
export const TAILNET_CIDR = '100.64.0.0/10'
/** Exit code of a cancelled UAC prompt (ERROR_CANCELLED). */
export const UAC_CANCELLED = 1223
/** Exit code the elevated script uses for any failure. */
const FIX_FAILED = 3

/** A literal for a PowerShell single-quoted string (PS also treats U+2018..U+201B as quotes). */
export function psQuote(value: string): string {
  return `'${String(value).replace(/['‘’‚‛]/g, (m) => m + m)}'`
}

/** -EncodedCommand payload: base64 of the UTF-16LE script. */
export function encodePs(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64')
}

export function psArgs(script: string): string[] {
  return ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encodePs(script)]
}

function validPort(port: number): number {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`bad port ${port}`)
  return port
}

function fileName(p: string): string {
  const parts = p.split(/[\\/]/)
  return parts[parts.length - 1] ?? ''
}

/** Path for comparisons: backslashes, no trailing separator, lower case (Windows paths). */
export function normPath(p: string): string {
  return p.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase()
}

const IPV4 = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/

export interface InspectScriptInput {
  exe: string
  port: number
  ips: string[]
}

/** The read-only inspection script. Its JSON is parsed by parseInspectOutput(). */
export function buildInspectScript({ exe, port, ips }: InspectScriptInput): string {
  const p = validPort(port)
  const ipList = ips.filter((ip) => IPV4.test(ip)).map(psQuote)
  return [
    "$ErrorActionPreference = 'Stop'",
    "$ProgressPreference = 'SilentlyContinue'",
    '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
    `$exe = ${psQuote(exe)}`,
    `$leaf = ${psQuote(fileName(exe))}`,
    `$legacy = ${psQuote(LEGACY_BRAND.winExe)}`,
    `$port = ${p}`,
    `$ips = @(${ipList.join(', ')})`,
    '$eps = @()',
    'foreach ($ip in $ips) {',
    "  $cat = ''; $nm = ''; $al = ''",
    '  try {',
    '    $a = Get-NetIPAddress -IPAddress $ip -ErrorAction Stop | Select-Object -First 1',
    '    $al = [string]$a.InterfaceAlias',
    '    $pr = Get-NetConnectionProfile -InterfaceIndex $a.InterfaceIndex -ErrorAction Stop | Select-Object -First 1',
    '    if ($pr) { $cat = [string]$pr.NetworkCategory; $nm = [string]$pr.Name }',
    '  } catch {}',
    '  $eps += [pscustomobject]@{ ip = $ip; profile = $cat; name = $nm; alias = $al }',
    '}',
    // A bulk Get-NetFirewallPortFilter is denied without elevation; piping the
    // rules into the filter cmdlets is allowed and takes about a second.
    '$all = @(Get-NetFirewallRule -Direction Inbound -Enabled True -PolicyStore ActiveStore)',
    '$app = @{}',
    'foreach ($f in @($all | Get-NetFirewallApplicationFilter)) { $app[[string]$f.InstanceID] = $f }',
    '$svc = @{}',
    'foreach ($f in @($all | Get-NetFirewallServiceFilter)) { $svc[[string]$f.InstanceID] = [string]$f.Service }',
    '$pfs = @{}',
    'foreach ($f in @($all | Get-NetFirewallPortFilter)) { $pfs[[string]$f.InstanceID] = $f }',
    '$rules = @()',
    'foreach ($r in $all) {',
    '  $id = [string]$r.InstanceID',
    '  $af = $app[$id]',
    "  $prog = 'Any'; $pkg = ''",
    '  if ($af) { $prog = [string]$af.Program; $pkg = [string]$af.Package }',
    "  if (-not $prog) { $prog = 'Any' }",
    "  $sv = [string]$svc[$id]; if (-not $sv) { $sv = 'Any' }",
    '  # Rules scoped to a service, an app package or another account never apply to the app.',
    "  if ($sv -ne 'Any' -or $pkg -or [string]$r.Owner) { continue }",
    "  if ($prog -ne 'Any') { $prog = [Environment]::ExpandEnvironmentVariables($prog) }",
    "  $proto = 'Any'; $lp = @('Any')",
    '  $f = $pfs[$id]',
    '  if ($f) { $proto = [string]$f.Protocol; $lp = @($f.LocalPort | ForEach-Object { [string]$_ }) }',
    '  $keep = $false',
    "  if ($prog -ne 'Any') {",
    '    $pl = [System.IO.Path]::GetFileName($prog)',
    '    if ($prog -ieq $exe -or $pl -ieq $leaf -or $pl -ieq $legacy) { $keep = $true }',
    "  } elseif ($proto -eq 'TCP' -or $proto -eq 'Any' -or $proto -eq '6') {",
    '    foreach ($x in $lp) {',
    "      if ($x -eq 'Any' -or $x -eq [string]$port) { $keep = $true }",
    "      elseif ($x -match '^(\\d+)-(\\d+)$') { if ($port -ge [int]$Matches[1] -and $port -le [int]$Matches[2]) { $keep = $true } }",
    '    }',
    '  }',
    '  if ($keep) {',
    "    $ifs = @('Any')",
    '    $inf = $r | Get-NetFirewallInterfaceFilter',
    '    if ($inf) { $ifs = @($inf.InterfaceAlias | ForEach-Object { [string]$_ }) }',
    "    $las = @('Any')",
    '    $adf = $r | Get-NetFirewallAddressFilter',
    '    if ($adf) { $las = @($adf.LocalAddress | ForEach-Object { [string]$_ }) }',
    '    $rules += [pscustomobject]@{ name = [string]$r.Name; displayName = [string]$r.DisplayName; action = [string]$r.Action; program = $prog; protocol = $proto; localPort = @($lp); profile = [string]$r.Profile; interfaces = @($ifs); localAddress = @($las) }',
    '  }',
    '}',
    'ConvertTo-Json -InputObject ([pscustomobject]@{ endpoints = @($eps); rules = @($rules) }) -Compress -Depth 4',
  ].join('\n')
}

export interface FixScriptInput {
  exe: string
  port: number
  /** Scope the Allow rule to the exe (installed app) or to the port only. */
  programScope: boolean
  /** Add the Tailscale rule (RemoteAddress 100.64.0.0/10, any profile). */
  tailnet: boolean
  /** A LAN endpoint is on a domain network: the LAN rule covers Domain too. */
  domain: boolean
  /** Rule names and display labels; absent = the phone server's (FW_RULES_REMOTE). */
  rules?: FirewallRuleNames
}

/**
 * The stable -Name of our two Allow rules and the label their DisplayName
 * starts with ("<label> (TCP <port>)"). The phone server and the Share
 * listener (app 2.4.0) each own a pair, so neither fix touches the other's.
 */
export interface FirewallRuleNames {
  lan: string
  tailnet: string
  lanLabel: string
  tailnetLabel: string
}

export const FW_RULES_REMOTE: FirewallRuleNames = {
  lan: FW_RULE_LAN,
  tailnet: FW_RULE_TAILNET,
  lanLabel: `${BRAND.productName} Remote`,
  tailnetLabel: `${BRAND.productName} Remote Tailscale`,
}

export const FW_RULES_SHARE: FirewallRuleNames = {
  lan: `${BRAND.productName}.Share.TCP`,
  tailnet: `${BRAND.productName}.Share.Tailnet`,
  lanLabel: `${BRAND.productName} Share`,
  tailnetLabel: `${BRAND.productName} Share Tailscale`,
}

/** The elevated fix script: remove the current exe's Blocks, recreate our Allow rule(s). */
export function buildFixScript({ exe, port, programScope, tailnet, domain, rules = FW_RULES_REMOTE }: FixScriptInput): string {
  const p = validPort(port)
  const program = programScope ? ` -Program ${psQuote(exe)}` : ''
  const lanName = psQuote(rules.lan)
  const tailName = psQuote(rules.tailnet)
  // Blocks on the current exe are removed on the profiles our rules open:
  // Private (plus Domain on a domain network), and Public too when the
  // Tailscale rule is created, since the tailnet adapter usually sits on a
  // Public network and the Defender dialog leaves a Public Block there.
  // Without our Allow rules nothing else opens on those profiles.
  const removeProfiles = ['Private', ...(domain ? ['Domain'] : []), ...(tailnet ? ['Public'] : [])].join('|')
  const lines = [
    "$ErrorActionPreference = 'Stop'",
    "$ProgressPreference = 'SilentlyContinue'",
    'try {',
    `  $exe = ${psQuote(exe)}`,
    `  $port = '${p}'`,
    '  $targets = @()',
    '  foreach ($f in @(Get-NetFirewallApplicationFilter -PolicyStore PersistentStore)) {',
    '    $pg = [string]$f.Program',
    "    if ($pg -and $pg -ne 'Any' -and ([Environment]::ExpandEnvironmentVariables($pg) -ieq $exe)) { $targets += $f }",
    '  }',
    '  foreach ($f in $targets) {',
    '    foreach ($r in @($f | Get-NetFirewallRule)) {',
    "      if ([string]$r.Direction -ne 'Inbound' -or [string]$r.Action -ne 'Block' -or [string]$r.Enabled -ne 'True') { continue }",
    '      $prof = [string]$r.Profile',
    `      if ($prof -ne 'Any' -and $prof -notmatch ${psQuote(removeProfiles)}) { continue }`,
    '      $pf = $r | Get-NetFirewallPortFilter',
    '      $proto = [string]$pf.Protocol',
    "      if ($proto -ne 'TCP' -and $proto -ne 'Any' -and $proto -ne '6') { continue }",
    '      $lp = @($pf.LocalPort | ForEach-Object { [string]$_ })',
    "      if (-not ($lp -contains 'Any' -or $lp -contains $port)) { continue }",
    '      $r | Remove-NetFirewallRule',
    '    }',
    '  }',
    `  Get-NetFirewallRule -Name ${lanName} -ErrorAction SilentlyContinue | Remove-NetFirewallRule`,
    `  New-NetFirewallRule -Name ${lanName} -DisplayName ${psQuote(`${rules.lanLabel} (TCP ${p})`)} -Direction Inbound -Action Allow -Protocol TCP -LocalPort ${p} -Profile ${domain ? 'Private,Domain' : 'Private'} -RemoteAddress LocalSubnet${program} -EdgeTraversalPolicy Block | Out-Null`,
    `  Get-NetFirewallRule -Name ${tailName} -ErrorAction SilentlyContinue | Remove-NetFirewallRule`,
  ]
  if (tailnet) {
    lines.push(
      `  New-NetFirewallRule -Name ${tailName} -DisplayName ${psQuote(`${rules.tailnetLabel} (TCP ${p})`)} -Direction Inbound -Action Allow -Protocol TCP -LocalPort ${p} -Profile Any -RemoteAddress ${TAILNET_CIDR}${program} -EdgeTraversalPolicy Block | Out-Null`,
    )
  }
  lines.push('  exit 0', '} catch {', `  exit ${FIX_FAILED}`, '}')
  return lines.join('\n')
}

/**
 * Unelevated wrapper: starts the fix elevated and waits. A cancelled UAC
 * prompt surfaces as a Win32Exception with NativeErrorCode 1223 somewhere in
 * the exception chain; it exits with 1223, any other failure with 2.
 */
export function buildElevatedWrapper(innerScript: string): string {
  const inner = encodePs(innerScript)
  return [
    "$ErrorActionPreference = 'Stop'",
    "$ProgressPreference = 'SilentlyContinue'",
    'try {',
    `  $p = Start-Process -FilePath (Join-Path $PSHOME 'powershell.exe') -ArgumentList @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-EncodedCommand', '${inner}') -Verb RunAs -Wait -PassThru -WindowStyle Hidden`,
    '  exit $p.ExitCode',
    '} catch {',
    '  $e = $_.Exception',
    `  while ($e) { if ($e.NativeErrorCode -eq ${UAC_CANCELLED}) { exit ${UAC_CANCELLED} }; $e = $e.InnerException }`,
    '  exit 2',
    '}',
  ].join('\n')
}

// --- parsing / classification ---

interface RawEndpoint {
  ip?: unknown
  profile?: unknown
  name?: unknown
  alias?: unknown
}

interface RawRule {
  name?: unknown
  displayName?: unknown
  action?: unknown
  program?: unknown
  protocol?: unknown
  localPort?: unknown
  profile?: unknown
  interfaces?: unknown
  localAddress?: unknown
}

export interface ClassifyContext {
  exe: string
  port: number
  programScope: boolean
  endpoints: RemoteEndpoint[]
  now: number
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : v == null ? '' : String(v)
}

/** ConvertTo-Json turns a one-element array into a scalar; accept both. */
function list<T>(v: unknown): T[] {
  if (Array.isArray(v)) return v as T[]
  return v == null ? [] : [v as T]
}

export function normProfile(raw: string): FirewallProfile {
  const v = raw.trim().toLowerCase()
  if (v === 'private' || v === '1') return 'Private'
  if (v === 'public' || v === '0') return 'Public'
  if (v === 'domainauthenticated' || v === '2') return 'DomainAuthenticated'
  return 'unknown'
}

const PROFILE_RANK: Record<FirewallProfile, number> = { Public: 3, unknown: 2, Private: 1, DomainAuthenticated: 0 }

/** The worst profile among the endpoints (contract `profile`). */
export function worstProfile(endpoints: FirewallEndpointCheck[]): FirewallProfile {
  let worst: FirewallProfile | null = null
  for (const e of endpoints) if (worst === null || PROFILE_RANK[e.profile] > PROFILE_RANK[worst]) worst = e.profile
  return worst ?? 'unknown'
}

function tcp(protocol: string): boolean {
  const p = protocol.trim().toLowerCase()
  return p === 'tcp' || p === 'any' || p === '6' || p === ''
}

export function portCovers(localPort: string[], port: number): boolean {
  if (localPort.length === 0) return true
  return localPort.some((x) => {
    const v = x.trim()
    if (v.toLowerCase() === 'any') return true
    if (/^\d+$/.test(v)) return Number(v) === port
    const m = /^(\d+)-(\d+)$/.exec(v)
    return !!m && port >= Number(m[1]) && port <= Number(m[2])
  })
}

/** True when a rule's profile set (`Any`, `Private, Public`, ...) applies to a network category. */
export function profileApplies(ruleProfile: string, category: FirewallProfile): boolean {
  const v = ruleProfile.toLowerCase()
  if (!v || v.includes('any') || category === 'unknown') return true
  if (category === 'Private') return v.includes('private')
  if (category === 'Public') return v.includes('public')
  return v.includes('domain')
}

function ipv4ToInt(ip: string): number | null {
  if (!IPV4.test(ip)) return null
  const parts = ip.split('.').map(Number)
  if (parts.some((n) => n > 255)) return null
  return ((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3]
}

/**
 * A LocalAddress filter entry (`Any`, an IP, `a.b.c.d/nn`, `a.b.c.d/255.255.0.0`,
 * `a-b`) covers an endpoint IP. Keywords and IPv6 entries never match an IPv4
 * endpoint; an empty filter is Any.
 */
export function localAddressCovers(entries: string[], ip: string): boolean {
  if (entries.length === 0) return true
  const target = ipv4ToInt(ip)
  return entries.some((raw) => {
    const v = raw.trim()
    if (!v || v.toLowerCase() === 'any' || v === '*') return true
    if (target === null) return false
    const range = /^([\d.]+)-([\d.]+)$/.exec(v)
    if (range) {
      const a = ipv4ToInt(range[1])
      const b = ipv4ToInt(range[2])
      return a !== null && b !== null && target >= a && target <= b
    }
    const cidr = /^([\d.]+)\/([\d.]+)$/.exec(v)
    if (cidr) {
      const base = ipv4ToInt(cidr[1])
      let mask: number | null
      if (/^\d+$/.test(cidr[2])) {
        const bits = Number(cidr[2])
        mask = bits <= 0 ? 0 : bits >= 32 ? 0xffffffff : (0xffffffff << (32 - bits)) >>> 0
      } else {
        mask = ipv4ToInt(cidr[2])
      }
      return base !== null && mask !== null && ((target & mask) >>> 0) === ((base & mask) >>> 0)
    }
    return ipv4ToInt(v) === target
  })
}

interface Rule {
  name: string
  displayName: string
  allow: boolean
  program: string | null
  protocol: string
  localPort: string[]
  profile: string
  interfaces: string[]
  localAddress: string[]
}

function toRule(r: RawRule): Rule {
  const program = str(r.program).trim()
  return {
    name: str(r.name),
    displayName: str(r.displayName) || str(r.name),
    allow: str(r.action).toLowerCase() === 'allow' || str(r.action) === '2',
    program: !program || program.toLowerCase() === 'any' ? null : program,
    protocol: str(r.protocol) || 'Any',
    localPort: list<unknown>(r.localPort).map(str).filter(Boolean),
    profile: str(r.profile) || 'Any',
    interfaces: list<unknown>(r.interfaces).map(str).filter(Boolean),
    localAddress: list<unknown>(r.localAddress).map(str).filter(Boolean),
  }
}

interface Endpoint extends FirewallEndpointCheck {
  alias: string
}

/** A rule applies to an endpoint when its profile, interface and local address all cover it. */
function appliesTo(rule: Rule, e: Endpoint): boolean {
  if (!profileApplies(rule.profile, e.profile)) return false
  const anyIf = rule.interfaces.length === 0 || rule.interfaces.some((i) => i.toLowerCase() === 'any')
  if (!anyIf && !rule.interfaces.some((i) => i.toLowerCase() === e.alias.toLowerCase())) return false
  return localAddressCovers(rule.localAddress, e.ip)
}

/** Map the inspection JSON to a FirewallStatus. Throws on output that is not that JSON. */
export function parseInspectOutput(stdout: string, ctx: ClassifyContext): FirewallStatus {
  const start = stdout.indexOf('{')
  if (start < 0) throw new Error('no JSON in the firewall inspection output')
  const raw = JSON.parse(stdout.slice(start)) as { endpoints?: unknown; rules?: unknown }
  const kindOf = new Map(ctx.endpoints.map((e) => [e.ip, e.kind]))
  const all: Endpoint[] = list<RawEndpoint>(raw.endpoints)
    .map((e) => {
      const ip = str(e.ip)
      const name = str(e.name)
      const out: Endpoint = { ip, kind: kindOf.get(ip) ?? 'other', profile: normProfile(str(e.profile)), alias: str(e.alias) }
      if (name) out.networkName = name
      return out
    })
    .filter((e) => IPV4.test(e.ip))
  // vEthernet / WSL / Docker adapters are not where phones connect: judge the
  // real adapters, falling back to everything when there is nothing else.
  const real = all.filter((e) => !isVirtualAdapter(e.alias))
  const judged = real.length > 0 ? real : all
  const exeNorm = normPath(ctx.exe)
  const exeLeaf = fileName(exeNorm)
  const legacyLeaf = LEGACY_BRAND.winExe.toLowerCase()

  let ruleFound = false
  const covered = new Set<string>()
  const blockingRules: FirewallBlockingRule[] = []
  for (const r of list<RawRule>(raw.rules).map(toRule)) {
    if (!tcp(r.protocol) || !portCovers(r.localPort, ctx.port)) continue
    const progNorm = r.program ? normPath(r.program) : null
    const current = progNorm === exeNorm
    if (r.allow) {
      // By exact exe path or by port; never by rule name, never the old exe.
      if (progNorm !== null && !current) continue
      ruleFound = true
      for (const e of judged) if (appliesTo(r, e)) covered.add(e.ip)
      continue
    }
    if (progNorm !== null && !current) {
      const leaf = fileName(progNorm)
      // The 1.x exe was deleted by the E0 cleanup: its rules are inert.
      if (leaf === legacyLeaf || leaf !== exeLeaf) continue
    }
    if (judged.length > 0 && !judged.some((e) => appliesTo(r, e))) continue
    blockingRules.push({
      name: r.name,
      displayName: r.displayName,
      scope: current ? 'currentProgram' : progNorm === null ? 'port' : 'otherProgram',
    })
  }

  const endpoints: FirewallEndpointCheck[] = all.map(({ alias: _alias, ...e }) => e)
  const portBlocked = blockingRules.some((b) => b.scope === 'port')
  const blocked = portBlocked || blockingRules.some((b) => b.scope === 'currentProgram')
  const publicLan = judged.some((e) => e.kind === 'lan' && e.profile === 'Public')
  const uncovered = judged.length === 0 ? !ruleFound : judged.some((e) => !covered.has(e.ip))
  // A Public LAN comes before a Block on our own exe: the Allow rule [Fix]
  // makes is Private only, so fixing first would end in "could not fix" while
  // the real step is marking the network Private (then Fix, if still needed).
  const state: FirewallStatus['state'] = portBlocked
    ? 'blocked'
    : publicLan
      ? 'publicProfile'
      : blocked
        ? 'blocked'
        : uncovered
          ? 'noRule'
          : 'ok'
  return {
    ok: state === 'ok',
    profile: worstProfile(judged),
    ruleFound,
    state,
    port: ctx.port,
    endpoints,
    blockingRules,
    ruleScope: ctx.programScope ? 'program' : 'port',
    fixable: !portBlocked,
    checkedAt: ctx.now,
  }
}

// --- service ---

export interface RunResult {
  code: number | null
  stdout: string
  timedOut: boolean
}

export interface FirewallDeps {
  platform: NodeJS.Platform
  /** The running executable (process.execPath; the temp copy on portable). */
  exe: () => string
  /** The configured / bound server port. */
  port: () => number
  /** Installed (packaged, not portable) build: rules by program and port. */
  programScope: () => boolean
  endpoints: (port: number) => RemoteEndpoint[]
  /** Run powershell.exe with these args. */
  run: (args: string[], timeoutMs: number) => Promise<RunResult>
  now: () => number
  /** Our rules' names and labels; absent = the phone server's (app 2.4.0: the Share listener has its own). */
  rules?: FirewallRuleNames
}

function baseStatus(state: 'unknown' | 'unsupported', port: number, programScope: boolean, now: number, detail?: string): FirewallStatus {
  const s: FirewallStatus = {
    ok: false,
    profile: 'unknown',
    ruleFound: false,
    state,
    port,
    endpoints: [],
    blockingRules: [],
    ruleScope: programScope ? 'program' : 'port',
    fixable: false,
    checkedAt: now,
  }
  if (detail) s.detail = detail
  return s
}

export class FirewallService {
  private cache: { key: string; status: FirewallStatus } | null = null
  private inflight: Promise<FirewallStatus> | null = null
  private fixing: Promise<FirewallFixRes> | null = null
  /** Bumped when a fix run ends, so a check started before it is not reused. */
  private gen = 0
  private inflightGen = -1

  constructor(private readonly deps: FirewallDeps) {}

  /** Cached for 60s per (exe, port); `force` skips the cache. */
  check(force = false): Promise<FirewallStatus> {
    const port = this.deps.port()
    const programScope = this.deps.programScope()
    if (this.deps.platform !== 'win32') return Promise.resolve(baseStatus('unsupported', port, programScope, this.deps.now()))
    const key = `${normPath(this.deps.exe())}|${port}`
    const c = this.cache
    if (!force && c && c.key === key && this.deps.now() - c.status.checkedAt < FIREWALL_CACHE_MS) return Promise.resolve(c.status)
    if (this.inflight) {
      // A run that started before the last fix ran may show the old rules: a
      // forced check waits for it and starts its own.
      if (!force || this.inflightGen === this.gen) return this.inflight
      return this.inflight.then(() => this.check(true))
    }
    this.inflightGen = this.gen
    this.inflight = this.inspect(key, port, programScope).finally(() => {
      this.inflight = null
    })
    return this.inflight
  }

  private async inspect(key: string, port: number, programScope: boolean): Promise<FirewallStatus> {
    const exe = this.deps.exe()
    const endpoints = this.deps.endpoints(port)
    let status: FirewallStatus
    try {
      const res = await this.deps.run(psArgs(buildInspectScript({ exe, port, ips: endpoints.flatMap((e) => (e.ip ? [e.ip] : [])) })), FIREWALL_CHECK_TIMEOUT_MS)
      if (res.timedOut) status = baseStatus('unknown', port, programScope, this.deps.now(), 'timeout')
      else if (res.code !== 0) status = baseStatus('unknown', port, programScope, this.deps.now(), `exit ${res.code}`)
      else status = parseInspectOutput(res.stdout, { exe, port, programScope, endpoints, now: this.deps.now() })
    } catch (err) {
      status = baseStatus('unknown', port, programScope, this.deps.now(), err instanceof Error ? err.message.slice(0, 200) : 'error')
    }
    // An unknown result is not cached: the next open tries again.
    this.cache = status.state === 'unknown' ? null : { key, status }
    return status
  }

  /** Elevated fix, then a fresh check. One at a time. */
  fix(): Promise<FirewallFixRes> {
    if (this.deps.platform !== 'win32') return Promise.resolve({ ok: false, error: 'unsupported' })
    if (this.fixing) return this.fixing
    this.fixing = this.runFix().finally(() => {
      this.fixing = null
    })
    return this.fixing
  }

  private async runFix(): Promise<FirewallFixRes> {
    const port = this.deps.port()
    const exe = this.deps.exe()
    const endpoints = this.deps.endpoints(port)
    const last = this.cache?.status
    const lanDomain = (last?.endpoints ?? []).some((e) => e.kind === 'lan' && e.profile === 'DomainAuthenticated')
    const script = buildFixScript({
      exe,
      port,
      programScope: this.deps.programScope(),
      tailnet: endpoints.some((e) => e.kind === 'tailscale'),
      domain: lanDomain,
      rules: this.deps.rules,
    })
    let res: RunResult
    try {
      res = await this.deps.run(psArgs(buildElevatedWrapper(script)), FIREWALL_FIX_TIMEOUT_MS)
    } catch {
      this.gen++
      return { ok: false, error: 'failed', status: await this.check(true) }
    }
    this.gen++
    if (res.code === UAC_CANCELLED) return { ok: false, cancelled: true, error: 'cancelled', status: await this.check(true) }
    const status = await this.check(true)
    if (res.timedOut) return { ok: false, error: 'timeout', status }
    if (res.code !== 0) return { ok: false, error: 'failed', status }
    // A Block that is not ours stays: never promise OK when the re-check disagrees.
    if (status.state === 'blocked') return { ok: false, error: 'notFixed', status }
    return { ok: true, status }
  }
}
