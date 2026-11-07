// App 2.11.0 (Labs voice): the pure hands-free modules. Wake word, command
// grammar (es + en, Rioplatense forms, number words), spoken names and their
// resolution, speech text cleaning, the local summary, and the schema 22 keys.
const { buildSync } = require('esbuild')
const vm = require('node:vm')
const assert = require('node:assert/strict')
const path = require('node:path')
const root = path.resolve(__dirname, '..')
let checks = 0
function check(condition, label) { assert.ok(condition, label); checks++ }
function load(file, overrides = {}) {
  const code = buildSync({ entryPoints: [path.join(root, file)], bundle: true, platform: 'node', format: 'cjs', write: false, external: ['electron', 'ws'], alias: { '@shared': path.join(root, 'src/shared') } }).outputFiles[0].text
  const mod = { exports: {} }
  vm.runInNewContext(code, { module: mod, exports: mod.exports, require, console, process, Buffer, URL, setTimeout, clearTimeout, ...overrides })
  return mod.exports
}
const J = (v) => JSON.stringify(v)

function testWake(C) {
  check(C.foldSpeech('¡Agente, CONSOLA dos!') === 'agente consola dos', 'foldSpeech: lower case, accents and punctuation out')
  for (const heard of ['Agente, consola dos', 'agente consola dos', 'Ajente consola dos', 'A gente, consola dos', 'Eh, agente consola dos', 'che agente consola dos', 'Agentes consola dos']) {
    const m = C.matchWake(heard, 'Agente')
    check(m.hit && C.foldSpeech(m.rest) === 'consola dos', `wake hit: ${J(heard)} (rest ${J(m.rest)})`)
  }
  for (const heard of ['urgente consola dos', 'la gente esta loca', 'consola dos', 'oye che agente consola', 'gerente consola']) {
    check(!C.matchWake(heard, 'Agente').hit, `wake miss: ${J(heard)}`)
  }
  check(C.matchWake('Agent, read API', 'Agent').hit && C.matchWake('Agent, read API', 'Agent').rest === 'read API', 'English wake word, rest keeps the case')
  check(C.matchWake('oye Jarvis enviar', 'Jarvis').hit && C.matchWake('Hola compu, enviar', 'hola compu').hit && C.matchWake('Hola compu, enviar', 'hola compu').rest === 'enviar' && !C.matchWake('compu enviar', 'hola compu').hit, 'a custom wake word, one or two words (a two-word one is not skipped as a filler)')
  const split = C.splitAtLastWake('Arreglá el login y corré los tests, agente, enviar', 'Agente')
  check(split && split.before === 'Arreglá el login y corré los tests' && C.foldSpeech(split.after) === 'enviar', 'splitAtLastWake: the dictated text keeps its accents, the command after the last wake word')
  check(C.splitAtLastWake('Agente enviar', 'Agente') === null, 'a wake word at the start is not a trailing one')
  check(C.sameWord('ajente', 'agente') && C.sameWord('bos', 'voz') && !C.sameWord('casa', 'agente'), 'sameWord folds sounds (g/j, v/b, z/s)')
}

function testGrammar(C) {
  const p = (s) => C.parseVoiceCommand(s)
  const cases = [
    ['consola dos', { kind: 'selectConsole', ref: '2' }],
    ['la consola tres', { kind: 'selectConsole', ref: '3' }],
    ['la 3', { kind: 'selectConsole', ref: '3' }],
    ['console four', { kind: 'selectConsole', ref: '4' }],
    ['workspace SnLib', { kind: 'selectWorkspace', ref: 'snlib' }],
    ['proyecto MineBosh', { kind: 'selectWorkspace', ref: 'minebosh' }],
    ['andá a SnHolograms', { kind: 'select', ref: 'snholograms' }],
    ['go to the workspace two', { kind: 'selectWorkspace', ref: '2' }],
    ['API', { kind: 'select', ref: 'api' }],
    ['SnLib dos', { kind: 'select', ref: 'snlib 2' }],
    ['dictar', { kind: 'dictate' }],
    ['dictale a la consola pagos', { kind: 'dictate', ref: 'pagos' }],
    ['escribile a API', { kind: 'dictate', ref: 'api' }],
    ['enviar', { kind: 'send' }],
    ['mandalo', { kind: 'send' }],
    ['send it', { kind: 'send' }],
    ['insertar', { kind: 'insert' }],
    ['cancelá', { kind: 'cancel' }],
    ['olvidalo', { kind: 'cancel' }],
    ['leé API', { kind: 'read', ref: 'api', full: false }],
    ['leeme todo API', { kind: 'read', ref: 'api', full: true }],
    ['lee', { kind: 'read', full: false }],
    ['qué dijo la consola dos', { kind: 'read', ref: '2', full: false }],
    ['read all SnLib', { kind: 'read', ref: 'snlib', full: true }],
    ['siguiente', { kind: 'next' }],
    ['repetí', { kind: 'repeat' }],
    ['otra vez', { kind: 'repeat' }],
    ['callate', { kind: 'stop' }],
    ['basta', { kind: 'stop' }],
    ['¿cómo van?', { kind: 'status' }],
    ['quién terminó', { kind: 'status' }],
    ['ayuda', { kind: 'help' }],
    ['salir', { kind: 'exit' }],
    ['apagá manos libres', { kind: 'exit' }],
  ]
  for (const [heard, want] of cases) check(J(p(heard)) === J(want), `parse ${J(heard)} -> ${J(want)} (got ${J(p(heard))})`)
  const tell = p('Decile a API que corra los tests y arregle el login')
  check(tell && tell.kind === 'dictate' && tell.ref === 'api' && tell.text === 'corra los tests y arregle el login', 'decile a X que <texto>: the text keeps its words (got ' + J(tell) + ')')
  const tellConsole = p('decile a la consola dos que siga')
  check(tellConsole && tellConsole.ref === '2' && tellConsole.text === 'siga', 'decile a la consola dos que siga')
  check(p('') === null && p('esto es una frase larga que nadie dijo como comando') === null, 'empty or a long free phrase is no command')
  check(C.bareDictationCommand('Enviar.') === 'send' && C.bareDictationCommand('cancelar') === 'cancel' && C.bareDictationCommand('insertá') === 'insert' && C.bareDictationCommand('hay que enviar') === null, 'bare dictation commands: only a whole phrase')
  check(C.numberOf('doce') === 12 && C.numberOf('tercera') === 3 && C.numberOf('7') === 7 && C.numberOf('mil') === null, 'number words')
}

function testNames(N) {
  const input = {
    workspaces: [
      { id: 'w1', name: 'SnLib', panes: [{ id: 'a', title: 'Claude Code', defaultTitle: true }, { id: 'b', title: 'Pagos', defaultTitle: false }, { id: 'c', title: 'Claude Code', defaultTitle: true }] },
      { id: 'w2', name: 'MineBosh', panes: [{ id: 'd', title: 'Claude Code', defaultTitle: true }] },
      { id: 'w3', name: 'SnHolograms', panes: [{ id: 'e', title: 'Pagos', defaultTitle: false }, { id: 'f', title: 'API Gateway', defaultTitle: false }, { id: 'g', title: 'API', defaultTitle: false }] },
    ],
  }
  const roster = N.spokenLabels(input)
  const labels = roster.workspaces.map((w) => w.label + ':' + w.panes.map((p) => p.label).join('|')).join(' ; ')
  check(labels === 'SnLib:SnLib 1|SnLib Pagos|SnLib 3 ; MineBosh:MineBosh ; SnHolograms:SnHolograms Pagos|API Gateway|API', 'spokenLabels: default titles by position, the only console by its workspace, a shared title prefixed (got ' + labels + ')')
  const r = (ref, active, want) => N.resolveSpokenRef(ref, roster, active, want)
  const id = (res) => (res.ok ? res.target.kind[0] + ':' + res.target.id : res.reason)
  check(id(r('2', 'w1', 'console')) === 'c:b' && id(r('2', 'w1', 'workspace')) === 'w:w2' && id(r('9', 'w1', 'console')) === 'not_found', 'numbers: position in the active workspace, or in the sidebar')
  check(id(r('snlib 3', 'w3', 'any')) === 'c:c' && id(r('minebosh', 'w1', 'any')) === 'w:w2', '"<workspace> <n>" and a workspace name')
  check(id(r('pagos', 'w1', 'console')) === 'c:b' && id(r('pagos', 'w3', 'console')) === 'c:e', 'a shared word resolves inside the active workspace first')
  check(id(r('api', 'w3', 'console')) === 'c:g' && id(r('api gateway', 'w3', 'console')) === 'c:f', 'an exact label wins over a longer one')
  check(id(r('sn holograms', 'w1', 'workspace')) === 'w:w3' && id(r('mine bosh', 'w1', 'any')) === 'w:w2', 'Whisper splitting a name in two still matches')
  check(id(r('cocina', 'w1', 'any')) === 'not_found', 'an unknown name is not_found')
  const amb = r('snlib', 'w2', 'console')
  check(!amb.ok && amb.reason === 'ambiguous' && amb.options.length === 2, 'several close matches are ambiguous with two options (got ' + J(amb) + ')')
  check(N.pickOption('la segunda', amb.options) === amb.options[1] && N.pickOption('primera', amb.options) === amb.options[0], 'pickOption by position')
  check(N.nameSimilarity('holograms', 'olograms') > 0.8 && N.nameSimilarity('pagos', 'logs') < 0.6, 'nameSimilarity')
}

function testSpeech(T) {
  const reply = [
    '## Listo',
    'Corregí `src/main/status/HookServer.ts` y el test **pasa** (commit 3ecc968a).',
    '```ts',
    'const x = 1',
    '```',
    '- Subí el jar a https://github.com/ValentinTarnovsky/SnAgentsOS/releases',
    '| col | col |',
    '¿Hago el release?',
  ].join('\n')
  const clean = T.cleanForSpeech(reply, 'es')
  check(!clean.includes('```') && !clean.includes('src/') && !clean.includes('3ecc968a') && !clean.includes('|') && !clean.includes('**') && !clean.includes('##'), 'cleanForSpeech drops code, paths, hashes, tables and markdown (got ' + J(clean) + ')')
  check(clean.includes('HookServer') && clean.includes('(código)') && clean.includes('github.com') && clean.endsWith('¿Hago el release?'), 'a path says its file name, code becomes a word, a URL its host')
  check(T.cleanForSpeech('Edité C:\\Users\\x\\app\\main.tsx y package.json.', 'en') === 'Edité main y package.', 'Windows paths and file names lose folders and extensions')
  check(T.sentencesOf('Uno. Dos? Tres!').length === 3 && T.isShortReply('Listo, pasa.', 240) && !T.isShortReply('Uno. Dos. Tres.', 240) && !T.isShortReply('x'.repeat(300), 240), 'sentences and the short rule')
  check(T.localSummary('Hice el wipe. Conecté MySQL. Verifiqué hashes. ¿Borro el archivo?', 'es') === 'Hice el wipe. Y 2 puntos más. ¿Borro el archivo?', 'localSummary: first sentence, the count, the closing question')
  check(T.localSummary('Done.', 'en') === 'Done.' && T.localSummary('', 'en') === '', 'localSummary of one sentence or nothing')
  check(T.joinNames(['API'], 'es') === 'API' && T.joinNames(['API', 'SnLib'], 'es') === 'API y SnLib' && T.joinNames(['A', 'B', 'C'], 'es') === 'A, B y C' && T.joinNames(['A', 'B', 'C', 'D', 'E'], 'en') === 'A, B and 3 more', 'joinNames')
}

function testSettings() {
  const V = load('src/shared/voice.ts')
  check(V.SUPERTONIC_SPEAKERS.male === 9 && V.SUPERTONIC_SPEAKERS.female === 4, 'the voices the user picked: 9 male, 4 female')
  check(V.wakeWordFor('', 'es') === 'Agente' && V.wakeWordFor('  ', 'en') === 'Agent' && V.wakeWordFor('Jarvis', 'es') === 'Jarvis', 'wakeWordFor')
  check(V.voiceLangOf('auto', 'en') === 'en' && V.voiceLangOf('auto', 'es') === 'es' && V.voiceLangOf('en', 'es') === 'en', 'voiceLangOf')
  const { parseConfig, CONFIG_VERSION, voiceSettingsSchema } = load('src/main/store/schema.ts')
  check(CONFIG_VERSION === 22, 'CONFIG_VERSION is 22 (app 2.11.0)')
  const baseSettings = { defaultShell: {}, fontFamily: 'mono', fontSize: 13, scrollback: 1000, restoreLastWorkspace: true, confirmCloseRunning: true, sidebarCollapsed: false }
  const cfg = (version, extra = {}) => ({ version, workspaces: [{ id: 'w1', name: 'Uno', cwd: 'C:/a', panes: [{ id: 'p1', type: 'shell', title: 'Shell', color: '#fff', icon: 'terminal' }] }], presets: [], settings: { ...baseSettings, ...extra }, activeWorkspaceId: 'w1' })
  const up = parseConfig(cfg(21))
  check(up && up.version === 22 && J(up.settings.voice) === J(V.DEFAULT_VOICE_SETTINGS) && up.settings.labs.voice === false, 'a v21 config gains the voice defaults and labs.voice off, stamped 22')
  const junk = voiceSettingsSchema.parse({ wakeWord: 'x'.repeat(99), followUpSec: 99, language: 'fr', tts: { voice: 'robot', speed: 9, engine: 'cloud' }, eleven: { resetDay: 40, mode: 'x' }, narration: { groupMs: 'a', summarizer: 'gpt' } })
  check(junk.wakeWord === '' && junk.followUpSec === 6 && junk.language === 'auto' && junk.tts.voice === 'male' && junk.tts.speed === 1.15 && junk.tts.engine === 'local' && junk.eleven.resetDay === 1 && junk.eleven.mode === 'fixedOnly' && junk.narration.groupMs === 2500 && junk.narration.summarizer === 'claude', 'every junk field falls back to its own default')
  const kept = voiceSettingsSchema.parse({ wakeWord: 'Jarvis', tts: { voice: 'female', speed: 1.3 }, eleven: { voiceId: 'abc123', mode: 'all' } })
  check(kept.wakeWord === 'Jarvis' && kept.tts.voice === 'female' && kept.tts.speed === 1.3 && kept.eleven.voiceId === 'abc123' && kept.eleven.mode === 'all' && kept.tts.volume === 80, 'valid values survive and the rest get defaults')
}

function main() {
  const C = load('src/shared/voiceCommands.ts')
  testWake(C)
  testGrammar(C)
  testNames(load('src/shared/spokenNames.ts'))
  testSpeech(load('src/shared/speechText.ts'))
  testSettings()
  console.log(`PASS: ${checks} voice checks (wake word, grammar es/en, spoken names, speech text, local summary, schema 22)`)
}

main()
