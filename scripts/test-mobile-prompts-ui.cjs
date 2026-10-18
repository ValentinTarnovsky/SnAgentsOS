// Answer cards on the phone (R22-15, E2-FR-17..25) rendered with the
// production mobile CSS in an isolated offscreen window at 360 px: the real
// LiveShell with a stubbed WS client (no socket). Home rows with Allow / Deny
// that answer without opening the terminal and [Answer] that opens the wizard
// at step 1; the permission card (3 line summary that expands, "1" / Esc with
// no Enter, the "always allow" hint), folding to a strip, the generic card
// and the generic strip (plan, Codex, promptCards off), the wizard (auto
// advance, multi select, Send, abort once the pane stops asking), "Answer in
// the terminal" for invalid asks and for more than 24 groups, the dropped
// socket, "Already answered", the Settings switch and Spanish.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path')
const { pathToFileURL } = require('node:url')
const { spawnSync } = require('node:child_process')
const root = path.resolve(__dirname, '..')
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
 check(!row('c').querySelector('[data-row-prompt]') && !row('f').querySelector('[data-row-prompt]'), 'Codex and plan rows get no inline buttons');
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
 check(!card() && strip()?.dataset.promptStrip === 'waiting' && strip().textContent === 'Claude is waiting for your answer - open terminal', 'a plan with a generic permission shows only the waiting strip');
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

 // Spanish.
 setLang('es'); setStatus('e', st([perm('pe3', 'Edit', 'x')])); await frames();
 check(card()?.querySelector('[data-prompt-title]').textContent === 'Claude quiere usar Edit' && card().textContent.includes('Permitir') && card().textContent.includes('Denegar') && card().textContent.includes("Para 'permitir siempre' usá la terminal"), 'the card is translated');
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
