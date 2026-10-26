// Render the phone's agent status UI (E1-FR-04..06, 40) with the production
// CSS in an isolated offscreen browser at phone width: the six indicator
// shapes and their state tokens, the Home rows' second line and one-line
// preview (E2-FR-05), the "N waiting" pill, the per-pane actions header, and
// the spinning ring standing still under prefers-reduced-motion.
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
import { HomeScreen } from './src/mobile/src/components/HomeScreen';
import { PaneActionList } from './src/mobile/src/components/PaneActionList';
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
 // v2.3: an answered action (attention false) draws like the desktop: working, or idle when title-only.
 flushSync(() => root.render(<div><StatusIndicator status={{ state: 'action', stateSince: 0, attention: false }} /><StatusIndicator status={{ state: 'action', stateSince: 0, attention: false, precise: false }} /></div>));
 await frames();
 check([...host.querySelectorAll('[role=img]')].map(g => g.getAttribute('data-state')).join() === 'working,idle', 'answered action: data-state working, idle when title-only');
 check(host.querySelector('[data-state=working]').getAttribute('aria-label') === 'Claude: working', 'and its label says working');

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
 flushSync(() => root.render(<div><header style={{ display: 'flex' }}><WaitingPill /></header><HomeScreen /></div>));
 await frames();
 const pill = host.querySelector('[data-waiting]');
 check(pill && pill.textContent === '1 waiting', 'viewing one of two waiting panes, the pill says "1 waiting" (got ' + (pill && pill.textContent) + ')');
 check(pill.closest('[aria-live=polite]'), 'the pill sits in a polite live region');
 const row = id => host.querySelector('[data-pane=' + id + ']');
 check(row('a1').querySelector('[data-status-line]').textContent === 'Waiting for permission', 'a permission row reads "Waiting for permission"');
 check(row('a2').querySelector('[data-status-line]').textContent === 'Done 3m ago', 'a done row reads "Done 3m ago"');
 check(row('b1').querySelector('[data-status-line]').textContent === 'Question pending', 'a question row reads "Question pending"');
 check(!row('b2').querySelector('[role=img]') && row('b2').querySelector('[data-status-line]').textContent === 'Idle', 'a running pane without status has no indicator and reads Idle');
 check(!row('a1').querySelector('[data-last-message]'), 'a pane in action shows no preview (only done or idle do)');
 const preview = row('a2').querySelector('[data-last-message]');
 const lh = parseFloat(getComputedStyle(preview).lineHeight);
 check(preview.getBoundingClientRect().height <= lh + 1, 'the preview is cut to one line');
 check(noOverflow(), 'Home fits 360px without horizontal overflow');
 check(row('a1').className.includes('accent-violet'), 'the viewed console is highlighted');

 flushSync(() => store.getState().update({ activePaneId: 'b2', paneStatus: { ...paneStatus } }));
 await frames();
 check(host.querySelector('[data-waiting]').textContent === '2 waiting', 'from another pane both waiting consoles count');
 check(row('b2').className.includes('accent-violet') && !row('a1').className.includes('accent-violet'), 'the highlight follows the viewed pane into another workspace');
 flushSync(() => store.getState().update({ paneStatus: {} }));
 await frames();
 check(!host.querySelector('[data-waiting]'), 'with nothing waiting the pill disappears');

 // v2.3 attention: a request answered on the desktop (attention false) clears the pill, the header badge and the unread row.
 const badge = ws => host.querySelector('[data-workspace=' + ws + '] [data-ws-badge]');
 flushSync(() => store.getState().update({ paneStatus: { ...paneStatus, a1: { ...paneStatus.a1, attention: true }, b1: { ...paneStatus.b1, attention: false }, a2: { ...paneStatus.a2, attention: true } } }));
 await frames();
 // app 2.7.0: the desktop's rule, so the done nobody saw (attention true) counts with the open request.
 check(host.querySelector('[data-waiting]').textContent === '2 waiting' && badge('w1') && badge('w1').textContent === '2' && !badge('w2'), 'an answered action leaves the pill and its workspace badge; the unseen done stays in both (got ' + (host.querySelector('[data-waiting]') || {}).textContent + ')');
 check(row('a2').hasAttribute('data-unread') && row('b1').querySelector('[data-status-line]').textContent.startsWith('Working') && row('b1').querySelector('[data-state]').getAttribute('data-state') === 'working', 'an unseen done is unread; the answered row reads working, line and glyph, as on the desktop (got ' + row('b1').querySelector('[data-status-line]').textContent + ')');
 flushSync(() => store.getState().update({ paneStatus: { ...paneStatus, a1: { ...paneStatus.a1, attention: false }, b1: { ...paneStatus.b1, attention: false }, a2: { ...paneStatus.a2, attention: false } } }));
 await frames();
 check(!host.querySelector('[data-waiting]') && !badge('w1') && !badge('w2'), 'with the only waiting console answered the pill and the red badge go');
 check(!row('a2').hasAttribute('data-unread'), 'a done seen on the desktop is not unread on the phone');
 check(noOverflow(), 'Home still fits 360px');

 setLang('es');
 flushSync(() => store.getState().update({ activePaneId: 'a1', paneStatus }));
 await frames();
 check(host.querySelector('[data-waiting]').textContent === '1 esperando', 'the pill is translated');
 check(row('a1').querySelector('[data-status-line]').textContent === 'Esperando permiso', 'the second line is translated');
 setLang('en');

 flushSync(() => root.render(<PaneActionList target={{ workspaceId: 'w1', paneId: 'a1' }} onClose={() => {}} />));
 await frames();
 const head = document.querySelector('[data-action-header]');
 check(head && head.textContent.includes('Viewed console') && head.textContent.includes('Front') && head.textContent.includes('Run the tests?') && head.querySelector('[role=img][data-state=action]'), 'the per-pane actions header shows title, workspace, status and last reply');
 check(noOverflow(), 'the actions fit 360px');
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
