// Note, statusLine and automations on the phone (E8-FR-11, the phone half of
// E8-FR-19 and E8-FR-32; R31-02): the real LiveShell in an isolated, hidden
// browser at phone width. The WS client's sendCtl is stubbed; no socket opens.
// Checks the workspace note on one truncated line and the task chip on Home,
// the Automations entry (only while the PC has one), the Automations screen
// (rows in desktop order, repeat rule, next run or "Paused", last result,
// the Active switch with its optimistic value and snap back, "Run now" sent
// once and "Waiting..." while the desktop's run waits, the empty state), the
// Settings entry, the terminal header's `snaos status` line (else the note)
// and the Spanish labels without horizontal overflow.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path')
const { pathToFileURL } = require('node:url')
const { spawnSync } = require('node:child_process')
const root = path.resolve(__dirname, '..')
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snagentsos-mobile-automations-ui-'))
const assets = path.join(root, 'out/mobile/assets')
const mobileCss = fs.existsSync(assets) && fs.readdirSync(assets).find(name => /^index-.*\.css$/.test(name))
if (!mobileCss) throw new Error('Run npm run build:mobile first')
require('esbuild').buildSync({ stdin: { resolveDir: root, loader: 'tsx', contents: `
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { LiveShell } from './src/mobile/src/components/LiveShell';
import { store } from './src/mobile/src/lib/store';
import { client } from './src/mobile/src/lib/client';
import { setLang } from './src/mobile/src/lib/i18n';
import { useAutomationsStore } from './src/mobile/src/lib/automations';
const wait = ms => new Promise(r => setTimeout(r, ms));
const frames = () => wait(40);
let checks = 0; const check = (ok, label) => { if (!ok) throw new Error(label); checks++ };
const noOverflow = () => document.documentElement.scrollWidth <= window.innerWidth;
const $ = sel => document.querySelector(sel);
const $$ = sel => [...document.querySelectorAll(sel)];
const ptr = (el, type) => el.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, clientX: 10, clientY: 10, pointerId: 1, pointerType: 'touch', isPrimary: true, button: 0 }));
const click = el => el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 }));
const tap = el => { ptr(el, 'pointerdown'); ptr(el, 'pointerup'); click(el) };
const ctls = [];
let ackFor = () => ({ ok: true });
let release = null;
client.sendCtl = action => { ctls.push(action); const res = ackFor(action); return res === 'hold' ? new Promise(r => { release = r }) : Promise.resolve(res) };
const now = Date.now(), HOUR = 3600000;
const due = new Date(now + 26 * HOUR); due.setMinutes(0, 0, 0);
const pad = n => String(n).padStart(2, '0');
const hhmm = pad(due.getHours()) + ':' + pad(due.getMinutes());
const longNote = 'Esperando que termine el pipeline de CI en la rama release antes de mergear el cambio grande de autenticacion';
const pane = (id, title, type, extra = {}) => ({ id, title, type, color: '', icon: '', running: true, ...extra });
const base = {
 language: 'en', themeTokens: {}, fontFamily: 'mono', fontSize: 13, activeWorkspaceId: 'w1', hostName: 'ESTUDIO-PC', keyButtons: [],
 mountedWorkspaceIds: ['w1', 'w2', 'w3'],
 workspaces: [
  { id: 'w1', name: 'Api', note: longNote, taskState: 'review', layoutOrder: ['c1', 'c2'], panes: [
   pane('c1', 'Claude', 'claude', { statusLine: 'corriendo tests de integracion' }),
   pane('c2', 'Shell', 'shell'),
  ] },
  { id: 'w2', name: 'Web', layoutOrder: ['d1'], panes: [pane('d1', 'Cron job', 'shell')] },
  { id: 'w3', name: 'Docs', taskState: 'done', layoutOrder: [], panes: [] },
 ],
 schedules: [
  { workspaceId: 'w1', paneId: 'c1', time: '09:00', recurrence: { kind: 'weekdays' }, dueAt: due.getTime(), enabled: true, waitIdle: true, lastRun: { at: now - 3 * HOUR, status: 'sent', trigger: 'scheduled' } },
  { workspaceId: 'w2', paneId: 'd1', time: '07:15', recurrence: { kind: 'hourly' }, dueAt: due.getTime(), enabled: false, waitIdle: true },
  { workspaceId: 'w2', paneId: 'gone', time: '07:15', recurrence: { kind: 'daily' }, dueAt: due.getTime(), enabled: true, waitIdle: true },
 ],
};
const setSnap = snap => flushSync(() => store.getState().update({ snapshot: snap }));
window.runMain = async () => {
 try { localStorage.clear() } catch {}
 setLang('en');
 store.getState().update({ phase: 'live', snapshot: base, paneStatus: {}, connected: true, appVersion: '2.0.0', screen: 'home', activePaneId: null, subscribedPaneId: null, lastPane: null, lastViewedAt: {}, homeCollapsed: [] });
 const host = document.getElementById('root'); const r = createRoot(host);
 flushSync(() => r.render(<LiveShell />));
 await frames();

 // --- Home: note and task state (E8-FR-11) ---
 const note = $('[data-workspace=w1] [data-ws-note]');
 check(note && note.textContent === longNote && note.title === longNote, 'the workspace note shows under its name, with the full text as title');
 check(note.scrollWidth > note.clientWidth && note.getBoundingClientRect().height < 20 && getComputedStyle(note).textOverflow === 'ellipsis', 'a long note stays on one truncated line');
 const chip = $('[data-workspace=w1] [data-ws-task]');
 check(chip && chip.textContent === 'In review' && chip.className.includes('amber'), '"In review" is an amber chip next to the name');
 check($('[data-workspace=w3] [data-ws-task]').textContent === 'Done' && !$('[data-workspace=w3] [data-ws-task]').className.includes('amber'), 'other task states are neutral');
 check(!$('[data-workspace=w2] [data-ws-note]') && !$('[data-workspace=w2] [data-ws-task]'), 'no note and no state: nothing extra');
 check(noOverflow(), 'Home with a note fits 360px');

 // --- the entry shows only while the PC has an automation ---
 check(!!$('[data-home-automations]'), 'the Home header offers Automations');
 setSnap({ ...base, schedules: [] }); await frames();
 check(!$('[data-home-automations]'), 'without automations the header has no entry');
 setSnap({ ...base, schedules: undefined }); await frames();
 check(!$('[data-home-automations]'), 'an older desktop (no schedules) has no entry either');
 setSnap(base); await frames();

 // --- Automations screen (E8-FR-32) ---
 click($('[data-home-automations]')); await wait(380);
 const screen = () => $('[data-push-screen="automations"]');
 check(screen() && screen().textContent.includes('Automations'), 'the entry pushes Automations');
 const rows = () => $$('[data-auto-row]');
 check(rows().map(e => e.dataset.autoRow).join() === 'c1,d1', 'one card per automation in desktop order; one whose console is gone is dropped');
 const row = id => $('[data-auto-row=' + id + ']');
 const text = (id, sel) => row(id).querySelector(sel).textContent;
 check(text('c1', '[data-auto-ws]') === 'Api' && text('c1', '[data-auto-pane]') === 'Claude', 'workspace / console');
 check(text('c1', '[data-auto-rec]') === 'Mon-Fri' && text('d1', '[data-auto-rec]') === 'Hourly at :15', 'the repeat rule');
 check(text('c1', '[data-auto-next]').startsWith('Next: ') && text('c1', '[data-auto-next]').endsWith(hhmm) && text('d1', '[data-auto-next]') === 'Paused', 'the next run, or "Paused"');
 check(text('c1', '[data-auto-last]') === 'Sent 3h ago' && text('d1', '[data-auto-last]') === 'Never ran', 'the last result, or "Never ran"');
 const sw = id => row(id).querySelector('[data-auto-toggle]');
 check(sw('c1').getAttribute('aria-checked') === 'true' && sw('d1').getAttribute('aria-checked') === 'false', 'the Active switch mirrors enabled');
 check(rows().every(e => e.querySelector('[data-auto-run]').getBoundingClientRect().height >= 44 && sw(e.dataset.autoRow).getBoundingClientRect().height >= 44), 'switch and Run now are 44px touch targets');
 check(noOverflow(), 'Automations fits 360px');

 // The switch flips at once and holds until the desktop agrees.
 click(sw('c1')); await frames();
 check(JSON.stringify(ctls.at(-1)) === JSON.stringify({ kind: 'scheduleToggle', workspaceId: 'w1', paneId: 'c1', enabled: false }), 'the switch sends scheduleToggle with its workspace: ' + JSON.stringify(ctls.at(-1)));
 check(sw('c1').getAttribute('aria-checked') === 'false', 'it shows the new value before the snapshot');
 setSnap({ ...base, workspaces: [...base.workspaces] }); await frames();
 check(sw('c1').getAttribute('aria-checked') === 'false', 'a snapshot that has not caught up does not flip it back');
 const paused = { ...base, schedules: base.schedules.map(s => s.paneId === 'c1' ? { ...s, enabled: false } : s) };
 setSnap(paused); await frames();
 check(sw('c1').getAttribute('aria-checked') === 'false' && text('c1', '[data-auto-next]') === 'Paused', 'the desktop snapshot confirms it: Paused');
 ackFor = () => ({ ok: false, error: 'not_found' });
 click(sw('d1')); await frames();
 check(sw('d1').getAttribute('aria-checked') === 'false' && store.getState().toasts.some(t => t.text === 'That automation no longer exists on the PC'), 'a failed ack snaps back with a toast');
 ackFor = () => ({ ok: true });

 store.getState().update({ toasts: [] });
 ackFor = () => ({ ok: false, error: 'no_schedule' });
 click(sw('d1')); await frames();
 check(sw('d1').getAttribute('aria-checked') === 'false' && store.getState().toasts.some(t => t.text === 'That automation no longer exists on the PC'), 'a toggle refused with no_schedule says it is gone');
 store.getState().update({ toasts: [] });
 ackFor = () => ({ ok: false, error: 'rate' });
 click(sw('d1')); await frames();
 check(sw('d1').getAttribute('aria-checked') === 'false' && store.getState().toasts.some(t => t.text === 'The PC did not answer'), 'a rate-limited toggle snaps back with the no-reply toast');
 ackFor = () => ({ ok: true });

 // Run now: sent once, then "Waiting..." while the desktop's run waits.
 ackFor = () => 'hold';
 const run = () => row('c1').querySelector('[data-auto-run]');
 click(run()); click(run()); await frames();
 check(ctls.filter(a => a.kind === 'scheduleRun').length === 1 && JSON.stringify(ctls.at(-1)) === JSON.stringify({ kind: 'scheduleRun', workspaceId: 'w1', paneId: 'c1' }), 'Run now sends scheduleRun once, never the text');
 check(run().disabled && !!run().querySelector('.animate-spin'), 'it spins until the ack');
 release({ ok: true }); await frames();
 check(store.getState().toasts.some(t => t.text === 'Run started on the PC: Claude'), 'the ack says the run started on the PC');
 ackFor = () => ({ ok: true });
 setSnap({ ...paused, schedules: paused.schedules.map(s => s.paneId === 'c1' ? { ...s, runPending: true } : s) }); await frames();
 check(run().textContent === 'Waiting...' && run().disabled && run().dataset.pending === 'true', '"Waiting..." while the desktop waits for a free agent');
 setSnap(paused); await frames();
 check(run().textContent === 'Run now' && !run().disabled, 'back to Run now when it is done');
 ackFor = () => ({ ok: false, error: 'no_schedule' });
 click(row('d1').querySelector('[data-auto-run]')); await frames();
 check(store.getState().toasts.some(t => t.text === 'That automation no longer exists or has no prompt to send'), 'a run refused with no_schedule (gone or an empty prompt) has its own toast');
 ackFor = () => ({ ok: true });

 // Empty state, then back to Home.
 setSnap({ ...base, schedules: [] }); await frames();
 check($('[data-auto-empty]') && $('[data-auto-empty]').textContent.includes('No automations yet'), 'without automations the screen explains how to add one');
 history.back(); await wait(400);
 check(!screen() && !useAutomationsStore.getState().open, 'back closes Automations');
 setSnap(paused); await frames();

 // Settings entry: Automations opens over Settings.
 click($('[data-home-settings]')); await wait(380);
 const entry = $('[data-settings-section=automations] button');
 check(entry && entry.textContent.includes('Automations'), 'Settings lists Automations');
 click(entry); await wait(380);
 check(screen() && rows().length === 2, 'and opens the same screen over it');
 history.back(); await wait(400);
 history.back(); await wait(400);
 check(store.getState().screen === 'home', 'back, back: Home again');

 // --- terminal header: statusLine (E8-FR-19), else the note (E8-FR-11) ---
 tap($('[data-pane=c1]')); await wait(400);
 const layer = $('[data-terminal-layer]');
 const sl = layer.querySelector('[data-pane-statusline]');
 check(layer.querySelector('[data-ws-name]').textContent === 'Api' && sl && sl.textContent.includes('corriendo tests de integracion'), 'the terminal header shows the console status line after the workspace');
 check(!layer.querySelector('header [data-ws-note]'), 'the status line wins over the note');
 click(layer.querySelector('[data-terminal-back]')); await wait(400);
 tap($('[data-pane=c2]')); await wait(400);
 const hn = layer.querySelector('header [data-ws-note]');
 check(!layer.querySelector('[data-pane-statusline]') && hn && hn.textContent.includes(longNote), 'a console without a line shows the workspace note there');
 check(hn.scrollWidth > hn.clientWidth && layer.querySelector('[data-ws-name]').getBoundingClientRect().width > 0, 'the note truncates and the workspace name stays visible');
 check(noOverflow(), 'the terminal header fits 360px');
 click(layer.querySelector('[data-terminal-back]')); await wait(400);

 // --- Spanish ---
 // A real state frame is parsed JSON: every workspace is a new object.
 setLang('es'); setSnap(JSON.parse(JSON.stringify({ ...paused, language: 'es' }))); await frames();
 check($('[data-workspace=w1] [data-ws-task]').textContent === 'En revision', 'es task chip');
 click($('[data-home-automations]')); await wait(380);
 check(screen().textContent.includes('Automatizaciones') && text('c1', '[data-auto-rec]') === 'Lun-Vie' && text('c1', '[data-auto-next]') === 'Pausada' && text('c1', '[data-auto-last]') === 'Enviado hace 3h', 'es rows: Lun-Vie, Pausada, Enviado hace 3h');
 check(row('c1').querySelector('[data-auto-run]').textContent === 'Probar ahora' && sw('c1').textContent.includes('Activa'), 'es actions: Probar ahora, Activa');
 { const wide = $$('body *').filter(e => e.getBoundingClientRect().right > innerWidth + 1).slice(0, 5).map(e => e.tagName + '.' + String(e.className).slice(0, 60)); check(noOverflow(), 'es Automations fits 360px ' + JSON.stringify(wide)) }
 history.back(); await wait(400);

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
 console.log('PASS: '+checks+' mobile note, statusLine and Automations UI checks');w.destroy();app.quit();
}).catch(e=>{console.error(e);app.exit(1)});
`)
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
// Hosted Linux CI cannot use Electron's unpacked SUID helper. This flag applies
// only to the isolated, trusted fixture; the shipped application is unchanged.
const flags = process.platform === 'linux' && process.env.CI ? ['--no-sandbox'] : []
const result = spawnSync(require('electron'), [...flags, path.join(dir, 'main.cjs')], { env, windowsHide: true, encoding: 'utf8', timeout: 90000 })
process.stdout.write(result.stdout ?? '')
process.stderr.write((result.stderr ?? '') + (result.error ? result.error.message : ''))
fs.rmSync(dir, { recursive: true, force: true })
if (result.status !== 0 || !/^PASS:/m.test(result.stdout ?? '')) process.exit(1)
