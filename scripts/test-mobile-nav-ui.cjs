// Render the phone's M5 navigation (E1-FR-32..37, 39; E5-FR-11) with the
// production CSS in an isolated offscreen browser at phone width: the pane
// tabs (order, icons, cut titles, dimmed panes, first tap keeps the focus,
// "+"), the 450ms long-press that opens the per-pane ActionList from a tab and
// from a Home row (E2-FR-08), the resume rows shown or hidden by `resumable` and the
// restartPane they send, the Sheet drag (100px closes, a slow 40px springs
// back, a flick closes, mounted until transitionend), the back stack against
// the real History API, the Settings PushScreen slide, and reduced motion.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path')
const { pathToFileURL } = require('node:url')
const { spawnSync } = require('node:child_process')
const root = path.resolve(__dirname, '..')
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snagentsos-mobile-nav-ui-'))
const assets = path.join(root, 'out/mobile/assets')
const mobileCss = fs.existsSync(assets) && fs.readdirSync(assets).find(name => /^index-.*\.css$/.test(name))
if (!mobileCss) throw new Error('Run npm run build:mobile first')
require('esbuild').buildSync({ stdin: { resolveDir: root, loader: 'tsx', contents: `
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { PaneTabs } from './src/mobile/src/components/PaneTabs';
import { HomeScreen } from './src/mobile/src/components/HomeScreen';
import { PaneActionList as PaneActionSheet } from './src/mobile/src/components/PaneActionList';
import { SettingsScreen } from './src/mobile/src/components/SettingsScreen';
import { BackStackHost } from './src/mobile/src/lib/useBackClaim';
import { Sheet } from './src/mobile/src/components/Sheet';
import { store } from './src/mobile/src/lib/store';
import { client } from './src/mobile/src/lib/client';
const wait = ms => new Promise(r => setTimeout(r, ms));
const frames = () => wait(32);
let checks = 0; const check = (ok, label) => { if (!ok) throw new Error(label); checks++ };
const noOverflow = () => document.documentElement.scrollWidth <= window.innerWidth;
const $ = sel => document.querySelector(sel);
const $$ = sel => [...document.querySelectorAll(sel)];
const ptr = (el, type, x, y, id = 1) => el.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, pointerId: id, pointerType: 'touch', isPrimary: true, button: 0 }));
const click = el => el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 }));
const tap = el => { ptr(el, 'pointerdown', 10, 10); ptr(el, 'pointerup', 10, 10); click(el) };
async function hold(el, ms = 470) { ptr(el, 'pointerdown', 10, 10); await wait(ms); ptr(el, 'pointerup', 10, 10); click(el) }
const RED = (() => { const el = document.createElement('span'); el.className = 'text-red-400'; document.body.appendChild(el); const c = getComputedStyle(el).color; el.remove(); return c })();
const translateY = el => new DOMMatrix(getComputedStyle(el).transform).m42;
const ctls = [], views = [];
client.sendCtl = async action => { ctls.push(action); return { ok: true, paneId: 'n1' } };
client.requestOpen = paneId => { views.push(paneId); store.getState().update({ activePaneId: paneId }); return 'open' };
client.showPane = paneId => { views.push(paneId); store.getState().update({ activePaneId: paneId }) };
const lastMessage = 'L'.repeat(269) + ' end-of-msg';
const snapshot = {
 language: 'en', themeTokens: {}, fontFamily: 'mono', fontSize: 13, activeWorkspaceId: 'w1',
 workspaces: [
  { id: 'w1', name: 'Front', layoutOrder: ['a2', 'a1', 'a3', 'a4'], panes: [
   { id: 'a1', title: 'Claude main', type: 'claude', color: '', icon: '', running: true, resumable: true },
   { id: 'a2', title: 'Codex', type: 'codex', color: '', icon: '', running: true },
   { id: 'a3', title: 'A shell with a really long title', type: 'shell', color: '', icon: '', running: false },
   { id: 'a4', title: 'Bot', type: 'custom', color: '', icon: '', running: true },
  ] },
  { id: 'w2', name: 'Back', layoutOrder: ['b1'], panes: [
   { id: 'b1', title: 'Reviewer', type: 'claude', color: '', icon: '', running: true, resumable: true },
  ] },
 ],
};
const openDrawer = () => click(document.querySelector('[data-workspace=w2] [data-ws-menu]'));
function Harness() {
 const [target, setTarget] = useState(null);
 return <BackStackHost>
  <PaneTabs onPaneActions={setTarget} />
  <PaneActionSheet target={target} onClose={() => setTarget(null)} />
  <HomeScreen />
 </BackStackHost>;
}
window.runMain = async () => {
 const host = document.getElementById('root'); const root = createRoot(host);
 store.getState().update({ phase: 'live', snapshot, activePaneId: 'a1', subscribedPaneId: 'a1', connected: true,
  paneStatus: { a1: { state: 'action', reason: 'permission', stateSince: Date.now(), lastMessage } } });
 flushSync(() => root.render(<Harness />));
 await frames();
 check(history.state && history.state.snagentsos === 'root', 'the live root is marked with replaceState({snagentsos:"root"})');

 // --- tabs (E1-FR-32) ---
 const tabs = $$('[data-tab]');
 check(tabs.map(t => t.dataset.tab).join() === 'a2,a1,a3,a4', 'tabs follow layoutOrder of the viewed workspace (got ' + tabs.map(t => t.dataset.tab).join() + ')');
 check(tabs.map(t => t.querySelector('[data-pane-icon]').dataset.paneIcon).join() === 'codex,claude,shell,custom', 'each tab carries its type icon (custom = Bot)');
 {
  // v2.4: a shell console running a hand-typed codex shows the agent's icon (status.provider wins).
  const before = store.getState().paneStatus;
  store.getState().update({ paneStatus: { ...before, a3: { state: 'idle', provider: 'codex', hosted: true, stateSince: Date.now() } } });
  await frames();
  check($('[data-tab=a3] [data-pane-icon]').dataset.paneIcon === 'codex', 'v2.4: a shell tab whose status names codex carries the codex icon');
  store.getState().update({ paneStatus: before });
  await frames();
  check($('[data-tab=a3] [data-pane-icon]').dataset.paneIcon === 'shell', 'and the shell icon again once the agent is gone');
 }
 const a3 = $('[data-tab=a3]');
 check([...a3.textContent].length === 18 && a3.textContent.endsWith('\\u2026'), 'a long title is cut to 18 characters (got ' + a3.textContent + ')');
 check(getComputedStyle(a3).opacity === '0.5', 'a pane without a pty is dimmed to 50%');
 let a1 = $('[data-tab=a1]');
 check(a1.dataset.active === 'true' && getComputedStyle(a1).backgroundColor === 'rgb(99, 102, 241)', 'the active tab is filled');
 check(a1.querySelector('[role=img][data-state=action]'), 'the tab shows the pane status indicator');
 check(!ptr($('[data-tab=a2]'), 'pointerdown', 10, 10), 'pointerdown on a tab is preventDefault-ed (first tap with the keyboard open)');
 ptr($('[data-tab=a2]'), 'pointerup', 10, 10); click($('[data-tab=a2]'));
 await frames();
 check(views.join() === 'a2' && !$('[data-sheet]'), 'a tap switches pane without opening any sheet');
 check($('[data-tab=a2]').dataset.active === 'true', 'the active tab follows the viewed pane');
 tap($('[data-tab-new]'));
 await frames();
 check(ctls.at(-1).kind === 'createPane' && ctls.at(-1).workspaceId === 'w1' && views.at(-1) === 'n1', '"+" creates a console in this workspace and enters it');
 store.getState().update({ activePaneId: 'a1' });
 await frames();
 check(noOverflow(), 'the tab strip fits 360px without page overflow');
 a1 = $('[data-tab=a1]'); // the strip remounted while the new console (not in the snapshot) was viewed

 // --- long-press (E1-FR-33) ---
 views.length = 0;
 ptr(a1, 'pointerdown', 10, 10);
 await wait(300);
 check(!$('[data-pane-actions]'), 'nothing opens before 450ms');
 await wait(170);
 check($('[data-pane-actions=a1]'), 'a 450ms hold opens the pane actions');
 ptr(a1, 'pointerup', 10, 10); click(a1);
 await wait(260);
 check(views.length === 0, 'the lift after a hold does not also switch to the tab');
 check($('[data-sheet-panel]') && translateY($('[data-sheet-panel]')) === 0, 'and does not close the sheet it opened (got ' + ($('[data-sheet-panel]') ? getComputedStyle($('[data-sheet-panel]')).transform + ' ' + $('[data-sheet]').dataset.open : 'none') + ')');
 const head = $('[data-action-header]');
 check(head.textContent.includes('Claude main') && head.textContent.includes('Front') && $('[data-action-message]').textContent === lastMessage, 'the header shows title, workspace and the full last reply');
 check(!a1.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })), 'the browser context menu is suppressed');
 const ids = () => $$('[data-pane-actions] [data-action]').map(b => b.dataset.action).join();
 check(ids() === 'rename,restart,restartResume,restartFresh,reveal,copyTitle,close', 'a resumable pane lists Relaunch resuming, New chat, Show on the PC and Copy title (got ' + ids() + ')');
 check($$('[data-pane-actions] [data-action]').every(b => b.getBoundingClientRect().height >= 48), 'every row is at least 48px tall');
 const closeRow = $('[data-pane-actions] [data-action=close]');
 check(getComputedStyle(closeRow.querySelector('span:nth-child(2)')).color === RED && getComputedStyle($('[data-pane-actions] [data-action=rename] span:nth-child(2)')).color !== RED, 'Close is red, the other rows are not');
 check(getComputedStyle(closeRow).borderTopWidth !== '0px' && getComputedStyle($('[data-pane-actions] [data-action=rename]')).borderTopWidth === '0px', 'rows are separated by hairlines');
 check(noOverflow(), 'the action list fits 360px');
 click($('[data-action=restartResume]'));
 await wait(60);
 check($('[data-confirm-message]') && $('[data-confirm-message]').textContent.includes('resume'), 'Relaunch resuming asks for confirmation');
 click($('[data-confirm-ok]'));
 await wait(400);
 check(ctls.at(-1).kind === 'restartPane' && ctls.at(-1).paneId === 'a1' && ctls.at(-1).workspaceId === 'w1' && ctls.at(-1).resume === true, 'confirming sends restartPane resume:true');
 check(!$('[data-sheet]'), 'every sheet is gone after the exit animations');
 await hold($('[data-tab=a1]'));
 await frames();
 click($('[data-action=restartFresh]'));
 await wait(60);
 click($('[data-confirm-ok]'));
 await wait(400);
 check(ctls.at(-1).kind === 'restartPane' && ctls.at(-1).resume === false, 'New chat sends restartPane resume:false');
 await hold($('[data-tab=a2]'));
 await frames();
 check(ids() === 'rename,restart,reveal,copyTitle,close', 'a pane without resumable hides both resume rows (got ' + ids() + ')');
 history.back();
 await wait(400);
 check(!$('[data-sheet]'), 'back closes the pane actions');
 ptr($('[data-tab=a1]'), 'pointerdown', 10, 10);
 ptr($('[data-tab=a1]'), 'pointermove', 10, 25);
 await wait(500);
 ptr($('[data-tab=a1]'), 'pointerup', 10, 25);
 check(!$('[data-sheet]'), 'moving more than 10px cancels the long-press');

 // --- Home rows (E2-FR-08) and the back stack (E1-FR-36) ---
 const depth0 = history.length;
 await hold($('[data-pane=b1]'));
 await frames();
 check($('[data-pane-actions=b1]') && $('[data-action-header]').textContent.includes('Back'), 'a long-press on a Home row opens the same actions, with its workspace');
 history.back();
 await wait(400);
 check(!$('[data-sheet]'), 'back closes them');
 openDrawer();
 await frames();
 check(history.state && history.state.snagentsos && history.state.snagentsos !== 'root', 'an open sheet (the workspace kebab) owns a history entry {snagentsos:id}');
 await hold($('[data-tab=a1]'));
 await frames();
 check($$('[data-sheet][data-open=true]').length === 2, 'the actions stack over the kebab sheet');
 history.back();
 await wait(400);
 check(!$('[data-pane-actions]') && $$('[data-sheet][data-open=true]').length === 1, 'one back closes only the top sheet');
 history.back();
 await wait(400);
 check(!$('[data-sheet]'), 'the next back closes the kebab sheet');
 check(history.state && history.state.snagentsos === 'root', 'and history is back at the live root');
 views.length = 0;
 tap($('[data-pane=a2]'));
 await wait(100);
 check(views.join() === 'a2' && !$('[data-sheet]'), 'a tap on a Home row opens the console (phone-only navigation)');
 openDrawer();
 await frames();
 click($('[data-ws-actions] [data-action=showOnPc]'));
 await wait(400);
 check(ctls.at(-1).kind === 'switchWorkspace' && ctls.at(-1).workspaceId === 'w2', 'the kebab "Show on the PC" is the only explicit switchWorkspace');
 await wait(50);
 check(history.state && history.state.snagentsos === 'root', 'closing from the UI pops its entry (no double pop)');
 check(history.length >= depth0, 'history stays consistent');

 // --- Sheet drag (E1-FR-34) ---
 const openActions = async () => { await hold($('[data-tab=a1]')); await frames(); return $('[data-sheet-handle]') };
 const drag = async (handle, steps, stepPx, stepMs) => {
  ptr(handle, 'pointerdown', 100, 300);
  let y = 300;
  for (let i = 0; i < steps; i++) { if (stepMs) await wait(stepMs); y += stepPx; ptr(handle, 'pointermove', 100, y) }
  return y;
 };
 let handle = await openActions();
 const panel = $('[data-sheet-panel]');
 let ended = false;
 panel.addEventListener('transitionend', e => { if (e.propertyName === 'transform') ended = true });
 let y = await drag(handle, 10, 10, 30);
 check(translateY(panel) === 100, 'the panel follows the finger');
 check(Number($('[data-sheet-backdrop]').style.opacity) < 1, 'the backdrop fades with the drag');
 ptr(handle, 'pointerup', 100, y);
 await frames();
 check($('[data-sheet][data-open=false]') && !ended, 'a 100px drag closes it and it stays mounted while it animates out');
 // Under a loaded offscreen compositor the transform transition can finish
 // after the 350 ms fallback, so poll for the unmount and accept either path.
 for (let t = 0; t < 30 && $('[data-sheet]'); t++) await wait(50);
 check(!$('[data-sheet]'), 'it unmounts on transitionend (or its 350 ms fallback)');
 await wait(50);
 handle = await openActions();
 y = await drag(handle, 10, 4, 40);
 ptr(handle, 'pointerup', 100, y);
 await wait(260);
 check($('[data-sheet][data-open=true]') && translateY($('[data-sheet-panel]')) === 0, 'a slow 40px drag springs back');
 y = await drag(handle, 2, 20, 0);
 ptr(handle, 'pointerup', 100, y);
 await frames();
 check($('[data-sheet][data-open=false]'), 'a fast 40px flick closes it');
 await wait(400);
 check(!$('[data-sheet]') && history.state.snagentsos === 'root', 'gone, with its history entry popped');

 // --- leaving 'live' with sheets open (E1-FR-36): the host orphans its claims ---
 openDrawer();
 await frames();
 await hold($('[data-tab=a1]'));
 await frames();
 check($$('[data-sheet][data-open=true]').length === 2 && history.state.snagentsos !== 'root', 'two stacked sheets own their entries before the phase change');
 flushSync(() => root.render(<span />));
 await wait(200);
 check(!$('[data-sheet]') && history.state && history.state.snagentsos === 'root', 'unmounting the host (phase change) drops both entries in one traversal: the next back leaves the app');

 // --- content drags (touch events): only at scrollTop 0, never with a field focused ---
 let listOpen = true;
 const renderList = () => flushSync(() => root.render(<BackStackHost><Sheet open={listOpen} onClose={() => { listOpen = false; renderList() }} title="List"><input data-field /><div style={{ height: 2000 }} /></Sheet></BackStackHost>));
 renderList();
 await wait(260);
 const list = $('[data-sheet-panel]');
 const touch = (type, y) => {
  const t = new Touch({ identifier: 7, target: list, clientX: 100, clientY: y });
  return list.dispatchEvent(new TouchEvent(type, { bubbles: true, cancelable: true, touches: type === 'touchend' ? [] : [t], changedTouches: [t] }));
 };
 const touchDrag = async () => { touch('touchstart', 200); let y = 200, prevented = false; for (let i = 0; i < 10; i++) { await wait(30); y += 12; prevented = !touch('touchmove', y) || prevented } touch('touchend', y); return prevented };
 list.scrollTop = 300;
 check(!(await touchDrag()) && $('[data-sheet][data-open=true]'), 'a list scrolled halfway scrolls: the drag does not close it');
 list.scrollTop = 0;
 $('[data-field]').focus();
 check(!(await touchDrag()) && $('[data-sheet][data-open=true]'), 'with a field focused the content does not drag');
 $('[data-field]').blur();
 check(await touchDrag(), 'at the top the content drag takes over from scrolling');
 await frames();
 check(listOpen === false && $('[data-sheet][data-open=false]'), 'and a 120px content drag closes the sheet');
 await wait(400);

 // --- the terminal kebab: the viewed pane's rows plus Quick Commands (E2-FR-16) ---
 const quickRow = [{ id: 'quick', icon: null, label: 'Quick Commands', onSelect: () => {} }];
 flushSync(() => root.render(<BackStackHost><PaneActionSheet target={{ workspaceId: 'w1', paneId: 'a1' }} onClose={() => {}} extraItems={quickRow} /></BackStackHost>));
 await frames();
 const main = () => $$('[data-action-list] [data-action]').map(b => b.dataset.action).join();
 check(main() === 'rename,restart,restartResume,restartFresh,reveal,copyTitle,close,quick', 'the kebab lists the pane rows (resume rows for a resumable pane) then Quick Commands (got ' + main() + ')');
 flushSync(() => root.render(<BackStackHost><PaneActionSheet target={{ workspaceId: 'w1', paneId: 'a2' }} onClose={() => {}} extraItems={quickRow} /></BackStackHost>));
 await frames();
 check(main() === 'rename,restart,reveal,copyTitle,close,quick', 'and without them for a pane that is not resumable');
 check(getComputedStyle($('[data-action=close] span:nth-child(2)')).color === RED, 'Close is red in the kebab too');
 click($('[data-action=reveal]'));
 await wait(50);
 check(ctls.at(-1).kind === 'revealPane' && ctls.at(-1).paneId === 'a2', 'Show on the PC sends revealPane (E2-FR-07)');

 // --- Settings as a PushScreen (E1-FR-37) ---
 flushSync(() => root.render(<span />));
 await frames();
 let settingsOpen = true;
 const renderSettings = () => flushSync(() => root.render(<BackStackHost><SettingsScreen open={settingsOpen} onClose={() => { settingsOpen = false; renderSettings() }} /></BackStackHost>));
 renderSettings();
 const screen = $('[data-push-screen=settings]');
 const cs = getComputedStyle(screen);
 check(cs.animationName === 'push-in' && cs.animationDuration === '0.3s' && cs.animationTimingFunction === 'cubic-bezier(0.2, 0.8, 0.2, 1)', 'Settings slides in over 300ms with the spring curve (got ' + cs.animationName + ' ' + cs.animationDuration + ' ' + cs.animationTimingFunction + ')');
 check(cs.pointerEvents === 'none', 'touches are ignored while it slides');
 await wait(420);
 check(screen.dataset.stage === 'shown' && getComputedStyle(screen).pointerEvents === 'auto', 'then it settles and takes touches');
 check($('[data-settings-section=appearance]') && $('[data-settings-section=alerts] [data-pref=inPageAlerts]') && $('[data-settings-section=device]'), 'Appearance, Alerts (with its toggle) and This device sections are present');
 check(noOverflow(), 'Settings fits 360px');
 click($('[data-push-back]'));
 await frames();
 check($('[data-push-screen=settings]') && $('[data-push-screen=settings]').dataset.stage === 'out' && getComputedStyle($('[data-push-screen=settings]')).animationName === 'push-out', 'the back arrow slides it out');
 await wait(420);
 check(!$('[data-push-screen]') && history.state.snagentsos === 'root', 'and unmounts with its entry popped');
 settingsOpen = true; renderSettings();
 await wait(420);
 history.back();
 await wait(420);
 check(!$('[data-push-screen]') && settingsOpen === false, 'the browser back closes Settings');
 // E2-FR-45: Settings > Key bar pushes a second screen; back pops only that one.
 settingsOpen = true; renderSettings();
 await wait(420);
 click($('[data-settings-section=keybar] [data-action=keybar]'));
 await wait(420);
 check($('[data-push-screen=keybar]') && $('[data-push-screen=keybar]').dataset.stage === 'shown' && $('[data-push-screen=keybar] [data-key-row=esc]'), 'the Key bar row pushes the Key bar screen');
 check(noOverflow() && [...document.querySelectorAll('[data-key-row]')].every(r => r.scrollWidth <= r.clientWidth), 'the Key bar screen and every row fit 360px');
 history.back();
 await wait(420);
 check(!$('[data-push-screen=keybar]') && $('[data-push-screen=settings]') && settingsOpen === true, 'the browser back pops the Key bar screen and leaves Settings open');
 history.back();
 await wait(420);
 check(!$('[data-push-screen]') && settingsOpen === false, 'a second back closes Settings');
 return checks;
};
window.reducedCheck = async () => {
 let n = 0;
 const host = document.getElementById('root'); const r = createRoot(host);
 let open = true;
 const render = () => flushSync(() => r.render(<SettingsScreen open={open} onClose={() => {}} />));
 render();
 await frames();
 const screen = document.querySelector('[data-push-screen=settings]');
 if (!screen || screen.dataset.stage !== 'shown') throw new Error('reduced motion: Settings appears at once (got ' + (screen && screen.dataset.stage) + ')'); n++;
 open = false; render();
 if (document.querySelector('[data-push-screen]')) throw new Error('reduced motion: Settings disappears at once'); n++;
 flushSync(() => r.render(<PaneActionSheet target={{ workspaceId: 'w1', paneId: 'a1' }} onClose={() => {}} />));
 await frames();
 flushSync(() => r.render(<PaneActionSheet target={null} onClose={() => {}} />));
 if (document.querySelector('[data-sheet]')) throw new Error('reduced motion: a sheet closes without an exit animation'); n++;
 if (!(document.documentElement.scrollWidth <= window.innerWidth)) throw new Error('reduced motion: no horizontal overflow'); n++;
 return n;
};
` }, bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic', define: { __APP_VERSION__: '"2.0.0"', 'process.env.NODE_ENV': '"production"' }, alias: { '@shared': path.join(root, 'src/shared') }, outfile: path.join(dir, 'renderer.js') })
fs.writeFileSync(path.join(dir, 'index.html'), `<html><head><meta charset="utf-8"><link rel="stylesheet" href="${pathToFileURL(path.join(assets, mobileCss))}"></head><body><div id="root"></div><script src="renderer.js"></script></body></html>`)
fs.writeFileSync(path.join(dir, 'main.cjs'), `
const {app,BrowserWindow}=require('electron');const path=require('path');
app.setPath('userData',path.join(__dirname,'profile'));
app.whenReady().then(async()=>{
 const w=new BrowserWindow({show:false,width:360,height:640,useContentSize:true,webPreferences:{sandbox:true,backgroundThrottling:false,offscreen:true}});
 await w.loadFile(path.join(__dirname,'index.html'));
 let checks=await w.webContents.executeJavaScript('window.runMain()');
 w.webContents.debugger.attach('1.3');
 await w.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
 await w.loadFile(path.join(__dirname,'index.html'));
 checks+=await w.webContents.executeJavaScript('window.reducedCheck()');
 console.log('PASS: '+checks+' mobile navigation UI checks');w.destroy();app.quit();
}).catch(e=>{console.error(e);app.exit(1)});
`)
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
const flags = process.platform === 'linux' && process.env.CI ? ['--no-sandbox'] : []
const result = spawnSync(require('electron'), [...flags, path.join(dir, 'main.cjs')], { env, windowsHide: true, encoding: 'utf8', timeout: 60000 })
process.stdout.write(result.stdout ?? '')
process.stderr.write((result.stderr ?? '') + (result.error ? result.error.message : ''))
fs.rmSync(dir, { recursive: true, force: true })
if (result.status !== 0 || !/^PASS:/m.test(result.stdout ?? '')) process.exit(1)
