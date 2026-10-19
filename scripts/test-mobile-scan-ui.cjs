// The phone's in-app QR scanner (E3-FR-50) on a secure origin, end to end, in
// an isolated offscreen browser at phone width. The page is served over
// http://127.0.0.1 (loopback is a secure context, like the https tailnet
// origin) with the production CSP header from RemoteServer, and Chromium's fake
// camera plays a Y4M clip of a desktop pairing QR, so the real getUserMedia,
// <video>, canvas sampling and jsQR decode run with no camera attached:
//  - secure origin: Scan opens the live viewfinder (no photo button), asks for
//    the rear camera, reads the QR off the live video, starts pairing with its
//    code, closes the overlay and stops the camera;
//  - camera refused: falls back to the photo capture with "Camera unavailable";
//  - insecure origin (no mediaDevices, like plain-http LAN): photo capture with
//    capture=environment, a photo of the QR pairs, a photo without one says so;
//  - the manual 8-char code, Spanish strings, 360px fit and no CSP violations.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path')
const { spawnSync } = require('node:child_process')
const QRCode = require('qrcode')
const root = path.resolve(__dirname, '..')
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snagentsos-mobile-scan-ui-'))
const assets = path.join(root, 'out/mobile/assets')
const mobileCss = fs.existsSync(assets) && fs.readdirSync(assets).find(name => /^index-.*\.css$/.test(name))
if (!mobileCss) throw new Error('Run npm run build:mobile first')
// The production CSP, read from source so the test follows any change to it.
const csp = fs.readFileSync(path.join(root, 'src/main/remote/RemoteServer.ts'), 'utf8').match(/export const CSP =\s*\n?\s*"([^"]+)"/)
if (!csp) throw new Error('CSP constant not found in RemoteServer.ts')
// font-src 'self' blocks data: fonts, so the bundle must ship every font as a file.
if (/url\(data:font\//.test(fs.readFileSync(path.join(assets, mobileCss), 'utf8'))) throw new Error('the mobile CSS inlines a data: font that the CSP blocks')

// Fake camera clip: 640x480 YUV 4:2:0 frames of the desktop pairing QR, which
// Chromium loops as the only video input device.
const LIVE_CODE = 'ABCD2345'
const W = 640, H = 480
const qr = QRCode.create(`http://192.168.1.20:7777/#pair=${LIVE_CODE}`, { errorCorrectionLevel: 'M' })
const quiet = 4, mod = 10, side = (qr.modules.size + quiet * 2) * mod
if (side > H) throw new Error('QR clip does not fit the frame')
const luma = Buffer.alloc(W * H, 235)
const ox = (W - side) / 2, oy = (H - side) / 2
for (let y = 0; y < side; y++) {
  for (let x = 0; x < side; x++) {
    const r = Math.floor(y / mod) - quiet, c = Math.floor(x / mod) - quiet
    if (r >= 0 && c >= 0 && r < qr.modules.size && c < qr.modules.size && qr.modules.get(r, c)) luma[(oy + y) * W + ox + x] = 16
  }
}
const chroma = Buffer.alloc((W / 2) * (H / 2) * 2, 128)
const frame = Buffer.concat([Buffer.from('FRAME\n'), luma, chroma])
fs.writeFileSync(path.join(dir, 'camera.y4m'), Buffer.concat([Buffer.from(`YUV4MPEG2 W${W} H${H} F30:1 Ip A1:1 C420jpeg\n`), frame, frame, frame]))

require('esbuild').buildSync({ stdin: { resolveDir: root, loader: 'tsx', contents: `
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import QRCode from 'qrcode';
import { ScanScreen } from './src/mobile/src/components/ScanScreen';
import { store, useRemoteStore } from './src/mobile/src/lib/store';
import { client } from './src/mobile/src/lib/client';
import { setLang } from './src/mobile/src/lib/i18n';
const wait = ms => new Promise(r => setTimeout(r, ms));
const frames = () => wait(40);
let checks = 0; const check = (ok, label) => { if (!ok) throw new Error(label); checks++ };
const noOverflow = () => document.documentElement.scrollWidth <= window.innerWidth;
const $ = sel => document.querySelector(sel);
const click = el => el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 }));
const until = async (fn, ms) => { for (let t = 0; t < ms && !fn(); t += 50) await wait(50); return fn() };
const violations = [];
document.addEventListener('securitypolicyviolation', e => violations.push(e.violatedDirective + ' ' + e.blockedURI));
const paired = [];
client.startPairing = code => { paired.push(code) };
const realGum = navigator.mediaDevices && navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
const gumCalls = []; const streams = [];
let gum = async constraints => { gumCalls.push(constraints); const s = await realGum(constraints); streams.push(s); return s };
const setMedia = value => Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value });
const liveMedia = { getUserMedia: c => gum(c) };
function Overlay() { const open = useRemoteStore(s => s.scanOpen); return open ? <ScanScreen /> : null }
const host = document.getElementById('root');
const r = createRoot(host);
const open = async () => { flushSync(() => store.getState().update({ scanOpen: true, pairReason: 'expired' })); await frames() };
const qrPhoto = async text => {
  const canvas = document.createElement('canvas');
  if (text) await QRCode.toCanvas(canvas, text, { margin: 4, scale: 8 });
  else { canvas.width = canvas.height = 300; const ctx = canvas.getContext('2d'); ctx.fillStyle = '#888'; ctx.fillRect(0, 0, 300, 300) }
  const blob = await new Promise(res => canvas.toBlob(res, 'image/png'));
  return new File([blob], 'photo.png', { type: 'image/png' });
};
const pickPhoto = (input, file) => { const dt = new DataTransfer(); dt.items.add(file); input.files = dt.files; input.dispatchEvent(new Event('change', { bubbles: true })) };
window.runMain = async () => {
 setLang('en');
 check(window.isSecureContext === true && typeof realGum === 'function', 'the loopback origin is a secure context with getUserMedia');
 flushSync(() => r.render(<Overlay />));

 // --- secure origin: live camera (FR-50) ---
 setMedia(liveMedia);
 await open();
 const video = $('video');
 check(video && video.muted && video.hasAttribute('playsinline') && !$('input[type=file]'), 'Scan opens the live viewfinder, no photo button');
 check($('h1').textContent === 'Scan the QR code' && host.textContent.includes('Point the camera at the QR in Settings > Remote control on the desktop.'), 'the live screen shows the aim hint');
 const box = video.parentElement.getBoundingClientRect();
 check(box.width > 200 && box.width <= 280 && Math.abs(box.width - box.height) < 2 && noOverflow(), 'a square viewfinder up to 280px that fits 360px');
 check(await until(() => gumCalls.length === 1, 2000) && gumCalls[0].audio === false && gumCalls[0].video.facingMode === 'environment', 'getUserMedia asks for the rear camera, no audio');
 check(await until(() => video.readyState >= 2 && video.videoWidth === ${W}, 5000), 'the camera stream plays in the viewfinder');
 check(await until(() => paired.length === 1, 8000) && paired[0] === '${LIVE_CODE}', 'the QR on the live video starts pairing with its code');
 await frames();
 check(store.getState().scanOpen === false && store.getState().pairReason === null && !$('video'), 'pairing closes the scanner and clears the deny reason');
 check(streams.length === 1 && streams[0].getTracks().every(t => t.readyState === 'ended'), 'closing the scanner stops the camera');
 await wait(400);
 check(paired.length === 1, 'one QR pairs once');

 // Closing with X while live also lets the camera go. The fake camera still
 // shows the QR, so this round films a blank canvas instead.
 gum = async constraints => {
  gumCalls.push(constraints);
  const cv = document.createElement('canvas'); cv.width = 320; cv.height = 240;
  const ctx = cv.getContext('2d'); ctx.fillStyle = '#777'; ctx.fillRect(0, 0, 320, 240);
  const s = cv.captureStream(5); streams.push(s); return s;
 };
 await open();
 check(await until(() => streams.length === 2 && $('video') && $('video').srcObject === streams[1], 3000), 'reopening starts the camera again');
 await wait(500);
 check(paired.length === 1 && !!$('video'), 'a frame without a QR keeps scanning');
 click($('h1').parentElement.querySelector('button'));
 await frames();
 check(!$('video') && store.getState().scanOpen === false && streams[1].getTracks().every(t => t.readyState === 'ended'), 'X closes the scanner and stops the camera');
 paired.length = 0;

 // --- camera refused ---
 gum = async () => { throw new DOMException('Permission denied', 'NotAllowedError') };
 await open();
 check(await until(() => !!$('input[type=file]'), 2000) && !$('video'), 'a refused camera falls back to the photo capture');
 check(host.textContent.includes('Camera unavailable. Take a photo or type the code instead.'), 'and says the camera is unavailable');
 flushSync(() => store.getState().update({ scanOpen: false }));
 await frames();

 // --- insecure origin (plain-http LAN): no mediaDevices ---
 setMedia(undefined);
 await open();
 const input = $('input[type=file]');
 check(!$('video') && input && input.getAttribute('capture') === 'environment' && input.accept === 'image/*', 'http: the photo capture opens the rear camera');
 check(host.textContent.includes('Take a photo of the QR') && host.textContent.includes('The camera will open. Take a photo of the QR shown on the desktop.'), 'http: the photo hint and button');
 pickPhoto(input, await qrPhoto(''));
 check(await until(() => host.textContent.includes('No QR found in the photo. Get closer and try again.'), 4000) && paired.length === 0, 'a photo without a QR says so');
 pickPhoto($('input[type=file]'), await qrPhoto('http://10.0.0.5:7777/#pair=PHOTO234'));
 check(await until(() => paired.length === 1, 4000) && paired[0] === 'PHOTO234' && store.getState().scanOpen === false, 'a photo of the QR pairs with its code');
 check(violations.length === 0, 'no CSP violations (blob photo, live stream): ' + violations.join(', '));

 // --- manual code and Spanish ---
 paired.length = 0;
 setLang('es');
 await open();
 check($('h1').textContent === 'Escanear el codigo QR' && host.textContent.includes('o escribi el codigo de 8 caracteres'), 'Spanish scanner strings');
 const field = $('input[placeholder="ABCD2345"]');
 const go = [...host.querySelectorAll('button')].find(b => b.textContent === 'Ir');
 const setField = v => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(field, v); field.dispatchEvent(new Event('input', { bubbles: true })) };
 setField('abc');
 await frames();
 check(go.disabled && field.value === 'ABC', 'a short code keeps Go disabled (uppercased)');
 setField('wxyz6789');
 await frames();
 check(!go.disabled, 'eight characters enable Go');
 click(go);
 await frames();
 check(paired.join() === 'WXYZ6789' && store.getState().scanOpen === false, 'the typed code starts pairing');
 setLang('en');
 r.unmount();
 return checks;
};
` }, bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic', define: { __APP_VERSION__: '"2.0.0"', 'process.env.NODE_ENV': '"production"' }, alias: { '@shared': path.join(root, 'src/shared') }, loader: { '.css': 'empty' }, outfile: path.join(dir, 'renderer.js') })
fs.copyFileSync(path.join(assets, mobileCss), path.join(dir, 'app.css'))
fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><link rel="stylesheet" href="/app.css"></head><body style="margin:0"><div id="root"></div><script src="/renderer.js"></script></body></html>')
fs.writeFileSync(path.join(dir, 'csp.txt'), csp[1])
fs.writeFileSync(path.join(dir, 'main.cjs'), `
const {app,BrowserWindow}=require('electron');const path=require('path');const fs=require('fs');const http=require('http');
app.setPath('userData',path.join(__dirname,'profile'));
app.commandLine.appendSwitch('use-fake-device-for-media-stream');
app.commandLine.appendSwitch('use-fake-ui-for-media-stream');
app.commandLine.appendSwitch('use-file-for-fake-video-capture',path.join(__dirname,'camera.y4m'));
const csp=fs.readFileSync(path.join(__dirname,'csp.txt'),'utf8');
const types={'/':'text/html','/app.css':'text/css','/renderer.js':'text/javascript'};
const server=http.createServer((req,res)=>{const p=req.url.split('?')[0];const t=types[p];if(!t){res.writeHead(404);res.end();return}
 res.writeHead(200,{'Content-Type':t+'; charset=utf-8','Content-Security-Policy':csp,'X-Content-Type-Options':'nosniff'});
 res.end(fs.readFileSync(path.join(__dirname,p==='/'?'index.html':p.slice(1))))});
app.whenReady().then(async()=>{
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const w=new BrowserWindow({show:false,width:360,height:640,useContentSize:true,webPreferences:{sandbox:true,backgroundThrottling:false,offscreen:true}});
 await w.loadURL('http://127.0.0.1:'+server.address().port+'/');
 const checks=await w.webContents.executeJavaScript('window.runMain()');
 console.log('PASS: '+checks+' mobile QR scanner UI checks (live camera on a secure origin, photo fallback, manual code)');w.destroy();server.close();app.quit();
}).catch(e=>{console.error(e);app.exit(1)});
`)
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
const flags = process.platform === 'linux' && process.env.CI ? ['--no-sandbox'] : []
const result = spawnSync(require('electron'), [...flags, path.join(dir, 'main.cjs')], { env, windowsHide: true, encoding: 'utf8', timeout: 90000 })
process.stdout.write(result.stdout ?? '')
process.stderr.write((result.stderr ?? '') + (result.error ? result.error.message : ''))
fs.rmSync(dir, { recursive: true, force: true })
if (result.status !== 0 || !/^PASS:/m.test(result.stdout ?? '')) process.exit(1)
