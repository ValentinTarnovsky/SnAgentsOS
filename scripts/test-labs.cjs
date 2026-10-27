// Labs (app 2.7.0, A1.1 + A1.2): src/shared/labs.ts, the schema derived from
// LABS_KEYS (junk and a missing block give every lab off), CONFIG_VERSION 19
// (a v18 config gains the labs defaults, idempotent), the renderer defaults,
// the Settings > Labs rows and the labs keys of the three i18n catalogs.
// Same esbuild + vm harness as test-status.cjs: no Electron, no user data.
const { buildSync } = require('esbuild')
const vm = require('node:vm')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const root = path.resolve(__dirname, '..')
let checks = 0
function check(condition, label) { assert.ok(condition, label); checks++ }
// Values built inside the vm have another realm's prototypes; compare as JSON.
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const clone = (v) => JSON.parse(JSON.stringify(v))
function load(file, overrides = {}) {
  const code = buildSync({ entryPoints: [path.join(root, file)], bundle: true, platform: 'node', format: 'cjs', write: false, external: ['electron'], alias: { '@shared': path.join(root, 'src/shared') } }).outputFiles[0].text
  const mod = { exports: {} }
  vm.runInNewContext(code, { module: mod, exports: mod.exports, require, console, process, Buffer, structuredClone, setTimeout, clearTimeout, ...overrides })
  return mod.exports
}
function loadRenderer(contents, overrides = {}) {
  const code = buildSync({ stdin: { contents, resolveDir: path.join(root, 'src/renderer/lib'), loader: 'ts' }, bundle: true, platform: 'node', format: 'cjs', write: false, alias: { '@shared': path.join(root, 'src/shared'), '@': path.join(root, 'src/renderer') }, define: { 'process.env.NODE_ENV': '"production"' } }).outputFiles[0].text
  const mod = { exports: {} }
  vm.runInNewContext(code, { module: mod, exports: mod.exports, require, console, process, crypto: globalThis.crypto, setTimeout, clearTimeout, ...overrides })
  return mod.exports
}
// Every input value survives (new keys may appear next to them).
function survives(input, output, at = '') {
  if (input === output) return true
  if (typeof input !== 'object' || input === null || typeof output !== 'object' || output === null) throw new Error(`value changed at ${at || '<root>'}: ${JSON.stringify(input)} -> ${JSON.stringify(output)}`)
  for (const k of Object.keys(input)) if (k !== 'version') survives(input[k], output[k], `${at}.${k}`)
  return true
}

const L = load('src/shared/labs.ts')
const KEYS = [...L.LABS_KEYS]
const OFF = Object.fromEntries(KEYS.map((k) => [k, false]))

function sharedChecks() {
  check(same(KEYS, ['consoleChat', 'teams']), 'LABS_KEYS is consoleChat, teams')
  check(same(L.DEFAULT_LABS, OFF) && Object.keys(L.DEFAULT_LABS).join() === KEYS.join(), 'DEFAULT_LABS has every lab off, in LABS_KEYS order')

  // labOn: only an explicit true is on.
  check(L.labOn({ labs: { teams: true } }, 'teams') === true && L.labOn({ labs: { consoleChat: true } }, 'consoleChat') === true, 'labOn: an explicit true is on')
  for (const bad of ['true', 'yes', 1, null, {}, [true]]) check(L.labOn({ labs: { teams: bad } }, 'teams') === false, `labOn: ${JSON.stringify(bad)} is off`)
  check(L.labOn({ labs: { teams: true } }, 'consoleChat') === false, 'labOn: one lab on leaves the others off')
  check([null, undefined, {}, { labs: null }, { labs: undefined }].every((s) => L.labOn(s, 'teams') === false), 'labOn: no settings or no labs block is off')

  // normalizeLabs: any value becomes a full LabsSettings.
  for (const v of [undefined, null, 'on', 7, [true, true], {}]) check(same(L.normalizeLabs(v), OFF), `normalizeLabs(${JSON.stringify(v)}) gives every lab off`)
  const n = L.normalizeLabs({ teams: true, consoleChat: 'yes', extra: true })
  check(same(n, { consoleChat: false, teams: true }) && !('extra' in n), 'normalizeLabs keeps an explicit true, turns junk off and drops unknown keys')
  check(same(L.normalizeLabs({ consoleChat: true, teams: true }), { consoleChat: true, teams: true }), 'normalizeLabs keeps every lab on')
  n.consoleChat = true
  check(L.DEFAULT_LABS.consoleChat === false && L.normalizeLabs(null) !== L.DEFAULT_LABS, 'normalizeLabs returns a fresh object (DEFAULT_LABS is never shared)')
}

function schemaChecks() {
  const { labsSettingsSchema: S, parseConfig, CONFIG_VERSION } = load('src/main/store/schema.ts')
  check(CONFIG_VERSION === 20, 'CONFIG_VERSION is 20 (app 2.8.0)')
  check(Object.keys(S.shape).join() === KEYS.join(), 'labsSettingsSchema keys === LABS_KEYS, same order')
  check(same(S.parse({}), OFF) && same(S.parse({}), L.DEFAULT_LABS), 'an empty labs block parses to DEFAULT_LABS')
  for (const k of KEYS) {
    check(S.parse({ [k]: true })[k] === true, `labs.${k} true is kept`)
    check(S.parse({ [k]: false })[k] === false, `labs.${k} false is kept`)
    for (const bad of ['yes', 1, null, 'true', {}]) check(S.parse({ [k]: bad })[k] === false, `a junk labs.${k} ${JSON.stringify(bad)} becomes false`)
  }
  check(same(S.parse({ consoleChat: true, teams: 'yes', other: true }), { consoleChat: true, teams: false }), 'junk in one flag keeps the other, an unknown flag is stripped')

  // A v18 config as the 2.6.0 renderer writes it (minimal valid settings plus a few blocks).
  const baseSettings = { defaultShell: {}, fontFamily: 'mono', fontSize: 13, scrollback: 1000, restoreLastWorkspace: true, confirmCloseRunning: true, sidebarCollapsed: false }
  const v18 = {
    version: 18,
    workspaces: [{ id: 'w1', name: 'Uno', cwd: 'C:/a', panes: [{ id: 'p1', type: 'claude', title: 'Claude', color: '#fff', icon: 'claude' }] }],
    presets: [{ id: 'preset-claude', name: 'Claude Code', type: 'claude', command: 'claude', args: [], color: '#d97757', icon: 'claude' }],
    settings: { ...clone(baseSettings), language: 'es', dictation: { device: 'cpu', language: 'es-AR', headerButton: false, interim: false, vocabulary: 'zustand' }, share: { enabled: true, port: 4600, guestName: 'Laptop', defaultPerm: 'full' } },
    activeWorkspaceId: 'w1',
  }
  const up = parseConfig(clone(v18))
  check(up && up.version === 20, 'a v18 config parses and is stamped 20')
  check(same(up.settings.labs, OFF) && Object.keys(up.settings.labs).join() === KEYS.join(), 'v18 -> v19: settings.labs gains every lab off')
  check(survives(v18, up), 'v18 -> v19 keeps every other value')
  check(same(parseConfig(clone(up)), up), 'v19 parse is idempotent')
  const fromV10 = parseConfig({ version: 10, workspaces: [], presets: [], settings: clone(baseSettings) })
  check(fromV10 && fromV10.version === 20 && same(fromV10.settings.labs, OFF), 'a v10 config walks up to 20 and gets the labs defaults')

  // The labs block in a whole config: kept, junk and non-object values fall back without rejecting it.
  const withLabs = (labs) => { const c = clone(up); c.settings.labs = labs; return parseConfig(c) }
  const on = withLabs({ consoleChat: true, teams: true })
  check(on && same(on.settings.labs, { consoleChat: true, teams: true }) && same(parseConfig(clone(on)), on), 'labs on are kept, and a second parse changes nothing')
  check(same(withLabs({ teams: true }).settings.labs, { consoleChat: false, teams: true }), 'a partial block gains the missing flag off')
  const junk = withLabs({ consoleChat: 'yes', teams: 1 })
  check(junk && junk.settings.fontSize === 13 && same(junk.settings.labs, OFF), 'junk flags become false and the config still loads')
  for (const bad of ['on', 7, null, [true], true]) {
    const p = withLabs(bad)
    check(p && p.settings.share.port === 4600 && same(p.settings.labs, OFF), `a non-object labs block ${JSON.stringify(bad)} gives every lab off without rejecting the config`)
  }
  const missing = clone(up); delete missing.settings.labs
  check(same(parseConfig(missing).settings.labs, OFF), 'a missing labs block gives every lab off')
}

function rendererChecks() {
  const r = loadRenderer(`
    export * from '../components/settings/searchCatalog'
    export { en } from '../i18n/en'
    export { es } from '../i18n/es'
    export { useAppStore } from './store'
  `, { window: { snApi: { config: { save() {} }, pty: { killPanes: async () => 0 } } }, document: { hasFocus: () => false } })
  check(same(r.useAppStore.getState().settings.labs, OFF), 'renderer DEFAULT_SETTINGS.labs has every lab off')

  // Settings > Labs: one catalog row with an inline switch and one literal row per lab.
  check(r.CATEGORY_ORDER.includes('labs') && r.CATEGORY_ORDER.indexOf('labs') === r.CATEGORY_ORDER.indexOf('updates') - 1, 'labs is a settings category, right before updates')
  check(r.CATEGORY_LABEL.labs === 'settings.cat.labs', 'the Labs category label key')
  const section = fs.readFileSync(path.join(root, 'src/renderer/components/settings/sections/LabsSection.tsx'), 'utf8')
  for (const k of KEYS) {
    const row = r.SETTINGS_CATALOG.find((e) => e.id === `labs.${k}`)
    check(row && row.category === 'labs' && row.titleKey === `labs.${k}` && row.descriptionKey === `labs.${k}Hint` && row.toggle && row.toggle.path === `labs.${k}`, `labs.${k} is a catalog row with an inline switch at labs.${k}`)
    check(row.keywords.includes('labs') && row.keywords.includes('experimental'), `labs.${k} is found by "labs" and "experimental"`)
    check(section.includes(`searchId="labs.${k}"`), `LabsSection has a literal row for labs.${k}`)
  }
  check(r.SETTINGS_CATALOG.filter((e) => e.category === 'labs').length === KEYS.length, 'the labs category has exactly one row per lab')

  // Renderer i18n: every labs key in en and es, translated where the words differ.
  const { en, es } = r
  const keys = ['settings.cat.labs', 'labs.intro', ...KEYS.flatMap((k) => [`labs.${k}`, `labs.${k}Hint`])]
  const labsKeys = (dict) => Object.keys(dict).filter((k) => k.startsWith('labs.')).sort()
  check(same(labsKeys(en), keys.filter((k) => k.startsWith('labs.')).sort()) && same(labsKeys(es), labsKeys(en)), 'en and es carry exactly the labs.* keys: intro plus a title and hint per lab')
  check(keys.every((k) => typeof en[k] === 'string' && en[k].trim() && typeof es[k] === 'string' && es[k].trim()), 'every labs key is non-empty in en and es')
  check(en['settings.cat.labs'] === 'Labs' && es['settings.cat.labs'] === 'Labs', 'the category is Labs in both languages')
  check(keys.filter((k) => k !== 'settings.cat.labs').every((k) => es[k] !== en[k]), 'every other labs string is translated (es !== en)')
  check(en['labs.teams'] === 'Teams' && es['labs.teams'] === 'Equipos' && en['labs.consoleChat'] === 'Console chat' && es['labs.consoleChat'] === 'Chat de consola', 'Teams is Equipos and Console chat is Chat de consola')
  check(/\boff\b/.test(en['labs.intro']) && /apagado/.test(es['labs.intro']) && /Módulos experimentales/.test(es['labs.intro']), 'the intro says the modules are experimental and off by default, with tildes in es')
}

function otherCatalogChecks() {
  // Phone catalog.
  const m = load('src/mobile/src/lib/i18n.ts')
  m.setLang('en')
  const enTeams = m.t('labs.teams'), enOff = m.t('labs.teamsOff')
  m.setLang('es')
  const esTeams = m.t('labs.teams'), esOff = m.t('labs.teamsOff')
  m.setLang('en')
  check(enTeams === 'Teams' && esTeams === 'Equipos', 'phone: labs.teams is Teams / Equipos')
  check(enOff !== 'labs.teamsOff' && esOff !== 'labs.teamsOff' && esOff !== enOff, 'phone: labs.teamsOff exists in en and es and is translated')
  check(/Settings > Labs/.test(enOff) && /Ajustes > Labs/.test(esOff) && /está apagado/.test(esOff), 'phone: labs.teamsOff points at Settings > Labs (es with tildes)')

  // Main catalog (mainTLang falls back to en, so es must differ to exist).
  const { mainTLang } = load('src/main/i18n.ts')
  const mainEn = mainTLang('en', 'labs.teamsOff'), mainEs = mainTLang('es', 'labs.teamsOff')
  check(typeof mainEn === 'string' && mainEn.trim() && typeof mainEs === 'string' && mainEs.trim(), 'main: labs.teamsOff exists')
  check(mainEs !== mainEn && /Settings > Labs/.test(mainEn) && /Ajustes > Labs/.test(mainEs) && /está apagado/.test(mainEs), 'main: labs.teamsOff is translated and points at Settings > Labs')
}

async function main() {
  sharedChecks()
  schemaChecks()
  rendererChecks()
  otherCatalogChecks()
  console.log(`PASS: ${checks} labs checks (LABS_KEYS, labOn, normalizeLabs, derived schema, junk to false, v18 -> v19, renderer defaults, Settings > Labs rows, i18n in the three catalogs)`)
}

main().catch((error) => { console.error(error); process.exitCode = 1 })
