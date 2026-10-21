// Desktop dictation capture (app 2.5.0) on the real load path, in a hidden
// Electron window with Chromium's fake microphone
// (use-fake-device-for-media-stream). It loads the BUILT
// out/renderer/index.html with the real preload, the production CSP that
// registerCsp sets (read from the built out/main/index.js) and the real
// installPermissionHandlers, then runs dictationCapture in that page:
//  - the CSP is live (eval and a data: worklet are blocked), yet the worklet
//    loads from out/renderer/dictation-worklet.js (src/renderer/public);
//  - at least 8 chunks of 3200 bytes (16 kHz s16, 100 ms) arrive within 1.2 s;
//  - the permission handler saw `media` with only 'audio' and allowed it;
//  - getUserMedia with video (alone or with audio) is rejected on the app
//    page, and a foreign file page gets no microphone at all.
// The same capture then runs from inside an app.asar, the packaged layout
// (out/renderer packed with @electron/asar, as electron-builder does), or
// from SNAOS_TEST_ASAR=<path to app.asar> (from npm run pack:dir). Requires
// npm run build.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path')
const { pathToFileURL } = require('node:url')
const { spawnSync } = require('node:child_process')
const { buildSync } = require('esbuild')
const root = path.resolve(__dirname, '..')
// SNAOS_TEST_OUT: another build output folder laid out like out/ (main, preload, renderer).
const out = process.env.SNAOS_TEST_OUT ? path.resolve(process.env.SNAOS_TEST_OUT) : path.join(root, 'out')
const index = path.join(out, 'renderer/index.html')
const preload = path.join(out, 'preload/index.js')
const mainJs = path.join(out, 'main/index.js')
for (const f of [index, preload, mainJs]) if (!fs.existsSync(f)) throw new Error(`Missing ${path.relative(root, f)}: run npm run build first`)

// The build ships the worklet next to index.html, byte for byte.
const workletSrc = fs.readFileSync(path.join(root, 'src/renderer/public/dictation-worklet.js'), 'utf8')
const workletOut = path.join(out, 'renderer/dictation-worklet.js')
if (!fs.existsSync(workletOut) || fs.readFileSync(workletOut, 'utf8') !== workletSrc) throw new Error('out/renderer/dictation-worklet.js is missing or stale: run npm run build')
// The app bundle resolves the same file name against the page (dictationCapture.workletUrl).
const assets = path.join(out, 'renderer/assets')
const appBundle = fs.readdirSync(assets).filter((f) => /\.js$/.test(f)).map((f) => fs.readFileSync(path.join(assets, f), 'utf8')).find((t) => t.includes('dictation-worklet.js'))
if (!appBundle || !appBundle.includes('snaos-pcm')) throw new Error('the built renderer bundle does not load dictation-worklet.js / snaos-pcm: run npm run build')
// registerCsp's production policy, as built.
const cspMatch = fs.readFileSync(mainJs, 'utf8').match(/["`](default-src 'self'; script-src 'self'; [^"`]*)["`]/)
if (!cspMatch) throw new Error('production CSP not found in out/main/index.js')
const csp = cspMatch[1]

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snagentsos-capture-ui-'))
const alias = { '@shared': path.join(root, 'src/shared'), '@': path.join(root, 'src/renderer') }
buildSync({ entryPoints: [path.join(root, 'src/main/permissions.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: path.join(dir, 'permissions.cjs'), external: ['electron'], alias })
buildSync({ stdin: { contents: `import { startCapture, workletUrl, CHUNK_BYTES } from './src/renderer/lib/dictationCapture'; (window as any).__snaosCapture = { startCapture, workletUrl, CHUNK_BYTES }`, resolveDir: root, loader: 'ts' }, bundle: true, platform: 'browser', format: 'iife', outfile: path.join(dir, 'capture.js'), alias })
fs.writeFileSync(path.join(dir, 'evil.html'), '<!doctype html><html><head><meta charset="utf-8"></head><body>not the app</body></html>')
let asar = process.env.SNAOS_TEST_ASAR ? path.resolve(process.env.SNAOS_TEST_ASAR) : ''
if (!asar) {
  // Packed layout: <app.asar>/out/renderer/index.html, read through Electron's asar support.
  const stage = path.join(dir, 'asar-src')
  fs.mkdirSync(path.join(stage, 'out'), { recursive: true })
  fs.cpSync(path.join(out, 'renderer'), path.join(stage, 'out/renderer'), { recursive: true })
  fs.writeFileSync(path.join(stage, 'package.json'), '{"name":"capture-smoke","main":"out/main/index.js"}')
  asar = path.join(dir, 'app.asar')
}
fs.writeFileSync(path.join(dir, 'cfg.json'), JSON.stringify({
  csp,
  appUrl: pathToFileURL(index).href,
  preload,
  evilUrl: pathToFileURL(path.join(dir, 'evil.html')).href,
  asarUrl: asar ? pathToFileURL(path.join(asar, 'out/renderer/index.html')).href : '',
}))

fs.writeFileSync(path.join(dir, 'main.cjs'), `
const {app,BrowserWindow,session}=require('electron');const fs=require('fs'),path=require('path');
app.commandLine.appendSwitch('use-fake-device-for-media-stream');
app.setPath('userData',path.join(__dirname,'profile'));
const cfg=JSON.parse(fs.readFileSync(path.join(__dirname,'cfg.json'),'utf8'));
const capture=fs.readFileSync(path.join(__dirname,'capture.js'),'utf8');
const {installPermissionHandlers}=require('./permissions.cjs');
let n=0;const ok=(c,label)=>{if(!c)throw new Error(label);n++};
// registerCsp (production branch) + the real permission handlers, spied on.
function prepare(ses,appUrl){
 ses.webRequest.onHeadersReceived((details,cb)=>cb({responseHeaders:{...details.responseHeaders,'Content-Security-Policy':[cfg.csp]}}));
 const log={asked:[],checked:[]};
 installPermissionHandlers({
  setPermissionRequestHandler:fn=>ses.setPermissionRequestHandler((wc,p,cb,d)=>fn(wc,p,v=>{log.asked.push({p,types:d.mediaTypes||null,url:d.requestingUrl,v});cb(v)},d)),
  setPermissionCheckHandler:fn=>ses.setPermissionCheckHandler((wc,p,o,d)=>{const v=fn(wc,p,o,d);log.checked.push({p,type:d.mediaType||null,v});return v}),
 },appUrl);
 return log;
}
function open(ses,url,withPreload){
 const w=new BrowserWindow({width:900,height:600,show:false,webPreferences:{session:ses,preload:withPreload?cfg.preload:undefined,contextIsolation:true,nodeIntegration:false,sandbox:true,spellcheck:false,backgroundThrottling:false}});
 return w.loadURL(url).then(()=>w);
}
const CAPTURE=\`(async()=>{
 const C=window.__snaosCapture;const chunks=[];let first=null;
 const t0=performance.now();
 const cap=await C.startCapture(b=>{const now=performance.now();if(first===null)first=now;const v=new Int16Array(b);let peak=0;for(let i=0;i<v.length;i++){const a=Math.abs(v[i]);if(a>peak)peak=a}chunks.push({t:now,bytes:b.byteLength,peak})},e=>chunks.push({err:e}));
 const started=performance.now();
 await new Promise(r=>setTimeout(r,1200));
 const within=chunks.filter(c=>!c.err&&c.t-started<=1200);
 cap.stop();
 const before=chunks.length;
 await new Promise(r=>setTimeout(r,300));
 return {url:C.workletUrl(),rate:cap.rate,openMs:Math.round(started-t0),firstMs:first===null?null:Math.round(first-started),within:within.length,sizes:[...new Set(within.map(c=>c.bytes))],peak:Math.max(0,...within.map(c=>c.peak)),errs:chunks.filter(c=>c.err).map(c=>c.err),afterStop:chunks.length-before};
})()\`;
const GUM=c=>'navigator.mediaDevices.getUserMedia('+JSON.stringify(c)+').then(s=>{s.getTracks().forEach(t=>t.stop());return "granted"},e=>e.name)';
async function captureChecks(w,label){
 const js=s=>w.webContents.executeJavaScript(s);
 ok(await js("(()=>{try{new Function('return 1');return false}catch(e){return e instanceof EvalError}})()"),label+': the production CSP is live (eval blocked)');
 ok(await js("(async()=>{const c=new AudioContext();try{await c.audioWorklet.addModule('data:text/javascript,1');return false}catch(e){return true}finally{c.close()}})()"),label+': the CSP blocks a data: worklet');
 await js(capture);
 const r=await js(CAPTURE);
 console.log(label+' capture: '+JSON.stringify(r));
 ok(r.url===new URL('dictation-worklet.js',w.webContents.getURL()).href,label+': the worklet URL is next to index.html: '+r.url);
 ok(r.rate===16000,label+': the context runs at 16 kHz ('+r.rate+')');
 ok(r.errs.length===0,label+': no capture error: '+r.errs);
 ok(r.within>=8,label+': at least 8 chunks within 1.2 s ('+r.within+')');
 ok(r.sizes.length===1&&r.sizes[0]===3200,label+': every chunk is 3200 bytes (100 ms of 16 kHz s16): '+r.sizes);
 ok(r.afterStop===0,label+': nothing after stop');
 return r;
}
app.whenReady().then(async()=>{
 const ses=session.defaultSession;
 const log=prepare(ses,cfg.appUrl);
 const w=await open(ses,cfg.appUrl,true);
 const js=s=>w.webContents.executeJavaScript(s);
 await captureChecks(w,'out/renderer');
 const mediaAsks=log.asked.filter(a=>a.p==='media');
 ok(mediaAsks.length>=1&&mediaAsks.every(a=>a.v===true&&JSON.stringify(a.types)==='["audio"]'&&a.url===cfg.appUrl),'the request handler saw media audio-only from the app page and allowed it: '+JSON.stringify(mediaAsks));
 const askedBefore=log.asked.length;
 ok(await js(GUM({video:true}))==='NotAllowedError','the camera alone is rejected on the app page');
 ok(await js(GUM({audio:true,video:true}))==='NotAllowedError','the camera with the mic is rejected on the app page');
 const vids=log.asked.slice(askedBefore).filter(a=>a.p==='media');
 ok(vids.length>=2&&vids.every(a=>a.v===false&&a.types&&a.types.includes('video')),'the handler denied both video requests: '+JSON.stringify(vids));
 ok(await js(GUM({audio:true}))==='granted','the mic alone is still granted to the app page');
 const ev=await open(ses,cfg.evilUrl,false);
 const evilAnswer=await ev.webContents.executeJavaScript(GUM({audio:true}));
 ok(evilAnswer==='NotAllowedError','a foreign file page gets no microphone ('+evilAnswer+')');
 ok(log.asked.some(a=>a.p==='media'&&a.url===cfg.evilUrl&&a.v===false)||log.checked.some(c=>c.p==='media'&&c.v===false),'the foreign page was refused by the handlers');
 ev.destroy();
 if(cfg.asarUrl){
  const s2=session.fromPartition('asar-smoke');
  prepare(s2,cfg.asarUrl);
  const wa=await open(s2,cfg.asarUrl,false);
  await captureChecks(wa,'app.asar');
  wa.destroy();
 }
 console.log('PASS: '+n+' dictation capture checks (built page, production CSP, worklet from out/renderer, 16 kHz chunks, audio-only permission'+(cfg.asarUrl?', app.asar':'')+')');
 w.destroy();app.quit();
}).catch(e=>{console.error(e);app.exit(1)});
`)
async function run() {
  if (!process.env.SNAOS_TEST_ASAR) await require('@electron/asar').createPackage(path.join(dir, 'asar-src'), asar)
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL
  const res = spawnSync(require('electron'), [path.join(dir, 'main.cjs')], { env, windowsHide: true, encoding: 'utf8', timeout: 90000 })
  process.stdout.write(res.stdout ?? ''); if (res.status !== 0) process.stderr.write(res.stderr ?? '')
  try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* the profile may still be locked */ }
  process.exitCode = res.status ?? 1
}
run().catch((e) => { console.error(e); process.exitCode = 1 })
