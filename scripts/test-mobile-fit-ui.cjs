// Phone mode chip and settings (E3-FR-13..18) rendered with the production
// mobile CSS in an isolated offscreen window at 360x640: the header chip
// (Monitor by default) fits next to the title, a tap switches to phone mode
// (saved per pane) and the real RemoteTerminal sends one fitPane for its grid
// after 150ms; the confirming fitState renders the grid without horizontal
// pan; another device's size turns the chip into "Another device controls
// the size" and a tap takes it back; the PC taking the size back returns to
// desktop mode with its toast; leaving phone mode sends releaseFit; Settings
// has the "Fit consoles to the phone" switch and the 11..16 text sizes, in
// en/es. The WS client's sendCtl is stubbed; no socket opens.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path')
const { pathToFileURL } = require('node:url')
const { spawnSync } = require('node:child_process')
const root = path.resolve(__dirname, '..')
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snagentsos-fit-mobile-ui-'))
const assets = path.join(root, 'out/mobile/assets')
const mobileCss = fs.existsSync(assets) && fs.readdirSync(assets).find(name => /^index-.*\.css$/.test(name))
if (!mobileCss) throw new Error('Run npm run build:mobile first')
require('esbuild').buildSync({ stdin: { resolveDir: root, loader: 'tsx', contents: `
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { MainScreen } from './src/mobile/src/components/MainScreen';
import { SettingsScreen } from './src/mobile/src/components/SettingsScreen';
import { store } from './src/mobile/src/lib/store';
import { client } from './src/mobile/src/lib/client';
import { setLang } from './src/mobile/src/lib/i18n';
window.result = (async () => {
 const wait = ms => new Promise(r => setTimeout(r, ms));
 let checks = 0; const check = (ok, label) => { if (!ok) throw new Error(label); checks++ };
 const sent = [];
 client.sendCtl = async (action) => { sent.push(action); return { ok: true } };
 const fitState = (owner, cols, rows) => client['handleFitState']({ v: 1, type: 'fitState', paneId: 'a', owner, cols, rows });
 const host = document.getElementById('root'); const root = createRoot(host);
 const noOverflow = () => document.documentElement.scrollWidth <= window.innerWidth;
 const pane = (id, title) => ({ id, title, type: 'claude', color: '#6366f1', icon: 'claude', running: true });
 const snapshot = { language: 'en', themeTokens: {}, fontFamily: 'mono', fontSize: 13, keyButtons: [], activeWorkspaceId: 'w1',
  workspaces: [{ id: 'w1', name: 'Uno', layoutOrder: ['a', 'b'], panes: [pane('a', 'Claude con un titulo largo de verdad'), pane('b', 'Shell')] }] };
 flushSync(() => store.getState().update({ snapshot, activePaneId: 'a', subscribedPaneId: 'a', phase: 'live', connected: true, screen: 'terminal' }));
 flushSync(() => root.render(<MainScreen onBack={() => {}} />)); await wait(300);
 const chip = () => host.querySelector('[data-fit-mode]');
 check(chip() && chip().dataset.fitMode === 'desktop' && chip().getAttribute('aria-label') === 'Desktop mode', 'the chip starts in desktop mode (phoneFitDefault off)');
 check(noOverflow() && chip().getBoundingClientRect().right <= 360, 'the header fits 360 px with the chip');
 const fits = sent.filter(a => a.kind === 'fitPane');
 check(fits.length === 0, 'desktop mode sends no fitPane');
 chip().click(); await wait(80);
 check(chip().dataset.fitMode === 'phone' && localStorage.getItem('snagentsos.remote.paneMode.a') === 'phone', 'a tap switches to phone mode and saves it for the pane');
 check(sent.filter(a => a.kind === 'fitPane').length === 0, 'nothing before the 150ms debounce');
 await wait(200);
 const fp = sent.filter(a => a.kind === 'fitPane');
 check(fp.length === 1 && fp[0].workspaceId === 'w1' && fp[0].paneId === 'a' && fp[0].cols >= 20 && fp[0].cols <= 60 && fp[0].rows >= 8, 'one fitPane for the phone grid ' + JSON.stringify(fp[0]));
 fitState('phone', fp[0].cols, fp[0].rows); await wait(300);
 const screen = host.querySelector('.xterm-screen').getBoundingClientRect();
 const scroller = host.querySelector('[data-scrollable]');
 check(screen.width <= 360 + 0.5 && scroller.scrollLeft === 0 && noOverflow(), 'the confirmed grid renders without horizontal pan (' + screen.width.toFixed(1) + 'px)');
 const after = sent.filter(a => a.kind === 'fitPane').length;
 check(after <= 2, 'at most one correction once the real cell is measured');
 // Another device takes control (FR-16).
 fitState('phone', fp[0].cols - 7, fp[0].rows); await wait(100);
 check(chip().dataset.fitMode === 'other' && chip().textContent.includes('Another device controls the size'), 'another size: "Another device controls the size"');
 check(noOverflow() && chip().getBoundingClientRect().right <= 360, 'the long chip still fits the header');
 const before = sent.filter(a => a.kind === 'fitPane').length;
 chip().click(); await wait(250);
 check(sent.filter(a => a.kind === 'fitPane').length === before + 1, 'a tap on it takes control back with a new fitPane');
 const last = sent.filter(a => a.kind === 'fitPane').at(-1);
 fitState('phone', last.cols, last.rows); await wait(100);
 check(chip().dataset.fitMode === 'phone', 'back to phone mode as owner');
 // The PC takes the size back (FR-18).
 fitState('desktop', 120, 40); await wait(150);
 check(chip().dataset.fitMode === 'desktop' && localStorage.getItem('snagentsos.remote.paneMode.a') === 'desktop' && document.body.textContent.includes('The PC took the size back'), 'fitState desktop: desktop mode, saved, with the toast');
 // Leaving phone mode as owner sends releaseFit.
 chip().click(); await wait(250);
 const own = sent.filter(a => a.kind === 'fitPane').at(-1);
 fitState('phone', own.cols, own.rows); await wait(100);
 chip().click(); await wait(80);
 check(sent.at(-1).kind === 'releaseFit' && sent.at(-1).paneId === 'a' && chip().dataset.fitMode === 'desktop', 'switching to desktop mode while owning sends releaseFit');
 // Settings (FR-13/14).
 flushSync(() => root.render(<SettingsScreen open onClose={() => {}} />)); await wait(400);
 const sec = document.querySelector('[data-settings-section=phoneFit]');
 check(sec && sec.textContent.includes('Fit consoles to the phone') && sec.textContent.includes('Phone mode text size: 13px'), 'Settings: the switch and the text size row');
 const sizes = [...sec.querySelectorAll('[data-px]')].map(b => b.dataset.px).join();
 check(sizes === '11,12,13,14,16', 'text sizes 11/12/13/14/16');
 sec.querySelector('[data-px="16"]').click(); sec.querySelector('[data-pref=phoneFitDefault]').click(); await wait(80);
 check(store.getState().phoneFontSize === 16 && localStorage.getItem('snagentsos.remote.phoneFontSize') === '16' && store.getState().phoneFitDefault === true, 'choices are applied and saved');
 check(noOverflow(), 'Settings fits 360 px');
 setLang('es'); flushSync(() => root.render(<SettingsScreen open onClose={() => {}} key="es" />)); await wait(300);
 const es = document.querySelector('[data-settings-section=phoneFit]').textContent;
 check(es.includes('Ajustar consolas al celular') && es.includes('Tamaño de texto del modo celular: 16px'), 'Settings in Spanish');
 return checks;
})();
` }, bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic', define: { __APP_VERSION__: '"2.0.0"', 'process.env.NODE_ENV': '"production"' }, alias: { '@shared': path.join(root, 'src/shared') }, loader: { '.ttf': 'empty', '.woff': 'empty', '.woff2': 'empty' }, outfile: path.join(dir, 'renderer.js') })
fs.writeFileSync(path.join(dir, 'index.html'), `<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="${pathToFileURL(path.join(assets, mobileCss))}"><link rel="stylesheet" href="renderer.css"></head><body><div id="root"></div><script src="renderer.js"></script></body></html>`)
fs.writeFileSync(path.join(dir, 'main.cjs'), `
const {app,BrowserWindow}=require('electron');const path=require('path');
app.setPath('userData',path.join(__dirname,'profile'));
app.whenReady().then(async()=>{
 const w=new BrowserWindow({show:false,width:360,height:640,useContentSize:true,webPreferences:{sandbox:true,backgroundThrottling:false}});
 await w.loadFile(path.join(__dirname,'index.html'));
 const checks=await w.webContents.executeJavaScript('window.result');
 console.log('PASS: '+checks+' mobile phone mode UI checks');w.destroy();app.quit();
}).catch(e=>{console.error(e);app.exit(1)});
`)
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
const flags = process.platform === 'linux' && process.env.CI ? ['--no-sandbox'] : []
const result = spawnSync(require('electron'), [...flags, path.join(dir, 'main.cjs')], { env, windowsHide: true, encoding: 'utf8', timeout: 30000 })
process.stdout.write(result.stdout ?? '')
process.stderr.write((result.stderr ?? '') + (result.error ? result.error.message : ''))
if (result.status !== 0 || !/^PASS:/m.test(result.stdout ?? '')) process.exit(1)
fs.rmSync(dir, { recursive: true, force: true })
