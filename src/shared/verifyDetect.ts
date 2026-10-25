/**
 * The verify command of Integrar (app 2.7.0, E10 B6, design 2.11): what a
 * repo's build files suggest, the shape a command must have before the user
 * may confirm it, and whether it installs dependencies (then the temp tree gets
 * no node_modules junction). Main only reads the root listing and the script names
 * of `package.json` (it never runs anything to detect); a suggestion is text
 * the user copies into `team.md`. A command runs only when the trusted
 * definition declares it AND the user confirmed that exact text
 * (`verifyConfirmed[repoId].sha256 === sha256(command)`), never from agent
 * text. Pure, type-only imports.
 */
import { VERIFY_COMMAND_MAX } from './teamDefinition'

export { VERIFY_COMMAND_MAX }

/**
 * The root of a repo as main read it: the names of its entries and, when it has one, the script names of its
 * `package.json`. `windows` (main sets it on win32): a suggestion runs through cmd.exe there, so a wrapper in the
 * repo root is named without `./` (cmd.exe looks in the current folder first and does not take `./gradlew`).
 */
export interface VerifyProbe { rootFiles: readonly string[]; npmScripts?: readonly string[]; windows?: boolean }
export interface VerifySuggestion { command: string; source: 'maven' | 'gradle' | 'npm' | 'cargo' | 'go' | 'dotnet' | 'make' | 'python' }

/** Root names compared without case: Windows and macOS fold it, and a repo made there may spell `Makefile` either way. */
function hasAny(names: ReadonlySet<string>, ...want: string[]): boolean {
  return want.some((w) => names.has(w.toLowerCase()))
}

/**
 * pom.xml -> `mvn -q package`; gradlew/build.gradle -> `./gradlew test`; package.json -> `npm test` or `npm run build`
 * when that script exists; Cargo.toml -> `cargo test`; go.mod -> `go test ./...`; *.sln/*.csproj -> `dotnet test`;
 * Makefile with test -> `make test`; pyproject.toml -> `python -m pytest`. Order = this list.
 *
 * Gradle: the repo's wrapper when it has one (`gradlew test` on Windows), else `gradle test`. npm: `npm test` when the
 * scripts have `test`, `npm run build` when they have `build` (both, in that order), `npm test` when the scripts are
 * unknown; a package.json whose scripts have neither suggests nothing. A Makefile always suggests `make test` (main
 * reads no file but package.json: the target is the user's to check).
 */
export function suggestVerify(p: VerifyProbe): VerifySuggestion[] {
  const names = new Set((Array.isArray(p.rootFiles) ? p.rootFiles : []).filter((n): n is string => typeof n === 'string').map((n) => n.toLowerCase()))
  const out: VerifySuggestion[] = []
  if (hasAny(names, 'pom.xml')) out.push({ command: 'mvn -q package', source: 'maven' })
  if (hasAny(names, 'gradlew', 'gradlew.bat')) out.push({ command: p.windows ? 'gradlew test' : './gradlew test', source: 'gradle' })
  else if (hasAny(names, 'build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts')) out.push({ command: 'gradle test', source: 'gradle' })
  if (hasAny(names, 'package.json')) {
    const scripts = Array.isArray(p.npmScripts) ? new Set(p.npmScripts) : null
    if (!scripts || scripts.has('test')) out.push({ command: 'npm test', source: 'npm' })
    if (scripts?.has('build')) out.push({ command: 'npm run build', source: 'npm' })
  }
  if (hasAny(names, 'Cargo.toml')) out.push({ command: 'cargo test', source: 'cargo' })
  if (hasAny(names, 'go.mod')) out.push({ command: 'go test ./...', source: 'go' })
  if ([...names].some((n) => n.endsWith('.sln') || n.endsWith('.csproj'))) out.push({ command: 'dotnet test', source: 'dotnet' })
  if (hasAny(names, 'Makefile', 'GNUmakefile')) out.push({ command: 'make test', source: 'make' })
  if (hasAny(names, 'pyproject.toml')) out.push({ command: 'python -m pytest', source: 'python' })
  return out
}

/** npm verbs that install, add, update, remove, link or rebuild packages (npm's own aliases too): node_modules is rewritten. */
const NPM_INSTALL = new Set([
  'ci', 'clean-install', 'ic', 'install-clean', 'isntall-clean', 'install', 'i', 'in', 'ins', 'inst', 'insta', 'instal', 'isnt', 'isnta', 'isntal', 'isntall',
  'add', 'it', 'install-test', 'cit', 'install-ci-test', 'clean-install-test', 'sit', 'update', 'up', 'upgrade', 'udpate', 'uninstall', 'un', 'unlink',
  'remove', 'rm', 'r', 'prune', 'dedupe', 'ddp', 'rebuild', 'rb', 'link', 'ln',
])
const PNPM_INSTALL = new Set(['install', 'i', 'add', 'update', 'up', 'upgrade', 'remove', 'rm', 'uninstall', 'un', 'prune', 'dedupe', 'rebuild', 'rb', 'install-test', 'it', 'link', 'ln', 'unlink', 'import'])
/** yarn with no verb (only flags, or nothing) installs too. */
const YARN_INSTALL = new Set(['install', 'add', 'up', 'upgrade', 'upgrade-interactive', 'remove', 'dedupe', 'link', 'unlink', 'rebuild', 'import'])
const BUN_INSTALL = new Set(['install', 'i', 'ci', 'add', 'a', 'update', 'remove', 'rm', 'link', 'unlink'])
const PIP_RE = /^pip\d*(?:\.\d+)?$/
/** Flags of npm, pnpm, yarn and bun whose value is the next word, never the verb (`npm -w web install`, `pnpm -C web i`, `yarn --cwd web`). */
const VALUE_FLAGS = new Set(['-w', '--workspace', '--prefix', '-C', '--dir', '--filter', '-F', '--cwd'])

/** The program a word names: no folders, no `.cmd`/`.exe`/`.bat`/`.ps1`, lower case (`C:\x\npm.cmd` -> `npm`). */
function programOf(word: string): string {
  return word.replace(/^.*[\\/]/, '').toLowerCase().replace(/\.(?:cmd|exe|bat|ps1)$/, '')
}

/** The index of the first word after `i` that is neither a flag nor a flag's value; -1 at the end of the command or of its segment. */
function verbAt(words: readonly string[], i: number): number {
  for (let j = i + 1; j < words.length; j++) {
    const w = words[j]
    if (w === ';') return -1
    if (VALUE_FLAGS.has(w)) {
      if (words[j + 1] === ';') return -1
      j++
      continue
    }
    if (!w.startsWith('-')) return j
  }
  return -1
}

/** The verb after `i`, lower case (null: none); yarn's `workspace <name> <verb>` names the verb after the workspace. */
function verbAfter(words: readonly string[], i: number, yarn = false): string | null {
  let v = verbAt(words, i)
  if (yarn && v >= 0 && words[v].toLowerCase() === 'workspace') {
    const name = verbAt(words, v)
    v = name >= 0 ? verbAt(words, name) : -1
  }
  return v >= 0 ? words[v].toLowerCase() : null
}

/**
 * The verify command installs dependencies (B6 integration, data safety): `npm ci`, `npm install` / `npm i` (and every
 * npm, pnpm, yarn or bun verb that adds, updates, removes, links or rebuilds packages), `pnpm install` / `pnpm i`,
 * `yarn install` and plain `yarn`, `bun install`, `pip install` (`pip3`, `python -m pip`). Then the temp tree of
 * Integrar gets no node_modules junction: the install builds its own node_modules there and can never delete or rewrite
 * the repo's through the link. Any word of the command counts (after `&&`, `;`, `|`, inside `sh -c "..."`, behind a
 * wrapper such as `corepack` or `npx`), the value of a flag such as `-w web` or `--cwd web` is never the verb, and
 * `yarn workspace <name> <verb>` reads its verb: a false match only drops the junction, the safe side.
 */
export function verifyInstalls(cmd: unknown): boolean {
  if (typeof cmd !== 'string') return false
  // Operators and grouping split segments; quotes, carets (cmd.exe) and backticks only group or escape.
  const words = cmd.replace(/["'`^]/g, '').replace(/&&|\|\||[;&|()<>]/g, ' ; ').split(/\s+/).filter(Boolean)
  for (let i = 0; i < words.length; i++) {
    const prog = programOf(words[i])
    if (prog === 'yarn') {
      const verb = verbAfter(words, i, true)
      if (verb === null || YARN_INSTALL.has(verb)) return true
      continue
    }
    const verb = prog === 'npm' || prog === 'pnpm' || prog === 'bun' || PIP_RE.test(prog) ? verbAfter(words, i) : null
    if (verb === null) continue
    if ((prog === 'npm' && NPM_INSTALL.has(verb)) || (prog === 'pnpm' && PNPM_INSTALL.has(verb)) || (prog === 'bun' && BUN_INSTALL.has(verb)) || (PIP_RE.test(prog) && verb === 'install')) return true
  }
  return false
}

/**
 * C0, DEL, C1, the Unicode line and paragraph separators, and the characters that hide or reorder what the user reads
 * (zero width, bidi controls, the BOM): the confirmed command must be the text the dialog showed.
 */
// eslint-disable-next-line no-control-regex
const COMMAND_BAD_RE = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/

/** One line, 1..VERIFY_COMMAND_MAX, no control chars. Also: not blank, no surrounding spaces (the definition trims it). */
export function verifyCommandOk(cmd: unknown): cmd is string {
  return typeof cmd === 'string' && cmd.length >= 1 && cmd.length <= VERIFY_COMMAND_MAX && cmd.trim() === cmd && !COMMAND_BAD_RE.test(cmd)
}
