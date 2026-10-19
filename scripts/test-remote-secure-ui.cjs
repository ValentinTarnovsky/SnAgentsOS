// Settings > Remote control, secure mode (E3-FR-42/43): the production
// RemoteSection and RemoteQrModal in an isolated hidden Electron window with a
// fake snApi.remote. Nothing runs the tailscale CLI: every secureSet answer is
// scripted. The switch saves settings.remote.https only after main answered
// `on`; no_https shows the console link; turning it off saves false; the https
// endpoint is listed first and the QR modal labels it with its name and says
// the phone pairs again. Requires npm run build (CSS).
const fs = require('node:fs'), os = require('node:os'), path = require('node:path')
const { pathToFileURL } = require('node:url')
const { spawnSync } = require('node:child_process')
const { buildSync } = require('esbuild')
const root = path.resolve(__dirname, '..'), dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snagentsos-secure-ui-'))
const assets = path.join(root, 'out/renderer/assets')
const css = fs.existsSync(assets) && fs.readdirSync(assets).find(f => /^index-.*\.css$/.test(f))
if (!css) throw new Error('Run npm run build first')
buildSync({ stdin: { contents: `
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { RemoteSection } from './src/renderer/components/settings/sections/RemoteSection';
import { RemoteQrModal } from './src/renderer/components/remote/RemoteQrModal';
import { I18nProvider } from './src/renderer/i18n';
import { applyTheme } from './src/renderer/themes/applyTheme';
import { useAppStore } from './src/renderer/lib/store';
import { useRemoteStore } from './src/renderer/lib/remoteStore';
const DNS = 'pc.tail1234.ts.net';
const calls = { secure: [], external: [] };
let nextSecure = null;
window.snApi = {
  app: { info: async () => ({ version: '2.0.0', platform: 'linux', arch: 'x64', portable: false, configPath: '' }) },
  system: { openExternal: url => calls.external.push(url) },
  clipboard: { writeText() {} },
  remote: {
    secureSet: async enabled => { calls.secure.push(enabled); return nextSecure },
    pairingBegin: async () => ({ code: 'ABCD2345', expiresAt: Date.now() + 120000, endpoints: [
      { host: DNS, kind: 'tailscaleHttps', url: 'https://' + DNS, qrDataUrl: 'data:image/png;base64,iVBORw0KGgo=' },
      { ip: '100.101.1.2', kind: 'tailscale', url: 'http://100.101.1.2:4517', qrDataUrl: 'data:image/png;base64,iVBORw0KGgo=' },
    ] }),
    pairingCancel() {},
  },
};
applyTheme('midnight');
window.result = (async () => {
 const wait = (ms = 40) => new Promise(r => setTimeout(r, ms));
 let checks = 0; const check = (ok, label) => { if (!ok) throw new Error(label); checks++ };
 const $ = sel => document.querySelector(sel);
 const toggle = () => $('[data-secure-mode] button[role=switch]');
 const settings = () => useAppStore.getState().settings.remote;
 useAppStore.setState(s => ({ settings: { ...s.settings, language: 'en', remote: { enabled: true, port: 4517, phoneFit: true, https: { enabled: false, mode: 'tailscaleServe' } } } }));
 useRemoteStore.setState({ status: { state: 'running', port: 4517, endpoints: [{ ip: '100.101.1.2', kind: 'tailscale', url: 'http://100.101.1.2:4517' }], connectedCount: 0 } });
 const host = document.getElementById('root'); const r = createRoot(host);
 const render = (lang = 'en') => flushSync(() => r.render(<I18nProvider lang={lang}><RemoteSection /><RemoteQrModal /></I18nProvider>));
 render(); await wait();
 const row = $('[data-secure-mode]');
 check(row && row.textContent.includes('Secure mode (HTTPS via Tailscale)') && toggle(), 'Settings > Remote has the Secure mode switch');
 check(document.getElementById('setting-remote-secure'), 'the row is a settings search anchor');

 // no_https: the setting stays off, the error and the console link show.
 nextSecure = { state: 'error', error: 'no_https' };
 toggle().click(); await wait(80);
 check(calls.secure.join() === 'true' && settings().https.enabled === false, 'a failed enable never saves https.enabled');
 const err = $('[data-secure-error=no_https]');
 check(err && err.textContent.includes('Turn on MagicDNS and HTTPS Certificates in the Tailscale console'), 'no_https names MagicDNS and HTTPS Certificates');
 [...err.querySelectorAll('button')].find(b => b.textContent.includes('Open the Tailscale console')).click();
 check(calls.external[0] === 'https://login.tailscale.com/admin/dns', 'the link opens the Tailscale DNS console');

 nextSecure = { state: 'error', error: 'cli', message: 'serve: access denied' };
 toggle().click(); await wait(80);
 check($('[data-secure-error=cli]').textContent.includes('serve: access denied'), 'a CLI failure shows its raw message');
 nextSecure = { state: 'error', error: 'funnel' };
 toggle().click(); await wait(80);
 check($('[data-secure-error=funnel]').textContent.includes('Funnel') && settings().https.enabled === false, 'Funnel on 443: told, nothing saved');

 // Success.
 nextSecure = { state: 'on', dnsName: DNS, url: 'https://' + DNS };
 toggle().click(); await wait(80);
 check(settings().https.enabled === true && settings().https.mode === 'tailscaleServe' && settings().enabled === true && settings().port === 4517, 'on: saves https { enabled: true, tailscaleServe } and keeps the rest');
 useRemoteStore.setState({ status: { state: 'running', port: 4517, connectedCount: 0, secure: { state: 'on', dnsName: DNS, url: 'https://' + DNS },
   endpoints: [{ host: DNS, kind: 'tailscaleHttps', url: 'https://' + DNS }, { ip: '100.101.1.2', kind: 'tailscale', url: 'http://100.101.1.2:4517' }] } });
 await wait();
 check($('[data-secure-url]').textContent.includes('Active at https://' + DNS), 'the status line shows the https URL');
 check(row.textContent.includes('pair again'), 'and says phones pair again on that origin');
 check(host.textContent.indexOf('https://' + DNS) < host.textContent.indexOf('http://100.101.1.2:4517') && host.textContent.includes('Tailscale HTTPS'), 'the https endpoint is listed first with its kind');

 // QR modal: the https QR first, labelled by name, with the re-pair note.
 useRemoteStore.getState().setQrOpen(true); await wait(80);
 const chips = [...document.querySelectorAll('button')].filter(b => b.textContent.includes(' · '));
 check(chips[0].textContent.includes('Tailscale HTTPS') && chips[0].textContent.includes(DNS) && chips[1].textContent.includes('100.101.1.2'), 'QR endpoints: the https name first, then the IPs');
 check($('[data-qr-secure]') && $('[data-qr-secure]').textContent.includes('pairs again'), 'the https QR says the phone pairs again as a new device');
 chips[1].click(); await wait();
 check(!$('[data-qr-secure]'), 'an http QR has no re-pair note');
 useRemoteStore.getState().cancelQr(); await wait();

 // Off.
 nextSecure = { state: 'off' };
 toggle().click(); await wait(80);
 check(calls.secure.at(-1) === false && settings().https.enabled === false, 'off: secureSet(false) then saves https.enabled = false');

 // Server stopped: the switch cannot be turned on.
 useRemoteStore.setState({ status: { state: 'stopped', port: 4517, endpoints: [], connectedCount: 0 } });
 await wait();
 check(toggle().disabled, 'with the server stopped the switch is disabled');

 // Spanish.
 render('es'); await wait();
 check($('[data-secure-mode]').textContent.includes('Modo seguro (HTTPS por Tailscale)'), 'Spanish label');
 check(document.documentElement.scrollWidth <= window.innerWidth, 'no horizontal overflow');
 r.unmount();
 return checks;
})();
`, resolveDir: root, loader: 'tsx' }, bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' }, alias: { '@shared': path.join(root, 'src/shared'), '@': path.join(root, 'src/renderer') }, loader: { '.css': 'empty', '.woff2': 'empty', '.woff': 'empty', '.png': 'empty', '.svg': 'empty' }, outfile: path.join(dir, 'renderer.js') })
fs.writeFileSync(path.join(dir, 'index.html'), `<html><head><meta charset="utf-8"><link rel="stylesheet" href="${pathToFileURL(path.join(assets, css))}"></head><body><div id="root"></div><script src="renderer.js"></script></body></html>`)
fs.writeFileSync(path.join(dir, 'main.cjs'), `
const {app,BrowserWindow}=require('electron');const path=require('path');
app.setPath('userData',path.join(__dirname,'profile'));
app.whenReady().then(async()=>{
 const w=new BrowserWindow({show:false,width:900,height:900,webPreferences:{sandbox:true,offscreen:true}});
 await w.loadFile(path.join(__dirname,'index.html'));
 const checks=await w.webContents.executeJavaScript('window.result');
 console.log('PASS: '+checks+' secure mode settings checks (switch, errors, console link, endpoints, QR, off, es)');
 w.destroy();app.quit();
}).catch(e=>{console.error(e);app.exit(1)});
`)
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
const flags = process.platform === 'linux' && process.env.CI ? ['--no-sandbox'] : []
const result = spawnSync(require('electron'), [...flags, path.join(dir, 'main.cjs')], { env, windowsHide: true, encoding: 'utf8', timeout: 90000 })
process.stdout.write(result.stdout ?? '')
process.stderr.write((result.stderr ?? '') + (result.error ? result.error.message : ''))
fs.rmSync(dir, { recursive: true, force: true })
if (result.status !== 0 || !/^PASS:/m.test(result.stdout ?? '')) process.exit(1)
