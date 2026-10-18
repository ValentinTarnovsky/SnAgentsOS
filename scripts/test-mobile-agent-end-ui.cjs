// Phone "Claude exited" strip (E6-FR-24, R22-20) rendered with the production
// mobile CSS in an isolated offscreen window at 360 px: it shows only while the
// snapshot carries `agentEnded` for the viewed pane (and no exit strip), offers
// [Resume] only with canResume, sends ctl agentResume with the pane's
// workspace, turns a `stale` ack into a toast and [Hide] hides it on this phone
// until the offer goes away. The WS client's sendCtl is stubbed; no socket opens.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path')
const { pathToFileURL } = require('node:url')
const { spawnSync } = require('node:child_process')
const root = path.resolve(__dirname, '..')
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snagentsos-agent-end-ui-'))
const assets = path.join(root, 'out/mobile/assets')
const mobileCss = fs.existsSync(assets) && fs.readdirSync(assets).find(name => /^index-.*\.css$/.test(name))
if (!mobileCss) throw new Error('Run npm run build:mobile first')
require('esbuild').buildSync({ stdin: { resolveDir: root, loader: 'tsx', contents: `
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { AgentEndStrip } from './src/mobile/src/components/AgentEndStrip';
import { ExitStrip } from './src/mobile/src/components/ExitStrip';
import { store } from './src/mobile/src/lib/store';
import { useExitStore } from './src/mobile/src/lib/exitState';
import { client } from './src/mobile/src/lib/client';
import { setLang } from './src/mobile/src/lib/i18n';
window.result = (async () => {
 const frames = () => new Promise(r => setTimeout(r, 16));
 let checks = 0; const check = (ok, label) => { if (!ok) throw new Error(label); checks++ };
 const sent = []; let reply = { ok: true };
 client.sendCtl = async (action) => { sent.push(action); return reply };
 const host = document.getElementById('root'); const root = createRoot(host);
 const noOverflow = () => document.documentElement.scrollWidth <= window.innerWidth;
 const pane = (id, title, agentEnded) => ({ id, title, type: 'claude', color: '#d97757', icon: 'claude', running: true, ...(agentEnded ? { agentEnded } : {}) });
 const snap = (a, b, c) => ({ language: 'en', themeTokens: {}, fontFamily: 'mono', fontSize: 13, keyButtons: [], activeWorkspaceId: 'w1',
  workspaces: [
   { id: 'w1', name: 'Uno', layoutOrder: ['a', 'b'], panes: [pane('a', 'Claude', a), pane('b', 'Otro', b)] },
   { id: 'w2', name: 'Dos', layoutOrder: ['c'], panes: [pane('c', 'Claude dos', c)] },
  ] });
 const setSnap = (s, extra = {}) => flushSync(() => store.getState().update({ snapshot: s, ...extra }));
 const strip = () => host.querySelector('[data-agent-end-strip]');
 const btn = (k) => strip()?.querySelector('[data-agent-end="' + k + '"]');
 setSnap(snap(), { activePaneId: 'a', subscribedPaneId: 'a', phase: 'live', connected: true });
 // The app re-renders the strip with MainScreen on every snapshot (language included).
 const mount = () => flushSync(() => root.render(<div style={{ position: 'relative', height: '640px', display: 'flex', flexDirection: 'column', justifyContent: 'flex-end' }}><ExitStrip /><AgentEndStrip /></div>));
 mount();
 await frames();
 check(!strip(), 'no strip while the session is live');
 setSnap(snap(undefined, { canResume: true })); await frames();
 check(!strip(), 'an offer on another pane shows nothing here');
 setSnap(snap({ canResume: true })); await frames();
 check(strip() && strip().textContent.includes('Claude exited') && btn('resume') && btn('new') && btn('hide'), 'the offer of the viewed pane shows Claude exited with Resume, New and Hide');
 check(noOverflow() && strip().getBoundingClientRect().right <= 360, 'strip fits 360 px');
 btn('resume').click(); await frames();
 check(sent.length === 1 && JSON.stringify(sent[0]) === JSON.stringify({ kind: 'agentResume', workspaceId: 'w1', paneId: 'a', mode: 'resume' }), 'Resume sends agentResume resume for the viewed pane and its workspace');
 reply = { ok: false, error: 'stale' };
 btn('new').click(); await frames(); await frames();
 check(sent.length === 2 && sent[1].mode === 'new' && store.getState().toast === 'Already answered from another device', 'New sends agentResume new; a stale ack becomes a toast');
 reply = { ok: false, error: 'not_running' };
 btn('new').click(); await frames(); await frames();
 check(store.getState().toast === 'The PC could not do it', 'another error shows the generic failure toast');
 reply = { ok: true };
 setSnap(snap({ canResume: false })); await frames();
 check(strip() && !btn('resume') && btn('new'), 'canResume false leaves only New');
 // The exit strip wins for the same pane.
 flushSync(() => useExitStore.getState().setExit({ paneId: 'a', exitCode: 0 })); await frames();
 check(!strip() && host.querySelector('[data-exit-strip]'), 'with the exit strip up the Claude strip hides');
 flushSync(() => useExitStore.getState().setExit(null)); await frames();
 check(strip(), 'and comes back without it');
 // Hide: local only, until the offer goes away.
 btn('hide').click(); await frames();
 check(!strip() && sent.length === 3, 'Hide hides it without telling the desktop');
 setSnap(snap({ canResume: true })); await frames();
 check(!strip(), 'a later push of the same offer stays hidden');
 setSnap(snap()); await frames();
 setSnap(snap({ canResume: true })); await frames();
 check(strip(), 'a new offer shows it again');
 // Another viewed pane in another workspace sends its own workspace.
 setSnap(snap(undefined, undefined, { canResume: true }), { activePaneId: 'c', subscribedPaneId: 'c' }); await frames();
 btn('new').click(); await frames();
 check(sent.at(-1).workspaceId === 'w2' && sent.at(-1).paneId === 'c', 'the ctl carries the viewed pane\\'s own workspace');
 setLang('es'); setSnap({ ...snap(undefined, undefined, { canResume: true }), language: 'es' }); mount(); await frames();
 check(strip().textContent.includes('Claude termino') && btn('resume').textContent.includes('Retomar') && btn('new').textContent.includes('Nueva'), 'strip is translated');
 setLang('en');
 return checks;
})();
` }, bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic', define: { __APP_VERSION__: '"2.0.0"', 'process.env.NODE_ENV': '"production"' }, alias: { '@shared': path.join(root, 'src/shared') }, outfile: path.join(dir, 'renderer.js') })
fs.writeFileSync(path.join(dir, 'index.html'), `<html><head><meta charset="utf-8"><link rel="stylesheet" href="${pathToFileURL(path.join(assets, mobileCss))}"></head><body><div id="root"></div><script src="renderer.js"></script></body></html>`)
fs.writeFileSync(path.join(dir, 'main.cjs'), `
const {app,BrowserWindow}=require('electron');const path=require('path');
app.setPath('userData',path.join(__dirname,'profile'));
app.whenReady().then(async()=>{
 const w=new BrowserWindow({show:false,width:360,height:640,useContentSize:true,webPreferences:{sandbox:true,backgroundThrottling:false}});
 await w.loadFile(path.join(__dirname,'index.html'));
 const checks=await w.webContents.executeJavaScript('window.result');
 console.log('PASS: '+checks+' mobile Claude exited strip checks');w.destroy();app.quit();
}).catch(e=>{console.error(e);app.exit(1)});
`)
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
const flags = process.platform === 'linux' && process.env.CI ? ['--no-sandbox'] : []
const result = spawnSync(require('electron'), [...flags, path.join(dir, 'main.cjs')], { env, windowsHide: true, encoding: 'utf8', timeout: 20000 })
process.stdout.write(result.stdout ?? '')
process.stderr.write((result.stderr ?? '') + (result.error ? result.error.message : ''))
if (result.status !== 0 || !/^PASS:/m.test(result.stdout ?? '')) process.exit(1)
fs.rmSync(dir, { recursive: true, force: true })
