// Image from the phone (E3-FR-06..09) in the real MainScreen, in an isolated
// hidden browser at phone width, with a fake XMLHttpRequest: the button only
// with an httpToken (KeyBar in Direct mode, composer in Composer mode), the
// real canvas downscale (1170x2532 PNG -> 924x2000 PNG, 4032x3024 JPEG ->
// 2000x1500 JPEG), the request headers, the progress chip, the safe paste of
// the quoted path in Direct mode without Enter, the draft of the origin pane
// in Composer mode (live or saved), failure + Retry, the 401 retry with the
// next token, the X abort, a console closed mid-upload and the too-big toast.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path')
const { pathToFileURL } = require('node:url')
const { spawnSync } = require('node:child_process')
const root = path.resolve(__dirname, '..')
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snagentsos-upload-ui-'))
const assets = path.join(root, 'out/mobile/assets')
const mobileCss = fs.existsSync(assets) && fs.readdirSync(assets).find(name => /^index-.*\.css$/.test(name))
if (!mobileCss) throw new Error('Run npm run build:mobile first')
require('esbuild').buildSync({ stdin: { resolveDir: root, loader: 'tsx', contents: `
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { MainScreen } from './src/mobile/src/components/MainScreen';
import { client } from './src/mobile/src/lib/client';
import { store } from './src/mobile/src/lib/store';
import { setLang } from './src/mobile/src/lib/i18n';
import { setUploadXhrFactory, useUploadStore } from './src/mobile/src/lib/uploadJob';
window.result = (async () => {
 let checks=0; const check=(ok,label)=>{if(!ok)throw new Error(label);checks++};
 const frames = () => new Promise(r => setTimeout(r, 30));
 const wait = ms => new Promise(r => setTimeout(r, ms));
 const until = async (fn, label, ms=8000) => { const t0=performance.now(); while(!fn()){ if(performance.now()-t0>ms) throw new Error('timeout: '+label); await wait(20) } };
 const sent=[]; let open=true;
 client.sendInput = data => { if(!open) return false; sent.push(['viewed', data]); return true };
 client.sendInputTo = (paneId, data) => { if(!open) return false; sent.push([paneId, data]); return true };
 client.isOpen = () => open;
 client.sendCtl = async () => ({ ok:true });
 const xhrs=[];
 class FakeXhr {
  constructor(){ this.headers={}; this.upload={ onprogress:null }; this.status=0; this.responseText=''; this.aborted=false; xhrs.push(this) }
  open(m,u){ this.method=m; this.url=u }
  setRequestHeader(k,v){ this.headers[k]=v }
  send(body){ this.body=body }
  abort(){ this.aborted=true; this.onabort && this.onabort() }
  respond(status, text=''){ this.status=status; this.responseText=text; this.onload() }
 }
 setUploadXhrFactory(() => new FakeXhr());
 const T1='a1'.repeat(32), T2='b2'.repeat(32);
 const panes=[
  { id:'c1', title:'Claude', type:'claude', color:'', icon:'', running:true },
  { id:'s1', title:'Shell', type:'shell', color:'', icon:'', running:true },
 ];
 const snap = list => ({ language:'en', themeTokens:{}, fontFamily:'mono', fontSize:13, activeWorkspaceId:'w1', keyButtons:[], quickCommands:[],
  workspaces:[{ id:'w1', name:'Front', layoutOrder:list.map(p=>p.id), panes:list }] });
 setLang('en');
 store.getState().update({ phase:'live', banner:null, connected:true, snapshot:snap(panes), activePaneId:'c1', subscribedPaneId:'c1',
  paneStatus:{ c1:{ state:'idle', stateSince:0, provider:'claude' } }, httpToken:null });
 const host=document.getElementById('root'); const reactRoot=createRoot(host);
 flushSync(() => reactRoot.render(<MainScreen />)); await frames(); await wait(50);
 const q = sel => document.querySelector(sel);
 const key = label => { const b=document.querySelector('button[aria-label="'+label+'"]'); if(!b)throw new Error('missing key '+label); return b };
 const ptr = (el,type) => { const r=el.getBoundingClientRect(); el.dispatchEvent(new PointerEvent(type,{bubbles:true,cancelable:true,pointerId:1,pointerType:'touch',isPrimary:true,clientX:r.left+10,clientY:r.top+10})) };
 const tap = el => { ptr(el,'pointerdown'); ptr(el,'pointerup') };
 const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set;
 const typeInto = (el,value) => { setter.call(el,value); el.dispatchEvent(new Event('input',{bubbles:true})) };
 const composer = () => q('[data-kb-input="composer"]');
 const chip = () => q('[data-upload-chip]');
 const chipText = () => q('[data-upload-text]')?.textContent ?? '';
 const lastToast = () => store.getState().toasts.at(-1)?.text;
 const makeImage = async (w, h, type) => {
  const c=document.createElement('canvas'); c.width=w; c.height=h;
  const g=c.getContext('2d'); g.fillStyle='#3366ff'; g.fillRect(0,0,w,h); g.fillStyle='#ffffff'; g.fillRect(10,10,w/2,h/2);
  const blob=await new Promise(r => c.toBlob(r, type, 0.9));
  return new File([blob], type==='image/png' ? 'shot.png' : 'photo.jpg', { type });
 };
 const pick = (origin, file) => {
  const input=q('[data-upload-input="'+origin+'"]'); if(!input) throw new Error('no input for '+origin);
  const dt=new DataTransfer(); dt.items.add(file); input.files=dt.files;
  input.dispatchEvent(new Event('change',{bubbles:true}));
 };
 const dims = async blob => { const b=await createImageBitmap(blob); return b.width+'x'+b.height };
 const nextXhr = async n => { await until(() => xhrs.length>=n, 'xhr '+n); await frames(); return xhrs[n-1] };
 const P1='C:\\\\Users\\\\me\\\\AppData\\\\Roaming\\\\snagentsos\\\\attachments\\\\20261018-070509-0a1b2c3d.png';
 const P2='C:\\\\Users\\\\me\\\\attachments\\\\20261018-070600-11112222.jpg';
 const P3='C:\\\\att\\\\20261018-070700-33334444.png';

 // E3-FR-06: no httpToken (an older desktop), no button.
 check(!q('[data-upload-button]') && !q('[data-upload-input]'),'without an httpToken there is no image button');
 flushSync(() => store.getState().update({ httpToken:T1 })); await frames();
 const btn=q('[data-upload-button="direct"]');
 check(!!btn && !q('[data-upload-button="composer"]'),'with an httpToken the KeyBar shows it in Direct mode');
 const rect=btn.getBoundingClientRect();
 check(rect.width===44 && rect.height===44,'the button is 44x44');
 check(btn.getAttribute('aria-label')==='Attach image','the button is labelled');
 const input=q('[data-upload-input="direct"]');
 check(input.type==='file' && input.accept==='image/*' && !input.hasAttribute('capture'),'a plain image picker: camera or gallery');

 // Direct mode: a screenshot goes PNG 924x2000 and lands as a safe paste, no Enter.
 pick('direct', await makeImage(1170, 2532, 'image/png'));
 await frames();
 check(!!chip(),'the chip appears as soon as an image is picked');
 let x=await nextXhr(1);
 check(x.method==='POST' && x.url==='/api/upload','POST /api/upload');
 check(x.headers.Authorization==='Bearer '+T1 && x.headers['Content-Type']==='image/png','Bearer httpToken and the PNG mime');
 check(x.body.type==='image/png' && (await dims(x.body))==='924x2000','a 1170x2532 PNG goes up as a 924x2000 PNG (E3-FR-07)');
 check(chip().dataset.uploadChip==='uploading' && chipText()==='Uploading image... 0%','the chip shows the progress');
 check(q('[data-upload-button="direct"]').getAttribute('aria-disabled')==='true','the button is inert while uploading');
 x.upload.onprogress({ lengthComputable:true, loaded:42, total:100 }); await frames();
 check(chipText()==='Uploading image... 42%' && q('[data-upload-bar]').style.width==='42%','"Uploading image... 42%" with its bar');
 x.respond(200, JSON.stringify({ path:P1 })); await until(() => !chip(), 'chip gone after delivery');
 check(sent.length===1 && sent[0][0]==='c1' && sent[0][1]==='\\x1b[200~"'+P1+'" \\x1b[201~','Direct: the quoted path plus a space as one bracketed paste into the origin pane (E3-FR-09)');
 check(!sent.some(([,d]) => d.includes('\\r')),'never an Enter');

 // Composer mode: the button moves into the composer.
 tap(key('Input mode')); await frames();
 check(!!composer() && !!q('[data-upload-button="composer"]') && !q('[data-upload-button="direct"]'),'in Composer mode the button lives in the composer, not the KeyBar');
 typeInto(composer(),'mira'); await frames();
 pick('composer', await makeImage(4032, 3024, 'image/jpeg'));
 x=await nextXhr(2);
 check(x.headers['Content-Type']==='image/jpeg' && x.body.type==='image/jpeg' && (await dims(x.body))==='2000x1500','a 4032x3024 photo goes up as a 2000x1500 JPEG');
 // The user moves to another console before it finishes.
 flushSync(() => store.getState().update({ activePaneId:'s1', subscribedPaneId:'s1' })); await frames();
 check(!!chip(),'the chip stays on another console');
 sent.length=0;
 x.respond(200, JSON.stringify({ path:P2 })); await until(() => !chip(), 'chip gone (composer, saved draft)');
 check(JSON.parse(localStorage.getItem('snagentsos.draft.c1')).text==='mira "'+P2+'" ','Composer: appended to the origin pane draft even when another console is viewed');
 check(sent.length===0,'Composer delivery sends nothing to any console');
 flushSync(() => store.getState().update({ activePaneId:'c1', subscribedPaneId:'c1' })); await frames();
 check(composer().value==='mira "'+P2+'" ','back on the console, the composer shows the reference');

 // Live composer: failure, Retry, then appended to the field.
 pick('composer', await makeImage(300, 200, 'image/png'));
 x=await nextXhr(3);
 check((await dims(x.body))==='300x200','a small image keeps its size');
 x.respond(500); await until(() => chip()?.dataset.uploadChip==='failed', 'failed chip');
 check(chipText()==='The PC could not save the image' && !!q('[data-upload-retry]'),'a failure turns the chip red with Retry');
 q('[data-upload-retry]').click();
 x=await nextXhr(4);
 check(x.headers.Authorization==='Bearer '+T1 && chip().dataset.uploadChip==='uploading','Retry sends the same image again');
 x.respond(200, JSON.stringify({ path:P3 })); await until(() => !chip(), 'chip gone after retry');
 await frames();
 check(composer().value==='mira "'+P2+'" "'+P3+'" ','the live composer gets the reference appended');
 check(sent.length===0,'still no Enter and nothing typed');

 // 401: one retry with the next authOk's token.
 pick('composer', await makeImage(64, 64, 'image/png'));
 x=await nextXhr(5);
 x.respond(401); await frames();
 check(xhrs.length===5 && chip().dataset.uploadChip==='uploading','a 401 waits for the reconnect');
 flushSync(() => store.getState().update({ httpToken:T2 }));
 x=await nextXhr(6);
 check(x.headers.Authorization==='Bearer '+T2,'and retries once with the new httpToken');
 x.respond(200, JSON.stringify({ path:P3 })); await until(() => !chip(), 'chip gone after 401 retry');

 // Spanish, then the X aborts without leaving anything.
 setLang('es'); flushSync(() => store.getState().update({ snapshot:{ ...snap(panes), language:'es' } })); await frames();
 const before=composer().value;
 pick('composer', await makeImage(64, 64, 'image/png'));
 x=await nextXhr(7);
 check(chipText()==='Subiendo imagen... 0%' && q('[data-upload-button="composer"]').getAttribute('aria-label')==='Adjuntar imagen','es: "Subiendo imagen... 0%"');
 q('[data-upload-cancel]').click(); await frames();
 check(x.aborted && !chip() && composer().value===before,'the X aborts the request and inserts nothing');
 setLang('en'); flushSync(() => store.getState().update({ snapshot:snap(panes) })); await frames();

 // The console closes during the upload: the chip keeps the path to copy.
 pick('composer', await makeImage(64, 64, 'image/png'));
 x=await nextXhr(8);
 flushSync(() => store.getState().update({ snapshot:snap([panes[1]]), activePaneId:'s1', subscribedPaneId:'s1' })); await frames();
 x.respond(200, JSON.stringify({ path:P1 })); await until(() => chip()?.dataset.uploadChip==='paneGone', 'paneGone chip');
 check(chipText()==='The console closed. The image is on the PC.' && !!q('[data-upload-copy]'),'a closed console offers [Copy path]');
 check(useUploadStore.getState().job.path===P1,'the job keeps the path');
 q('[data-upload-copy]').click(); await frames();
 check(['Path copied','Could not copy the path'].includes(lastToast()),'Copy path answers with a toast');
 if (chip()) { q('[data-upload-cancel]').click(); await frames() }
 check(!chip(),'the chip can be dismissed');

 // Too big for the PC: a toast, no chip.
 flushSync(() => store.getState().update({ snapshot:snap(panes), activePaneId:'c1', subscribedPaneId:'c1' })); await frames();
 pick('composer', await makeImage(64, 64, 'image/png'));
 x=await nextXhr(9);
 x.respond(413); await until(() => !chip(), 'chip gone on 413');
 check(lastToast()==='Image too large','413: "Image too large"');

 // The token gone (disconnected): the button goes away again.
 flushSync(() => store.getState().update({ httpToken:null })); await frames();
 check(!q('[data-upload-button]'),'without a token the button disappears');
 check(document.documentElement.scrollWidth<=430,'nothing overflows the phone width');

 reactRoot.unmount(); return checks;
})();
` }, bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"', __APP_VERSION__: '"test"' }, alias: { '@shared': path.join(root, 'src/shared') }, loader: { '.css': 'empty' }, outfile: path.join(dir, 'renderer.js') })
fs.writeFileSync(path.join(dir, 'index.html'), `<html><head><meta charset="utf-8"><link rel="stylesheet" href="${pathToFileURL(path.join(assets, mobileCss))}"></head><body style="margin:0;width:430px"><div id="root"></div><script src="renderer.js"></script></body></html>`)
fs.writeFileSync(path.join(dir, 'main.cjs'), `
const {app,BrowserWindow}=require('electron');const path=require('path');
app.setPath('userData',path.join(__dirname,'profile'));
app.whenReady().then(async()=>{
 const w=new BrowserWindow({show:false,width:430,height:800,webPreferences:{sandbox:true,backgroundThrottling:false}});
 await w.loadFile(path.join(__dirname,'index.html'));
 const checks=await w.webContents.executeJavaScript('window.result');
 console.log('PASS: '+checks+' mobile image upload UI checks');w.destroy();app.quit();
}).catch(e=>{console.error(e);app.exit(1)});
`)
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
// Hosted Linux CI cannot use Electron's unpacked SUID helper. This flag applies
// only to the isolated, trusted fixture; the shipped application is unchanged.
const flags = process.platform === 'linux' && process.env.CI ? ['--no-sandbox'] : []
const result = spawnSync(require('electron'), [...flags, path.join(dir, 'main.cjs')], { env, windowsHide: true, encoding: 'utf8', timeout: 90000 })
process.stdout.write(result.stdout ?? '')
if (result.status !== 0) process.stderr.write((result.stderr || '') + (result.error ? result.error.message : '') + (result.signal ? ' signal ' + result.signal : ''))
fs.rmSync(dir, { recursive: true, force: true })
process.exitCode = result.status ?? 1
