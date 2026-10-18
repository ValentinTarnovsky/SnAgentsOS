// Render the phone diagnostics (M9, E2-FR-36/37) with the production CSS in an
// isolated offscreen browser at phone width: DiagnosticsBody (six checks, the
// suggestions, the six-item accordion, the log), the connecting screen on the
// pairing path (live log, then the 25s timeout with Retry and Copy report),
// the banner's Diagnose entry and a report without secrets.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path')
const { pathToFileURL } = require('node:url')
const { spawnSync } = require('node:child_process')
const root = path.resolve(__dirname, '..')
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snagentsos-diag-ui-'))
const assets = path.join(root, 'out/mobile/assets')
const mobileCss = fs.existsSync(assets) && fs.readdirSync(assets).find(name => /^index-.*\.css$/.test(name))
if (!mobileCss) throw new Error('Run npm run build:mobile first')
require('esbuild').buildSync({ stdin: { resolveDir: root, loader: 'tsx', contents: `
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { DiagnosticsBody, currentReport } from './src/mobile/src/components/DiagnosticsScreen';
import { ConnectingScreen } from './src/mobile/src/components/StatusScreens';
import { StatusBanner } from './src/mobile/src/components/StatusBanner';
import { SettingsScreen } from './src/mobile/src/components/SettingsScreen';
import { store } from './src/mobile/src/lib/store';
import { log, useDiagStore } from './src/mobile/src/lib/connLog';
import { setLang } from './src/mobile/src/lib/i18n';
window.result = (async () => {
 const wait = (ms = 16) => new Promise(r => setTimeout(r, ms));
 let checks = 0; const check = (ok, label) => { if (!ok) throw new Error(label); checks++ };
 const host = document.getElementById('root'); const root = createRoot(host);
 const noOverflow = () => document.documentElement.scrollWidth <= window.innerWidth;
 const secret = 'ab'.repeat(32);
 log('info', 'dial 192.168.1.20:4517');
 log('warn', 'close=1006 clean=false dur=1200');
 log('info', 'secret=' + secret);
 flushSync(() => store.getState().update({ phase: 'connecting', appVersion: '2.0.0', lastConnectedAt: Date.now() - 90000 }));
 flushSync(() => useDiagStore.getState().update({ lastClose: { code: 1006, reason: '', clean: false, at: Date.now() - 5000 }, abnormalStreak: 2, retries: 4 }));
 flushSync(() => root.render(<DiagnosticsBody />));
 for (let i = 0; i < 300 && host.querySelector('[data-check=server]')?.dataset.result === 'warn'; i++) await wait(20);
 const rows = [...host.querySelectorAll('[data-check]')];
 check(rows.map(r => r.dataset.check).join() === 'paired,route,server,lastClose,version,retries', 'six checks render in order');
 check(host.querySelector('[data-check=server]').dataset.result === 'fail', 'with no desktop the server check fails');
 check(host.querySelector('[data-check=lastClose]').textContent.includes('1006'), 'the last close names its code');
 check(host.querySelector('[data-check=paired]').dataset.result === 'fail', 'no stored device key fails the paired check');
 check(!!host.querySelector('[data-suggestion=abnormal]') && host.textContent.includes('asleep'), 'the suggestion mentions the firewall / sleeping PC');
 const faqs = host.querySelectorAll('[data-faq]');
 check(faqs.length === 6, 'six common problems');
 const first = faqs[0].querySelector('button');
 check(first.getAttribute('aria-expanded') === 'false', 'the accordion starts closed');
 flushSync(() => first.click());
 check(first.getAttribute('aria-expanded') === 'true' && faqs[0].querySelector('p'), 'tapping an item opens its answer');
 const logEl = host.querySelector('[data-diag-log]');
 check(logEl.children.length === 3 && logEl.textContent.includes('close=1006'), 'the log lists every entry');
 check(!logEl.textContent.includes(secret), 'the log shows the secret redacted');
 check(!!host.querySelector('[data-action=copy-report]'), 'Copy report is offered');
 check(noOverflow(), 'diagnostics fit 360px without horizontal overflow');
 const report = currentReport({ kind: 'fail' });
 check(!report.includes(secret) && report.includes('[FAIL] server') && report.includes('bundle: 2.0.0'), 'the report has the checks and no secret');
 setLang('es'); flushSync(() => root.render(<DiagnosticsBody key="es" />)); await wait(50);
 check(host.textContent.includes('Comprobaciones') && host.textContent.includes('Problemas comunes'), 'diagnostics are translated');
 setLang('en');

 // Pairing path: live log under the spinner, then the 25s timeout.
 flushSync(() => useDiagStore.getState().update({ pairCeilingAt: Date.now() + 20000, pairStartedAt: Date.now() - 1000, pairTimedOut: false }));
 log('info', 'pair sent');
 flushSync(() => root.render(<ConnectingScreen />)); await wait();
 const pairLog = host.querySelector('[data-pair-log]');
 check(!!pairLog && pairLog.textContent.includes('pair sent') && !pairLog.textContent.includes('dial 192'), 'the pairing log shows only this attempt');
 check(host.textContent.includes('Reaching the PC... 20s'), 'the ceiling countdown is shown');
 log('warn', 'connect timeout 8000ms (never opened)'); await wait();
 check(host.querySelector('[data-pair-log]').textContent.includes('connect timeout'), 'new lines appear as they arrive');
 flushSync(() => useDiagStore.getState().update({ pairCeilingAt: null, pairTimedOut: true })); await wait();
 check(host.textContent.includes("Couldn't reach the PC in 25s - check the log"), 'the timeout message names the 25s ceiling');
 const actions = host.querySelector('[data-pair-timeout]');
 check(actions && actions.textContent.includes('Retry') && actions.querySelector('[data-action=copy-report]'), 'timeout offers Retry and Copy report');
 check(noOverflow(), 'the timeout screen fits 360px');
 flushSync(() => useDiagStore.getState().update({ pairTimedOut: false })); await wait();
 check(!host.querySelector('[data-pair-log]'), 'outside the pairing path the connecting screen has no log');

 // The amber banner opens Diagnostics.
 flushSync(() => store.getState().update({ phase: 'live', banner: { kind: 'reconnecting', attempt: 4 }, connAttempt: 4 }));
 flushSync(() => root.render(<div style={{ position: 'relative', height: '220px' }}><StatusBanner /></div>)); await wait();
 const diagBtn = host.querySelector('[data-action=diagnostics]');
 check(!!diagBtn, 'the expanded banner offers Diagnose');
 flushSync(() => diagBtn.click());
 check(useDiagStore.getState().open === true, 'Diagnose opens the diagnostics screen');
 check(noOverflow(), 'the banner with Diagnose fits 360px');

 // Settings > This device opens Diagnostics too.
 flushSync(() => useDiagStore.getState().update({ open: false }));
 flushSync(() => root.render(<SettingsScreen open onClose={() => {}} />)); await wait(400);
 const setBtn = host.querySelector('[data-settings-section=device] [data-action=diagnostics]');
 check(!!setBtn && setBtn.textContent.includes('Diagnostics'), 'Settings lists Diagnostics under This device');
 flushSync(() => setBtn.click());
 check(useDiagStore.getState().open === true, 'the Settings row opens the diagnostics screen');
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
 console.log('PASS: '+checks+' mobile diagnostics screen checks');w.destroy();app.quit();
}).catch(e=>{console.error(e);app.exit(1)});
`)
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
const flags = process.platform === 'linux' && process.env.CI ? ['--no-sandbox'] : []
const result = spawnSync(require('electron'), [...flags, path.join(dir, 'main.cjs')], { env, windowsHide: true, encoding: 'utf8', timeout: 30000 })
process.stdout.write(result.stdout ?? '')
process.stderr.write((result.stderr ?? '') + (result.error ? result.error.message : ''))
if (result.status !== 0 || !/^PASS:/m.test(result.stdout ?? '')) process.exit(1)
fs.rmSync(dir, { recursive: true, force: true })
