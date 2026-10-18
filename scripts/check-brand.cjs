// Brand guard (E0-FR-23), run by npm test (so by CI and by every release leg).
// Scans the files git knows about (tracked, plus untracked ones that are not
// ignored, so a file planted before `git add` fails too) and fails on:
//   - the legacy product name outside the allowlist below;
//   - an en dash or em dash (U+2013, U+2014) in any file, with no allowlist
//     (repo style rule for every later epic).
// Binary files are skipped the way `git grep -I` does it: a NUL byte in the
// first 8000 bytes.
//
// CLI: node scripts/check-brand.cjs [dir]   (dir defaults to the cwd; the scan
// always covers the whole work tree that contains it). Exit code 0 = clean,
// 1 = findings (printed as file:line), 2 = git could not list the files.
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const LEGACY_RE = /snmulticc|multicc|multi command/i
// Built from code points so this file carries no literal dash.
const DASH_RE = new RegExp('[' + String.fromCharCode(0x2013, 0x2014) + ']')
const BINARY_PROBE_BYTES = 8000
const LEGACY_START = '<!-- legacy-start -->'
const LEGACY_END = '<!-- legacy-end -->'

// Where the legacy name is legitimate. Paths are repo-relative with "/".
//   path: one exact file; prefix: a whole tree; lines: only those exact lines
//   (trimmed); region: only between the README markers (markers included).
const ALLOWLIST = [
  { path: 'src/shared/brand.ts', why: 'LEGACY_BRAND, the single source of the old identity' },
  { prefix: 'src/main/migration/', why: 'detects, migrates and cleans 1.x' },
  { path: 'build/installer.nsh', why: 'NSIS needs the old exe and folder names literally' },
  { path: 'scripts/check-brand.cjs', why: 'this guard' },
  { path: 'scripts/test-rebrand.cjs', why: 'asserts the legacy constants and the migrations' },
  { path: 'scripts/test-legacy-migration.cjs', why: 'builds fake 1.x trees for the migration tests' },
  { prefix: 'docs/', why: 'history, plans and release notes' },
  { path: 'README.md', region: true, why: 'the "Before" section explains the rename' },
  { path: '.gitignore', lines: ['snmulticc-data/'], why: 'a 1.x portable data folder in a work tree stays ignored' },
]

function ruleFor(file) {
  return ALLOWLIST.find(r => r.path === file || (r.prefix && file.startsWith(r.prefix))) || null
}

function isBinary(buf) {
  return buf.subarray(0, BINARY_PROBE_BYTES).includes(0)
}

/** Findings of one text file: [{ file, line, kind, text }]. kind is 'legacy', 'dash' or 'marker'. */
function scanText(file, text) {
  const findings = []
  const rule = ruleFor(file)
  const lines = text.split(/\r?\n/)
  let inRegion = false
  let regionStart = 0
  lines.forEach((line, i) => {
    const n = i + 1
    if (DASH_RE.test(line)) {
      const cp = line.match(DASH_RE)[0].codePointAt(0).toString(16).toUpperCase()
      findings.push({ file, line: n, kind: 'dash', text: `en/em dash (U+${cp})` })
    }
    let allowed = false
    if (rule && rule.region) {
      const trimmed = line.trim()
      if (trimmed === LEGACY_START) {
        if (inRegion) findings.push({ file, line: n, kind: 'marker', text: `nested ${LEGACY_START}` })
        inRegion = true
        regionStart = n
      }
      allowed = inRegion
      if (trimmed === LEGACY_END) {
        if (!inRegion) findings.push({ file, line: n, kind: 'marker', text: `${LEGACY_END} without a start` })
        inRegion = false
      }
    } else if (rule && rule.lines) {
      allowed = rule.lines.includes(line.trim())
    } else if (rule) {
      allowed = true
    }
    if (!allowed && LEGACY_RE.test(line)) {
      findings.push({ file, line: n, kind: 'legacy', text: `legacy name "${line.match(LEGACY_RE)[0]}"` })
    }
  })
  // An unterminated region would silently allow the rest of the file.
  if (inRegion) findings.push({ file, line: regionStart, kind: 'marker', text: `${LEGACY_START} is never closed` })
  return findings
}

/** Repo-relative paths git knows about under the work tree containing dir. */
function listFiles(dir) {
  const top = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: dir, encoding: 'utf8' })
  if (top.status !== 0) throw new Error(`not a git work tree: ${dir} (${(top.stderr || '').trim()})`)
  const root = top.stdout.trim()
  const ls = spawnSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  if (ls.status !== 0) throw new Error(`git ls-files failed: ${(ls.stderr || '').trim()}`)
  const files = [...new Set(ls.stdout.split('\0').filter(Boolean))].sort()
  return { root, files }
}

/** Scans every listed file; deleted files, links and directories (submodules) are skipped. */
function checkBrand(dir) {
  const { root, files } = listFiles(dir)
  const findings = []
  let scanned = 0
  let binaries = 0
  for (const file of files) {
    const abs = path.join(root, file)
    let st
    try { st = fs.lstatSync(abs) } catch { continue }
    if (!st.isFile()) continue
    const buf = fs.readFileSync(abs)
    if (isBinary(buf)) { binaries++; continue }
    scanned++
    findings.push(...scanText(file, buf.toString('utf8')))
  }
  return { root, scanned, binaries, findings }
}

function main(argv) {
  let result
  try { result = checkBrand(path.resolve(argv[0] || process.cwd())) } catch (error) {
    console.error(`check-brand: ${error.message}`)
    return 2
  }
  if (result.findings.length > 0) {
    console.error(`check-brand: ${result.findings.length} finding(s):`)
    for (const f of result.findings) console.error(`  ${f.file}:${f.line}: ${f.text}`)
    console.error('The legacy name is allowed only in the files listed in scripts/check-brand.cjs; en/em dashes nowhere.')
    return 1
  }
  console.log(`PASS: brand guard, ${result.scanned} text files clean (${result.binaries} binaries skipped)`)
  return 0
}

module.exports = { checkBrand, scanText, listFiles, isBinary, ruleFor, ALLOWLIST, LEGACY_RE, DASH_RE, LEGACY_START, LEGACY_END, main }
if (require.main === module) process.exitCode = main(process.argv.slice(2))
