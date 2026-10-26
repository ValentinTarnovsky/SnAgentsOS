// DeadlineTimer (app 2.7.0, A1.7): keyed deadlines behind one platform timer
// armed for the nearest one, nothing armed while idle, re-arm only when the
// nearest changes, deadline then key order, late wakes, re-entrant and
// throwing callbacks, the 2^31-1 ms clamp, dispose and past deadlines (always
// async). Fake setTimeout that keeps `ms` and a fake clock.
// Same esbuild + vm harness as test-status.cjs: no Electron, no user data.
const { buildSync } = require('esbuild')
const vm = require('node:vm')
const assert = require('node:assert/strict')
const path = require('node:path')
const root = path.resolve(__dirname, '..')
let checks = 0
function check(condition, label) { assert.ok(condition, label); checks++ }
// Values built inside the vm have another realm's prototypes; compare as JSON.
function same(actual, expected, label) { assert.deepEqual(JSON.parse(JSON.stringify(actual ?? null)), expected, label); checks++ }
function load(file, overrides = {}) {
  const code = buildSync({ entryPoints: [path.join(root, file)], bundle: true, platform: 'node', format: 'cjs', write: false, external: ['electron', 'ws'], alias: { '@shared': path.join(root, 'src/shared') } }).outputFiles[0].text
  const mod = { exports: {} }
  vm.runInNewContext(code, { module: mod, exports: mod.exports, require, console, process, Buffer, URL, setTimeout, clearTimeout, ...overrides })
  return mod.exports
}

const MAX_DELAY = 2 ** 31 - 1
const DAY = 24 * 60 * 60 * 1000
const T0 = 1_700_000_000_000

/** A fake platform: a clock and timers that keep their `ms` and the clock time they are due at. */
function fakePlatform() {
  const p = { clock: T0, seq: 0, timers: new Map(), armed: 0, cleared: 0 }
  p.now = () => p.clock
  p.setTimeout = (fn, ms) => { p.armed++; p.timers.set(++p.seq, { fn, ms, due: p.clock + ms }); return p.seq }
  p.clearTimeout = (id) => { if (p.timers.delete(id)) p.cleared++ }
  /** The only pending timer (fails when there is not exactly one). */
  p.only = (label) => { assert.equal(p.timers.size, 1, `${label}: exactly one pending timer (${p.timers.size})`); return [...p.timers.values()][0] }
  /** Fires whatever is pending right now, whatever the clock says (an early or late wake). */
  p.wake = () => { const due = [...p.timers]; for (const [id] of due) p.timers.delete(id); for (const [, t] of due) t.fn() }
  /** Moves the clock to `to` and runs every timer due by then, earliest first, as the platform would. */
  p.advanceTo = (to) => {
    p.clock = to
    for (let guard = 0; guard < 1000; guard++) {
      const next = [...p.timers].filter(([, t]) => t.due <= to).sort(([, a], [, b]) => a.due - b.due)[0]
      if (!next) return
      p.timers.delete(next[0])
      next[1].fn()
    }
    throw new Error('advanceTo: timers keep re-arming at the same time')
  }
  return p
}

async function main() {
  const warns = []
  const { DeadlineTimer } = load('src/main/DeadlineTimer.ts', { console: { ...console, warn: (...args) => warns.push(args.map(String).join(' ')) } })
  const make = (onDue = () => {}) => {
    const p = fakePlatform()
    const fired = []
    const timer = new DeadlineTimer((key, at) => { fired.push([key, at]); onDue(key, at, timer, p) }, { now: p.now, setTimeout: p.setTimeout, clearTimeout: p.clearTimeout })
    return { p, timer, fired }
  }

  // --- one timer for the nearest of several keys ---
  {
    const { p, timer, fired } = make()
    check(p.timers.size === 0 && timer.size === 0 && timer.next() === null, 'a new timer arms nothing')
    timer.set('a', T0 + 5000)
    check(p.only('one key').ms === 5000, 'one key arms one timer for its delay')
    timer.set('b', T0 + 1000)
    check(p.only('earlier key').ms === 1000 && p.armed === 2 && p.cleared === 1, 'an earlier key re-arms: the old timer is cleared, the new one is for the nearest')
    const id = [...p.timers.keys()][0]
    timer.set('c', T0 + 3000)
    check(p.armed === 2 && p.cleared === 1 && [...p.timers.keys()][0] === id, 'a later key does not touch the timer')
    timer.set('c', T0 + 4000)
    check(p.armed === 2 && p.cleared === 1, 'moving a key that is not the nearest does not re-arm either')
    timer.set('b', T0 + 1000)
    check(p.armed === 2, 'setting the nearest key to the same deadline does not re-arm')
    check(timer.size === 3 && timer.next() === T0 + 1000 && timer.has('b') && !timer.has('z'), 'size, next() and has() read the keys')
    check(timer.at('c') === T0 + 4000 && timer.at('z') === undefined, 'at() is the replaced deadline, undefined for an unknown key')
    timer.set('b', T0 + 4500)
    check(p.only('nearest moved later').ms === 4000 && p.armed === 3 && timer.next() === T0 + 4000, 'moving the nearest key later re-arms for the new nearest')
    timer.set('b', T0 + 1000)

    // --- clear ---
    timer.clear('z')
    check(p.armed === 4 && p.cleared === 3, 'clearing an unknown key does nothing')
    timer.clear('a')
    check(p.armed === 4 && p.cleared === 3 && timer.size === 2, 'clearing a key that is not the nearest does not re-arm')
    p.clock = T0 + 200
    timer.clear('b')
    check(p.only('clear nearest').ms === 3800 && p.cleared === 4 && !timer.has('b'), 'clearing the nearest re-arms to the next one, from the current clock')
    timer.clear('c')
    check(p.timers.size === 0 && p.cleared === 5 && timer.size === 0 && timer.next() === null, 'clearing every key leaves no timer at all')
    check(fired.length === 0, 'nothing fired along the way')
    timer.set('n', NaN)
    timer.set('i', Infinity)
    check(timer.size === 0 && p.timers.size === 0, 'a non-finite deadline is no deadline')
    timer.set('i', T0 + 1000)
    timer.set('i', Infinity)
    check(!timer.has('i') && p.timers.size === 0, 'and setting one on a known key clears it')
  }

  // --- keys sharing the nearest deadline ---
  {
    const { p, timer } = make()
    timer.set('a', T0 + 1000)
    timer.set('b', T0 + 1000)
    timer.set('c', T0 + 2000)
    timer.clear('a')
    check(p.armed === 1 && p.cleared === 0 && p.only('shared').ms === 1000, 'clearing one of two keys on the nearest deadline keeps the timer')
    timer.clear('b')
    check(p.armed === 2 && p.cleared === 1 && p.only('shared gone').ms === 2000, 'clearing the last of them re-arms for the next one')
  }

  // --- firing order and what stays ---
  {
    const { p, timer, fired } = make()
    timer.set('b', T0 + 100)
    timer.set('d', T0 + 200)
    timer.set('a', T0 + 100)
    timer.set('c', T0 + 50)
    p.advanceTo(T0 + 50)
    same(fired, [['c', T0 + 50]], 'only the due key fires, with its deadline')
    check(!timer.has('c') && p.only('after c').ms === 50, 'a fired key is gone and the timer re-arms for the next one')
    p.advanceTo(T0 + 100)
    same(fired.slice(1), [['a', T0 + 100], ['b', T0 + 100]], 'keys on the same deadline fire in key order')
    check(timer.size === 1 && p.only('after a, b').ms === 100, 'the later key stays armed')
    p.advanceTo(T0 + 200)
    check(fired.length === 4 && timer.size === 0 && p.timers.size === 0, 'after the last one nothing is armed')
  }

  // --- late wake and clock jumps ---
  {
    const { p, timer, fired } = make()
    timer.set('w3', T0 + 3000)
    timer.set('w1', T0 + 1000)
    timer.set('w4', T0 + 10_000)
    timer.set('w2', T0 + 2000)
    check(p.only('late').ms === 1000, 'armed for the nearest of four')
    p.clock = T0 + 5000
    p.wake()
    same(fired, [['w1', T0 + 1000], ['w2', T0 + 2000], ['w3', T0 + 3000]], 'a late wake fires every overdue key in one pass, in deadline order')
    check(timer.size === 1 && p.only('after late').ms === 5000, 'the one still ahead is re-armed from the late clock')
    p.clock = T0 - 60_000
    p.wake()
    check(fired.length === 3 && timer.has('w4') && p.only('clock back').ms === 70_000, 'a wake after the clock went back fires nothing and re-arms for the rest')
    p.clock = T0 + 9999
    p.wake()
    check(fired.length === 3 && p.only('early').ms === 1, 'a wake 1 ms early by the wall clock fires nothing and re-arms for what is left')
  }

  // --- re-entrancy from onDue ---
  {
    const seenInside = []
    const { p, timer, fired } = make((key, at, t) => {
      if (key !== 'r' || seenInside.length) return // only the first 'r' reschedules
      seenInside.push(t.has('r'))
      t.set('r', at + 1000)
      t.set('s', at - 5000)
      t.clear('t')
      t.set('u', at + 500)
    })
    timer.set('t', T0 + 100)
    timer.set('r', T0 + 50)
    timer.set('v', T0 + 100)
    p.advanceTo(T0 + 49)
    p.clock = T0 + 100
    p.wake()
    same(fired, [['r', T0 + 50], ['v', T0 + 100]], 'a key cleared by an earlier callback of the same pass does not fire, the others do')
    check(seenInside[0] === false, 'the firing key is removed before its callback runs')
    check(timer.at('r') === T0 + 1050 && timer.has('u') && timer.has('s') && !timer.has('t'), 'set and clear from inside onDue apply')
    check(p.only('re-entrant').ms === 0, 'a key set to the past from onDue waits for the next tick, behind one timer')
    p.wake()
    same(fired.slice(2), [['s', T0 - 4950]], 'and fires there')
    check(p.only('after s').ms === 450, 'then the timer is back on the nearest real deadline')
    p.advanceTo(T0 + 2000)
    same(fired.slice(3).map(([k]) => k), ['u', 'r'], 'the rescheduled key fires at its new deadline')
    check(timer.size === 0 && p.timers.size === 0, 'and the timer rests')
  }

  // --- a throwing onDue ---
  {
    warns.length = 0
    const { p, timer, fired } = make((key) => { if (key === 'boom') throw new Error('kaput') })
    timer.set('a', T0 + 10)
    timer.set('boom', T0 + 10)
    timer.set('c', T0 + 10)
    timer.set('later', T0 + 99)
    p.advanceTo(T0 + 10)
    same(fired.map(([k]) => k), ['a', 'boom', 'c'], 'a throwing callback does not stop the rest of the pass')
    check(warns.length === 1 && warns[0].includes('kaput') && warns[0].includes('boom'), 'the failure is logged with console.warn')
    check(!timer.has('boom') && p.only('after boom').ms === 89, 'the failed key is gone and the timer re-arms as usual')
    timer.set('a', T0 + 20)
    check(p.only('usable').ms === 10, 'the timer still works after a throw')
  }

  // --- the 2^31-1 ms clamp ---
  {
    const { p, timer, fired } = make()
    const far = T0 + 40 * DAY
    timer.set('far', far)
    check(p.only('far').ms === MAX_DELAY, 'a deadline beyond the platform limit arms a clamped delay')
    p.advanceTo(T0 + MAX_DELAY)
    check(fired.length === 0 && timer.has('far'), 'the clamped wake fires nothing')
    check(p.only('after clamp').ms === far - (T0 + MAX_DELAY), 'and simply re-arms for what is left')
    p.advanceTo(far)
    same(fired, [['far', far]], 'the far key fires at its deadline')
    check(p.timers.size === 0, 'nothing armed afterwards')
    timer.set('very-far', T0 + 200 * DAY)
    p.advanceTo(T0 + 100 * DAY)
    check(fired.length === 1 && p.only('very far').ms === MAX_DELAY, 'several clamped wakes in a row keep one timer each time')
  }

  // --- dispose ---
  {
    const { p, timer, fired } = make()
    timer.set('a', T0 + 10)
    timer.set('b', T0 + 20)
    timer.dispose()
    check(timer.size === 0 && timer.next() === null && p.timers.size === 0 && p.cleared === 1, 'dispose drops every key and clears the pending timer')
    timer.set('c', T0 + 5)
    check(timer.size === 0 && p.timers.size === 0, 'a set after dispose is ignored')
    p.advanceTo(T0 + 100)
    check(fired.length === 0, 'nothing fires after dispose')
    const inner = make((key, _at, t) => { if (key === 'x') t.dispose() })
    inner.timer.set('x', T0 + 10)
    inner.timer.set('y', T0 + 10)
    inner.timer.set('z', T0 + 50)
    inner.p.advanceTo(T0 + 10)
    same(inner.fired.map(([k]) => k), ['x'], 'a dispose from inside onDue stops the rest of the pass')
    check(inner.timer.size === 0 && inner.p.timers.size === 0, 'and leaves nothing armed')
  }

  // --- a deadline in the past is async ---
  {
    const { p, timer, fired } = make()
    timer.set('past', T0 - 5000)
    check(fired.length === 0, 'set() never calls onDue synchronously, even for a past deadline')
    check(p.only('past').ms === 0, 'a past deadline arms a 0 ms timer')
    timer.set('now', T0)
    check(p.armed === 1 && p.only('past+now').ms === 0, 'another due key behind it shares the same timer')
    p.wake()
    same(fired, [['past', T0 - 5000], ['now', T0]], 'both fire on the next tick, the older first')
  }

  // --- defaults: the real clock and timers of the realm ---
  {
    const p = fakePlatform()
    const vmTimers = load('src/main/DeadlineTimer.ts', { setTimeout: p.setTimeout, clearTimeout: p.clearTimeout, Date: class extends Date { static now() { return p.clock } } })
    const fired = []
    const timer = new vmTimers.DeadlineTimer((key) => fired.push(key))
    timer.set('d', T0 + 750)
    check(p.only('defaults').ms === 750, 'without opts it uses Date.now() and the global setTimeout')
    timer.clear('d')
    check(p.timers.size === 0 && p.cleared === 1, 'and the global clearTimeout')
    timer.set('e', T0 + 1)
    p.advanceTo(T0 + 1)
    same(fired, ['e'], 'and fires through them')
  }

  console.log(`PASS: ${checks} deadline checks (one timer, re-arm, clear, order, late wake, re-entrancy, throw, clamp, dispose, async past)`)
}

main().catch((error) => { console.error(error); process.exitCode = 1 })
