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
const expectedOrder = ['key.esc', '^C', 'key.tab', 'key.ctrl', 'left', 'up', 'down', 'right', 'backspace', 'key.del', 'key.enter', 'key.shiftTab', 'key.ctrlEnter', '^L', '^R', 'F5', 'paste', 'snippets', '^D', '^Z']
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

console.log(`PASS: ${checks} mobile KeyBar logic checks`)
