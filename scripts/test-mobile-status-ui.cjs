// Render the phone's agent status UI (E1-FR-04..06, 40) with the production
// CSS in an isolated offscreen browser at phone width: the six indicator
// shapes and their state tokens, the drawer's second line and clamped preview,
// the "N waiting" pill, the action sheet header, the Alerts toggle, and the
// spinning ring standing still under prefers-reduced-motion.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path')
const { pathToFileURL } = require('node:url')
const { spawnSync } = require('node:child_process')
const root = path.resolve(__dirname, '..')
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snagentsos-status-ui-'))
const assets = path.join(root, 'out/mobile/assets')
const mobileCss = fs.existsSync(assets) && fs.readdirSync(assets).find(name => /^index-.*\.css$/.test(name))
if (!mobileCss) throw new Error('Run npm run build:mobile first')
require('esbuild').buildSync({ stdin: { resolveDir: root, loader: 'tsx', contents: `
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { StatusIndicator } from './src/mobile/src/components/StatusIndicator';
import { WaitingPill } from './src/mobile/src/components/WaitingPill';
import { ConsoleDrawer } from './src/mobile/src/components/ConsoleDrawer';
import { ActionSheet } from './src/mobile/src/components/ActionSheet';
import { store } from './src/mobile/src/lib/store';
import { setLang } from './src/mobile/src/lib/i18n';
const frames = () => new Promise(r => setTimeout(r, 16));
let checks = 0; const check = (ok, label) => { if (!ok) throw new Error(label); checks++ };
const noOverflow = () => document.documentElement.scrollWidth <= window.innerWidth;
const MIN = 60000;
window.result = (async () => {
 const host = document.getElementById('root'); const root = createRoot(host);
 const states = ['working', 'action', 'done', 'error', 'idle', 'unknown'];
 flushSync(() => root.render(<div>{states.map(s => <StatusIndicator key={s} status={{ state: s, stateSince: 0 }} />)}<StatusIndicator /></div>));
 await frames();
 const glyphs = [...host.querySelectorAll('[role=img]')];
 check(glyphs.length === 6, 'six indicators, none without a status');
 const inner = s => host.querySelector('[data-state=' + s + '] > span');
 const bg = s => getComputedStyle(inner(s)).backgroundColor;
 check(host.querySelector('[data-state=working]').getAttribute('aria-label') === 'Claude: working', 'aria label "Claude: working"');
 check(getComputedStyle(inner('working')).borderLeftColor === 'rgb(139, 92, 246)' && getComputedStyle(inner('working')).animationName === 'spin', 'working = violet ring that spins');
 check(getComputedStyle(inner('working')).animationDuration === '0.8s', 'the ring turns every 0.8s');
 check(bg('action') === 'rgb(245, 158, 11)' && getComputedStyle(inner('action')).boxShadow !== 'none', 'action = amber dot with halo');
 check(bg('done') === 'rgb(34, 197, 94)', 'done = green dot');
 check(bg('error') === 'rgb(239, 68, 68)' && getComputedStyle(inner('error')).boxShadow !== 'none', 'error = red dot with halo');
 check(/rgba\\(107, 114, 128, 0\\.4|oklab|color-mix/.test(bg('idle')) || bg('idle').includes('0.4'), 'idle = grey at 40% (got ' + bg('idle') + ')');
 check(getComputedStyle(inner('unknown')).backgroundColor === 'rgba(0, 0, 0, 0)' && getComputedStyle(inner('unknown')).boxShadow !== 'none', 'unknown = hollow ring');
 check(host.querySelector('[data-state=working]').getBoundingClientRect().width === 12, 'indicator is 12px');

 const now = Date.now();
 const snapshot = {
  language: 'en', themeTokens: {}, fontFamily: 'mono', fontSize: 13, activeWorkspaceId: 'w1',
  workspaces: [
   { id: 'w1', name: 'Front', layoutOrder: ['a1', 'a2'], panes: [
    { id: 'a1', title: 'Viewed console', type: 'claude', color: '', icon: '', running: true },
    { id: 'a2', title: 'Builder', type: 'claude', color: '', icon: '', running: true },
   ] },
   { id: 'w2', name: 'Back', layoutOrder: ['b1', 'b2'], panes: [
    { id: 'b1', title: 'Reviewer', type: 'claude', color: '', icon: '', running: true },
    { id: 'b2', title: 'Shell', type: 'shell', color: '', icon: '', running: true },
   ] },
  ],
 };
 const long = 'This is a very long assistant reply that keeps going and going so that it needs far more than two lines in a phone sized drawer row, and the clamp must cut it off cleanly without pushing the layout sideways at all.';
 const paneStatus = {
  a1: { state: 'action', reason: 'permission', stateSince: now - MIN, lastMessage: 'Run the tests?' },
  a2: { state: 'done', stateSince: now - 3 * MIN, lastMessage: long },
  b1: { state: 'action', reason: 'question', stateSince: now - 2 * MIN },
 };
 flushSync(() => store.getState().update({ phase: 'live', snapshot, paneStatus, activePaneId: 'a1', subscribedPaneId: 'a1', connected: true }));
 flushSync(() => root.render(<div><header style={{ display: 'flex' }}><WaitingPill /></header><ConsoleDrawer open={true} onClose={() => {}} /></div>));
 await frames();
 const pill = host.querySelector('[data-waiting]');
 check(pill && pill.textContent === '1 waiting', 'viewing one of two waiting panes, the pill says "1 waiting" (got ' + (pill && pill.textContent) + ')');
 check(pill.closest('[aria-live=polite]'), 'the pill sits in a polite live region');
 const row = id => host.querySelector('[data-pane=' + id + ']');
 check(row('a1').querySelector('[data-status-line]').textContent === 'Waiting for permission', 'a permission row reads "Waiting for permission"');
 check(row('a2').querySelector('[data-status-line]').textContent === 'Done 3m ago', 'a done row reads "Done 3m ago"');
 check(row('b1').querySelector('[data-status-line]').textContent === 'Question', 'a question row reads "Question"');
 check(!row('b2').querySelector('[role=img]') && !row('b2').querySelector('[data-status-line]'), 'a pane without status has no indicator or second line');
 const preview = row('a2').querySelector('[data-last-message]');
 const lh = parseFloat(getComputedStyle(preview).lineHeight);
 check(preview.getBoundingClientRect().height <= lh * 2 + 1, 'the preview is clamped to two lines');
 check(noOverflow(), 'drawer fits 360px without horizontal overflow');
 check(host.querySelector('[data-workspace=w1] span').className.includes('accent-violet'), 'the viewed workspace is highlighted');

 flushSync(() => store.getState().update({ activePaneId: 'b2', paneStatus: { ...paneStatus } }));
 await frames();
 check(host.querySelector('[data-waiting]').textContent === '2 waiting', 'from another pane both waiting consoles count');
 check(host.querySelector('[data-workspace=w2] span').className.includes('accent-violet'), 'the highlight follows the viewed pane into another workspace');
 flushSync(() => store.getState().update({ paneStatus: {} }));
 await frames();
 check(!host.querySelector('[data-waiting]'), 'with nothing waiting the pill disappears');

 setLang('es');
 flushSync(() => store.getState().update({ activePaneId: 'a1', paneStatus }));
 await frames();
 check(host.querySelector('[data-waiting]').textContent === '1 esperando', 'the pill is translated');
 check(row('a1').querySelector('[data-status-line]').textContent === 'Esperando permiso', 'the second line is translated');
 setLang('en');

 flushSync(() => root.render(<ActionSheet open={true} onClose={() => {}} />));
 await frames();
 const head = host.querySelector('[data-action-status]');
 check(head && head.textContent.includes('Viewed console') && head.textContent.includes('Waiting for permission') && head.textContent.includes('Run the tests?'), 'the action sheet header shows status and last reply');
 check(noOverflow(), 'action sheet fits 360px');
 return checks;
})();
window.reducedCheck = () => {
 const ring = document.querySelector('[data-state=working] > span') || (() => {
  const el = document.createElement('span'); el.className = 'spin'; document.body.appendChild(el); return el })();
 const cs = getComputedStyle(ring);
 if (!(cs.animationIterationCount === '1' && parseFloat(cs.animationDuration) < 0.01)) throw new Error('reduced motion keeps the ring still (got ' + cs.animationIterationCount + ' / ' + cs.animationDuration + ')');
 return 1;
};
` }, bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic', define: { __APP_VERSION__: '"2.0.0"', 'process.env.NODE_ENV': '"production"' }, alias: { '@shared': path.join(root, 'src/shared') }, outfile: path.join(dir, 'renderer.js') })
fs.writeFileSync(path.join(dir, 'index.html'), `<html><head><meta charset="utf-8"><link rel="stylesheet" href="${pathToFileURL(path.join(assets, mobileCss))}"></head><body><div id="root"></div><script src="renderer.js"></script></body></html>`)
fs.writeFileSync(path.join(dir, 'main.cjs'), `
const {app,BrowserWindow}=require('electron');const path=require('path');
app.setPath('userData',path.join(__dirname,'profile'));
app.whenReady().then(async()=>{
 const w=new BrowserWindow({show:false,width:360,height:640,useContentSize:true,webPreferences:{sandbox:true,backgroundThrottling:false}});
 await w.loadFile(path.join(__dirname,'index.html'));
 let checks=await w.webContents.executeJavaScript('window.result');
 w.webContents.debugger.attach('1.3');
 await w.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
 checks+=await w.webContents.executeJavaScript('window.reducedCheck()');
 console.log('PASS: '+checks+' mobile agent status UI checks');w.destroy();app.quit();
}).catch(e=>{console.error(e);app.exit(1)});
`)
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
const flags = process.platform === 'linux' && process.env.CI ? ['--no-sandbox'] : []
const result = spawnSync(require('electron'), [...flags, path.join(dir, 'main.cjs')], { env, windowsHide: true, encoding: 'utf8', timeout: 20000 })
process.stdout.write(result.stdout ?? '')
process.stderr.write((result.stderr ?? '') + (result.error ? result.error.message : ''))
fs.rmSync(dir, { recursive: true, force: true })
if (result.status !== 0 || !/^PASS:/m.test(result.stdout ?? '')) process.exit(1)
