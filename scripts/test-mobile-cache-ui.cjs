// Phone Claude cache countdown (E5-FR-28) with the production CSS in an
// isolated offscreen browser at phone width: off by default (no chip, no
// ticker), the Settings switch and TTL stored in snagentsos.cacheTimer, a live
// working -> done transition stamped at reception even with the desktop clock
// 2 min ahead, the chip on the tab and in the terminal header, amber in the
// last minute, gone with a new prompt, and Codex never gets one.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path')
const { pathToFileURL } = require('node:url')
const { spawnSync } = require('node:child_process')
const root = path.resolve(__dirname, '..')
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snagentsos-cache-ui-'))
const assets = path.join(root, 'out/mobile/assets')
const mobileCss = fs.existsSync(assets) && fs.readdirSync(assets).find(name => /^index-.*\.css$/.test(name))
if (!mobileCss) throw new Error('Run npm run build:mobile first')
require('esbuild').buildSync({ stdin: { resolveDir: root, loader: 'tsx', contents: `
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { PaneTabs } from './src/mobile/src/components/PaneTabs';
import { SettingsScreen } from './src/mobile/src/components/SettingsScreen';
import { CacheChip } from './src/mobile/src/components/CacheChip';
import { store } from './src/mobile/src/lib/store';
import { startCacheTimer, useCacheTimer, CACHE_TIMER_KEY } from './src/mobile/src/lib/cacheTimer';
import { setLang } from './src/mobile/src/lib/i18n';
const frames = (ms = 30) => new Promise(r => setTimeout(r, ms));
let checks = 0; const check = (ok, label) => { if (!ok) throw new Error(label); checks++ };
const noOverflow = () => document.documentElement.scrollWidth <= window.innerWidth;
const MIN = 60000;
window.result = (async () => {
 localStorage.removeItem(CACHE_TIMER_KEY);
 const host = document.getElementById('root'); const root = createRoot(host);
 const skew = 2 * MIN; // the desktop clock runs 2 min ahead of the phone
 const desk = () => Date.now() + skew;
 const snapshot = { language: 'en', themeTokens: {}, fontFamily: 'mono', fontSize: 13, activeWorkspaceId: 'w1',
  workspaces: [{ id: 'w1', name: 'Front', layoutOrder: ['c1', 'x1'], panes: [
   { id: 'c1', title: 'Claude', type: 'claude', color: '', icon: '', running: true },
   { id: 'x1', title: 'Codex', type: 'codex', color: '', icon: '', running: true } ] }] };
 const working = { c1: { state: 'working', provider: 'claude', stateSince: desk() - MIN }, x1: { state: 'working', provider: 'codex', stateSince: desk() - MIN } };
 flushSync(() => store.getState().update({ phase: 'live', snapshot, paneStatus: working, activePaneId: 'c1', subscribedPaneId: 'c1', connected: true }));
 startCacheTimer();
 flushSync(() => root.render(<div><header data-head style={{ display: 'flex', gap: 6 }}><span>Claude</span><CacheChip paneId="c1" /></header><PaneTabs onPaneActions={() => {}} /></div>));
 await frames();
 check(!useCacheTimer.getState().prefs.enabled, 'off by default');
 // The live transition (a paneStatus delta) while the switch is still off.
 flushSync(() => store.getState().update({ paneStatus: { c1: { state: 'done', provider: 'claude', stateSince: desk() }, x1: { state: 'done', provider: 'codex', stateSince: desk() } } }));
 await frames();
 check(!host.querySelector('[data-cache-chip]'), 'switched off: no chip');
 const start = useCacheTimer.getState().starts.c1;
 check(start && Math.abs(start.start - Date.now()) < 1000, 'the transition was stamped with the phone clock at reception (not the desktop stateSince 2 min ahead)');
 check(!useCacheTimer.getState().starts.x1, 'Codex is never tracked');

 // Settings: switch + TTL, stored per phone.
 flushSync(() => root.render(<SettingsScreen open={true} onClose={() => {}} />));
 await frames(350);
 const sw = document.querySelector('[data-pref=cacheTimer]');
 check(sw && sw.getAttribute('aria-checked') === 'false', 'Settings shows the cache switch off');
 check(document.querySelector('[data-ttl="60"]').disabled, 'TTL disabled while off');
 sw.click(); await frames();
 check(JSON.parse(localStorage.getItem(CACHE_TIMER_KEY)).enabled === true && useCacheTimer.getState().prefs.enabled, 'the switch writes snagentsos.cacheTimer');
 document.querySelector('[data-ttl="60"]').click(); await frames();
 check(JSON.parse(localStorage.getItem(CACHE_TIMER_KEY)).ttlMinutes === 60, 'TTL 60 stored');
 document.querySelector('[data-ttl="5"]').click(); await frames();
 check(noOverflow(), 'Settings fits 360px');

 flushSync(() => root.render(<div><header data-head style={{ display: 'flex', gap: 6 }}><span>Claude</span><CacheChip paneId="c1" /></header><PaneTabs onPaneActions={() => {}} /></div>));
 await frames();
 const head = host.querySelector('[data-head] [data-cache-chip]');
 const tab = host.querySelector('[data-tab=c1] [data-cache-chip]');
 check(head && /^(5:00|4:59)$/.test(head.textContent), 'header chip counts 5:00 from the transition the desktop also saw (got ' + (head && head.textContent) + ')');
 check(tab && tab.textContent === head.textContent, 'the tab shows the same chip next to the console name');
 check(!host.querySelector('[data-tab=x1] [data-cache-chip]'), 'no chip on the Codex tab');
 check(tab.getAttribute('role') === 'timer' && tab.getAttribute('aria-label').includes(tab.textContent), 'the chip is a labeled timer');
 check(noOverflow(), 'tabs fit 360px with the chip');
 useCacheTimer.setState({ starts: { c1: { start: Date.now() - (5 * MIN - 30000), since: 0 } } });
 await frames();
 const warn = host.querySelector('[data-head] [data-cache-chip]');
 check(warn && warn.dataset.cacheChip === 'warn' && /^0:(30|29)$/.test(warn.textContent), 'amber in the last minute');
 setLang('es'); await frames(1100); // the next tick re-renders with the new language
 check(host.querySelector('[data-head] [data-cache-chip]').getAttribute('aria-label').startsWith('La caché de Claude vence'), 'the label is translated');
 setLang('en');
 flushSync(() => store.getState().update({ paneStatus: { ...store.getState().paneStatus, c1: { state: 'working', provider: 'claude', stateSince: desk() } } }));
 await frames();
 check(!host.querySelector('[data-cache-chip]') && !useCacheTimer.getState().starts.c1, 'a new prompt (working) removes it');
 flushSync(() => store.getState().update({ paneStatus: { ...store.getState().paneStatus, c1: { state: 'done', provider: 'claude', stateSince: desk() } } }));
 useCacheTimer.setState({ starts: { c1: { start: Date.now() - (5 * MIN - 1200), since: 0 } } });
 await frames(2300);
 check(!host.querySelector('[data-cache-chip]'), 'gone at 0:00');
 // A reconnect snapshot (authOk/state) with a done pane starts at its stateSince.
 flushSync(() => store.getState().update({ snapshot: { ...snapshot }, paneStatus: { c1: { state: 'done', provider: 'claude', stateSince: Date.now() - MIN } } }));
 await frames();
 check(useCacheTimer.getState().starts.c1.start === store.getState().paneStatus.c1.stateSince, 'snapshot only: the chip starts at stateSince');
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
 console.log('PASS: '+checks+' mobile cache timer UI checks');w.destroy();app.quit();
}).catch(e=>{console.error(e);app.exit(1)});
`)
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
const flags = process.platform === 'linux' && process.env.CI ? ['--no-sandbox'] : []
const result = spawnSync(require('electron'), [...flags, path.join(dir, 'main.cjs')], { env, windowsHide: true, encoding: 'utf8', timeout: 30000 })
process.stdout.write(result.stdout ?? '')
process.stderr.write((result.stderr ?? '') + (result.error ? result.error.message : ''))
fs.rmSync(dir, { recursive: true, force: true })
if (result.status !== 0 || !/^PASS:/m.test(result.stdout ?? '')) process.exit(1)
