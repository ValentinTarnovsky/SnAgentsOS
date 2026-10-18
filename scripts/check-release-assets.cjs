// Release health gate (E0-FR-21). The build matrix uploads to a draft release;
// the release-notes job runs this against the draft's asset list and only
// publishes when it passes. Healthy = the 8 distributables of one version, each
// with its .sha256 sidecar, and nothing else: exactly 16 assets.
//
// CLI: node scripts/check-release-assets.cjs <assets.json> <tag> [version]
// <assets.json> is the output of `gh release view <tag> --json assets` (or a
// plain array of names). With a version, the tag must match it as well (see
// tagMatchesVersion). Exit code 0 = publish, 1 = keep the draft.
const fs = require('node:fs')

const EXPECTED_ASSETS = 16
const TAG_RE = /^v\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/

// Order matters: the arm64 patterns come first because the x64 ones would also
// match an arm64 name (the version can carry a "-" prerelease suffix).
const KINDS = [
  ['win-installer', /^SnAgentsOS-(.+)-setup\.exe$/],
  ['win-portable', /^SnAgentsOS-(.+)-portable\.exe$/],
  ['mac-zip-arm64', /^SnAgentsOS-(.+)-arm64-mac\.zip$/],
  ['mac-zip-x64', /^SnAgentsOS-(.+)-mac\.zip$/],
  ['mac-dmg-arm64', /^SnAgentsOS-(.+)-arm64\.dmg$/],
  ['mac-dmg-x64', /^SnAgentsOS-(.+)\.dmg$/],
  ['linux-appimage', /^SnAgentsOS-(.+)\.AppImage$/],
  ['linux-deb', /^snagentsos_(.+)_amd64\.deb$/],
]

function assetList(input) {
  const list = Array.isArray(input) ? input : input && Array.isArray(input.assets) ? input.assets : null
  if (!list) throw new Error('expected an array of asset names or { assets: [...] }')
  return list.map(a => typeof a === 'string' ? { name: a } : a || {})
}

// The tag drives the in-app updater (tag_name vs app.getVersion()), so a stable
// tag must equal the packaged version or 1.x/2.x clients would loop on an
// "update" that installs the same version. A prerelease tag (never latest) may
// also be a rehearsal of the version it prefixes: v2.0.0-rc.1 over 2.0.0.
function tagMatchesVersion(tag, version) {
  if (tag === 'v' + version) return true
  return tag.includes('-') && tag.startsWith('v' + version + '-')
}

function classify(name) {
  for (const [kind, re] of KINDS) {
    const m = re.exec(name)
    if (m) return { kind, version: m[1] }
  }
  return null
}

function checkReleaseAssets(input, { version } = {}) {
  const assets = assetList(input)
  const names = assets.map(a => a.name)
  const errors = []
  // gh lists an interrupted upload with state "open"; an empty file is never a
  // valid distributable or checksum.
  for (const a of assets) {
    if (typeof a.state === 'string' && a.state !== 'uploaded') errors.push(`${a.name} is not fully uploaded (state ${a.state})`)
    if (a.size === 0) errors.push(`${a.name} is empty`)
  }
  const set = new Set(names)
  if (set.size !== names.length) errors.push('duplicate asset names')
  if (names.length !== EXPECTED_ASSETS) errors.push(`expected ${EXPECTED_ASSETS} assets, found ${names.length}`)

  const byKind = new Map()
  const versions = new Set()
  for (const name of names) {
    if (typeof name !== 'string' || !name) { errors.push('asset without a name'); continue }
    if (name.endsWith('.sha256')) {
      const base = name.slice(0, -'.sha256'.length)
      if (!set.has(base)) errors.push(`${name} has no matching distributable`)
      else if (!classify(base)) errors.push(`${name} belongs to an unexpected asset`)
      continue
    }
    const hit = classify(name)
    if (!hit) { errors.push(`unexpected asset ${name}`); continue }
    if (!set.has(name + '.sha256')) errors.push(`${name} is missing its .sha256`)
    byKind.set(hit.kind, [...(byKind.get(hit.kind) || []), name])
    versions.add(hit.version)
  }
  for (const [kind] of KINDS) {
    const found = byKind.get(kind) || []
    if (found.length === 0) errors.push(`missing ${kind} distributable`)
    else if (found.length > 1) errors.push(`${kind} appears ${found.length} times: ${found.join(', ')}`)
  }
  if (versions.size > 1) errors.push(`distributables mix versions: ${[...versions].join(', ')}`)
  if (version && versions.size === 1 && !versions.has(version)) errors.push(`distributables are ${[...versions][0]}, expected ${version}`)

  return { ok: errors.length === 0, errors, version: versions.size === 1 ? [...versions][0] : null }
}

function main(argv) {
  const [file, tag, version] = argv
  if (!file || !tag) {
    console.error('usage: check-release-assets.cjs <assets.json> <tag> [version]')
    return 1
  }
  if (!TAG_RE.test(tag)) {
    console.error(`invalid tag ${JSON.stringify(tag)}`)
    return 1
  }
  let input
  try { input = JSON.parse(fs.readFileSync(file, 'utf8')) } catch (error) {
    console.error(`cannot read ${file}: ${error.message}`)
    return 1
  }
  if (version && !tagMatchesVersion(tag, version)) {
    console.error(`tag ${tag} does not match package.json version ${version}, it stays a draft`)
    return 1
  }
  const result = checkReleaseAssets(input, { version })
  if (!result.ok) {
    console.error(`release ${tag} is not complete, it stays a draft:`)
    for (const e of result.errors) console.error(`  - ${e}`)
    return 1
  }
  console.log(`release ${tag}: ${EXPECTED_ASSETS} assets, version ${result.version}, every distributable has its .sha256`)
  return 0
}

module.exports = { checkReleaseAssets, tagMatchesVersion, EXPECTED_ASSETS, TAG_RE, KINDS, main }
if (require.main === module) process.exitCode = main(process.argv.slice(2))
