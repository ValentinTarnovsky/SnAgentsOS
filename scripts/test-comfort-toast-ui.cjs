// Feedback toasts of the daily-comfort actions (E4-FR-04/05/06): the
// production endpoint copy buttons (RemoteQrModal, Settings > Remote,
// Settings > CLI), GlobalPromptDialog and a Quick Command run, with the real
// NotificationStack, in an isolated hidden Electron window. main is a fake:
// the clipboard and pty.submit only record, no pty or config is touched.
// Requires npm run build (CSS).
const fs = require('node:fs'), os = require('node:os'), path = require('node:path')
const { pathToFileURL } = require('node:url')
const { spawnSync } = require('node:child_process')
const { buildSync } = require('esbuild')
const root = path.resolve(__dirname, '..'), dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snagentsos-comfort-toast-'))
const assets = path.join(root, 'out/renderer/assets')
const css = fs.existsSync(assets) && fs.readdirSync(assets).find(f => /^index-.*\.css$/.test(f))
if (!css) throw new Error('Run npm run build first')
buildSync({ stdin: { contents: `
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { RemoteSection } from './src/renderer/components/settings/sections/RemoteSection';
import { CliSettings } from './src/renderer/components/settings/sections/CliSettings';
import { RemoteQrModal } from './src/renderer/components/remote/RemoteQrModal';
import { GlobalPromptDialog } from './src/renderer/components/workspace/GlobalPromptDialog';
import { NotificationStack } from './src/renderer/components/ui/NotificationStack';
import { I18nProvider } from './src/renderer/i18n';
import { applyTheme } from './src/renderer/themes/applyTheme';
import { useAppStore } from './src/renderer/lib/store';
import { useRemoteStore } from './src/renderer/lib/remoteStore';
import { useToastStore } from './src/renderer/lib/toast';
import { registerPty, unregisterPty } from './src/renderer/lib/ptyRegistry';
import { registerPaster, unregisterPaster } from './src/renderer/lib/pasteRegistry';
import { setFocusedPane } from './src/renderer/lib/focus';
import { runQuickCommand } from './src/renderer/lib/quickCommands';
// Unknown snApi calls resolve to null; on* subscriptions return an unsubscribe.
const stub = new Proxy(() => Promise.resolve(null), { get: () => stub });
const api = base => new Proxy(base, { get: (t, k) => k in t ? t[k] : typeof k !== 'string' ? undefined : k.startsWith('on') ? () => () => {} : stub });
const calls = { clipboard: [], submits: [], pasted: [], writes: [] };
let submitAnswer = { ok: true };
window.snApi = api({
  platform: 'linux',
  app: api({ info: async () => ({ version: '2.0.0', platform: 'linux', arch: 'x64', portable: false, configPath: '' }) }),
  clipboard: api({ writeText: text => calls.clipboard.push(text) }),
  config: api({ save() {} }),
  pty: api({ write: req => calls.writes.push(req), submit: async req => { calls.submits.push(req); return submitAnswer } }),
  cli: api({ state: async () => null, skill: async () => null }),
  remote: api({
    pairingBegin: async () => ({ code: 'ABCD2345', expiresAt: Date.now() + 120000, endpoints: [
      { ip: '192.168.0.10', kind: 'lan', url: 'http://192.168.0.10:4517', qrDataUrl: 'data:image/png;base64,iVBORw0KGgo=' },
    ] }),
    pairingCancel() {},
  }),
});
applyTheme('midnight');
const pane = (id, title) => ({ id, type: 'shell', title, color: '#fff', icon: 'terminal' });
window.result = (async () => {
 const wait = (ms = 60) => new Promise(r => setTimeout(r, ms));
 let checks = 0; const check = (ok, label, extra) => { if (!ok) throw new Error(label + (extra !== undefined ? ' ' + JSON.stringify(extra) : '')); checks++ };
 const $ = sel => document.querySelector(sel);
 const toasts = () => useToastStore.getState().items.map(t => ({ kind: t.kind, title: t.title }));
 const shown = () => [...document.querySelectorAll('[data-toast-id]')].map(e => e.textContent);
 const clear = () => useToastStore.setState({ items: [] });
 // A real dblclick sends two clicks: both go through the same handler.
 const doubleClick = el => { el.click(); el.click() };

 useAppStore.setState(s => ({ hydrated: true, activeWorkspaceId: 'ws-0',
  workspaces: [{ id: 'ws-0', name: 'Front', cwd: 'C:/w', panes: [pane('p1', 'Servidor'), pane('p2', 'Tests'), pane('p3', 'Logs')], layout: { grid: 3, order: ['p1', 'p2', 'p3'] } }],
  settings: { ...s.settings, language: 'es', remote: { enabled: true, port: 4517, phoneFit: true, https: { enabled: false, mode: 'tailscaleServe' } } } }));
 useRemoteStore.setState({ status: { state: 'running', port: 4517, endpoints: [{ ip: '192.168.0.10', kind: 'lan', url: 'http://192.168.0.10:4517' }], connectedCount: 0 } });
 const r = createRoot(document.getElementById('root'));
 const render = lang => flushSync(() => r.render(<I18nProvider lang={lang}><RemoteSection /><CliSettings /><RemoteQrModal /><GlobalPromptDialog /><NotificationStack /></I18nProvider>));
 render('es'); await wait(120);

 // --- FR-04: every copy button shows one "Copied to clipboard" -------------------
 const sectionCopy = [...document.querySelectorAll('button[title="Copiar dirección"]')].find(b => b.parentElement?.textContent.includes('http://192.168.0.10:4517'));
 check(sectionCopy, 'Settings > Remote lists the endpoint with its copy button');
 doubleClick(sectionCopy); await wait();
 check(calls.clipboard.join() === 'http://192.168.0.10:4517,http://192.168.0.10:4517', 'the endpoint URL goes to the clipboard', calls.clipboard);
 check(JSON.stringify(toasts()) === JSON.stringify([{ kind: 'success', title: 'Copiado al portapapeles' }]), 'a double click on the Settings copy shows a single success', toasts());
 check(shown().length === 1 && shown()[0].includes('Copiado al portapapeles'), 'the stack shows it once', shown());

 clear(); calls.clipboard.length = 0;
 useRemoteStore.getState().setQrOpen(true); await wait(150);
 const qrCopy = [...document.querySelectorAll('.fixed button[title="Copiar dirección"]')].find(b => b.parentElement?.textContent.includes('http://192.168.0.10:4517'));
 check(qrCopy, 'the QR modal shows the endpoint with its copy button');
 doubleClick(qrCopy); await wait();
 check(calls.clipboard.length === 2 && calls.clipboard[0] === 'http://192.168.0.10:4517', 'the QR copy writes the endpoint', calls.clipboard);
 check(JSON.stringify(toasts()) === JSON.stringify([{ kind: 'success', title: 'Copiado al portapapeles' }]), 'a double click in the QR modal shows a single success', toasts());
 check(useRemoteStore.getState().qrOpen, 'clicking copy keeps the QR modal open');
 useRemoteStore.getState().cancelQr(); await wait();

 clear(); calls.clipboard.length = 0;
 const cliCopy = $('[data-cli-copy]');
 check(cliCopy, 'Settings > CLI has its copy button');
 doubleClick(cliCopy); await wait();
 check(calls.clipboard.length === 2 && toasts().length === 1 && toasts()[0].title === 'Copiado al portapapeles', 'the CLI copy uses the same deduped toast', toasts());

 // --- FR-05: global prompt reports how many consoles got it ----------------------
 const live = ids => {
  for (const id of ['p1', 'p2', 'p3']) { unregisterPty(id); unregisterPaster(id) }
  for (const id of ids) { registerPty(id, 'pty-' + id); registerPaster(id, { paste: text => calls.pasted.push(id + ':' + text), bracketed: () => false }) }
 };
 const setArea = (el, v) => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })) };
 const sendPrompt = async (text, opts = {}) => {
  clear(); calls.pasted.length = 0;
  useAppStore.getState().setGlobalPromptOpen(true); await wait();
  check($('[data-global-prompt]'), 'the global prompt dialog opens');
  setArea($('[data-global-prompt-text]'), text); await wait(30);
  if (opts.enter) { $('[data-global-prompt-enter]').click(); await wait(30) }
  $('[data-global-prompt-send]').click(); await wait();
  check(!$('[data-global-prompt]'), 'sending closes the dialog');
 };
 live(['p1', 'p2', 'p3']);
 await sendPrompt('corre los tests');
 check(calls.pasted.length === 3, 'three live consoles received the text', calls.pasted);
 check(JSON.stringify(toasts()) === JSON.stringify([{ kind: 'success', title: 'Prompt insertado en 3 consolas (sin Enter)' }]), 'three consoles: plural success without Enter', toasts());
 check(calls.writes.length === 0, 'without "Send with Enter" nothing presses Enter');
 live(['p2']);
 await sendPrompt('solo una');
 check(JSON.stringify(toasts()) === JSON.stringify([{ kind: 'success', title: 'Prompt insertado en 1 consola (sin Enter)' }]), 'one console: singular success', toasts());
 live([]);
 await sendPrompt('nadie');
 check(calls.pasted.length === 0 && JSON.stringify(toasts()) === JSON.stringify([{ kind: 'warning', title: 'Ninguna consola activa recibió el prompt' }]), 'no live console: the warning, not a success', toasts());
 live(['p1', 'p3']);
 await sendPrompt('con enter', { enter: true });
 check(toasts().length === 1 && toasts()[0].kind === 'success' && toasts()[0].title === 'Prompt enviado a 2 consolas (Enter solo a los agentes)', 'with Enter the copy says sent', toasts());

 // --- FR-06: a Quick Command run names the command and the console ----------------
 clear(); live(['p1', 'p2']); setFocusedPane('p2', 'ws-0');
 const send = { id: 'qc-1', name: 'Compilar', text: 'npm run build', action: 'send', enter: true };
 let res = await runQuickCommand(send); await wait();
 check(res.ok && calls.submits.at(-1).ptyId === 'pty-p2', 'the command went to the focused console', calls.submits.at(-1));
 check(JSON.stringify(toasts()) === JSON.stringify([{ kind: 'success', title: 'Enviado: Compilar a Tests' }]), 'the success names the command and the target console', toasts());
 check(shown().some(t => t.includes('Compilar') && t.includes('Tests')), 'the stack shows both names', shown());
 clear(); live([]);
 res = await runQuickCommand(send); await wait();
 check(!res.ok && res.error === 'no_console', 'with no live console nothing runs', res);
 check(JSON.stringify(toasts()) === JSON.stringify([{ kind: 'error', title: 'No hay consola activa' }]), 'no target console: an error toast', toasts());
 clear(); live(['p1']); submitAnswer = { ok: false, error: 'not_running' };
 res = await runQuickCommand(send); await wait();
 check(toasts().length === 1 && toasts()[0].kind === 'error', 'a pty that ended under the send is the same error', toasts());
 clear(); submitAnswer = { ok: false, error: 'multiline_unsafe' };
 await runQuickCommand({ ...send, text: 'a\\nb' }); await wait();
 check(toasts().length === 1 && toasts()[0].kind === 'warning' && toasts()[0].title.startsWith('Texto multil'), 'multi-line on a console without bracketed paste stays a warning', toasts());
 submitAnswer = { ok: true };

 // English copy.
 clear(); render('en'); useAppStore.getState().updateSettings({ language: 'en' }); setFocusedPane('p1', 'ws-0'); await wait();
 await runQuickCommand(send); await wait();
 check(toasts()[0]?.title === 'Sent: Compilar to Servidor', 'English names both too', toasts());
 clear(); doubleClick($('[data-cli-copy]')); await wait();
 check(toasts().length === 1 && toasts()[0].title === 'Copied to clipboard', 'English copy toast', toasts());
 r.unmount();
 return checks;
})();
`, resolveDir: root, loader: 'tsx' }, bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' }, alias: { '@shared': path.join(root, 'src/shared'), '@': path.join(root, 'src/renderer') }, loader: { '.css': 'empty', '.woff2': 'empty', '.woff': 'empty', '.png': 'empty', '.svg': 'empty' }, outfile: path.join(dir, 'renderer.js') })
fs.writeFileSync(path.join(dir, 'index.html'), `<html><head><meta charset="utf-8"><link rel="stylesheet" href="${pathToFileURL(path.join(assets, css))}"></head><body><div id="root"></div><script src="renderer.js"></script></body></html>`)
fs.writeFileSync(path.join(dir, 'main.cjs'), `
const {app,BrowserWindow}=require('electron');const path=require('path');
app.setPath('userData',path.join(__dirname,'profile'));
app.whenReady().then(async()=>{
 const w=new BrowserWindow({show:false,width:1000,height:900,webPreferences:{sandbox:true,backgroundThrottling:false}});
 const failures=[];w.webContents.on('console-message',(_e,level,message)=>{if(process.env.SN_UI_DEBUG)console.log('[renderer]',level,message);if(level>=3)failures.push(message)});
 await w.loadFile(path.join(__dirname,'index.html'));
 const checks=await w.webContents.executeJavaScript('window.result');
 if(failures.length)throw new Error(failures.join('\\n'));
 console.log('PASS: '+checks+' comfort toast checks (endpoint copy x3 deduped, global prompt N/1/0/Enter, Quick Command names the console, no-console error, en)');
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
