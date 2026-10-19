// Answer cards on the phone (R22-15, E2-FR-17..25) rendered with the
// production mobile CSS in an isolated offscreen window at 360 px: the real
// LiveShell with a stubbed WS client (no socket). Home rows with Allow / Deny
// that answer without opening the terminal and [Answer] that opens the wizard
// at step 1; the permission card (3 line summary that expands, "1" / Esc with
// no Enter, the "always allow" hint), folding to a strip, the generic card
// and the generic strip (plan, Codex, promptCards off), the wizard (auto
// advance, multi select, Send, abort once the pane stops asking), "Answer in
// the terminal" for invalid asks and for more than 24 groups, the dropped
// socket, "Already answered", the Settings switch and Spanish. R31-03
// (E2-FR-53, 54): with Claude's menu written into the phone's xterm, "Always
// allow" sends "2" with no Enter and the Plan card sends the option digit,
// only for the layouts the phone validates; another layout falls back to the
// hint / the generic strip, and a menu that changes before the tap sends
// nothing.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path')
const { pathToFileURL } = require('node:url')
const { spawnSync } = require('node:child_process')
const root = path.resolve(__dirname, '..')
const menus = require('./fixtures/claude-menus.cjs')
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snagentsos-mobile-prompts-ui-'))
const assets = path.join(root, 'out/mobile/assets')
const mobileCss = fs.existsSync(assets) && fs.readdirSync(assets).find(name => /^index-.*\.css$/.test(name))
if (!mobileCss) throw new Error('Run npm run build:mobile first')
require('esbuild').buildSync({ stdin: { resolveDir: root, loader: 'tsx', contents: `
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { LiveShell } from './src/mobile/src/components/LiveShell';
import { store } from './src/mobile/src/lib/store';
import { client } from './src/mobile/src/lib/client';
import { usePromptUi } from './src/mobile/src/lib/answer';
import { answerCard } from './src/mobile/src/lib/answerLive';
import { setLang } from './src/mobile/src/lib/i18n';
import { getActiveTerm } from './src/mobile/src/lib/terminalBus';
const MENUS = ${JSON.stringify(menus)};
const wait = ms => new Promise(r => setTimeout(r, ms));
const frames = () => wait(40);
let checks = 0; const check = (ok, label) => { if (!ok) throw new Error(label); checks++ };
const noOverflow = () => document.documentElement.scrollWidth <= window.innerWidth;
const $ = sel => document.querySelector(sel);
const $$ = sel => [...document.querySelectorAll(sel)];
const click = el => el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 }));
const setValue = (el, value) => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(el, value); el.dispatchEvent(new Event('input', { bubbles: true })) };
const inputs = [];
let open = true;
client.isOpen = () => open;
client.sendInputTo = (paneId, data) => { if (!open) return false; inputs.push({ paneId, data }); return true };
client.sendInput = () => true;
client.sendCtl = async () => ({ ok: true });
const now = Date.now();
const opts = n => Array.from({ length: n }, (_, i) => ({ label: 'Opcion ' + (i + 1), ...(i === 0 ? { description: 'La primera' } : {}) }));
const single = (n = 3) => ({ question: 'Que framework?', header: 'Framework', multiSelect: false, options: opts(n) });
const multi = (n = 4, header = 'Extras') => ({ question: 'Que extras?', header, multiSelect: true, options: opts(n) });
const perm = (id, toolName, summary) => ({ id, kind: 'permission', ...(toolName ? { toolName } : {}), summary: summary ?? '' });
const ask = (id, questions) => ({ id, kind: 'question', summary: questions[0].question, questions });
const plan = (id, summary) => ({ id, kind: 'plan', toolName: 'ExitPlanMode', summary: summary ?? '' });
const st = (pending, extra = {}) => ({ state: 'action', provider: 'claude', reason: pending[0] ? pending[0].kind : 'permission', pendingCount: pending.length, stateSince: now, pending, ...extra });
const long = 'npm run build && ' + 'echo una linea bastante larga que no entra '.repeat(5);
const statuses = {
 a: st([perm('pa', 'Bash', 'npm test')]),
 b: st([ask('qb', [single(), multi()])], { reason: 'question' }),
 c: { state: 'action', provider: 'codex', reason: 'permission', pendingCount: 1, stateSince: now },
 d: st([ask('qd', [single(9)])], { reason: 'question' }),
 e: st([perm('pe', 'Edit', long.slice(0, 200))]),
 f: st([{ id: 'pl', kind: 'plan', toolName: 'ExitPlanMode', summary: '' }, perm('fallback:permission', undefined, '')], { reason: 'plan' }),
 g: st([perm('fallback:permission', undefined, '')]),
 h: st([ask('qh', [multi(8, 'Uno'), multi(8, 'Dos'), multi(8, 'Tres')])], { reason: 'question' }),
 j: st([ask('qj', [multi(3), multi(3, 'Mas')])], { reason: 'question' }),
 k: st([perm('pk', 'Bash', 'Bash: npm test')]),
 l: st([plan('pl', 'Add the parser and wire it')], { reason: 'plan' }),
};
const pane = (id, title, type) => ({ id, title, type, color: '', icon: '', running: true });
const ids = Object.keys(statuses);
const snapshot = { language: 'en', themeTokens: {}, fontFamily: 'mono', fontSize: 13, activeWorkspaceId: 'w1', hostName: 'PC', keyButtons: [], mountedWorkspaceIds: ['w1'],
 workspaces: [{ id: 'w1', name: 'Front', layoutOrder: ids, panes: ids.map(id => pane(id, 'Consola ' + id, id === 'c' ? 'codex' : 'claude')) }] };
const setStatus = (id, s) => { const next = { ...store.getState().paneStatus }; if (s) next[id] = s; else delete next[id]; flushSync(() => store.getState().update({ paneStatus: next })) };
const row = id => $('[data-pane="' + id + '"]');
const openPane = async id => { flushSync(() => client.requestOpen(id)); await frames() };
const card = () => $('[data-terminal-layer] [data-prompt-card]');
const strip = () => $('[data-terminal-layer] [data-prompt-strip]');
const phase = () => $('[data-terminal-layer] [data-answer-phase]');
// Claude's menu on the phone's screen (E2-FR-53, 54); resolves once parsed.
const screen = rows => new Promise(res => { const term = getActiveTerm(); term.resize(80, 30); term.write('\\x1bc' + rows.join('\\r\\n'), res) });
const polled = () => wait(450);
window.runMain = async () => {
 try { localStorage.clear() } catch {}
 setLang('en');
 store.getState().update({ phase: 'live', snapshot, paneStatus: { ...statuses }, connected: true, appVersion: '2.0.0', screen: 'home', activePaneId: null, subscribedPaneId: null, lastPane: null, lastViewedAt: {}, homeCollapsed: [], promptCards: true });
 const host = document.getElementById('root'); const r = createRoot(host);
 flushSync(() => r.render(<LiveShell />)); await frames();

 // --- Home rows (E2-FR-23) ---
 const ra = row('a').querySelector('[data-row-prompt="permission"]');
 check(ra && ra.querySelector('[data-row-prompt-text]').textContent === 'Allow Bash: npm test', 'a permission row adds "Allow Bash: npm test"');
 const allow = ra.querySelector('[data-row-allow]'), deny = ra.querySelector('[data-row-deny]');
 check(Math.round(allow.getBoundingClientRect().height) === 36 && Math.round(deny.getBoundingClientRect().height) === 36, 'row Allow / Deny are 36 px tall');
 check(row('b').querySelector('[data-row-prompt="question"] [data-row-answer-open]') && row('b').textContent.includes('Question: Que framework?'), 'a question row offers [Answer]');
 check(!row('c').querySelector('[data-row-prompt]'), 'Codex rows get no inline buttons');
 check(row('f').querySelector('[data-row-prompt="plan"] [data-row-answer-open]')?.textContent === 'Review' && row('f').querySelector('[data-row-prompt-text]').textContent === 'Plan to approve', 'a plan row offers [Review], never Allow / Deny');
 check(row('l').querySelector('[data-row-prompt-text]').textContent === 'Plan: Add the parser and wire it' && !row('l').querySelector('[data-row-allow]'), 'a plan row shows the first line of the plan');
 check(noOverflow(), 'Home with request lines fits 360 px');
 click(allow); await frames();
 check(inputs.length === 1 && inputs[0].paneId === 'a' && inputs[0].data === '1', 'row Allow writes "1" to that pane');
 check(store.getState().screen === 'home', 'row Allow never opens the terminal');
 check(row('a').querySelector('[data-row-answer="sending"]')?.textContent === 'Sending answer...', 'the row shows "Sending answer..."');
 setStatus('a', st([], { pendingCount: 1, reason: 'permission' }));
 await frames();
 check(row('a').querySelector('[data-row-answer]'), 'the answer state stays while the invalidated request leaves pending[]');

 // [Answer] opens the terminal with the wizard at step 1.
 click(row('b').querySelector('[data-row-answer-open]')); await frames();
 check(store.getState().screen === 'terminal' && store.getState().activePaneId === 'b', '[Answer] opens that console');
 check(card()?.dataset.promptCard === 'question' && card().dataset.step === '0', 'the wizard is open at step 1');
 check(card().querySelector('[data-prompt-title]').textContent === 'Claude asks you 2 questions' && $$('[data-terminal-layer] [data-ask-tab]').length === 2, 'two questions: title and tabs');
 check(card().textContent.includes('La primera'), 'option descriptions show');
 click(card().querySelector('[data-ask-option="1"]')); await frames();
 check(card().querySelector('[data-ask-option="1"]').getAttribute('aria-checked') === 'true' && card().dataset.step === '0', 'a single select tap marks the option');
 await wait(260);
 check(card().dataset.step === '1', 'and moves to the next question after 200 ms');
 check(card().querySelector('[data-ask-send]') && !card().querySelector('[data-ask-send]').disabled, 'with one question answered Send is ready (the other tab is skipped)');
 click(card().querySelector('[data-ask-option="0"]')); click(card().querySelector('[data-ask-option="2"]')); await frames();
 check(card().dataset.step === '1' && card().querySelectorAll('[aria-checked="true"]').length === 2, 'multi select checks without moving on');
 check(card().querySelector('[data-ask-tab="0"] svg'), 'an answered tab shows its check');
 check(noOverflow(), 'the wizard fits 360 px');
 inputs.length = 0;
 click(card().querySelector('[data-ask-send]')); await frames();
 check(inputs.length === 1 && inputs[0].paneId === 'b' && inputs[0].data === '2', 'Send writes the first group at once');
 check(phase()?.dataset.answerPhase === 'sending' && phase().textContent.includes('Sending answer...'), '"Sending answer..." replaces the card');
 setStatus('b', st([], { reason: 'question', pendingCount: 1 }));
 await wait(1100);
 check(inputs.length === 2 && inputs[1].data === '1', 'one group per second while the pane still asks');
 setStatus('b', { state: 'working', provider: 'claude', stateSince: now });
 await wait(1100);
 check(inputs.length === 2, 'once the pane leaves action the rest is dropped');

 // --- permission card (E2-FR-19, 22) ---
 await openPane('e');
 check(card()?.dataset.promptCard === 'permission' && card().querySelector('[data-prompt-title]').textContent === 'Claude wants to use Edit', 'permission card title');
 const sumBtn = card().querySelector('[data-prompt-summary]'), sum = sumBtn.querySelector('[data-prompt-summary-text]');
 const lh = parseFloat(getComputedStyle(sum).lineHeight);
 check(sum.scrollHeight > sum.clientHeight && Math.round(sum.clientHeight / lh) === 3, 'a 200 character summary shows 3 lines');
 click(sumBtn); await frames();
 check(sumBtn.dataset.expanded === 'true' && sum.scrollHeight <= sum.clientHeight + 1 && Math.round(sum.clientHeight / lh) > 3, 'a tap expands it');
 check(card().textContent.includes("For 'always allow' use the terminal"), 'the always allow hint');
 check(noOverflow() && card().getBoundingClientRect().right <= 360, 'the card fits 360 px');
 click(card().querySelector('[data-prompt-fold]')); await frames();
 check(!card() && strip()?.dataset.promptStrip === 'folded' && strip().textContent === 'Claude asks for permission: Edit - tap to answer', 'the chevron folds it to a strip');
 click(strip()); await frames();
 check(card()?.dataset.promptCard === 'permission', 'tapping the strip unfolds it');
 inputs.length = 0;
 click(card().querySelector('[data-prompt-deny]')); await frames();
 check(inputs.length === 1 && inputs[0].data === '\\x1b' && inputs[0].paneId === 'e', 'Deny writes Esc, nothing else');
 check(!inputs.some(i => i.data.includes('\\r')), 'no Enter after a permission answer');

 // --- generic card and strips (E2-FR-18, 25) ---
 await openPane('g');
 check(card()?.dataset.promptCard === 'permission' && card().querySelector('[data-prompt-title]').textContent === 'Claude asks for a permission' && !card().querySelector('[data-prompt-summary]'), 'a permission without tool gets the generic card');
 await openPane('f');
 check(!card() && strip()?.dataset.promptStrip === 'waiting' && strip().textContent === 'Claude is waiting for your answer - open terminal', 'a plan with no menu on screen shows only the waiting strip');
 await openPane('c');
 check(!card() && strip()?.textContent === 'Codex is waiting for your answer - open terminal', 'a Codex pane in action shows the strip');
 await openPane('d');
 check(card()?.dataset.promptCard === 'terminal' && card().textContent.includes('Answer in the terminal'), 'a question with 9 options says "Answer in the terminal"');

 // More than 24 groups: the wizard turns into "Answer in the terminal" before sending.
 await openPane('h');
 for (let step = 0; step < 3; step++) {
  for (let k = 0; k < 8; k++) click(card().querySelector('[data-ask-option="' + k + '"]'));
  await frames();
  if (step < 2) { if (!card().querySelector('[data-ask-next]')) break; click(card().querySelector('[data-ask-next]')); await frames() }
 }
 check(card().querySelector('[data-ask-terminal]') && !card().querySelector('[data-ask-send]'), 'more than 24 groups: "Answer in the terminal" instead of Send');

 // Other: its text field, capped at 2000.
 await openPane('j');
 click(card().querySelector('[data-ask-other]')); await frames();
 const other = card().querySelector('[data-ask-other-input]');
 check(other && other.maxLength === 2000, 'Other opens a text field of up to 2000 characters');
 setValue(other, 'algo propio'); await frames();
 click(card().querySelector('[data-ask-next]')); await frames();
 click(card().querySelector('[data-ask-option="1"]')); await frames();
 inputs.length = 0;
 click(card().querySelector('[data-ask-send]')); await frames();
 check(inputs[0]?.data === '4', 'Other of a 3 option question writes "4" first');
 // The socket drops mid sequence.
 flushSync(() => store.getState().update({ connected: false })); open = false; await frames();
 check(phase()?.dataset.answerPhase === 'disconnected' && phase().textContent.includes('The connection dropped, check the terminal'), 'a dropped socket aborts with "The connection dropped"');
 await wait(1100);
 check(inputs.length === 1, 'nothing more is written after the drop');
 click(phase().querySelector('[data-answer-dismiss]')); await frames();
 check(!phase(), 'dismiss clears it');
 open = true; flushSync(() => store.getState().update({ connected: true }));

 // "Already answered".
 answerCard('g', 'gone', { kind: 'allow' }); await frames();
 check(store.getState().toasts.some(t => t.text === 'Already answered'), 'a request no longer in paneStatus shows "Already answered"');

 // promptCards off: only the strip, and the Settings switch.
 setStatus('e', st([perm('pe2', 'Edit', 'x')])); usePromptUi.getState().setAnswer('e', { pendingId: 'pe', kind: 'permission', phase: 'sent', groups: 1 });
 await openPane('e');
 check(card()?.dataset.pending === 'pe2', 'a new request starts unfolded, even while the previous answer reads "Sent"');
 usePromptUi.getState().setAnswer('e', null); await frames();
 flushSync(() => store.getState().setPromptCards(false)); await frames();
 check(!card() && strip()?.dataset.promptStrip === 'waiting', 'promptCards off: a Claude permission shows the strip, not the card');
 check(!row('e').querySelector('[data-row-prompt]'), 'and no row buttons');
 flushSync(() => store.getState().setScreen('settings')); await frames();
 const sw = $('[data-pref="promptCards"]');
 check(sw && sw.getAttribute('aria-checked') === 'false' && sw.textContent.includes('Answer cards'), 'Settings has the Answer cards switch');
 click(sw); await frames();
 check(store.getState().promptCards === true && localStorage.getItem('snagentsos.promptCards') === null, 'the switch turns it back on (default removes the key)');
 flushSync(() => store.getState().setScreen('terminal')); await frames();

 // --- "Always allow" (E2-FR-53) ---
 await openPane('k');
 check(card()?.dataset.promptCard === 'permission' && !card().querySelector('[data-prompt-always]') && card().querySelector('[data-prompt-always-hint]'), 'no menu on screen: the hint, no "Always allow"');
 await screen(MENUS.changedPermission); await polled();
 check(!card().querySelector('[data-prompt-always]') && card().querySelector('[data-prompt-always-hint]'), 'a permission layout the phone does not know keeps the hint');
 await screen(MENUS.twoOptionPermission); await polled();
 check(!card().querySelector('[data-prompt-always]'), 'a two option menu (2 = No) gets no "Always allow"');
 await screen(MENUS.bashPermission); await polled();
 const alwaysBtn = card().querySelector('[data-prompt-always]');
 check(alwaysBtn && alwaysBtn.textContent.includes('Always allow') && !card().querySelector('[data-prompt-always-hint]'), 'the validated Bash menu shows "Always allow" instead of the hint');
 check(alwaysBtn.querySelector('[data-prompt-always-scope]').textContent.startsWith("Yes, and don't ask again for npm test commands in"), 'the button repeats the scope text of Claude');
 check(alwaysBtn.getBoundingClientRect().height >= 44 && noOverflow() && card().getBoundingClientRect().right <= 360, '"Always allow" is a 44 px target and the card fits 360 px');
 // The menu changes between the last read and the tap: nothing is sent.
 inputs.length = 0;
 await screen(MENUS.changedPermission); click(alwaysBtn); await frames();
 check(inputs.length === 0 && store.getState().toasts.some(t => t.text === 'The menu changed, check the terminal'), 'a menu that changed before the tap sends nothing and says so');
 await screen(MENUS.editPermission); await polled();
 check(card().querySelector('[data-prompt-always-scope]')?.textContent === 'Yes, allow all edits during this session', 'the boxed Edit menu validates too');
 click(card().querySelector('[data-prompt-always]')); await frames();
 check(inputs.length === 1 && inputs[0].paneId === 'k' && inputs[0].data === '2', '"Always allow" writes "2" to the pane');
 check(!inputs.some(i => i.data.includes('\\r')) && phase()?.dataset.answerPhase === 'sending', 'no Enter, and "Sending answer..." replaces the card');

 // --- Plan card (E2-FR-54) ---
 await openPane('l');
 await screen([]); await polled();
 check(!card() && strip()?.dataset.promptStrip === 'waiting', 'a plan before Claude draws its menu: the generic strip');
 await screen(MENUS.changedPlan); await polled();
 check(!card() && strip()?.dataset.promptStrip === 'waiting', 'a plan layout of another Claude version falls back to the strip');
 await screen(MENUS.plan); await polled();
 check(card()?.dataset.promptCard === 'plan' && card().dataset.pending === 'pl' && card().querySelector('[data-prompt-title]').textContent === 'Claude has a plan ready', 'the validated plan menu shows the Plan card');
 check(card().querySelector('[data-prompt-summary-text]').textContent === 'Add the parser and wire it' && card().textContent.includes('The full plan is in the terminal'), 'the card shows the first line of the plan and points to the terminal');
 const planBtns = $$('[data-terminal-layer] [data-plan-option]');
 check(planBtns.map(b => b.textContent).join('|') === 'Yes, and auto-accept edits|Yes, and approve each edit|No, keep planning', 'one button per menu option, known labels translated');
 check(planBtns[0].className.includes('bg-accent-violet') && !planBtns[1].className.includes('bg-accent-violet') && planBtns[2].dataset.planClass === 'reject', 'the first approval is the primary');
 check(noOverflow() && card().getBoundingClientRect().right <= 360, 'the Plan card fits 360 px');
 click(card().querySelector('[data-prompt-fold]')); await frames();
 check(!card() && strip()?.dataset.promptStrip === 'folded' && strip().textContent === 'Claude has a plan to approve - tap to answer', 'the Plan card folds to a strip');
 click(strip()); await frames();
 inputs.length = 0;
 await screen(MENUS.changedPlan); click(card().querySelector('[data-plan-option="3"]')); await frames();
 check(inputs.length === 0 && store.getState().toasts.filter(t => t.text === 'The menu changed, check the terminal').length >= 1, 'a plan menu that changed before the tap sends nothing');
 await screen(MENUS.planWithFeedback); await polled();
 const fbBtn = card()?.querySelector('[data-plan-feedback]');
 check(fbBtn && fbBtn.textContent === 'Tell Claude what to change' && $$('[data-terminal-layer] [data-plan-option]').length === 3, 'the free text row becomes "Tell Claude what to change"');
 check($('[data-terminal-layer] [data-plan-option="1"]').textContent === 'Yes, clear the context and auto-accept edits', 'the later layout labels are translated too');
 if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
 click(fbBtn); await frames();
 check(inputs.length === 1 && inputs[0].paneId === 'l' && inputs[0].data === '4', '"Tell Claude what to change" writes its digit, so an Enter from the composer never picks the first approval');
 check(phase()?.dataset.answerPhase === 'sending' && document.activeElement?.tagName === 'TEXTAREA', 'and brings the keyboard up for the feedback in the same tap');
 await wait(1100);
 setStatus('l', st([plan('pl3', 'Add the parser and wire it')], { reason: 'plan' })); await polled();
 check(card()?.dataset.pending === 'pl3', 'the next plan request shows its card again');
 inputs.length = 0;
 click($('[data-terminal-layer] [data-plan-option="3"]')); await frames();
 check(inputs.length === 1 && inputs[0].paneId === 'l' && inputs[0].data === '3', 'a plan option writes its digit');
 check(!inputs.some(i => i.data.includes('\\r')) && phase()?.dataset.answerPhase === 'sending', 'no Enter after a plan answer, and "Sending answer..."');
 setStatus('l', st([], { reason: 'plan', pendingCount: 1 })); await wait(1100);
 check(phase()?.dataset.answerPhase === 'sent' && inputs.length === 1, '"Sent" once the request leaves pending[], nothing more written');

 // Spanish.
 await openPane('e'); await screen([]); await polled();
 setLang('es'); setStatus('e', st([perm('pe3', 'Edit', 'x')])); await frames();
 check(card()?.querySelector('[data-prompt-title]').textContent === 'Claude quiere usar Edit' && card().textContent.includes('Permitir') && card().textContent.includes('Denegar') && card().textContent.includes("Para 'permitir siempre' usá la terminal"), 'the card is translated');
 await screen(MENUS.bashPermission); await polled();
 check(card()?.querySelector('[data-prompt-always]')?.textContent.includes('Permitir siempre'), '"Permitir siempre" in Spanish');
 setStatus('l', st([plan('pl2', 'Plan')], { reason: 'plan' })); await openPane('l'); await screen(MENUS.plan); await polled();
 check(card()?.dataset.promptCard === 'plan' && card().querySelector('[data-prompt-title]').textContent === 'Claude tiene un plan listo' && $$('[data-terminal-layer] [data-plan-option]').map(b => b.textContent).join('|') === 'Sí, y aceptar las ediciones solas|Sí, y aprobar cada edición|No, seguir planificando', 'the Plan card in Spanish');
 r.unmount();
 return checks;
};
` }, bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic', define: { __APP_VERSION__: '"2.0.0"', 'process.env.NODE_ENV': '"production"' }, alias: { '@shared': path.join(root, 'src/shared') }, loader: { '.css': 'empty' }, outfile: path.join(dir, 'renderer.js') })
fs.writeFileSync(path.join(dir, 'index.html'), `<html><head><meta charset="utf-8"><link rel="stylesheet" href="${pathToFileURL(path.join(assets, mobileCss))}"></head><body style="margin:0"><div id="root"></div><script src="renderer.js"></script></body></html>`)
fs.writeFileSync(path.join(dir, 'main.cjs'), `
const {app,BrowserWindow}=require('electron');const path=require('path');
app.setPath('userData',path.join(__dirname,'profile'));
app.whenReady().then(async()=>{
 const w=new BrowserWindow({show:false,width:360,height:640,useContentSize:true,webPreferences:{sandbox:true,backgroundThrottling:false,offscreen:true}});
 await w.loadFile(path.join(__dirname,'index.html'));
 const checks=await w.webContents.executeJavaScript('window.runMain()');
 console.log('PASS: '+checks+' mobile answer card UI checks');w.destroy();app.quit();
}).catch(e=>{console.error(e);app.exit(1)});
`)
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
const flags = process.platform === 'linux' && process.env.CI ? ['--no-sandbox'] : []
const result = spawnSync(require('electron'), [...flags, path.join(dir, 'main.cjs')], { env, windowsHide: true, encoding: 'utf8', timeout: 90000 })
process.stdout.write(result.stdout ?? '')
process.stderr.write((result.stderr ?? '') + (result.error ? result.error.message : ''))
fs.rmSync(dir, { recursive: true, force: true })
if (result.status !== 0 || !/^PASS:/m.test(result.stdout ?? '')) process.exit(1)
