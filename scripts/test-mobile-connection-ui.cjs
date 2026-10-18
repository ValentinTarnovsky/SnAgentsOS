// Render the phone's connection banner tiers and the updated screen (E1-FR-13,
// 15) with the production CSS in an isolated offscreen browser at phone width.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path')
const { pathToFileURL } = require('node:url')
const { spawnSync } = require('node:child_process')
const root = path.resolve(__dirname, '..')
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snagentsos-conn-ui-'))
const assets = path.join(root, 'out/mobile/assets')
const mobileCss = fs.existsSync(assets) && fs.readdirSync(assets).find(name => /^index-.*\.css$/.test(name))
if (!mobileCss) throw new Error('Run npm run build:mobile first')
require('esbuild').buildSync({ stdin: { resolveDir: root, loader: 'tsx', contents: `
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { StatusBanner } from './src/mobile/src/components/StatusBanner';
import { UpdatedScreen } from './src/mobile/src/components/StatusScreens';
import { store } from './src/mobile/src/lib/store';
import { setLang } from './src/mobile/src/lib/i18n';
window.result = (async () => {
 // flushSync commits synchronously; a short timer lets effects settle (rAF can
 // stall in a hidden window).
 const frames = () => new Promise(r => setTimeout(r, 16));
 let checks = 0; const check = (ok, label) => { if (!ok) throw new Error(label); checks++ };
 const host = document.getElementById('root'); const root = createRoot(host);
 const set = s => flushSync(() => store.getState().update(s));
 const noOverflow = () => document.documentElement.scrollWidth <= window.innerWidth;
 flushSync(() => root.render(<div style={{ position: 'relative', height: '220px' }}><StatusBanner /></div>));
 check(!host.querySelector('[data-tier]'), 'no banner while connected');
 const now = Date.now();
 const cases = [
  [{ banner: { kind: 'reconnecting', attempt: 1 }, connAttempt: 1 }, 'reconnecting', 'Reconnecting... Attempt 1'],
  [{ banner: { kind: 'reconnecting', attempt: 3 }, connAttempt: 3 }, 'cantConnect', "Can't connect"],
  [{ banner: { kind: 'reconnecting', attempt: 12 }, connAttempt: 12, lastConnectedAt: now - 125000 }, 'unreachable', 'Last connection 2m ago'],
  [{ online: false }, 'offline', 'No connection on the phone'],
  [{ online: true, banner: { kind: 'desktopGone' }, connAttempt: 2 }, 'desktopGone', 'The PC closed'],
  [{ banner: { kind: 'disabled' } }, 'disabled', 'Remote control was turned off'],
 ];
 for (const [state, tier, text] of cases) {
  set(state); await frames();
  const el = host.querySelector('[data-tier]');
  check(el && el.dataset.tier === tier, 'banner tier ' + tier);
  check(el.textContent.includes(text), tier + ' shows "' + text + '" (got "' + el.textContent + '")');
  check(noOverflow(), tier + ' banner fits 360px without horizontal overflow');
  const retry = el.querySelector('[data-action=retry]');
  check(tier === 'offline' || tier === 'disabled' ? !retry : !!retry, tier + ' retry button visibility');
 }
 set({ banner: { kind: 'reconnecting', attempt: 4 }, connAttempt: 4, lastConnectedAt: null }); await frames();
 check(host.textContent.includes('SnAgentsOS open?'), 'amber tier leads with the endpoint hint');
 host.querySelector('[data-action=retry]').click();
 setLang('es'); set({ banner: { kind: 'reconnecting', attempt: 5 }, connAttempt: 5 }); await frames();
 check(host.textContent.includes('No se puede conectar') && host.textContent.includes('Reintentar'), 'banner is translated');
 setLang('en');
 set({ banner: null, connAttempt: 0 }); await frames();
 check(!host.querySelector('[data-tier]'), 'banner disappears once connected again');
 flushSync(() => root.render(<UpdatedScreen />));
 set({ phase: 'updated', updateInfo: { from: '2.0.0', to: '2.0.1', kind: 'mismatch', retried: false } }); await frames();
 check(host.textContent.includes('was updated on the PC (v2.0.0 -> v2.0.1)'), 'updated screen names both versions');
 check(!!host.querySelector('[data-action=continue]') && host.textContent.includes('Reload'), 'mismatch offers Reload and Continue anyway');
 check(noOverflow(), 'updated screen fits 360px');
 set({ updateInfo: { from: '2.0.0', to: '2.0.1', kind: 'mismatch', retried: true } }); await frames();
 check(host.textContent.includes('close the tab and open it again'), 'a mismatch that survived a reload asks to reopen the tab');
 set({ updateInfo: { from: '2.0.0', to: '', kind: 'protocol', retried: false } }); await frames();
 check(!host.querySelector('[data-action=continue]') && host.textContent.includes('was updated on the PC'), 'protocol mismatch has no Continue anyway');
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
 console.log('PASS: '+checks+' mobile connection banner and updated screen checks');w.destroy();app.quit();
}).catch(e=>{console.error(e);app.exit(1)});
`)
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
const flags = process.platform === 'linux' && process.env.CI ? ['--no-sandbox'] : []
const result = spawnSync(require('electron'), [...flags, path.join(dir, 'main.cjs')], { env, windowsHide: true, encoding: 'utf8', timeout: 20000 })
process.stdout.write(result.stdout ?? '')
process.stderr.write((result.stderr ?? '') + (result.error ? result.error.message : ''))
if (result.status !== 0 || !/^PASS:/m.test(result.stdout ?? '')) process.exit(1)
fs.rmSync(dir, { recursive: true, force: true })
