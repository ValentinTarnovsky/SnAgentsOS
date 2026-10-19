// The phone's secure mode pieces (E3-FR-43, 44, 48, 49) with the production
// CSS in an isolated offscreen browser at phone width: the real LiveShell and
// KeyBar with a stubbed control plane. `window.isSecureContext`, the push
// manager, Notification, the wake lock and the clipboard are stubbed, so the
// same page plays the http origin and the https one:
//  - http: the "secure version available" card on Home (Open link, dismiss
//    remembered), no Notifications row, the wake lock switch disabled with
//    "Requires secure mode", and Paste opening the one-shot composer;
//  - https: "Enable notifications" subscribes through the service worker
//    and posts the subscription with the Bearer, the iPhone Safari guide, the
//    wake lock taken in a console and let go on Home, and Paste writing the
//    clipboard as a bracketed paste without opening the composer.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path')
const { pathToFileURL } = require('node:url')
const { spawnSync } = require('node:child_process')
const root = path.resolve(__dirname, '..')
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snagentsos-mobile-secure-ui-'))
const assets = path.join(root, 'out/mobile/assets')
const mobileCss = fs.existsSync(assets) && fs.readdirSync(assets).find(name => /^index-.*\.css$/.test(name))
if (!mobileCss) throw new Error('Run npm run build:mobile first')
require('esbuild').buildSync({ stdin: { resolveDir: root, loader: 'tsx', contents: `
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { LiveShell } from './src/mobile/src/components/LiveShell';
import { KeyBar } from './src/mobile/src/components/KeyBar';
import { pasteKey } from './src/mobile/src/components/pasteKey';
import { store } from './src/mobile/src/lib/store';
import { client } from './src/mobile/src/lib/client';
import { setLang } from './src/mobile/src/lib/i18n';
import { usePushStore } from './src/mobile/src/lib/push';
import { startWakeLock, useWakeLockStore } from './src/mobile/src/lib/wakeLock';
import { setActiveTerm } from './src/mobile/src/lib/terminalBus';
const wait = ms => new Promise(r => setTimeout(r, ms));
const frames = () => wait(40);
let checks = 0; const check = (ok, label) => { if (!ok) throw new Error(label); checks++ };
const noOverflow = () => document.documentElement.scrollWidth <= window.innerWidth;
const $ = sel => document.querySelector(sel);
const click = el => el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 }));
const ptr = (el, type) => { const r = el.getBoundingClientRect(); el.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 1, pointerType: 'touch', isPrimary: true, clientX: r.left + 5, clientY: r.top + 5 })) };
const tapKey = el => { ptr(el, 'pointerdown'); ptr(el, 'pointerup') };
let secure = false;
Object.defineProperty(window, 'isSecureContext', { configurable: true, get: () => secure });
try { Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' }) } catch {}
let ua = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/126 Mobile Safari/537.36';
Object.defineProperty(navigator, 'userAgent', { configurable: true, get: () => ua });
// Push plumbing: Notification, the service worker registration and fetch.
let permission = 'default';
window.Notification = { get permission() { return permission }, requestPermission: async () => { permission = 'granted'; return 'granted' } };
if (!('PushManager' in window)) window.PushManager = function () {};
let current = null; const subscribed = [];
const key = 'BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U';
const toBytes = b64 => Uint8Array.from(atob(b64.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - b64.length % 4) % 4)), c => c.charCodeAt(0));
const reg = { pushManager: {
  getSubscription: async () => current,
  subscribe: async opts => { subscribed.push(opts); current = { options: { applicationServerKey: opts.applicationServerKey.buffer }, toJSON: () => ({ endpoint: 'https://fcm.googleapis.com/fcm/send/x', expirationTime: null, keys: { p256dh: 'p', auth: 'a' } }), unsubscribe: async () => { current = null; return true } }; return current },
} };
Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: { ready: Promise.resolve(reg), register: async () => reg, addEventListener() {} } });
const posts = [];
window.fetch = async (url, init) => { posts.push({ url, init }); return { status: 200 } };
// Wake lock.
const wakeLog = [];
Object.defineProperty(navigator, 'wakeLock', { configurable: true, value: { request: async () => { const s = { released: false, fns: [], addEventListener(t, fn) { this.fns.push(fn) }, release: async () => { s.released = true; wakeLog.push('release'); s.fns.forEach(f => f()) } }; wakeLog.push('request'); return s } } });
// Clipboard.
let clip = async () => 'hola\\nmundo';
Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { readText: () => clip(), writeText: async () => {} } });
client.sendCtl = async () => ({ ok: true });
const pane = (id, title, type) => ({ id, title, type, color: '', icon: '', running: true });
const snapshot = { language: 'en', themeTokens: {}, fontFamily: 'mono', fontSize: 13, activeWorkspaceId: 'w1', hostName: 'PC', keyButtons: [], mountedWorkspaceIds: ['w1'],
  workspaces: [{ id: 'w1', name: 'Front', layoutOrder: ['a1', 'a2'], panes: [pane('a1', 'Builder', 'claude'), pane('a2', 'Shell', 'shell')] }] };
const SECURE_URL = 'https://pc.tail1234.ts.net';
window.runMain = async () => {
 try { localStorage.clear() } catch {}
 setLang('en');
 store.getState().update({ phase: 'live', snapshot, paneStatus: { a1: { state: 'idle', stateSince: 1, provider: 'claude' } }, connected: true, appVersion: '2.0.0', screen: 'home', activePaneId: null, subscribedPaneId: null, lastPane: null, lastViewedAt: {}, homeCollapsed: [], toasts: [], toast: null, httpToken: 'ab'.repeat(32), pushKey: null, secureUrl: SECURE_URL });
 const host = document.getElementById('root'); const r = createRoot(host);
 flushSync(() => r.render(<LiveShell />));
 await frames();

 // --- http origin ---
 const card = $('[data-secure-card]');
 check(card && card.textContent.includes('A secure version is available') && card.querySelector('[data-secure-open]').getAttribute('href') === SECURE_URL, 'http: Home shows the secure version card linking to the https origin');
 check(card.textContent.includes('pair this phone again'), 'the card says the phone pairs again there');
 check(card.querySelector('[data-secure-open]').getBoundingClientRect().height >= 40 && noOverflow(), 'Open is a 40px target and the card fits 360px');
 click(card.querySelector('[data-secure-dismiss]'));
 await frames();
 check(!$('[data-secure-card]') && localStorage.getItem('snagentsos.remote.secureCardDismissed') === SECURE_URL, 'dismiss hides it and remembers that address');
 click($('[data-home-settings]'));
 await wait(420);
 check(!$('[data-settings-section=push]'), 'http: no Notifications row (FR-44)');
 const wakeRow = $('[data-pref=wakeLock]');
 check(wakeRow && wakeRow.disabled && wakeRow.textContent.includes('Requires secure mode'), 'http: the wake lock switch is disabled with "Requires secure mode" (FR-49)');
 history.back(); await wait(420);
 flushSync(() => store.getState().update({ secureUrl: 'https://other.tail1234.ts.net' }));
 await frames();
 check(!!$('[data-secure-card]'), 'a different secure address shows the card again');

 // --- https origin ---
 secure = true;
 flushSync(() => store.getState().update({ pushKey: key, secureUrl: SECURE_URL }));
 await frames();
 check(!$('[data-secure-card]'), 'https: no card (already on the secure origin)');
 click($('[data-home-settings]'));
 await wait(420);
 const push = $('[data-settings-section=push]');
 check(push && push.querySelector('[data-pref=push]').textContent.includes('Enable notifications'), 'https + pushKey: "Enable notifications" (FR-44)');
 click(push.querySelector('[data-pref=push]'));
 for (let i = 0; i < 20 && usePushStore.getState().state !== 'on'; i++) await wait(20);
 check(usePushStore.getState().state === 'on' && push.querySelector('[data-pref=push]').getAttribute('aria-checked') === 'true', 'tapping it subscribes and shows on');
 check(subscribed.length === 1 && subscribed[0].userVisibleOnly === true && subscribed[0].applicationServerKey.join() === toBytes(key).join(), 'pushManager.subscribe with userVisibleOnly and the desktop key');
 const post = posts.at(-1);
 check(post.url === '/api/push/subscribe' && post.init.headers.Authorization === 'Bearer ' + 'ab'.repeat(32) && JSON.parse(post.init.body).endpoint.startsWith('https://fcm.googleapis.com/'), 'POST /api/push/subscribe with the Bearer and the subscription');
 click(push.querySelector('[data-pref=push]'));
 for (let i = 0; i < 20 && usePushStore.getState().state !== 'off'; i++) await wait(20);
 check(current === null && push.querySelector('[data-pref=push]').getAttribute('aria-checked') === 'false', 'tapping again unsubscribes on the phone');
 const wake = $('[data-pref=wakeLock]');
 check(!wake.disabled && wake.textContent.includes('Keep the screen on while I watch a console'), 'https: the wake lock switch is enabled');
 click(wake);
 await frames();
 check(useWakeLockStore.getState().pref === true && localStorage.getItem('snagentsos.remote.wakeLock') === '1', 'the wake lock setting persists in snagentsos.remote.wakeLock');
 check(noOverflow(), 'Settings fits 360px');
 // iPhone in a Safari tab: the guide instead of the switch.
 ua = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 Version/17.4 Mobile/15E148 Safari/604.1';
 flushSync(() => store.getState().update({ snapshot: { ...snapshot, themeName: 'nord' } }));
 await frames();
 const ios = $('[data-push-ios]');
 check(ios && ios.textContent.includes('add SnAgentsOS Remote to the home screen (iOS 16.4+)') && !$('[data-pref=push]'), 'iPhone Safari tab: the install guide, no switch');
 setLang('es');
 flushSync(() => store.getState().update({ snapshot: { ...snapshot, language: 'es', themeName: 'dracula' } }));
 await frames();
 check($('[data-push-ios]').textContent.includes('agregá SnAgentsOS Remote a la pantalla de inicio') && $('[data-pref=wakeLock]').textContent.includes('Mantener pantalla encendida mientras miro una consola'), 'Spanish guide and wake lock label');
 setLang('en');
 ua = 'Mozilla/5.0 (Linux; Android 14)';
 history.back(); await wait(420);

 // Wake lock follows the screen (FR-49).
 startWakeLock();
 wakeLog.length = 0;
 flushSync(() => store.getState().update({ screen: 'terminal' }));
 await frames();
 check(wakeLog.join() === 'request' && useWakeLockStore.getState().held, 'a console on screen takes the wake lock');
 flushSync(() => store.getState().update({ screen: 'home' }));
 await frames();
 check(wakeLog.join() === 'request,release' && !useWakeLockStore.getState().held, 'Home lets it go');
 r.unmount();

 // --- Paste key (FR-48) ---
 const kb = createRoot(host);
 const sent = [];
 client.sendInputTo = (paneId, data) => { sent.push([paneId, data]); return true };
 client.isOpen = () => true;
 const helper = document.createElement('textarea'); document.body.appendChild(helper);
 setActiveTerm({ textarea: helper, modes: { applicationCursorKeysMode: false, bracketedPasteMode: true } });
 store.getState().update({ activePaneId: 'a1', subscribedPaneId: 'a1', composerOneShot: null, inputModes: { a1: 'direct' }, banner: null });
 flushSync(() => kb.render(<KeyBar onPaste={pasteKey} onQuickCommands={() => {}} inputMode="direct" />));
 await frames();
 const pasteBtn = host.querySelector('button[aria-label="Paste"]');
 tapKey(pasteBtn);
 await wait(60);
 check(sent.length === 1 && sent[0][0] === 'a1' && sent[0][1] === '\\x1b[200~hola\\rmundo\\x1b[201~' && store.getState().composerOneShot === null, 'https: Paste writes the clipboard as one bracketed paste, no composer');
 clip = async () => { throw new DOMException('denied', 'NotAllowedError') };
 tapKey(pasteBtn);
 await wait(60);
 check(sent.length === 1 && store.getState().composerOneShot === 'a1', 'a refused clipboard read opens the one-shot composer (D11)');
 store.getState().update({ composerOneShot: null });
 secure = false;
 clip = async () => 'never read';
 tapKey(pasteBtn);
 check(store.getState().composerOneShot === 'a1' && sent.length === 1, 'http: Paste opens the one-shot composer at once');
 kb.unmount();
 return checks;
};
` }, bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic', define: { __APP_VERSION__: '"2.0.0"', 'process.env.NODE_ENV': '"production"' }, alias: { '@shared': path.join(root, 'src/shared') }, loader: { '.css': 'empty' }, outfile: path.join(dir, 'renderer.js') })
fs.writeFileSync(path.join(dir, 'index.html'), `<html><head><meta charset="utf-8"><link rel="stylesheet" href="${pathToFileURL(path.join(assets, mobileCss))}"></head><body style="margin:0"><div id="root"></div><script src="renderer.js"></script></body></html>`)
fs.writeFileSync(path.join(dir, 'main.cjs'), `
const {app,BrowserWindow}=require('electron');const path=require('path');
app.setPath('userData',path.join(__dirname,'profile'));
app.whenReady().then(async()=>{
 const w=new BrowserWindow({show:false,width:360,height:640,useContentSize:true,webPreferences:{sandbox:true,backgroundThrottling:false,offscreen:true}});
 await w.loadFile(path.join(__dirname,'index.html'));
 const checks=await w.webContents.executeJavaScript('window.runMain()');
 console.log('PASS: '+checks+' mobile secure mode UI checks (card, notifications, wake lock, paste key)');w.destroy();app.quit();
}).catch(e=>{console.error(e);app.exit(1)});
`)
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
const flags = process.platform === 'linux' && process.env.CI ? ['--no-sandbox'] : []
const result = spawnSync(require('electron'), [...flags, path.join(dir, 'main.cjs')], { env, windowsHide: true, encoding: 'utf8', timeout: 90000 })
process.stdout.write(result.stdout ?? '')
process.stderr.write((result.stderr ?? '') + (result.error ? result.error.message : ''))
fs.rmSync(dir, { recursive: true, force: true })
if (result.status !== 0 || !/^PASS:/m.test(result.stdout ?? '')) process.exit(1)
