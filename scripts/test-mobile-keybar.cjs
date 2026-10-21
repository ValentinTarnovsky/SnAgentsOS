// Phone KeyBar logic (E1-FR-16..21): the tap/hold/repeat controller under fake
// timers, the key layout and sequences, and the kbOpen derivation.
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
  vm.runInNewContext(code, { module: mod, exports: mod.exports, require, console, process, setTimeout, clearTimeout, ...overrides })
  return mod.exports
}

const keyPress = load('src/mobile/src/lib/keyPress.ts')
const { createKeyPress, REPEAT_DELAY_MS, REPEAT_INTERVAL_MS, REPEAT_MAX_MS, TAP_SLOP_PX } = keyPress

/** Virtual clock + timer queue: advance() runs due timers in order. */
function fakeTime() {
  let clock = 0, seq = 0
  const queue = new Map()
  const timers = {
    setTimeout: (fn, ms) => { queue.set(++seq, { due: clock + Math.max(0, ms), fn }); return seq },
    clearTimeout: id => { queue.delete(id) },
  }
  const advance = ms => {
    const target = clock + ms
    for (;;) {
      let next = null
      for (const [id, t] of queue) if (t.due <= target && (!next || t.due < next[1].due)) next = [id, t]
      if (!next) break
      queue.delete(next[0]); clock = next[1].due; next[1].fn()
    }
    clock = target
  }
  return { timers, now: () => clock, advance, pending: () => queue.size }
}

function harness(repeat, sendResult = () => true) {
  const time = fakeTime()
  const sends = []
  const press = createKeyPress(() => { sends.push(time.now()); return sendResult(sends.length) }, { repeat, now: time.now, timers: time.timers })
  return { press, sends, ...time }
}
const at = (x = 0, y = 0, pointerId = 1) => ({ clientX: x, clientY: y, pointerId })

// Contract constants.
check(REPEAT_DELAY_MS === 400 && REPEAT_INTERVAL_MS === 45, 'repeat starts at 400ms and runs every 45ms')
check(REPEAT_MAX_MS === 15000 && TAP_SLOP_PX === 10, 'safety cap is 15s and the tap slop 10px')

{
  const h = harness(true)
  h.press.down(at()); h.advance(120)
  check(h.sends.length === 0, 'nothing is sent on pointerdown')
  h.press.up(at())
  check(h.sends.length === 1 && h.sends[0] === 120, 'a tap sends exactly once, on pointerup')
  h.advance(2000)
  check(h.sends.length === 1 && h.pending() === 0, 'a tap leaves no timer behind')
}
{
  const h = harness(true)
  h.press.down(at()); h.advance(1000)
  check(h.sends.length === 14, `holding 1s sends 14 times (t=400 + 45ms x 13), got ${h.sends.length}`)
  check(h.sends[0] === 400 && h.sends[1] === 445 && h.sends[13] === 985, 'repeat sends land at 400, 445, ... 985')
  h.press.up(at())
  check(h.sends.length === 14, 'releasing a repeating key sends nothing extra')
  h.advance(1000)
  check(h.sends.length === 14 && h.pending() === 0, 'the repeat stops on release')
}
{
  const h = harness(true)
  h.press.down(at(100, 100)); h.advance(200); h.press.move(at(108, 100)); h.press.up(at(108, 100))
  check(h.sends.length === 1, 'jitter within the 10px slop still taps')
}
{
  const h = harness(true)
  h.press.down(at(100, 100)); h.advance(100); h.press.move(at(112, 100)); h.press.up(at(112, 100))
  check(h.sends.length === 0, 'a 12px move voids the tap')
}
{
  const h = harness(true)
  h.press.down(at(100, 100)); h.advance(600)
  const before = h.sends.length
  h.press.move(at(100, 112)); h.advance(1000); h.press.up(at(100, 112))
  check(before === 5 && h.sends.length === before, 'a 12px move stops a running repeat and up sends nothing')
}
{
  const h = harness(false)
  h.press.down(at(10, 20)); h.press.move(at(70, 20)); h.press.cancel(); h.press.up(at(70, 20))
  check(h.sends.length === 0, 'a 60px swipe starting on ^D sends nothing')
}
{
  const h = harness(true)
  h.press.down(at()); h.advance(500); h.press.cancel()
  const n = h.sends.length
  h.advance(1000)
  check(n === 3 && h.sends.length === n && h.pending() === 0, 'pointercancel stops the repeat')
  h.press.up(at())
  check(h.sends.length === n, 'an up after an external cancel sends nothing')
}
{
  const h = harness(true)
  h.press.down(at()); h.advance(20000)
  const expected = Math.floor((REPEAT_MAX_MS - REPEAT_DELAY_MS - 1) / REPEAT_INTERVAL_MS) + 1
  check(Math.abs(h.sends.length - expected) <= 1 && h.sends.at(-1) < REPEAT_MAX_MS, `the repeat stops itself at 15s (${h.sends.length} sends)`)
  check(h.pending() === 0, 'no timer stays armed after the cap')
  h.press.up(at())
  check(h.sends.length <= expected + 1, 'up after the cap sends nothing')
}
{
  const h = harness(true, n => n < 3)
  h.press.down(at()); h.advance(2000); h.press.up(at())
  check(h.sends.length === 3 && h.pending() === 0, 'a failed send (socket not OPEN) stops the repeat')
}
{
  const h = harness(true, () => false)
  h.press.down(at()); h.press.up(at())
  check(h.sends.length === 1, 'a failed tap is attempted once and not retried')
}
{
  const h = harness(false)
  h.press.down(at()); h.advance(3000)
  check(h.sends.length === 0, 'non-repeat keys never fire while held')
  h.press.up(at())
  check(h.sends.length === 1, 'non-repeat keys fire once on release after a long hold')
}
{
  const h = harness(true)
  h.press.down(at(0, 0, 1)); h.press.down(at(0, 0, 2)); h.press.move(at(50, 0, 2)); h.press.up(at(0, 0, 2))
  check(h.sends.length === 0, 'a second finger cannot move, release or restart the press')
  h.press.up(at(0, 0, 1))
  check(h.sends.length === 1, 'the original finger still taps')
}
{
  const h = harness(true)
  h.press.down(at()); h.advance(300); h.press.up(at())
  h.press.down(at()); h.advance(150)
  check(h.sends.length === 1, 'a timer from an earlier press never fires into the next one')
  h.press.up(at())
  check(h.sends.length === 2, 'back-to-back taps each send once')
}
{
  // One timer fires 500ms late (a throttled or stalled event loop).
  const time = fakeTime(), sends = []
  let armed = 0
  const lagging = { setTimeout: (fn, ms) => time.timers.setTimeout(fn, ms + (++armed === 3 ? 500 : 0)), clearTimeout: time.timers.clearTimeout }
  const press = createKeyPress(() => { sends.push(time.now()); return true }, { repeat: true, now: time.now, timers: lagging })
  press.down(at()); time.advance(1500); press.up(at())
  const gaps = sends.slice(1).map((v, i) => v - sends[i])
  check(sends.length > 3 && gaps.every(g => g >= REPEAT_INTERVAL_MS), 'a stalled timer never makes the repeat burst to catch up')
}

// Layout and sequences.
const keys = load('src/mobile/src/lib/keys.ts')
const order = keys.buildScrollKeys([{ id: 'u1', label: 'F5', seq: '\x1b[15~' }]).map(k => k.label ?? k.labelKey ?? k.icon)
const expectedOrder = ['key.esc', '^C', 'key.tab', 'key.ctrl', 'left', 'up', 'down', 'right', 'backspace', 'key.del', 'key.enter', 'key.shiftTab', 'key.ctrlEnter', '^L', '^R', 'F5', 'paste', 'quick', '^D', '^Z']
check(JSON.stringify(order) === JSON.stringify(expectedOrder), `scroll order matches E1-FR-21: ${order.join(' ')}`)
const all = keys.buildScrollKeys([])
const byId = Object.fromEntries(all.map(k => [k.id, k]))
const plain = { modes: { applicationCursorKeysMode: false } }, app = { modes: { applicationCursorKeysMode: true } }
check(keys.resolveSeq(byId.backspace, null) === '\x7f' && keys.resolveSeq(byId.delete, null) === '\x1b[3~', 'Bksp sends DEL (0x7f) and Del sends CSI 3 ~')
check(keys.resolveSeq(byId.left, plain) === '\x1b[D' && keys.resolveSeq(byId.up, app) === '\x1bOA', 'arrows follow DECCKM')
check(keys.resolveSeq(byId.right, null) === '\x1b[C', 'arrows default to CSI without a terminal')
check(byId.ctrlEnter.labelKey === 'key.ctrlEnter' && keys.resolveSeq(byId.ctrlEnter, null) === '\x1b\r', 'Newline keeps the key.ctrlEnter id and sends ESC CR')
check(['left', 'up', 'down', 'right', 'backspace', 'delete'].every(id => byId[id].repeat) && all.filter(k => k.repeat).length === 6, 'only the arrows, Bksp and Del repeat')
const chipSeqs = Object.fromEntries(keys.CTRL_CHIPS)
check(chipSeqs['^C'] === '\x03' && chipSeqs['^D'] === '\x04' && chipSeqs['^L'] === '\x0c' && chipSeqs['^R'] === '\x12' && chipSeqs['^Z'] === '\x1a', 'Ctrl chips carry their control codes')
check(all.filter(k => k.chip).every(k => keys.resolveSeq(k, null) === chipSeqs[k.label]) && all.filter(k => k.chip).length === 5, 'every chip key resolves to its CTRL_CHIPS sequence and releases the latch')
check(byId.ctrl.latch && keys.resolveSeq(byId.ctrl, null) === null && keys.resolveSeq(byId.paste, null) === null, 'latch and sheet keys never write to the pty')
check(all.every(k => k.icon == null || k.ariaKey), 'every icon key has a localized aria-label')

// i18n: the new strings exist in both languages.
const i18n = load('src/mobile/src/lib/i18n.ts')
check(i18n.t('key.ctrlEnter') === 'Newline' && i18n.t('key.ctrlEnterAria') === 'Alt+Enter: newline', 'English Newline label and aria-label')
i18n.setLang('es')
check(i18n.t('key.ctrlEnter') === 'Nueva linea' && i18n.t('key.ctrlEnterAria') === 'Alt+Enter: nueva linea', 'Spanish Newline label and aria-label')
check(i18n.t('key.ctrlComposerHint') === 'Ctrl+letra: usa el modo Directo', 'Spanish composer latch hint')
const needed = ['key.backspace', 'key.delete', 'key.del', 'key.ctrlC', 'key.ctrlD', 'key.ctrlL', 'key.ctrlR', 'key.ctrlZ', 'key.mode', 'key.left', 'key.up', 'key.down', 'key.right']
for (const lang of ['en', 'es']) { i18n.setLang(lang); check(needed.every(k => i18n.t(k) && i18n.t(k) !== k), `${lang} has every KeyBar aria string`) }

// kbOpen = a field has the focus AND the keyboard covers more than 120px.
const { store, KB_OPEN_MIN_INSET_PX } = load('src/mobile/src/lib/store.ts')
const s = () => store.getState()
check(KB_OPEN_MIN_INSET_PX === 120 && s().kbOpen === false, 'kbOpen starts closed')
s().setKeyboard({ focus: 'direct' })
check(!s().kbOpen, 'focus alone is not an open keyboard')
s().setKeyboard({ inset: 300 })
check(s().kbOpen && s().kbFocus === 'direct', 'focus plus a 300px inset is open')
s().setKeyboard({ inset: 120 })
check(!s().kbOpen, 'the OS hiding the keyboard without a blur reads as closed')
s().setKeyboard({ inset: 280 }); s().setKeyboard({ focus: null })
check(!s().kbOpen, 'losing the focus closes it')
const ref = s(); s().setKeyboard({ inset: 280, focus: null })
check(s() === ref, 'unchanged keyboard signals do not churn the store')

class FakeElement { constructor(cls, kb) { this.classList = { contains: c => c === cls }; this.dataset = kb ? { kbInput: kb } : {} } }
const viewport = load('src/mobile/src/lib/viewport.ts', { HTMLElement: FakeElement })
check(viewport.measureKeyboardInset(800, { height: 450, offsetTop: 0 }) === 350, 'keyboardInset = innerHeight - (vv.height + vv.offsetTop)')
check(viewport.measureKeyboardInset(800, { height: 450, offsetTop: 350 }) === 0, 'a scrolled visual viewport is not mistaken for a keyboard')
check(viewport.measureKeyboardInset(800, null) === 0 && viewport.measureKeyboardInset(800, { height: 900, offsetTop: 0 }) === 0, 'missing or taller viewports clamp to 0')
check(viewport.kbFieldOf(new FakeElement('xterm-helper-textarea')) === 'direct' && viewport.kbFieldOf(new FakeElement('x', 'composer')) === 'composer', 'helper textarea is direct, data-kb-input names other fields')
check(viewport.kbFieldOf(new FakeElement('button')) === null && viewport.kbFieldOf(null) === null, 'other elements own no keyboard')

// --- KeyBar part 2 (E2-FR-45, 46): custom key bytes, layout, persistence ---
{
  const none = { ctrl: false, alt: false, shift: false }
  const mods = s => ({ ctrl: s.includes('c'), alt: s.includes('a'), shift: s.includes('s') })
  const seq = (key, m = '', app = false) => keys.keySeq(key, mods(m), app)
  const combos = { '': 1, s: 2, a: 3, as: 4, c: 5, cs: 6, ca: 7, cas: 8 }
  check(Object.entries(combos).every(([m, n]) => keys.modifierParam(mods(m)) === n), 'modifier parameter = 1 + shift + 2*alt + 4*ctrl')
  // FR-46 AC: a custom Ctrl+Right key sends CSI 1 ; 5 C.
  const ctrlRight = { id: 'cust:a', label: 'C-R', mode: 'key', key: 'right', ctrl: true, alt: false, shift: false }
  check(keys.resolveSeq(keys.customKeyDef(ctrlRight), plain) === '\x1b[1;5C' && keys.resolveSeq(keys.customKeyDef(ctrlRight), app) === '\x1b[1;5C', 'Ctrl+Right sends \\x1b[1;5C, with or without DECCKM')
  check(seq('up', 's') === '\x1b[1;2A' && seq('left', 'a') === '\x1b[1;3D' && seq('down', 'cas') === '\x1b[1;8B', 'modified arrows use CSI 1 ; m A-D')
  check(seq('right') === '\x1b[C' && seq('right', '', true) === '\x1bOC', 'an unmodified arrow follows DECCKM like the built-ins')
  check(keys.resolveSeq(keys.customKeyDef({ ...ctrlRight, ctrl: false }), app) === '\x1bOC', 'a custom plain arrow reads DECCKM from the terminal at send time')
  check(seq('home') === '\x1b[H' && seq('end') === '\x1b[F' && seq('home', '', true) === '\x1bOH', 'Home/End are CSI H/F (SS3 under DECCKM)')
  check(seq('home', 'c') === '\x1b[1;5H' && seq('end', 's') === '\x1b[1;2F', 'modified Home/End use CSI 1 ; m H/F')
  check(seq('pageUp') === '\x1b[5~' && seq('pageDown', 's') === '\x1b[6;2~' && seq('delete', 'c') === '\x1b[3;5~' && seq('delete') === '\x1b[3~', 'PgUp/PgDn/Del use CSI n ; m ~')
  check(seq('f1') === '\x1bOP' && seq('f4') === '\x1bOS' && seq('f1', 's') === '\x1b[1;2P' && seq('f3', 'c') === '\x1b[1;5R', 'F1-F4: SS3 P-S, CSI 1 ; m P-S with a modifier')
  const fCodes = [15, 17, 18, 19, 20, 21, 23, 24]
  check(fCodes.every((c, i) => seq(`f${i + 5}`) === `\x1b[${c}~` && seq(`f${i + 5}`, 'c') === `\x1b[${c};5~`), 'F5-F12 use codes 15,17,18,19,20,21,23,24')
  check(seq('c', 'c') === '\x03' && seq('a', 'cs') === '\x01' && seq('z', 'c') === '\x1a', 'Ctrl+letter = charCode & 0x1f (Shift ignored)')
  check(seq('x', 'a') === '\x1bx' && seq('x', 'as') === '\x1bX' && seq('x') === 'x' && seq('x', 's') === 'X', 'Alt prefixes ESC; Shift capitalizes')
  check(seq('tab', 's') === '\x1b[Z' && seq('tab') === '\t' && seq('esc') === '\x1b' && seq('esc', 'a') === '\x1b\x1b', 'Shift+Tab is CSI Z; Tab and Esc')
  check(seq('enter', 'c') === null && seq('enter') === '\r' && seq('enter', 'a') === '\x1b\r', 'Ctrl+Enter is disabled; Enter and Alt+Enter work')
  check(seq('backspace') === '\x7f' && seq('backspace', 'c') === '\x08' && seq('space', 'c') === '\x00' && seq('space') === ' ', 'Bksp, Ctrl+Bksp, Space and Ctrl+Space')
  check(seq('5') === '5' && seq('2', 'c') === '\x00' && seq('1', 'c') === '1' && seq('nope') === null, 'digits, the legacy Ctrl+digit codes and unknown keys')
  check(keys.escapeSeq('\x1b[1;5C') === '\\x1b[1;5C' && keys.escapeSeq('ls\r') === 'ls\\r' && keys.escapeSeq('a\\b\t\x7f') === 'a\\\\b\\t\\x7f', 'the preview escapes control bytes')
  const text = (t, enter) => ({ id: 'cust:t', label: 'T', mode: 'text', text: t, enter })
  check(keys.customKeySeq(text('git status', true)) === 'git status\r' && keys.customKeySeq(text('ls', false)) === 'ls' && keys.customKeySeq(text('', false)) === null, 'Text keys send the literal plus an optional Enter')
  check(keys.customKeySeq(text('', true)) === '\r', 'an empty Text key with Enter still sends Enter')
  const tk = keys.customKeyDef(text('git status', true))
  check(keys.resolveSeq(tk, null) === 'git status' && tk.submit === true, 'a Text key with Enter sends its text, then a submit Enter frame (app 2.5.0)')
  check(!keys.customKeyDef(text('ls', false)).submit && keys.resolveSeq(keys.customKeyDef(text('', true)), null) === '\r' && !keys.customKeyDef(text('', true)).submit, 'without Enter, or with no text, no submit frame')
  // Validation.
  const ok = keys.parseCustomKey(ctrlRight)
  check(ok && ok.ctrl === true && ok.shift === false && keys.parseCustomKey({ ...ctrlRight, label: '  ab  ' }).label === 'ab', 'a valid key parses (label trimmed)')
  const bad = [
    { ...ctrlRight, id: 'user:x' }, { ...ctrlRight, id: 'cust:' }, { ...ctrlRight, label: '123456789' }, { ...ctrlRight, label: '   ' },
    { ...ctrlRight, key: 'f13' }, { ...ctrlRight, key: 'enter' }, { ...ctrlRight, mode: 'macro' }, text('x'.repeat(257), false), text('', false), null, 'x',
  ]
  check(bad.every(b => keys.parseCustomKey(b) === null), 'malformed keys, labels over 8, Ctrl+Enter, empty or oversized text are rejected')
  check(keys.parseCustomKey({ ...ctrlRight, label: '12345678' }) !== null && keys.MAX_CUSTOM_KEYS === 24 && keys.MAX_CUSTOM_LABEL === 8, 'an 8 character label is fine; caps are 24 keys and 8 characters')
  check(keys.suggestLabel(ctrlRight) === 'C-→' && keys.suggestLabel({ mode: 'key', key: 'c', ...mods('c') }) === '^C', 'suggested labels: C-→, ^C')
  check(keys.suggestLabel({ mode: 'key', key: 'x', ...none }) === 'x' && keys.suggestLabel({ mode: 'key', key: 'x', ...mods('s') }) === 'X' && keys.suggestLabel({ mode: 'key', key: 'f5', ...none }) === 'F5', 'suggested labels: x, X, F5')
  check(keys.suggestLabel(text('git  status', false)) === 'git stat', 'a Text key suggests its first 8 characters')
  const ids = new Set(); for (let i = 0; i < 50; i++) ids.add(keys.newCustomKeyId(ids))
  check(ids.size === 50 && [...ids].every(id => id.startsWith('cust:')), 'new custom ids are unique cust: ids')

  // Layout.
  const desk = [{ id: 'u1', label: 'F5', seq: '\x1b[15~' }]
  const def = keys.defaultLayout(desk)
  const builtIns = keys.BUILT_IN_IDS
  check(JSON.stringify(def.orderedIds) === JSON.stringify([...builtIns.slice(0, 15), 'desk:u1', ...builtIns.slice(15)]) && def.visibleIds.length === def.orderedIds.length, 'the default layout is the E1 order with desk: keys spliced in, all visible')
  check(JSON.stringify(keys.visibleKeyDefs(def, desk).map(k => k.id)) === JSON.stringify(keys.buildScrollKeys(desk).map(k => k.id)), 'the default layout renders exactly the E1 scroll zone')
  check(!def.orderedIds.includes('keyboard') && !def.orderedIds.includes('mode'), 'the keyboard toggle and the mode chip stay out of the layout')
  for (const raw of [null, undefined, 'x', 42, [], { version: 2, orderedIds: ['esc'] }, { orderedIds: ['esc'] }]) {
    check(JSON.stringify(keys.normalizeLayout(raw, desk)) === JSON.stringify(def), `normalizeLayout(${JSON.stringify(raw)}) falls back to the default`)
  }
  // FR-45 AC: hide Tab and move Esc to the end.
  let l = keys.setKeyVisible(def, 'tab', false)
  for (let i = 0; i < 40; i++) l = keys.moveKey(l, 'esc', 1)
  const shown = keys.visibleKeyDefs(l, desk).map(k => k.id)
  check(!shown.includes('tab') && shown.at(-1) === 'esc' && l.orderedIds.includes('tab'), 'Tab hidden (kept in the order) and Esc moved to the end')
  check(keys.moveKey(l, 'esc', 1) === l && keys.moveKey(l, l.orderedIds[0], -1) === l && keys.moveKey(l, 'nope', 1) === l, 'moving past either end or an unknown id is a no-op')
  check(JSON.stringify(keys.normalizeLayout(JSON.parse(JSON.stringify(l)), desk)) === JSON.stringify(l), 'a saved layout survives a JSON round trip through normalizeLayout')
  const reset = keys.resetLayout(l, desk)
  check(JSON.stringify(reset.orderedIds) === JSON.stringify(def.orderedIds) && reset.visibleIds.length === def.orderedIds.length, 'Reset returns to the default order, all visible')
  // A built-in added by a later release lands next to its canonical neighbour.
  const old = { version: 1, orderedIds: ['enter', ...def.orderedIds.filter(id => id !== 'enter' && id !== 'shiftTab')], visibleIds: def.orderedIds.filter(id => id !== 'shiftTab' && id !== 'enter'), custom: [] }
  const upgraded = keys.normalizeLayout(old, desk)
  check(upgraded.orderedIds[0] === 'enter' && upgraded.orderedIds[1] === 'shiftTab', 'a new built-in is inserted right after its canonical neighbour, wherever the user moved it')
  check(upgraded.visibleIds.includes('shiftTab') && !upgraded.visibleIds.includes('enter'), 'the new built-in comes in visible; the hidden neighbour stays hidden')
  const headless = keys.insertMissingBuiltInIds({ orderedIds: ['tab', 'ctrl'], visibleIds: ['tab'] }, ['esc', 'chip:^C', 'tab', 'ctrl'])
  check(JSON.stringify(headless.orderedIds) === JSON.stringify(['esc', 'chip:^C', 'tab', 'ctrl']) && JSON.stringify(headless.visibleIds) === JSON.stringify(['esc', 'chip:^C', 'tab']), 'ids with no earlier neighbour go before the next one, in canonical order')
  check(JSON.stringify(keys.insertMissingBuiltInIds({ orderedIds: [], visibleIds: [] }, ['a', 'b']).orderedIds) === JSON.stringify(['a', 'b']), 'into an empty order they are appended')
  // Desktop keys come and go; junk is dropped.
  const gone = keys.normalizeLayout({ ...l, orderedIds: ['nope', 'esc', 'esc', ...l.orderedIds], visibleIds: [...l.visibleIds, 'nope', 42] }, [])
  check(!gone.orderedIds.includes('desk:u1') && !gone.orderedIds.includes('nope') && gone.orderedIds.filter(id => id === 'esc').length === 1 && gone.orderedIds[0] === 'esc', 'a desk: key the desktop dropped, unknown ids and duplicates are discarded silently')
  const desk2 = [...desk, { id: 'u2', label: 'F6', seq: '\x1b[17~' }]
  const withU2 = keys.normalizeLayout(l, desk2)
  check(withU2.orderedIds.indexOf('desk:u2') === withU2.orderedIds.indexOf('desk:u1') + 1 && withU2.visibleIds.includes('desk:u2'), 'a new desktop key appears visible next to the previous desktop key')
  check(keys.layoutKeyDefs(withU2, desk2).find(k => k.id === 'desk:u2').seq === '\x1b[17~', 'desk: keys carry the desktop sequence')
  // Custom keys.
  let c = keys.upsertCustomKey(def, ctrlRight)
  check(c.orderedIds.at(-1) === 'cust:a' && c.visibleIds.at(-1) === 'cust:a' && c.custom.length === 1, 'a new custom key is appended, visible')
  c = keys.moveKey(c, 'cust:a', -1); c = keys.setKeyVisible(c, 'cust:a', false)
  const edited = keys.upsertCustomKey(c, { ...ctrlRight, label: 'Word>' })
  check(edited.custom[0].label === 'Word>' && edited.orderedIds.indexOf('cust:a') === c.orderedIds.indexOf('cust:a') && !edited.visibleIds.includes('cust:a'), 'editing keeps the place and the visibility')
  check(keys.upsertCustomKey(c, { ...ctrlRight, key: 'enter' }) === null, 'an invalid key is not saved')
  let full = def
  for (let i = 0; i < 24; i++) full = keys.upsertCustomKey(full, { ...ctrlRight, id: `cust:k${i}` })
  check(full.custom.length === 24 && keys.upsertCustomKey(full, { ...ctrlRight, id: 'cust:k99' }) === null, 'at most 24 custom keys')
  check(keys.normalizeLayout({ ...full, custom: [...full.custom, { ...ctrlRight, id: 'cust:k99' }, { id: 'cust:bad' }] }, desk).custom.length === 24, 'normalizeLayout caps custom keys at 24 and drops invalid ones')
  const resetC = keys.resetLayout(c, desk)
  check(resetC.orderedIds.at(-1) === 'cust:a' && resetC.visibleIds.includes('cust:a') && resetC.custom.length === 1, 'Reset keeps custom keys, at the end and visible')
  const removed = keys.removeCustomKey(c, 'cust:a')
  check(!removed.orderedIds.includes('cust:a') && removed.custom.length === 0, 'deleting a custom key removes it everywhere')
  const dropped = keys.normalizeLayout({ ...c, custom: [] }, desk)
  check(!dropped.orderedIds.includes('cust:a'), 'a cust: id without its definition is dropped')

  // Persistence in snagentsos.keybar (keyLayout.ts) with a fake localStorage.
  const backing = new Map()
  const localStorage = { getItem: k => (backing.has(k) ? backing.get(k) : null), setItem: (k, v) => backing.set(k, String(v)), removeItem: k => backing.delete(k), key: i => [...backing.keys()][i] ?? null, get length() { return backing.size } }
  const kl1 = load('src/mobile/src/lib/keyLayout.ts', { localStorage })
  check(kl1.KEYBAR_STORAGE_KEY === 'snagentsos.keybar' && kl1.keyLayoutStore.getState().stored === null, 'nothing stored reads as null (default layout)')
  kl1.keyLayoutStore.getState().save(l)
  const persisted = JSON.parse(backing.get('snagentsos.keybar'))
  check(persisted.version === 1 && Array.isArray(persisted.orderedIds) && Array.isArray(persisted.visibleIds) && Array.isArray(persisted.custom), 'the layout is stored as {version, orderedIds, visibleIds, custom}')
  const kl2 = load('src/mobile/src/lib/keyLayout.ts', { localStorage })
  const reloaded = keys.normalizeLayout(kl2.keyLayoutStore.getState().stored, desk)
  check(JSON.stringify(reloaded) === JSON.stringify(l) && !keys.visibleKeyDefs(reloaded, desk).some(k => k.id === 'tab'), 'after a reload Tab is still hidden and Esc still last')
  backing.set('snagentsos.keybar', '{not json')
  check(load('src/mobile/src/lib/keyLayout.ts', { localStorage }).loadStoredLayout() === null, 'corrupt JSON reads as the default')
  const blocked = { getItem() { throw new Error('blocked') }, setItem() { throw new Error('blocked') }, removeItem() {}, key: () => null, length: 0 }
  const kl3 = load('src/mobile/src/lib/keyLayout.ts', { localStorage: blocked })
  kl3.keyLayoutStore.getState().save(l)
  check(kl3.keyLayoutStore.getState().stored === l && kl3.saveStoredLayout(l) === false, 'blocked storage still applies the layout for the session')

  // i18n for the new screen and builder.
  const newKeys = ['keybar.title', 'keybar.entryHint', 'keybar.hint', 'keybar.moveUp', 'keybar.moveDown', 'keybar.show', 'keybar.edit', 'keybar.kindDesk', 'keybar.kindCustom', 'keybar.add', 'keybar.limit', 'keybar.reset', 'keybar.resetDone', 'custom.titleNew', 'custom.titleEdit', 'custom.label', 'custom.labelHint', 'custom.modeKey', 'custom.modeText', 'custom.text', 'custom.enter', 'custom.preview', 'custom.noSeq', 'custom.empty', 'custom.delete', ...keys.NAMED_KEYS.map(k => `custom.k.${k}`)]
  for (const lang of ['en', 'es']) { i18n.setLang(lang); check(newKeys.every(k => i18n.t(k) && i18n.t(k) !== k), `${lang} has every Key bar string`) }
  i18n.setLang('es')
  check(i18n.t('keybar.title') === 'Barra de teclas' && i18n.t('keybar.reset') === 'Restablecer' && i18n.t('keybar.moveUp', { key: 'Esc' }) === 'Subir Esc', 'Spanish Key bar strings')
  i18n.setLang('en')
}

console.log(`PASS: ${checks} mobile KeyBar logic checks`)
