/**
 * Hands-free voice (app 2.11.0): the wake word and the spoken command grammar,
 * in Spanish (Rioplatense forms included) and English. Pure, no Node or DOM:
 * the renderer runs it on every Whisper final and the tests drive it as is.
 *
 * A phrase is a command only when it starts with the wake word (after at most
 * one filler: "eh", "oye", "che"...) AND the rest parses here; "la gente esta
 * loca" matches the wake word loosely but parses to nothing, so it is ignored.
 * Names are not resolved here (spokenNames.ts does that): a command carries
 * the folded reference the user said, numbers already as digits.
 */

const COMBINING = /[̀-ͯ]/g

/** Lower case, accents dropped, punctuation to spaces, single spaces. */
export function foldSpeech(s: string): string {
  return String(s ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(COMBINING, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

/** A rough Spanish sound fold for matching one spoken word against another (v/b, z/c/s, ll/y, qu/k, g/j, silent h). */
export function soundFold(word: string): string {
  return foldSpeech(word)
    .replace(/\s+/g, '')
    .replace(/qu/g, 'k')
    .replace(/c([ei])/g, 's$1')
    .replace(/g([ei])/g, 'j$1')
    .replace(/ll/g, 'y')
    .replace(/^h/, '')
    .replace(/v/g, 'b')
    .replace(/z/g, 's')
    .replace(/c/g, 'k')
    .replace(/(.)\1+/g, '$1')
}

/** Levenshtein distance, capped at `max + 1` (enough to decide `<= max`). */
export function editDistance(a: string, b: string, max = 64): number {
  if (a === b) return 0
  if (Math.abs(a.length - b.length) > max) return max + 1
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    const cur = [i]
    let best = i
    for (let j = 1; j <= b.length; j++) {
      const v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
      cur.push(v)
      if (v < best) best = v
    }
    if (best > max) return max + 1
    prev = cur
  }
  return prev[b.length]
}

/** Two spoken words are the same word: equal after the sound fold, or within 1 edit (2 for 7+ letters). */
export function sameWord(heard: string, wanted: string): boolean {
  const a = soundFold(heard)
  const b = soundFold(wanted)
  if (!a || !b) return false
  if (a === b) return true
  const max = b.length <= 6 ? 1 : 2
  return editDistance(a, b, max) <= max
}

const FILLERS = new Set(['eh', 'ehh', 'em', 'emm', 'este', 'ok', 'okay', 'oye', 'oiga', 'che', 'hey', 'hola', 'bueno', 'a', 'y', 'hi', 'so', 'well'])

export interface WakeMatch {
  hit: boolean
  /** The phrase after the wake word, as Whisper wrote it (accents and case kept). */
  rest: string
}

/** Tokens of the original text with their folded form (punctuation-only tokens dropped). */
function tokens(text: string): Array<{ raw: string; fold: string }> {
  return String(text ?? '')
    .split(/\s+/)
    .map((raw) => ({ raw, fold: foldSpeech(raw) }))
    .filter((t) => t.fold.length > 0)
}

function restFrom(list: Array<{ raw: string }>, i: number): string {
  return list
    .slice(i)
    .map((t) => t.raw)
    .join(' ')
    .replace(/^[\s,.;:!?¡¿-]+/, '')
    .trim()
}

/**
 * Whether `text` starts with the wake word (one leading filler allowed; the
 * wake word may come split in two, "a gente"). A multi-word wake word must
 * match word by word.
 */
export function matchWake(text: string, wake: string): WakeMatch {
  const list = tokens(text)
  const want = foldSpeech(wake).split(' ').filter(Boolean)
  if (!list.length || !want.length) return { hit: false, rest: '' }
  for (const start of [0, 1]) {
    if (start === 1 && !FILLERS.has(list[0].fold)) break
    if (start >= list.length) break
    if (want.length === 1) {
      if (sameWord(list[start].fold, want[0])) return { hit: true, rest: restFrom(list, start + 1) }
      // Split in two ("a gente"): only an exact sound match, so "la gente" is not "agente".
      if (start + 1 < list.length && soundFold(list[start].fold + list[start + 1].fold) === soundFold(want[0])) return { hit: true, rest: restFrom(list, start + 2) }
    } else if (want.every((w, k) => start + k < list.length && sameWord(list[start + k].fold, w))) {
      return { hit: true, rest: restFrom(list, start + want.length) }
    }
  }
  return { hit: false, rest: '' }
}

/**
 * The last place the wake word appears inside a phrase (not at its start), so
 * "arregla el bug, agente, enviar" splits into the dictated text and the
 * command after it. Null when it never appears after the first word.
 */
export function splitAtLastWake(text: string, wake: string): { before: string; after: string } | null {
  const list = tokens(text)
  const want = foldSpeech(wake).split(' ').filter(Boolean)
  if (want.length !== 1) return null
  for (let i = list.length - 1; i >= 1; i--) {
    if (sameWord(list[i].fold, want[0])) {
      const before = list
        .slice(0, i)
        .map((t) => t.raw)
        .join(' ')
        .replace(/[\s,;:-]+$/, '')
        .trim()
      return { before, after: restFrom(list, i + 1) }
    }
  }
  return null
}

// --- Numbers ------------------------------------------------------------------

const NUMBER_WORDS: Record<string, number> = {
  cero: 0, uno: 1, una: 1, un: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6, siete: 7, ocho: 8, nueve: 9, diez: 10,
  once: 11, doce: 12, trece: 13, catorce: 14, quince: 15, dieciseis: 16, diecisiete: 17, dieciocho: 18, diecinueve: 19, veinte: 20,
  primera: 1, primero: 1, primer: 1, segunda: 2, segundo: 2, tercera: 3, tercero: 3, tercer: 3, cuarta: 4, cuarto: 4, quinta: 5, quinto: 5,
  sexta: 6, sexto: 6, septima: 7, septimo: 7, octava: 8, octavo: 8, novena: 9, noveno: 9, decima: 10, decimo: 10,
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20,
  first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10,
}

/** A folded word as a number 0..99 (digits or a number word), else null. */
export function numberOf(word: string): number | null {
  if (/^\d{1,2}$/.test(word)) return Number(word)
  const n = NUMBER_WORDS[word]
  return n === undefined ? null : n
}

/** Folded reference words with number words turned into digits ("consola dos" -> "2" once the noun is gone). */
function refOf(words: string[]): string {
  return words
    .map((w) => {
      const n = numberOf(w)
      return n === null ? w : String(n)
    })
    .join(' ')
    .trim()
}

// --- Grammar ------------------------------------------------------------------

export type VoiceCommand =
  | { kind: 'exit' | 'stop' | 'repeat' | 'next' | 'status' | 'help' | 'send' | 'insert' | 'cancel' }
  | { kind: 'read'; ref?: string; full: boolean }
  | { kind: 'dictate'; ref?: string; text?: string }
  | { kind: 'selectWorkspace'; ref: string }
  | { kind: 'selectConsole'; ref: string }
  /** A bare name or "anda a X": a console first, then a workspace (spokenNames decides). */
  | { kind: 'select'; ref: string }

/** Whole-phrase commands (folded). */
const EXACT: Array<[VoiceCommand['kind'], string[]]> = [
  ['exit', ['salir', 'sali', 'apagate', 'apaga', 'apagar', 'apaga manos libres', 'apagar manos libres', 'apaga el manos libres', 'chau', 'adios', 'exit', 'turn off', 'stop listening', 'goodbye', 'bye']],
  ['stop', ['para', 'parar', 'basta', 'silencio', 'callate', 'calla', 'detente', 'deten', 'stop', 'shut up', 'quiet', 'be quiet', 'enough']],
  ['repeat', ['repeti', 'repite', 'repetir', 'repetilo', 'repitelo', 'otra vez', 'de nuevo', 'repeat', 'again', 'say again', 'say that again']],
  ['next', ['siguiente', 'la siguiente', 'el siguiente', 'el que sigue', 'la que sigue', 'proxima', 'proximo', 'next', 'next one']],
  ['status', ['estado', 'como van', 'como vamos', 'como va todo', 'quien termino', 'quien espera', 'que paso', 'status', 'who finished', 'whats up', 'what is waiting']],
  ['help', ['ayuda', 'que puedo decir', 'comandos', 'help', 'what can i say', 'commands']],
  ['send', ['enviar', 'envia', 'envialo', 'enviala', 'enviarlo', 'manda', 'mandalo', 'mandar', 'mandarlo', 'send', 'send it', 'submit']],
  ['insert', ['insertar', 'inserta', 'insertalo', 'pegar', 'pega', 'pegalo', 'escribilo', 'insert', 'paste', 'paste it', 'type it']],
  ['cancel', ['cancelar', 'cancela', 'cancelalo', 'borrar', 'borra', 'borralo', 'olvidalo', 'descartar', 'descarta', 'cancel', 'discard', 'forget it', 'never mind']],
]

const READ_VERBS = ['lee', 'leeme', 'leer', 'lea', 'leelo', 'leela', 'read', 'read me']
const READ_ASK = ['que dijo', 'que dice', 'what did', 'what does']
const FULL_WORDS = new Set(['todo', 'entero', 'entera', 'completo', 'completa', 'all', 'full', 'everything', 'whole'])
const DICTATE_VERBS = ['dictar', 'dicta', 'dictale', 'escribir', 'escribi', 'escribile', 'escribe', 'dictate', 'write', 'type']
const TELL_VERBS = ['decile', 'dile', 'decirle', 'deci', 'tell']
const WS_NOUNS = ['workspace', 'espacio', 'proyecto', 'project', 'el workspace', 'el espacio', 'el proyecto']
const CONSOLE_NOUNS = ['consola', 'la consola', 'terminal', 'la terminal', 'console', 'the console', 'pane', 'el panel']
const GO_VERBS = ['anda a', 've a', 'ir a', 'vamos a', 'cambia a', 'cambiar a', 'pasa a', 'abri', 'abre', 'go to', 'switch to', 'open']
const ARTICLES = new Set(['la', 'el', 'a', 'al', 'the', 'de', 'del', 'to'])

function startsWithPhrase(words: string[], phrase: string): number {
  const p = phrase.split(' ')
  if (p.length > words.length) return 0
  for (let i = 0; i < p.length; i++) if (words[i] !== p[i]) return 0
  return p.length
}

function strip(words: string[], from: number): string[] {
  const rest = words.slice(from)
  while (rest.length && ARTICLES.has(rest[0])) rest.shift()
  return rest
}

function firstMatch(words: string[], phrases: readonly string[]): number {
  let best = 0
  for (const p of phrases) best = Math.max(best, startsWithPhrase(words, p))
  return best
}

/**
 * The command in the phrase after the wake word, or null. `original` keeps
 * the user's words (accents and case) for a dictated text ("decile a API que ...").
 */
export function parseVoiceCommand(original: string): VoiceCommand | null {
  const wt = wordTokens(original)
  const words = wt.map((w) => w.fold)
  const folded = words.join(' ')
  if (!folded) return null
  for (const [kind, list] of EXACT) if (list.includes(folded)) return { kind } as VoiceCommand

  // "lee [todo] [X]", "que dijo [X]"
  const readLen = Math.max(firstMatch(words, READ_VERBS), firstMatch(words, READ_ASK))
  if (readLen) {
    let rest = strip(words, readLen)
    let full = false
    if (rest.length && FULL_WORDS.has(rest[0])) {
      full = true
      rest = strip(rest, 1)
    }
    if (rest.length && FULL_WORDS.has(rest[rest.length - 1])) {
      full = true
      rest = rest.slice(0, -1)
    }
    const consoleLen = firstMatch(rest, CONSOLE_NOUNS)
    if (consoleLen) rest = strip(rest, consoleLen)
    if (rest[rest.length - 1] === 'say' || rest[rest.length - 1] === 'dijo') rest = rest.slice(0, -1)
    const ref = refOf(rest)
    return ref ? { kind: 'read', ref, full } : { kind: 'read', full }
  }

  // "decile a X que <texto>"
  const tellLen = firstMatch(words, TELL_VERBS)
  if (tellLen) {
    const rest = strip(words, tellLen)
    const offset = words.length - rest.length
    const que = rest.findIndex((w) => w === 'que' || w === 'that')
    if (que > 0) {
      let refWords = rest.slice(0, que)
      const c = firstMatch(refWords, CONSOLE_NOUNS)
      if (c) refWords = strip(refWords, c)
      const ref = refOf(refWords)
      const text = restFrom(tokens(original), wt[offset + que].token + 1)
      return { kind: 'dictate', ...(ref ? { ref } : {}), ...(text ? { text } : {}) }
    }
  }

  // "dictar [a X]"
  const dictLen = firstMatch(words, DICTATE_VERBS)
  if (dictLen) {
    let rest = strip(words, dictLen)
    const consoleLen = firstMatch(rest, CONSOLE_NOUNS)
    if (consoleLen) rest = strip(rest, consoleLen)
    const ref = refOf(rest)
    return ref ? { kind: 'dictate', ref } : { kind: 'dictate' }
  }

  // "workspace X", "consola X"
  const wsLen = firstMatch(words, WS_NOUNS)
  if (wsLen) {
    const ref = refOf(strip(words, wsLen))
    return ref ? { kind: 'selectWorkspace', ref } : null
  }
  const conLen = firstMatch(words, CONSOLE_NOUNS)
  if (conLen) {
    const ref = refOf(strip(words, conLen))
    return ref ? { kind: 'selectConsole', ref } : null
  }

  // "anda a X", "la 3"
  const goLen = firstMatch(words, GO_VERBS)
  if (goLen) {
    const rest = strip(words, goLen)
    const w = firstMatch(rest, WS_NOUNS)
    if (w) {
      const ref = refOf(strip(rest, w))
      return ref ? { kind: 'selectWorkspace', ref } : null
    }
    const c = firstMatch(rest, CONSOLE_NOUNS)
    if (c) {
      const ref = refOf(strip(rest, c))
      return ref ? { kind: 'selectConsole', ref } : null
    }
    const ref = refOf(rest)
    return ref ? { kind: 'select', ref } : null
  }
  if (words.length === 2 && (words[0] === 'la' || words[0] === 'el') && numberOf(words[1]) !== null) return { kind: 'selectConsole', ref: String(numberOf(words[1])) }

  // A bare name ("API", "SnLib dos"): up to 4 words, resolved against the roster.
  if (words.length <= 4) return { kind: 'select', ref: refOf(words) }
  return null
}

/** Every folded word of the phrase with the index of the original token it came from ("SnLib-dos" is two words of one token). */
function wordTokens(original: string): Array<{ fold: string; token: number }> {
  const out: Array<{ fold: string; token: number }> = []
  tokens(original).forEach((t, token) => {
    for (const fold of t.fold.split(' ')) if (fold) out.push({ fold, token })
  })
  return out
}

/** A phrase that, while dictating, is only "enviar", "insertar" or "cancelar" (bareCommands). */
export function bareDictationCommand(original: string): 'send' | 'insert' | 'cancel' | null {
  const folded = foldSpeech(original)
  for (const [kind, list] of EXACT) {
    if ((kind === 'send' || kind === 'insert' || kind === 'cancel') && list.includes(folded)) return kind
  }
  return null
}
