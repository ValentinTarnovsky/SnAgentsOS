// Firewall row (E2-FR-38/39): the production FirewallStatusRow in an isolated
// hidden Electron window with a fake snApi.remote. Nothing runs PowerShell or
// touches the real firewall: every status and fix result is scripted here.
// Requires npm run build (CSS).
const fs = require('node:fs'), os = require('node:os'), path = require('node:path')
const { pathToFileURL } = require('node:url')
const { spawnSync } = require('node:child_process')
const { buildSync } = require('esbuild')
const root = path.resolve(__dirname, '..'), dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snagentsos-fw-ui-'))
const assets = path.join(root, 'out/renderer/assets')
const css = fs.existsSync(assets) && fs.readdirSync(assets).find(f => /^index-.*\.css$/.test(f))
if (!css) throw new Error('Run npm run build first')
buildSync({ stdin: { contents: `
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { FirewallStatusRow } from './src/renderer/components/remote/FirewallStatusRow';
import { I18nProvider } from './src/renderer/i18n';
import { applyTheme } from './src/renderer/themes/applyTheme';
const base = { ok: false, profile: 'Private', ruleFound: false, port: 4517, endpoints: [{ ip: '192.168.1.20', kind: 'lan', profile: 'Private', networkName: 'Casa' }], blockingRules: [], ruleScope: 'program', fixable: true, checkedAt: 1 };
const calls = { check: [], fix: 0, network: 0 };
let nextStatus = null, nextFix = null;
window.snApi = { remote: {
  firewallCheck: async (force) => { calls.check.push(force); return nextStatus },
  firewallFix: async () => { calls.fix++; return nextFix },
  openNetworkSettings: () => { calls.network++ },
} };
applyTheme('midnight');
window.result = (async () => {
 const wait = (ms = 30) => new Promise(r => setTimeout(r, ms));
 let checks = 0; const check = (ok, label) => { if (!ok) throw new Error(label); checks++ };
 const host = document.getElementById('root'); const root = createRoot(host);
 let key = 0;
 const show = async (status, lang = 'en') => { nextStatus = status; flushSync(() => root.render(<I18nProvider lang={lang}><div style={{ width: 340 }}><FirewallStatusRow key={++key} /></div></I18nProvider>)); await wait(); };
 const row = () => host.querySelector('[data-fw-state]');
 const noOverflow = () => document.documentElement.scrollWidth <= window.innerWidth;
 await show({ ...base, state: 'ok', ok: true, ruleFound: true });
 check(row().dataset.fwState === 'ok' && row().textContent.includes('Firewall OK') && row().textContent.includes('4517'), 'OK is green with the port');
 check(calls.check[0] === false, 'opening checks without forcing (main caches 60s)');
 host.querySelector('[data-fw-action=recheck]').click(); await wait();
 check(calls.check.at(-1) === true, 'Check again forces a fresh check');
 await show({ ...base, state: 'publicProfile', profile: 'Public', endpoints: [{ ip: '192.168.1.20', kind: 'lan', profile: 'Public', networkName: 'Red' }] });
 check(row().textContent.includes('"Red" is Public'), 'Public network names the network');
 host.querySelector('[data-fw-action=network]').click();
 check(calls.network === 1, 'Open network settings asks main to open ms-settings');
 nextFix = { ok: false, cancelled: true, error: 'cancelled', status: { ...base, state: 'blocked', blockingRules: [{ name: 'b', displayName: 'snagentsos.exe', scope: 'currentProgram' }] } };
 await show({ ...base, state: 'blocked', blockingRules: [{ name: 'b', displayName: 'snagentsos.exe', scope: 'currentProgram' }] });
 check(row().dataset.fwState === 'blocked' && !!host.querySelector('[data-fw-action=fix]'), 'a fixable Block offers Fix');
 host.querySelector('[data-fw-action=fix]').click(); await wait();
 check(calls.fix === 1 && host.querySelector('[data-fw-note]').textContent === 'Cancelled', 'a cancelled UAC shows Cancelled');
 nextFix = { ok: true, status: { ...base, state: 'ok', ok: true, ruleFound: true } };
 host.querySelector('[data-fw-action=fix]').click(); await wait();
 check(row().dataset.fwState === 'ok' && !host.querySelector('[data-fw-note]'), 'an accepted fix turns the row green');
 await show({ ...base, state: 'blocked', fixable: false, blockingRules: [{ name: 'corp', displayName: 'Corp port block', scope: 'port' }] });
 check(!host.querySelector('[data-fw-action=fix]') && row().textContent.includes('cannot be removed automatically: Corp port block'), 'a port Block names the rule and offers no Fix');
 await show({ ...base, state: 'noRule', ruleScope: 'port' });
 check(!!host.querySelector('[data-fw-action=create]') && row().textContent.includes('port 4517 only'), 'no rule offers Create rule; portable says port-only');
 await show({ ...base, state: 'unknown' });
 check(row().dataset.fwState === 'unknown' && row().textContent.includes('Windows may ask to allow'), 'not checked falls back to the static hint');
 await show({ ...base, state: 'noRule' }, 'es');
 check(row().textContent.includes('Crear regla'), 'the row is translated');
 check(noOverflow(), 'the row fits 340px');
 await show({ ...base, state: 'unsupported' });
 check(!row(), 'nothing renders off Windows');
 return checks;
})();
`, resolveDir: root, loader: 'tsx' }, bundle: true, platform: 'browser', format: 'iife', outfile: path.join(dir, 'renderer.js'), alias: { '@shared': path.join(root, 'src/shared'), '@': path.join(root, 'src/renderer') }, jsx: 'automatic', loader: { '.css': 'empty' }, define: { 'process.env.NODE_ENV': '"production"' } })
fs.writeFileSync(path.join(dir, 'index.html'), `<html><head><meta charset="utf-8"><link rel="stylesheet" href="${pathToFileURL(path.join(assets, css))}"></head><body class="bg-bg-primary text-text-primary"><div id="root"></div><script src="renderer.js"></script></body></html>`)
fs.writeFileSync(path.join(dir, 'main.cjs'), `
const {app,BrowserWindow}=require('electron');const path=require('path');
app.setPath('userData',path.join(__dirname,'profile'));
app.whenReady().then(async()=>{
 const w=new BrowserWindow({show:false,width:420,height:500,useContentSize:true,webPreferences:{sandbox:true,backgroundThrottling:false}});
 await w.loadFile(path.join(__dirname,'index.html'));
 const checks=await w.webContents.executeJavaScript('window.result');
 console.log('PASS: '+checks+' firewall row checks');w.destroy();app.quit();
}).catch(e=>{console.error(e);app.exit(1)});
`)
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
const flags = process.platform === 'linux' && process.env.CI ? ['--no-sandbox'] : []
const result = spawnSync(require('electron'), [...flags, path.join(dir, 'main.cjs')], { env, windowsHide: true, encoding: 'utf8', timeout: 30000 })
process.stdout.write(result.stdout ?? '')
process.stderr.write((result.stderr ?? '') + (result.error ? result.error.message : ''))
if (result.status !== 0 || !/^PASS:/m.test(result.stdout ?? '')) process.exit(1)
fs.rmSync(dir, { recursive: true, force: true })
