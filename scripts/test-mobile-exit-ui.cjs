// Phone exit strip and "exited" console tag (E6-FR-20/38) rendered with the
// production mobile CSS in an isolated offscreen window at 360 px: the strip
// shows for the viewed pane only, [Restart] / [Close] send the right ctl (Close
// behind the confirmation sheet), and the drawer tags a pane that ended on its
// own instead of spinning. The WS client's sendCtl is stubbed; no socket opens.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path')
const { pathToFileURL } = require('node:url')
const { spawnSync } = require('node:child_process')
const root = path.resolve(__dirname, '..')
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snagentsos-exit-ui-'))
const assets = path.join(root, 'out/mobile/assets')
const mobileCss = fs.existsSync(assets) && fs.readdirSync(assets).find(name => /^index-.*\.css$/.test(name))
if (!mobileCss) throw new Error('Run npm run build:mobile first')
require('esbuild').buildSync({ stdin: { resolveDir: root, loader: 'tsx', contents: `
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { ExitStrip } from './src/mobile/src/components/ExitStrip';
import { HomeScreen } from './src/mobile/src/components/HomeScreen';
import { store } from './src/mobile/src/lib/store';
import { useExitStore } from './src/mobile/src/lib/exitState';
import { client } from './src/mobile/src/lib/client';
import { setLang } from './src/mobile/src/lib/i18n';
window.result = (async () => {
 const frames = () => new Promise(r => setTimeout(r, 16));
 let checks = 0; const check = (ok, label) => { if (!ok) throw new Error(label); checks++ };
 const sent = [];
 client.sendCtl = async (action) => { sent.push(action); return { ok: true } };
 const host = document.getElementById('root'); const root = createRoot(host);
 const noOverflow = () => document.documentElement.scrollWidth <= window.innerWidth;
 const pane = (id, title, running, exitCode) => ({ id, title, type: 'shell', color: '#6366f1', icon: 'terminal', running, ...(exitCode === undefined ? {} : { exitCode }) });
 const snapshot = { language: 'en', themeTokens: {}, fontFamily: 'mono', fontSize: 13, keyButtons: [], activeWorkspaceId: 'w1',
  workspaces: [
   { id: 'w1', name: 'Uno', layoutOrder: ['a', 'b'], panes: [pane('a', 'PowerShell', false), pane('b', 'Claude', true)] },
   { id: 'w2', name: 'Dos', layoutOrder: ['c', 'd'], panes: [pane('c', 'Build con un nombre bastante largo', false, 1), pane('d', 'Nunca abierta', false)] },
  ] };
 flushSync(() => store.getState().update({ snapshot, activePaneId: 'a', subscribedPaneId: 'a', phase: 'live', connected: true }));
 flushSync(() => root.render(<div style={{ position: 'relative', height: '640px', display: 'flex', flexDirection: 'column', justifyContent: 'flex-end' }}><ExitStrip /></div>));
 check(!host.querySelector('[data-exit-strip]'), 'no strip while the console runs');
 flushSync(() => useExitStore.getState().setExit({ paneId: 'a', exitCode: 3 })); await frames();
 const strip = host.querySelector('[data-exit-strip]');
 check(strip && strip.textContent.includes('The console exited (code 3)') && strip.textContent.includes('Restart') && strip.textContent.includes('Close'), 'strip with code, Restart and Close');
 check(noOverflow() && strip.getBoundingClientRect().right <= 360, 'strip fits 360 px');
 strip.querySelector('[data-exit-restart]').click(); await frames();
 check(sent.length === 1 && sent[0].kind === 'restartPane' && sent[0].workspaceId === 'w1' && sent[0].paneId === 'a', 'Restart sends restartPane for the viewed pane');
 [...strip.querySelectorAll('button')].find(b => b.textContent.includes('Close')).click(); await frames();
 check(sent.length === 1 && document.body.textContent.includes('Its output will be lost'), 'Close asks for confirmation first');
 [...document.querySelectorAll('button')].filter(b => b.textContent === 'Confirm').pop().click(); await frames();
 check(sent.length === 2 && sent[1].kind === 'closePane' && sent[1].paneId === 'a' && sent[1].workspaceId === 'w1', 'confirming sends closePane');
 flushSync(() => useExitStore.getState().setExit({ paneId: 'b', exitCode: 1 })); await frames();
 check(!host.querySelector('[data-exit-strip]'), 'an exit of another pane shows no strip here');
 setLang('es'); flushSync(() => useExitStore.getState().setExit({ paneId: 'a', exitCode: 0 })); await frames();
 check(host.querySelector('[data-exit-strip]').textContent.includes('La consola terminó (código 0)') && host.textContent.includes('Reiniciar'), 'strip is translated');
 setLang('en');
 // Home rows (E2-FR-05): exited from RemotePaneInfo.exitCode and from the viewed pane's strip.
 flushSync(() => useExitStore.getState().setExit({ paneId: 'a', exitCode: 3 }));
 flushSync(() => root.render(<HomeScreen />)); await frames();
 const rows = () => [...document.querySelectorAll('[data-pane]')].map(r => ({ t: r.textContent, line: r.querySelector('[data-status-line]').textContent, exited: !!r.querySelector('[data-pane-exited]') }));
 const row = t => rows().find(r => r.t.includes(t));
 check(row('PowerShell').exited && row('PowerShell').line.startsWith('Exited (code 3)'), 'the viewed pane that exited (strip only) reads "Exited (code 3)"');
 check(row('Claude').line === 'Idle' && !row('Claude').exited, 'a running pane without status reads Idle');
 check(row('Build con').exited && row('Build con').line.startsWith('Exited (code 1)'), 'a pane of another workspace with exitCode reads exited');
 check(!row('Nunca').exited && row('Nunca').line === 'Not started', 'a never started pane of an unmounted workspace reads "Not started"');
 check(noOverflow(), 'Home fits 360 px');
 flushSync(() => useExitStore.getState().setExit(null)); await frames();
 check(!row('PowerShell').exited && row('PowerShell').line === 'Stopped', 'without an exit a stopped pane of the mounted workspace reads Stopped');
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
 console.log('PASS: '+checks+' mobile exit strip and exited tag checks');w.destroy();app.quit();
}).catch(e=>{console.error(e);app.exit(1)});
`)
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
const flags = process.platform === 'linux' && process.env.CI ? ['--no-sandbox'] : []
const result = spawnSync(require('electron'), [...flags, path.join(dir, 'main.cjs')], { env, windowsHide: true, encoding: 'utf8', timeout: 20000 })
process.stdout.write(result.stdout ?? '')
process.stderr.write((result.stderr ?? '') + (result.error ? result.error.message : ''))
if (result.status !== 0 || !/^PASS:/m.test(result.stdout ?? '')) process.exit(1)
fs.rmSync(dir, { recursive: true, force: true })
