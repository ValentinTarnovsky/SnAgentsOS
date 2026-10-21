// Render the phone's page alerts (E2-FR-43, 44; R22-18) with the production
// CSS in an isolated offscreen browser at phone width: the real LiveShell with
// a stubbed control plane (no socket). Live paneStatus frames go through the
// client's own handler: in a terminal another console toasts with [Go] (which
// opens it), the console on screen and Home never toast, the stack keeps 3,
// info toasts leave before state toasts, and the Alerts section of Settings
// persists its three switches in snagentsos.prefs, in English and Spanish.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path')
const { pathToFileURL } = require('node:url')
const { spawnSync } = require('node:child_process')
const root = path.resolve(__dirname, '..')
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snagentsos-mobile-notify-ui-'))
const assets = path.join(root, 'out/mobile/assets')
const mobileCss = fs.existsSync(assets) && fs.readdirSync(assets).find(name => /^index-.*\.css$/.test(name))
if (!mobileCss) throw new Error('Run npm run build:mobile first')
require('esbuild').buildSync({ stdin: { resolveDir: root, loader: 'tsx', contents: `
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { LiveShell } from './src/mobile/src/components/LiveShell';
import { toastDuration } from './src/mobile/src/components/ToastStack';
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
client.sendCtl = async () => ({ ok: true });
const vibrations = [];
// An offscreen window may report hidden; the alerts only run on a visible page.
try { Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' }) } catch {}
try { Object.defineProperty(navigator, 'vibrate', { configurable: true, value: pattern => { vibrations.push(String(pattern)); return true } }) } catch {}
const pane = (id, title, type, extra = {}) => ({ id, title, type, color: '', icon: '', running: true, ...extra });
const snapshot = {
 language: 'en', themeTokens: {}, fontFamily: 'mono', fontSize: 13, activeWorkspaceId: 'w1', hostName: 'PC', keyButtons: [], mountedWorkspaceIds: ['w1', 'w2'],
 workspaces: [
  { id: 'w1', name: 'Front', layoutOrder: ['a1', 'a2'], panes: [pane('a1', 'Builder', 'claude'), pane('a2', 'Shell', 'shell')] },
  { id: 'w2', name: 'Back end with a long workspace name', layoutOrder: ['b1', 'b2', 'b3'], panes: [pane('b1', 'Reviewer with a long console title', 'claude'), pane('b2', 'Codex', 'codex'), pane('b3', 'Tests', 'claude')] },
 ],
};
let since = 1000;
const status = (paneId, state, extra = {}) => client.handlePaneStatus(paneId, { state, stateSince: ++since, provider: 'claude', ...extra });
window.runMain = async () => {
 try { localStorage.clear() } catch {}
 setLang('en');
 store.getState().update({ phase: 'live', snapshot, paneStatus: {}, connected: true, appVersion: '2.0.0', screen: 'home', activePaneId: null, subscribedPaneId: null, lastPane: null, lastViewedAt: {}, homeCollapsed: [], inPageAlerts: true, alertVibrate: true, alertDone: false, toasts: [], toast: null });
 const host = document.getElementById('root'); const r = createRoot(host);
 flushSync(() => r.render(<LiveShell />));
 await frames();

 // --- Home: vibration only (E2-FR-43) ---
 status('b1', 'action', { reason: 'permission' });
 await frames();
 check($$('[data-toast]').length === 0 && vibrations.at(-1) === '60,40,60', 'on Home a console in action vibrates [60,40,60] and shows no toast');

 // --- terminal: toast with [Go] for another console ---
 tap($('[data-pane=a1]'));
 await wait(380);
 const layer = $('[data-terminal-layer]');
 check(layer.dataset.open === 'true' && store.getState().activePaneId === 'a1', 'the terminal shows a1');
 status('b3', 'working'); status('b3', 'action', { reason: 'question' });
 await frames();
 const stack = layer.querySelector('[data-toast-stack]');
 check(stack && stack.getAttribute('role') === 'status' && stack.getAttribute('aria-live') === 'polite', 'the terminal stack is role=status, aria-live=polite');
 const t1 = stack.querySelector('[data-toast]');
 check(t1 && t1.dataset.toastKind === 'action' && t1.textContent.startsWith('Claude Back end with a long workspace name / Tests: Question'), 'the toast reads "<Claude> <workspace / console>: <reason>" (got ' + (t1 && t1.textContent) + ')');
 check(t1.querySelector('[data-toast-go=b3]').textContent === 'Go' && t1.querySelector('[data-toast-go]').getBoundingClientRect().height >= 32, 'with a [Go] button');
 check(noOverflow() && t1.getBoundingClientRect().right <= window.innerWidth, 'a long toast fits 360px (truncated)');
 status('a1', 'action', { reason: 'permission' });
 await frames();
 check(stack.querySelectorAll('[data-toast]').length === 1, 'the console on screen never toasts');
 status('b2', 'error', { provider: 'codex' });
 status('b1', 'working'); status('b1', 'done');
 await frames();
 check(stack.querySelectorAll('[data-toast]').length === 2, 'done stays quiet with "Alert when a turn ends" off');
 store.getState().setPagePref('toastDone', true);
 status('b1', 'working'); status('b1', 'done');
 status('a2', 'working', { provider: undefined }); status('a2', 'error', { provider: undefined });
 await frames();
 const kinds = [...stack.querySelectorAll('[data-toast]')].map(e => e.dataset.toastKind).join();
 check(stack.querySelectorAll('[data-toast]').length === 3 && kinds === 'error,done,error', 'the stack keeps the 3 newest, newest on top (got ' + kinds + ')');
 check(toastDuration({ kind: 'action' }) === 6000 && toastDuration({ kind: 'error' }) === 6000 && toastDuration({ kind: 'done' }) === 4000 && toastDuration({}) === 2500, 'action/error last 6s, done 4s, a plain notice 2.5s');

 // [Go] opens that console like a row tap.
 const go = [...stack.querySelectorAll('[data-toast-go]')].find(b => b.dataset.toastGo === 'b2');
 click(go);
 await wait(200);
 check(store.getState().activePaneId === 'b2' && layer.querySelector('[data-pane-title]').textContent === 'Codex', '[Go] opens the console of the toast');
 check(!store.getState().toasts.some(x => x.paneId === 'b2'), 'and dismisses its toast');

 // v2.3: a shown toast goes once the desktop says its console no longer needs the user (answered on the PC).
 status('b3', 'working'); status('b3', 'action', { reason: 'question', attention: true });
 await frames();
 check(store.getState().toasts.some(x => x.paneId === 'b3' && x.kind === 'action') && layer.querySelector('[data-toast-go=b3]'), 'a console waiting (attention true) toasts');
 client.handlePaneStatus('b3', { state: 'action', stateSince: since, provider: 'claude', reason: 'question', attention: false });
 await frames();
 check(!store.getState().toasts.some(x => x.paneId === 'b3') && !layer.querySelector('[data-toast-go=b3]'), 'the attention flip removes that toast from the stack');
 check(store.getState().toasts.some(x => x.paneId === 'a2'), 'the toasts of other consoles stay');
 const quiet = store.getState().toasts.length;
 status('b1', 'working'); status('b1', 'done', { attention: false });
 await frames();
 check(store.getState().toasts.length === quiet - 1 && !store.getState().toasts.some(x => x.paneId === 'b1'), 'a done already seen on the PC never toasts (and the state change dropped the older one)');

 // A plain notice leaves before a state toast.
 store.getState().setToast(null);
 status('b3', 'working'); status('b3', 'action');
 store.getState().setToast('Copied');
 await wait(2800);
 const left = store.getState().toasts.map(x => x.kind ?? 'info').join();
 check(left === 'action', 'after 2.8s the plain notice is gone and the action toast stays (got ' + left + ')');

 // --- Settings > Alerts (E2-FR-44) ---
 history.back(); await wait(420);
 const homeStack = $$('[data-toast-stack]').find(el => !el.closest('[data-terminal-layer]'));
 check(homeStack && store.getState().toasts.some(x => x.paneId) && !homeStack.querySelector('[data-toast-go]'), 'back on Home, a state toast raised in the terminal is not shown there');
 click($('[data-home-settings]'));
 await wait(420);
 const alerts = $('[data-settings-section=alerts]');
 check(alerts.querySelector('[data-pref=inPageAlerts]').textContent.includes('On-screen alerts') && alerts.querySelector('[data-pref=vibrate]') && alerts.querySelector('[data-pref=toastDone]'), 'Alerts has On-screen alerts, Vibrate and Alert when a turn ends');
 check(alerts.querySelector('[data-pref=toastDone]').getAttribute('aria-checked') === 'true', 'the turn end switch reflects the store');
 click(alerts.querySelector('[data-pref=vibrate]'));
 click(alerts.querySelector('[data-pref=inPageAlerts]'));
 await frames();
 const saved = JSON.parse(localStorage.getItem('snagentsos.prefs'));
 check(saved.version === 1 && saved.vibrate === false && saved.toasts === false && saved.toastDone === true, 'the switches persist in snagentsos.prefs');
 check(alerts.querySelector('[data-pref=vibrate]').getAttribute('aria-checked') === 'false', 'Vibrate shows off');
 setLang('es');
 // Settings re-renders on its own store slice: a theme change carries the language switch.
 flushSync(() => store.getState().update({ snapshot: { ...snapshot, language: 'es', themeName: 'nord' } }));
 await frames();
 check(alerts.querySelector('[data-pref=inPageAlerts]').textContent.includes('Avisos en pantalla') && alerts.querySelector('[data-pref=toastDone]').textContent.includes('Avisar fin de turno') && alerts.querySelector('[data-pref=vibrate]').textContent.includes('Vibrar'), 'Spanish labels');
 check(noOverflow(), 'Settings fits 360px');
 setLang('en');
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
 console.log('PASS: '+checks+' mobile page alerts UI checks');w.destroy();app.quit();
}).catch(e=>{console.error(e);app.exit(1)});
`)
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
const flags = process.platform === 'linux' && process.env.CI ? ['--no-sandbox'] : []
const result = spawnSync(require('electron'), [...flags, path.join(dir, 'main.cjs')], { env, windowsHide: true, encoding: 'utf8', timeout: 90000 })
process.stdout.write(result.stdout ?? '')
process.stderr.write((result.stderr ?? '') + (result.error ? result.error.message : ''))
fs.rmSync(dir, { recursive: true, force: true })
if (result.status !== 0 || !/^PASS:/m.test(result.stdout ?? '')) process.exit(1)
