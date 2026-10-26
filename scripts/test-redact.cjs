// redactCredentials (app 2.7.0, A2): src/shared/redact.ts masks credential
// shapes in free text (notices, plan A5; since the fifth B5 integration round
// the 64 hex snaos token shape too) and nothing else. Every pattern, the
// kept parts of a connection string, idempotence, the negatives (prose, git
// SHAs, UUIDs, paths, URLs without credentials), junk input and 1 MB inputs
// (adversarial ones too) under a time budget. redact() keeps its behavior.
// Same esbuild + vm harness as test-status.cjs: no Electron, no user data.
const { buildSync } = require('esbuild')
const vm = require('node:vm')
const assert = require('node:assert/strict')
const path = require('node:path')
const root = path.resolve(__dirname, '..')
let checks = 0
function check(condition, label) { assert.ok(condition, label); checks++ }
function load(file, overrides = {}) {
  const code = buildSync({ entryPoints: [path.join(root, file)], bundle: true, platform: 'node', format: 'cjs', write: false, alias: { '@shared': path.join(root, 'src/shared') } }).outputFiles[0].text
  const mod = { exports: {} }
  vm.runInNewContext(code, { module: mod, exports: mod.exports, console, ...overrides })
  return mod.exports
}

const { redactCredentials: rc, redact } = load('src/shared/redact.ts')
const M = '[redacted]'
// Built by repetition so no literal credential sits in the repo.
const rep = (s, n) => s.repeat(Math.ceil(n / s.length)).slice(0, n)
const B62 = 'aZ0bY1cX2dW3eV4fU5gT6hS7iR8jQ9kPlOmNnMoLpKqJrIsHtGuFvEwDxCyBzA'
const tok = (n, alphabet = B62) => rep(alphabet, n)
/** `text` turns into `want`, and a second pass changes nothing. */
function masks(text, want, label) {
  const got = rc(text)
  assert.equal(got, want, label); checks++
  assert.equal(rc(got), got, label + ' (idempotent)'); checks++
}
function keeps(text, label) {
  assert.equal(rc(text), text, label); checks++
}

function patterns() {
  const openai = 'sk-proj-' + tok(48)
  masks(`OPENAI_API_KEY=${openai}`, `OPENAI_API_KEY=${M}`, 'sk-proj- key after =')
  masks(`key ${'sk-' + tok(48)} end`, `key ${M} end`, 'legacy sk- key')
  masks(`"${'sk-ant-api03-' + tok(93) + 'AA'}"`, `"${M}"`, 'Anthropic sk-ant-api03 key in quotes')
  masks(`token: ${'sk-ant-oat01-' + tok(60)}`, `token: ${M}`, 'Claude OAuth sk-ant-oat01 token')
  masks(`${'sk-' + rep('0123456789abcdef', 32)}`, M, 'sk- with lowercase hex at the start of the text')
  masks('LANGFUSE_SECRET_KEY=sk-lf-1b2c3d4e-5f6a-7b8c-9d0e-1f2a3b4c5d6e', `LANGFUSE_SECRET_KEY=${M}`, 'sk- key shaped as a UUID (short parts, key-like)')
  masks('or sk-or-v1-' + rep('0123456789abcdef', 64), `or ${M}`, 'OpenRouter sk-or-v1- key')
  for (const p of ['ghp_', 'gho_', 'ghu_', 'ghs_', 'ghr_']) masks(`git push https://x/${p}${tok(36)} now`, `git push https://x/${M} now`, `GitHub ${p} token`)
  masks(`GH_TOKEN=github_pat_11${tok(20)}_${tok(59)}`, `GH_TOKEN=${M}`, 'GitHub fine-grained github_pat_ token')
  for (const k of 'abposr') masks(`slack xox${k}-1234567890-${tok(24)}.`, `slack ${M}.`, `Slack xox${k}- token`)
  masks('aws AKIA' + rep('IOSFODNN7EXAMPLE', 16) + ',', `aws ${M},`, 'AWS AKIA access key id')
  masks('aws=ASIA' + rep('Q2WSX3EDC4RFV5TG', 16), `aws=${M}`, 'AWS ASIA (temporary) access key id')
  masks(`maps AIza${tok(35, B62 + '_-')} ok`, `maps ${M} ok`, 'Google AIza API key')
  masks(`//registry.npmjs.org/:_authToken=npm_${tok(36)}`, `//registry.npmjs.org/:_authToken=${M}`, 'npm_ token')
  masks('Authorization: Bearer ' + tok(40) + '\n', `Authorization: Bearer ${M}\n`, 'Bearer opaque token, header line')
  masks('curl -H "authorization: bearer ' + tok(24) + '"', `curl -H "authorization: bearer ${M}"`, 'bearer in lower case')
  masks('Use Bearer ' + tok(20) + '.', `Use Bearer ${M}.`, 'a sentence full stop stays out of the Bearer token')
  const jwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIn0.' + tok(43, B62 + '_-')
  masks(`jwt=${jwt}&x=1`, `jwt=${M}&x=1`, 'JWT (three base64url parts)')
  masks(`Bearer ${jwt}`, `Bearer ${M}`, 'Bearer with a JWT')
  masks('unsigned eyJhbGciOiJub25lIn0.eyJzdWIiOiIxIn0. tail', `unsigned ${M} tail`, 'unsigned JWT (empty signature)')
  const pem = (kind) => `-----BEGIN ${kind}PRIVATE KEY-----\n${rep(tok(64) + '\n', 520)}-----END ${kind}PRIVATE KEY-----`
  for (const kind of ['', 'RSA ', 'EC ', 'OPENSSH ', 'ENCRYPTED ']) masks(`before\n${pem(kind)}\nafter`, `before\n${M}\nafter`, `PEM ${kind || 'PKCS8 '}private key block`)
  masks(`a ${pem('RSA ')} b ${pem('EC ')} c`, `a ${M} b ${M} c`, 'two PEM blocks, text between kept')
  masks(`-----BEGIN PGP PRIVATE KEY BLOCK-----\n${tok(64)}\n-----END PGP PRIVATE KEY BLOCK-----`, M, 'PGP private key block')
  masks(`key:\n-----BEGIN OPENSSH PRIVATE KEY-----\n${tok(64)}\n${tok(30)}`, `key:\n${M}`, 'a PEM block cut short is masked to the end')
  masks('-----BEGIN RSA PRIVATE KEY-----\r\n' + tok(64) + '\r\n-----END RSA PRIVATE KEY-----\r\nok', `${M}\r\nok`, 'PEM with CRLF line ends')
  keeps('-----BEGIN CERTIFICATE-----\n' + tok(64) + '\n-----END CERTIFICATE-----', 'a certificate (public) is not a private key')
  keeps('-----BEGIN PUBLIC KEY-----\n' + tok(64) + '\n-----END PUBLIC KEY-----', 'a public key stays')

  // Connection strings: scheme, user and host stay.
  masks('postgres://admin:s3cr3t@db.internal:5432/app', `postgres://admin:${M}@db.internal:5432/app`, 'postgres password')
  masks('DATABASE_URL="mongodb+srv://me:p%40ss@cluster0.x.mongodb.net/db?retryWrites=true"', `DATABASE_URL="mongodb+srv://me:${M}@cluster0.x.mongodb.net/db?retryWrites=true"`, 'mongodb+srv password (percent-encoded)')
  masks('redis://:hunter2@127.0.0.1:6379/0', `redis://:${M}@127.0.0.1:6379/0`, 'redis with an empty user')
  masks('https://user:p@ss:w0rd@example.com/x', `https://user:${M}@example.com/x`, 'a password with @ and : runs to the last @ before the host')
  masks('amqp://guest:guest@[::1]:5672', `amqp://guest:${M}@[::1]:5672`, 'IPv6 host')
  masks('two: mysql://a:b1@h1/x and ftp://c:d2@h2', `two: mysql://a:${M}@h1/x and ftp://c:${M}@h2`, 'two connection strings in one text')
  masks('postgres://u:' + 'sk-' + tok(30) + '@h/db', `postgres://u:${M}@h/db`, 'a token used as the password')

  // B5 integration, fifth round: the snaos token shape (newToken: 64 hex), the master token of runtime.json and every
  // console or team token; a second net behind main's refusal of a live token in a team text.
  const hex64 = rep('0f1e2d3c4b5a6978', 64)
  masks(`{"version":1,"pid":4242,"token":"${hex64}"}`, `{"version":1,"pid":4242,"token":"${M}"}`, 'the master token inside a pasted runtime.json')
  masks(`SNAOS_CTL_TOKEN=${hex64}`, `SNAOS_CTL_TOKEN=${M}`, 'a team or console token after =')
  masks(`Authorization ${hex64.toUpperCase()}\n${hex64}.`, `Authorization ${M}\n${M}.`, 'in capitals, and before a full stop')
  masks(`token_${hex64} y x-${hex64}`, `token_${M} y x-${M}`, 'after an underscore or a dash')
  masks(`sha256 ${'ab12'.repeat(16)}`, `sha256 ${M}`, 'a SHA-256 hex digest has the same shape and is masked too')
}

function negatives() {
  const prose = [
    'The bearer of this note may pass. Bearer tokens are explained in RFC 6750.',
    'Bearer authentication uses an opaque string; see Bearer <token> in the docs.',
    'sk-learn is a library; risk-assessment-framework-for-everyone; desk-lamp-collection-2024-edition.',
    'Hugs xoxo-love-you-forever-and-ever and ASIA Pacific, AKIA is not a word.',
    'Run npm_config_registry_url_override, npm_package_version and ghp_ alone.',
    'Ella dijo: "contraseña: ninguna" y el pájaro voló a las 15:00.',
    'Ratio 3:2 at 10:30, see http: or https:// alone, user:pass without a scheme.',
  ]
  for (const p of prose) keeps(p, 'prose stays: ' + p.slice(0, 40))
  keeps('commit a94a8fe5ccb19ba61c4c0873d391e987982fbbd3 (HEAD -> main)', '40-hex git SHA stays')
  keeps('a94a8fe5ccb19ba61c4c0873d391e987982fbbd3a94a8fe5ccb19ba61c4c0873d391e987982fbbd3', '80-hex run stays (redact() is the one for hashes)')
  keeps(`63 ${rep('0f1e2d3c', 63)} and 65 ${rep('0f1e2d3c', 65)}`, '63 and 65 hex runs are not the 64 hex token shape')
  keeps(`x${rep('0f1e2d3c', 64)} and ${rep('0f1e2d3c', 64)}g`, 'a 64 hex run glued to a letter or a digit is part of a longer word')
  keeps('session 123e4567-e89b-12d3-a456-426614174000 and pane-4f346061', 'UUIDs and pane ids stay')
  keeps('C:\\Users\\user\\Desktop\\Repo\\src\\shared\\redact.ts:42:7', 'Windows path with line:col stays')
  keeps('/home/me/.ssh/id_rsa and ~/.claude/settings.json and src/sk-utils/file.ts', 'POSIX paths stay')
  keeps('\\\\server\\share\\folder', 'UNC path stays')
  const urls = [
    'https://github.com/ValentinTarnovsky/SnAgentsOS/pull/27',
    'http://localhost:4517/#ws=w1&pane=p2',
    'https://example.com:8443/path?q=a@b.com&x=1',
    'http://localhost:3000?user=a@b.c',
    'https://site.com/?e=x:y@z',
    'ssh://git@github.com/org/repo.git',
    'git@github.com:org/repo.git',
    'postgres://localhost:5432/db',
    'http://[::1]:8080/health',
    'mailto:someone@example.com',
  ]
  for (const u of urls) keeps(`see ${u} now`, 'URL without credentials stays: ' + u)
  keeps('mail me at user@example.com', 'emails stay')
  keeps('192.168.1.20 and 10.0.0.1:4517', 'IPs stay')
  keeps('sk-' + rep('abcdefghij-', 30), 'an sk- run without a digit (a kebab id) stays')
  keeps('see src/sk-utils-for-everyone-v2/file.ts', 'an sk- path segment with a digit stays (short words)')
  keeps('C:\\repos\\sk-tools-2024-internal-build\\out.log', 'an sk- Windows folder with a year stays')
  keeps('git checkout sk-feature-login-fix-2024', 'an sk- branch name with a digit stays')
  keeps('https://github.com/org/sk-learn-extensions-2024/pull/3', 'an sk- repo name in a URL stays')
  keeps('x' + 'sk-' + tok(40), 'sk- inside a word stays (no edge)')
  keeps('AKIA' + rep('ABCDEFGHIJ', 17), 'AKIA followed by more than 16 key characters is not a key id')
  keeps('Bearer ' + rep('abcdefgh', 4), 'a Bearer word without a digit stays')
  keeps('', 'empty text stays empty')
  keeps('[redacted] and [redacted]', 'the mask itself stays')
}

function junk() {
  check(rc(undefined) === '' && rc(null) === '', 'undefined and null give empty text')
  check(rc(42) === '42' && rc({ toString: () => 'sk-' + tok(30) }) === M, 'non-strings are stringified first')
  check(typeof rc(Symbol('x')) === 'string', 'a symbol gives a string, no throw')
  check(rc({ toString() { throw new Error('boom') } }) === '', 'a throwing toString gives empty text, no throw')
}

function legacy() {
  // redact() is untouched: its own masks, nothing of redactCredentials.
  check(redact('id a94a8fe5ccb19ba61c4c0873d391e987982fbbd3') === 'id <redacted>', 'redact() still masks hex runs as <redacted>')
  check(redact('me@x.com 192.168.1.20') === '<email> 192.168.x.x', 'redact() still masks emails and private IPs')
  check(redact('postgres://a:b@h') === 'postgres://a:b@h', 'redact() still leaves a connection string alone')
  check(!redact('x').includes('[redacted]'), 'redact() never uses the [redacted] mask')
}

function linear() {
  const MB = 1 << 20
  const budget = 2000
  const corpus = [
    ' tok ' + 'sk-' + tok(48) + ' ' + 'ghp_' + tok(36) + ' Bearer ' + tok(30) + ' https://u:p4ss@h/x ',
    ' prose with words and 3:2 ratios, paths C:\\a\\b and https://host/a?b=c@d ',
    ' eyJ' + tok(20) + '.eyJ' + tok(20) + '.' + tok(20) + ' AKIA' + rep('Q2WSX3EDC4RFV5TG', 16) + ' ',
  ].join('')
  const inputs = {
    mixed: corpus.repeat(Math.ceil(MB / corpus.length)),
    letters: rep('abcdefghijklmnopqrstuvwxyz', MB),
    'scheme runs': rep('a://b:', MB),
    'colon runs': 'a://b:' + rep('x', MB),
    'jwt starts': rep(' eyJ', MB),
    'jwt run': 'eyJ' + rep('eyJ', MB),
    'two jwt parts': rep(' eyJabcdefgh.eyJabcdefgh', MB),
    'sk runs': ' sk-' + rep('a-', MB),
    'sk starts': rep(' sk-', MB),
    'bearer words': rep('bearer ', MB),
    'bearer dots': 'Bearer 1' + rep('.', MB),
    'pem headers': rep('-----BEGIN RSA PRIVATE KEY-----', MB),
    'pem prefixes': rep('-----BEGIN ' + 'A'.repeat(39) + ' PRIVATE KEY ', MB),
    'pem blocks': rep('-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----\n', MB),
    'at signs': 'a://u:' + rep('@', MB),
    'dash runs': rep('-', MB),
    'hex runs': rep('0123456789abcdef', MB),
    'hex words of 63': rep(' ' + rep('a1', 63), MB),
  }
  for (const [name, input] of Object.entries(inputs)) {
    const t0 = process.hrtime.bigint()
    const out = rc(input)
    const ms = Number(process.hrtime.bigint() - t0) / 1e6
    check(typeof out === 'string' && ms < budget, `1 MB ${name} input in ${ms.toFixed(0)} ms (budget ${budget} ms)`)
  }
  const out = rc(inputs.mixed)
  check(!out.includes('sk-' + tok(48)) && !out.includes('ghp_') && !out.includes('p4ss@') && !out.includes('AKIA') && out.includes('https://u:' + M + '@h/x'), 'the mixed 1 MB input has every credential masked')
  check(rc(out) === out, 'the mixed 1 MB output is a fixed point')
}

patterns()
negatives()
junk()
legacy()
linear()
console.log(`PASS: ${checks} redact checks (every credential pattern, connection strings keep scheme/user/host, idempotent, prose/SHA/UUID/path/URL negatives, junk input, 1 MB under budget, redact() unchanged)`)
