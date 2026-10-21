// Render the phone's Home (E2-FR-01..16, 47, 49..51; R22-14) with the
// production CSS in an isolated offscreen browser at phone width: the real
// LiveShell with a stubbed control plane (no socket). Header with the PC name,
// row order and unread, the collapse persisted in snagentsos.home.collapsed
// with the action badge, the "On the PC" and git chips, phone-only navigation
// (the terminal slides over Home, its header and tabs follow the viewed
// workspace, back returns), the Resume card, the mount confirmation, the FAB
// picker with promptFallback (draft + composer + toast), per-pane actions on
// the row's own workspace, the workspace kebab, empty states, inline usage,
// Settings with the versions, the Welcome steps and Spanish.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path')
const { pathToFileURL } = require('node:url')
const { spawnSync } = require('node:child_process')
const root = path.resolve(__dirname, '..')
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snagentsos-mobile-home-ui-'))
const assets = path.join(root, 'out/mobile/assets')
const mobileCss = fs.existsSync(assets) && fs.readdirSync(assets).find(name => /^index-.*\.css$/.test(name))
if (!mobileCss) throw new Error('Run npm run build:mobile first')
require('esbuild').buildSync({ stdin: { resolveDir: root, loader: 'tsx', contents: `
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { LiveShell } from './src/mobile/src/components/LiveShell';
import { WelcomeScreen } from './src/mobile/src/components/WelcomeScreen';
import { store } from './src/mobile/src/lib/store';
import { client } from './src/mobile/src/lib/client';
import { setLang } from './src/mobile/src/lib/i18n';
const wait = ms => new Promise(r => setTimeout(r, ms));
const frames = () => wait(40);
let checks = 0; const check = (ok, label) => { if (!ok) throw new Error(label); checks++ };
const noOverflow = () => document.documentElement.scrollWidth <= window.innerWidth;
const $ = sel => document.querySelector(sel);
const $$ = sel => [...document.querySelectorAll(sel)];
const ptr = (el, type, x, y) => el.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, pointerId: 1, pointerType: 'touch', isPrimary: true, button: 0 }));
const click = el => el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 }));
const tap = el => { ptr(el, 'pointerdown', 10, 10); ptr(el, 'pointerup', 10, 10); click(el) };
async function hold(el) { ptr(el, 'pointerdown', 10, 10); await wait(480); ptr(el, 'pointerup', 10, 10); click(el) }
const setValue = (el, value) => { const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value); el.dispatchEvent(new Event('input', { bubbles: true })) };
const ctls = [];
let promptFallback = false;
client.sendCtl = async action => {
 ctls.push(action);
 if (action.kind === 'createPane') return { ok: true, paneId: 'n1', ...(promptFallback ? { promptFallback: true } : {}) };
 if (action.kind === 'globalPrompt') return { ok: true, info: 2 };
 if (action.kind === 'mountWorkspace') return { ok: true, info: 2 };
 return { ok: true };
};
const now = Date.now(), MIN = 60000;
const pane = (id, title, type, running, extra = {}) => ({ id, title, type, color: '', icon: '', running, ...extra });
const snapshot = {
 language: 'en', themeTokens: {}, fontFamily: 'mono', fontSize: 13, activeWorkspaceId: 'w1', hostName: 'ESTUDIO-PC', keyButtons: [],
 mountedWorkspaceIds: ['w1'],
 presets: [
  { id: 'p-shell', name: 'PowerShell', type: 'shell', icon: 'terminal', color: '#888888' },
  { id: 'p-claude', name: 'Claude Code', type: 'claude', icon: 'claude', color: '#d97757' },
  { id: 'p-codex', name: 'Codex', type: 'codex', icon: 'codex', color: '#10a37f' },
 ],
 usage: { updatedAt: now, rows: [
  { id: 'c5', provider: 'claude', kind: '5h', label: '5h', percent: 42, status: 'ok' },
  { id: 'c7', provider: 'claude', kind: '7d', label: '7d', percent: 91, status: 'ok' },
 ], activeAccount: { id: 'acc_aaaaaaaaaaaa', role: 'primary', label: 'Work', other: { id: 'acc_bbbbbbbbbbbb', role: 'secondary', label: '' } } },
 workspaces: [
  { id: 'w1', name: 'Front', layoutOrder: ['a1', 'a2', 'a3', 'a4'], git: { branch: 'main', ahead: 2, behind: 0, added: 142, removed: 37, files: 5 }, panes: [
   pane('a1', 'Idle shell', 'shell', true),
   pane('a2', 'Builder', 'claude', true, { status: { state: 'done', stateSince: now - 3 * MIN, provider: 'claude', lastMessage: 'All tests passed' } }),
   pane('a3', 'Asker', 'claude', true, { resumable: true, status: { state: 'action', reason: 'permission', stateSince: now - MIN, provider: 'claude' } }),
   pane('a4', 'Worker', 'codex', true, { status: { state: 'working', stateSince: now - 2 * MIN, provider: 'codex' } }),
  ] },
  { id: 'w2', name: 'Back', layoutOrder: ['b1', 'b2'], panes: [
   pane('b1', 'Reviewer', 'claude', true, { resumable: true, status: { state: 'action', reason: 'question', stateSince: now - MIN, provider: 'claude' } }),
   pane('b2', 'Never started', 'shell', false),
  ] },
  { id: 'w3', name: 'Empty', layoutOrder: [], panes: [] },
 ],
};
const statusOf = snap => { const m = {}; for (const w of snap.workspaces) for (const p of w.panes) if (p.status) m[p.id] = p.status; return m };
window.runMain = async () => {
 try { localStorage.clear() } catch {}
 setLang('en');
 store.getState().update({ phase: 'live', snapshot, paneStatus: statusOf(snapshot), connected: true, appVersion: '2.0.0', screen: 'home', activePaneId: null, subscribedPaneId: null, lastPane: null, lastViewedAt: {}, homeCollapsed: [] });
 const host = document.getElementById('root'); const r = createRoot(host);
 flushSync(() => r.render(<LiveShell />));
 await frames();

 // --- header (E2-FR-02) and the stacked terminal (E2-FR-01) ---
 check($('[data-wordmark]').textContent === 'SnAgentsOS' && $('[data-host-name]').textContent === 'ESTUDIO-PC', 'the header shows the wordmark and the PC name');
 const layer = $('[data-terminal-layer]');
 check(layer && layer.dataset.open === 'false' && new DOMMatrix(getComputedStyle(layer).transform).m41 >= window.innerWidth - 1, 'the terminal stays mounted off screen with translateX(100%), not display:none');
 check(getComputedStyle(layer).display !== 'none' && layer.querySelector('.xterm'), 'and its xterm is mounted');
 check(noOverflow(), 'Home fits 360px');

 // --- rows (E2-FR-04/05) ---
 const order = ws => $$('[data-workspace=' + ws + '] [data-pane]').map(e => e.dataset.pane).join();
 check(order('w1') === 'a3,a2,a4,a1', 'rows: action > unread done > working > rest (got ' + order('w1') + ')');
 const line = id => $('[data-pane=' + id + '] [data-status-line]').textContent;
 check(line('a3') === 'Waiting for permission' && line('a2') === 'Done 3m ago' && line('a4') === 'Working 2m' && line('a1') === 'Idle', 'second lines follow the table');
 check(line('b2') === 'Not started', 'a stopped console of a workspace the desktop has not mounted reads "Not started"');
 check($('[data-pane=a2] [data-last-message]').textContent === 'All tests passed' && !$('[data-pane=a3] [data-last-message]'), 'done shows the preview line; action does not');
 const weight = id => getComputedStyle($('[data-pane=' + id + '] [data-pane-title]')).fontWeight;
 check(weight('a2') === '700' && weight('a3') === '700' && weight('a4') !== '700', 'unread done / action titles are bold, working is not');
 check($$('[data-pane]').every(e => e.getBoundingClientRect().height >= 56), 'every row is at least 56px tall');
 check($('[data-workspace=w1] [data-on-pc]') && !$('[data-workspace=w2] [data-on-pc]'), '"On the PC" only on the desktop active workspace');
 check($('[data-workspace=w1] [data-git-chip]').textContent === 'main +142 -37 \\u00b7 5 \\u21912' && !$('[data-workspace=w2] [data-git-chip]'), 'the git chip shows branch, counts and ahead; no chip and no space without git');
 check($('[data-workspace=w1] [data-ws-badge]').textContent === '1' && $('[data-workspace=w2] [data-ws-badge]').textContent === '1', 'each section badges its consoles in action');

 // --- collapse (E2-FR-04) ---
 click($('[data-workspace=w2] [data-ws-toggle]'));
 await frames();
 check($('[data-workspace=w2]').dataset.collapsed === 'true' && !$('[data-workspace=w2] [data-pane]'), 'a tap on the header collapses the section');
 check($('[data-workspace=w2] [data-ws-badge]').textContent === '1', 'the action badge stays visible while collapsed');
 check(JSON.parse(localStorage.getItem('snagentsos.home.collapsed')).join() === 'w2', 'the collapse persists in snagentsos.home.collapsed');
 click($('[data-workspace=w2] [data-ws-toggle]'));
 await frames();

 // --- empty states and inline usage (E2-FR-14/15) ---
 check($('[data-workspace=w3] [data-empty-consoles]').textContent.includes('No consoles'), 'an empty workspace says "No consoles"');
 check($$('[data-home-usage] [data-usage-bar]').length === 2, 'inline usage shows the 5h and 7d bars');
 click($('[data-home-usage] button'));
 await wait(300);
 check(document.body.textContent.includes('Usage') && $$('[data-sheet][data-open=true]').length === 1, 'a tap on the usage card opens the full UsageSheet');
 // App 2.3.0: the Claude account (label or role, never an email) and "Use <other>" only for a desktop >= 2.3.0.
 check($('[data-usage-account=primary]') && $('[data-usage-account=primary]').textContent.startsWith('Account: Work') && !$('[data-usage-use-account]'), 'the sheet names the Claude account; an older desktop gets no switch button');
 flushSync(() => store.getState().update({ appVersion: '2.3.0' }));
 await frames();
 const useBtn = $('[data-usage-use-account=secondary]');
 check(useBtn && useBtn.textContent === 'Use Secondary', 'with a 2.3.0 desktop the sheet offers Use <other>, the role name when unlabeled');
 click(useBtn);
 await wait(200);
 check(ctls.at(-1).kind === 'claudeAccountUse' && ctls.at(-1).role === 'secondary' && Object.keys(ctls.at(-1)).length === 2, 'Use <other> sends claudeAccountUse { role }');
 check($$('[data-toast]').some(t => t.textContent === 'Claude now uses Secondary'), 'and confirms with a toast');
 check(!$('[data-sheet][data-open=true]').textContent.includes('@'), 'no email in the usage sheet');
 // App 2.4.0: one other account keeps the single button, now by id.
 const others2 = [{ id: 'acc_bbbbbbbbbbbb', rank: 1, role: 'secondary', label: '', ready: true }]
 const withAccount = acc => ({ ...snapshot, usage: { ...snapshot.usage, activeAccount: acc } })
 flushSync(() => store.getState().update({ appVersion: '2.4.0', snapshot: withAccount({ id: 'acc_aaaaaaaaaaaa', rank: 0, role: 'primary', label: 'Work', other: { id: 'acc_bbbbbbbbbbbb', rank: 1, role: 'secondary', label: '' }, others: others2 }) }));
 await frames();
 const useById = $('[data-usage-use-account-id=acc_bbbbbbbbbbbb]');
 check(useById && useById.textContent === 'Use Account 2' && !$('[data-usage-change-account]'), 'a 2.4.0 desktop with one other account: the single Use button, named Account N');
 click(useById);
 await wait(200);
 check(ctls.at(-1).kind === 'claudeAccountUse' && ctls.at(-1).id === 'acc_bbbbbbbbbbbb' && !('role' in ctls.at(-1)), 'to a 2.4.0 desktop Use sends claudeAccountUse { id }');
 // More accounts: "Change account" opens the picker sheet by priority.
 const others3 = [
  { id: 'acc_aaaaaaaaaaaa', rank: 0, role: 'primary', label: 'Work', ready: true },
  { id: 'acc_bbbbbbbbbbbb', rank: 1, role: 'secondary', label: '', ready: false },
  { id: 'acc_dddddddddddd', rank: 3, role: 'secondary', label: 'Spare', ready: true },
 ]
 flushSync(() => store.getState().update({ snapshot: withAccount({ id: 'acc_cccccccccccc', rank: 2, role: 'secondary', label: 'Home', other: { id: 'acc_aaaaaaaaaaaa', rank: 0, role: 'primary', label: 'Work' }, others: others3 }) }));
 await frames();
 check($('[data-usage-account-id=acc_cccccccccccc]').textContent.startsWith('Account: Home') && !$('[data-usage-use-account]') && $('[data-usage-change-account]'), 'more than one other account: a Change account button instead of Use');
 click($('[data-usage-change-account]'));
 await wait(300);
 check($$('[data-sheet][data-open=true]').length === 2 && $$('[data-usage-pick-account]').map(b => b.dataset.usagePickRank).join() === '0,1,2,3', 'the picker sheet opens over the usage sheet, every account by priority');
 check($('[data-usage-pick-account=acc_cccccccccccc]').disabled && $('[data-usage-pick-account=acc_bbbbbbbbbbbb]').disabled && $('[data-usage-pick-account=acc_bbbbbbbbbbbb]').textContent.includes('Capture it again on the PC'), 'the active account and one that needs a capture cannot be picked');
 check($('[data-usage-pick-account=acc_bbbbbbbbbbbb]').textContent.includes('#2') && $('[data-usage-pick-account=acc_bbbbbbbbbbbb]').textContent.includes('Account 2'), 'rows carry #n and the label or Account N');
 click($('[data-usage-pick-account=acc_dddddddddddd]'));
 await wait(300);
 check(ctls.at(-1).kind === 'claudeAccountUse' && ctls.at(-1).id === 'acc_dddddddddddd' && Object.keys(ctls.at(-1)).length === 2, 'picking Spare sends claudeAccountUse { id }');
 check($$('[data-toast]').some(t => t.textContent === 'Claude now uses Spare') && $$('[data-sheet][data-open=true]').length === 1, 'a successful pick confirms and closes the picker');
 check(!$('[data-sheet][data-open=true]').textContent.includes('@'), 'still no email');
 // A 2.3.0 desktop never gets the picker nor { id }, even with others in the snapshot.
 flushSync(() => store.getState().update({ appVersion: '2.3.0' }));
 await frames();
 check(!$('[data-usage-change-account]') && $('[data-usage-use-account=primary]'), 'a 2.3.0 desktop: only Use <other> by role');
 flushSync(() => store.getState().update({ appVersion: '2.0.0', snapshot }));
 history.back(); await wait(400);

 // --- phone-only navigation (E2-FR-06/16/47) ---
 tap($('[data-pane=b1]'));
 await wait(380);
 check(layer.dataset.open === 'true' && Math.abs(new DOMMatrix(getComputedStyle(layer).transform).m41) < 1, 'a tap on a row slides the terminal in');
 check(!ctls.some(a => a.kind === 'switchWorkspace'), 'opening a console of another workspace never asks the desktop to switch');
 check(layer.querySelector('[data-pane-title]').textContent === 'Reviewer' && layer.querySelector('[data-ws-name]').textContent === 'Back', 'the terminal header names the console and its own workspace');
 check(layer.querySelector('[data-pane-tabs]').dataset.paneTabs === 'w2' && layer.querySelectorAll('[data-tab]').length === 2, 'the tabs list the viewed workspace, not the desktop one');
 check(store.getState().lastPane === 'b1' && localStorage.getItem('snagentsos.lastPane') === 'b1', 'the viewed console becomes lastPane');
 check(history.state && history.state.snagentsos && history.state.snagentsos !== 'root', 'the terminal owns a history entry');
 click(layer.querySelector('[data-terminal-back]'));
 await wait(420);
 check(layer.dataset.open === 'false' && store.getState().screen === 'home' && history.state.snagentsos === 'root', 'the chevron returns to Home and pops its entry');
 check(store.getState().subscribedPaneId === null && store.getState().activePaneId === 'b1', 'Home leaves the console stream (v2.2.1) but remembers the console');
 check($('[data-resume=b1]') && $('[data-resume=b1]').textContent.includes('Back'), 'the Resume card shows the console just viewed, with its workspace');
 tap($('[data-resume=b1]'));
 await wait(380);
 check(layer.dataset.open === 'true', 'a tap on Resume opens it');
 history.back();
 await wait(420);
 check(layer.dataset.open === 'false' && store.getState().screen === 'home', 'the browser / Android back returns to Home');

 // --- mount confirmation (E2-FR-06) ---
 tap($('[data-pane=b2]'));
 await wait(300);
 check($('[data-mount-message]').textContent === 'This starts 2 consoles of Back on the PC (without changing what you are looking at).', 'a stopped console of an unmounted workspace asks first');
 check(layer.dataset.open === 'false' && !ctls.some(a => a.kind === 'mountWorkspace'), 'nothing starts before the answer');
 click($('[data-mount-start]'));
 await wait(420);
 check(ctls.at(-1).kind === 'mountWorkspace' && ctls.at(-1).workspaceId === 'w2', 'Start sends mountWorkspace for that workspace');
 check(layer.dataset.open === 'true' && store.getState().activePaneId === 'b2', 'and opens the console');
 history.back(); await wait(420);

 // --- per-pane actions on the row's own workspace (E2-FR-08/47/49) ---
 await hold($('[data-pane=b1]'));
 await wait(300);
 const ids = () => $$('[data-pane-actions] [data-action]').map(b => b.dataset.action).join();
 check(ids() === 'rename,restart,restartResume,restartFresh,reveal,copyTitle,close', 'a long-press on a row opens its actions, with the resume rows of a resumable agent (got ' + ids() + ')');
 click($('[data-pane-actions] [data-action=close]'));
 await wait(300);
 click($('[data-confirm-ok]'));
 await wait(420);
 check(ctls.at(-1).kind === 'closePane' && ctls.at(-1).workspaceId === 'w2' && ctls.at(-1).paneId === 'b1', 'Close acts on the row workspace (w2), not the desktop active one');
 await hold($('[data-pane=a1]'));
 await wait(300);
 check(ids() === 'rename,restart,reveal,copyTitle,close', 'a plain shell has no resume rows');
 click($('[data-pane-actions] [data-action=reveal]'));
 await wait(420);
 check(ctls.at(-1).kind === 'revealPane' && ctls.at(-1).paneId === 'a1', 'Show on the PC sends revealPane');

 // --- workspace kebab (E2-FR-09/51) ---
 click($('[data-workspace=w2] [data-ws-menu]'));
 await wait(300);
 check($$('[data-ws-actions] [data-action]').map(b => b.dataset.action).join() === 'newHere,promptAll,quick,history,notes,showOnPc', 'the kebab offers New console here, Prompt to every console, Quick Commands, History (E3-FR-36), Notes (v2.2) and Show on the PC');
 click($('[data-ws-actions] [data-action=promptAll]'));
 await wait(420);
 setValue($('[data-global-prompt=w2]'), 'git status');
 await frames();
 click([...$$('[data-sheet] button')].find(b => b.textContent === 'Send'));
 await wait(420);
 check(ctls.at(-1).kind === 'globalPrompt' && ctls.at(-1).workspaceId === 'w2' && ctls.at(-1).text === 'git status', 'Prompt to every console targets that workspace');
 check($$('[data-toast]').some(t => t.textContent === 'Sent to 2 console(s)'), 'and confirms with a toast');

 // --- FAB picker (E2-FR-10/11) ---
 check(getComputedStyle($('[data-fab]')).width === '56px' && $('[data-fab]').getBoundingClientRect().right <= window.innerWidth - 15, 'the FAB is 56px, 16px from the edge');
 click($('[data-fab]'));
 await wait(320);
 check($('[data-ws-chip][aria-pressed=true]').dataset.wsChip === 'w2', 'the picker starts on the workspace of the last viewed console');
 check($('[data-preset][aria-pressed=true]').dataset.preset === 'p-claude' && $('[data-new-prompt]'), 'the first claude preset is the default, with the prompt field');
 click($('[data-preset=p-shell]'));
 await frames();
 check(!$('[data-new-prompt]'), 'a shell preset hides the prompt field');
 click($('[data-preset=p-codex]'));
 await frames();
 const ta = $('[data-new-prompt]');
 check(ta && getComputedStyle(ta).fontSize === '16px' && ta.maxLength === 16384, 'the prompt is 16px (no iOS zoom) with the 16384 cap');
 setValue(ta, 'x'.repeat(2001));
 await frames();
 check($('[data-prompt-hint]').textContent === 'It will go to the composer', 'past 2000 characters the hint warns it will go to the composer');
 setValue($('[data-new-prompt]'), 'subi al 100%');
 click($('[data-ws-chip=w1]'));
 await frames();
 promptFallback = true;
 click([...$$('[data-new-console] button')].find(b => b.textContent.includes('Open console')));
 await wait(420);
 const created = ctls.at(-1);
 check(created.kind === 'createPane' && created.workspaceId === 'w1' && created.presetId === 'p-codex' && created.prompt === 'subi al 100%', 'Open console sends createPane with the workspace, preset and prompt');
 check(JSON.parse(localStorage.getItem('snagentsos.draft.n1')).text === 'subi al 100%' && store.getState().inputModes.n1 === 'composer', 'promptFallback leaves the text in the new console composer draft (Composer mode)');
 check($$('[data-toast]').some(t => t.textContent === 'The prompt stayed in the composer'), 'with the toast');
 check(layer.dataset.open === 'true' && store.getState().activePaneId === 'n1', 'and the phone enters the new console');
 history.back(); await wait(420);

 // --- empty workspace button and Settings (E2-FR-13/15) ---
 click($('[data-workspace=w3] [data-empty-new]'));
 await wait(320);
 check($('[data-ws-chip][aria-pressed=true]').dataset.wsChip === 'w3', '"New console" in an empty workspace opens the picker on it');
 history.back(); await wait(420);
 click($('[data-home-settings]'));
 await wait(420);
 const settings = $('[data-push-screen=settings]');
 check(settings && settings.querySelector('[data-version=desktop]').textContent.includes('2.0.0') && settings.querySelector('[data-version=bundle]'), 'Settings opens as a screen with the desktop and bundle versions');
 check(settings.querySelector('[data-settings-section=device]'), 'and Unpair under This device');
 history.back(); await wait(420);
 check(!$('[data-push-screen]') && store.getState().screen === 'home', 'back closes Settings');
 check(noOverflow(), 'still no horizontal overflow');

 // --- Spanish ---
 setLang('es');
 // A real state frame is parsed JSON: every workspace object is new (memoized rows re-render).
 flushSync(() => store.getState().update({ snapshot: { ...JSON.parse(JSON.stringify(snapshot)), language: 'es' } }));
 await frames();
 check($('[data-workspace=w1] [data-on-pc]').textContent === 'En la PC' && $('[data-pane=b2] [data-status-line]').textContent === 'Sin iniciar', 'Spanish chips and second lines');

 // --- no workspaces (E2-FR-15) ---
 flushSync(() => store.getState().update({ snapshot: { ...snapshot, language: 'es', workspaces: [] } }));
 await frames();
 check($('[data-empty-workspaces]').textContent === 'No hay workspaces. Crea uno en la PC.' && !$('[data-fab]'), 'without workspaces the hero shows and there is no FAB');
 setLang('en');
 r.unmount();

 // --- Welcome (E2-FR-15) ---
 const w = createRoot(host);
 flushSync(() => w.render(<WelcomeScreen />));
 await frames();
 const steps = $$('[data-how-it-works] [data-step]');
 check(steps.length === 3 && steps[0].textContent.includes('Settings > Remote control') && steps.every(s => s.querySelector('span').getBoundingClientRect().width === 28), 'Welcome shows the 3 numbered steps in 28px squares');
 w.unmount();
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
 console.log('PASS: '+checks+' mobile Home UI checks');w.destroy();app.quit();
}).catch(e=>{console.error(e);app.exit(1)});
`)
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
const flags = process.platform === 'linux' && process.env.CI ? ['--no-sandbox'] : []
const result = spawnSync(require('electron'), [...flags, path.join(dir, 'main.cjs')], { env, windowsHide: true, encoding: 'utf8', timeout: 90000 })
process.stdout.write(result.stdout ?? '')
process.stderr.write((result.stderr ?? '') + (result.error ? result.error.message : ''))
fs.rmSync(dir, { recursive: true, force: true })
if (result.status !== 0 || !/^PASS:/m.test(result.stdout ?? '')) process.exit(1)
