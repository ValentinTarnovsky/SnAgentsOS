// Desktop dictation (app 2.5.0, local Whisper) with the production PaneCell,
// TerminalPane overlay, GlobalPromptDialog, SettingsModal and the global
// keymap in an isolated hidden Electron window. window.snApi.dictation is a
// fake that emits ready, hyp, final, error and end and serves models(),
// install progress, cancel and remove; the pty is a fake too, and the
// microphone capture module is a stub (the real capture has its own suite).
// Checks: the header mic and the context menu entry, the listening overlay
// (phrase, GPU / CPU badge, slow notice, GPU fallback), captured audio goes to
// the session, typed text never carries CR or LF, the menu guard (nothing
// typed while a permission is pending; Insert types it), the Ctrl+Shift+H
// shortcut, the global prompt mic inserting at the caret, the error actions
// (microphone page, VC++ runtime, model_missing opening Settings at the packs
// row), and the Settings block: packs with sizes, recommended pack, VC++
// warning, data folder, download progress with Cancel, phases, installed
// with Delete (CPU blocked while GPU is installed), errors, device, preview
// and vocabulary, with no horizontal overflow. Requires npm run build (CSS).
const fs = require('node:fs'), os = require('node:os'), path = require('node:path')
const { pathToFileURL } = require('node:url')
const { spawnSync } = require('node:child_process')
const { build } = require('esbuild')
const root = path.resolve(__dirname, '..'), dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snagentsos-dictation-ui-'))
const assets = path.join(root, 'out/renderer/assets')
const css = fs.readdirSync(assets).find(f => /^index-.*\.css$/.test(f))
if (!css) throw new Error('Run npm run build first')
// The capture module keeps its exports, but startCapture is a stub the page drives (window.__caps).
const realCapture = path.join(root, 'src/renderer/lib/dictationCapture.ts')
const captureStub = {
  name: 'capture-stub',
  setup(b) {
    b.onResolve({ filter: /(^|[\\/])dictationCapture$/ }, () => ({ path: 'dictationCapture', namespace: 'capture-stub' }))
    b.onLoad({ filter: /.*/, namespace: 'capture-stub' }, () => ({
      resolveDir: root,
      loader: 'ts',
      contents: `${fs.existsSync(realCapture) ? `export * from ${JSON.stringify(realCapture.replace(/\\/g, '/'))};` : ''}
export async function startCapture(onChunk: (pcm: ArrayBuffer) => void, onError?: (code: 'mic_denied' | 'no_mic' | 'audio') => void) {
  const c = { onChunk, onError, stopped: false };
  ((window as any).__caps ||= []).push(c);
  return { rate: 16000, stop() { c.stopped = true } };
}`,
    }))
  },
}
build({ stdin: { contents: `
import React from 'react'; import {createRoot} from 'react-dom/client';
import {PaneCell} from './src/renderer/components/layout/PaneCell';
import {GlobalPromptDialog} from './src/renderer/components/workspace/GlobalPromptDialog';
import {SettingsModal} from './src/renderer/components/settings/SettingsModal';
import {I18nProvider} from './src/renderer/i18n';
import {useAppStore} from './src/renderer/lib/store';
import {useGlobalKeys} from './src/renderer/lib/useGlobalKeys';
import {setFocusedPane} from './src/renderer/lib/focus';
import {isBracketedPaste} from './src/renderer/lib/pasteRegistry';
import {useDictationStore} from './src/renderer/lib/dictation';
import {applyTheme} from './src/renderer/themes/applyTheme';
const writes=[], subs=[];
const dict={start:[],stop:[],settings:[],audio:[],install:[],cancel:[],remove:[],listeners:new Set(),progress:new Set(),nextStart:null,installRes:[],removeRes:null,
 status:{supported:true,nvidia:true,vcRuntime:false,dataDir:'D:/Portable/snagentsos-data/whisper',install:null,loaded:null,warming:false,
  packs:[{id:'cpu',installed:false,downloadBytes:199899225,diskBytes:212000000},{id:'gpu',installed:false,downloadBytes:1759000704,diskBytes:3100000000}]}};
let seq=0;
const noop=()=>()=>{};
const fallback=(base)=>new Proxy(base,{get:(t,k)=>k in t?t[k]:(typeof k==='string'?fallback(noop):undefined)});
window.snApi=fallback({platform:'win32',filePath:()=>'',
 pty:fallback({reattach:async()=>null,spawn:async r=>({ptyId:'pty-'+r.paneId}),onData:cb=>{subs.push(cb);return()=>{}},onExit:noop,write:w=>writes.push(w),resize(){},flow(){},kill:async()=>{}}),
 dictation:{
  start:async req=>{dict.start.push(req);if(dict.nextStart){const r=dict.nextStart;dict.nextStart=null;return r}return{ok:true,sessionId:'s'+(++seq)}},
  stop:async id=>{dict.stop.push(id)},
  audio:(id,pcm)=>{dict.audio.push([id,pcm instanceof ArrayBuffer?pcm.byteLength:-1])},
  onEvent:cb=>{dict.listeners.add(cb);return()=>dict.listeners.delete(cb)},
  openSettings:async page=>{dict.settings.push(page);return true},
  models:async()=>JSON.parse(JSON.stringify(dict.status)),
  install:pack=>{dict.install.push(pack);return new Promise(r=>dict.installRes.push(r))},
  cancelInstall:async pack=>{dict.cancel.push(pack)},
  remove:async pack=>{dict.remove.push(pack);const r=dict.removeRes||{ok:true};dict.removeRes=null;return r},
  onInstallProgress:cb=>{dict.progress.add(cb);return()=>dict.progress.delete(cb)}},
 system:fallback({onDisplayRecovered:noop,openExternal(){}}),status:fallback({reportTitle(){}}),clipboard:fallback({readText:async()=>'',writeText(){}})});
const ws={id:'ws-1',name:'Dictado',cwd:'',panes:[{id:'agent',type:'claude',title:'Claude',icon:'bot'},{id:'shell',type:'shell',title:'SSH',icon:'terminal'}]};
useAppStore.setState({hydrated:true,activeWorkspaceId:'ws-1',workspaces:[ws]});
useAppStore.setState(s=>({settings:{...s.settings,language:'es',dictation:{device:'auto',language:'es-AR',headerButton:true,interim:true,vocabulary:''}}}));
applyTheme('midnight');
const noopFn=()=>{};
function Keys(){useGlobalKeys();return null}
createRoot(document.getElementById('root')).render(<I18nProvider lang="es"><Keys/><div style={{height:'100vh',display:'grid',gridTemplateColumns:'1fr 1fr',gap:6,padding:6}} className="bg-bg-primary text-text-primary">
 {ws.panes.map((p,i)=><PaneCell key={p.id} workspace={ws} pane={p} presets={[]} workspaceActive maximizedId={null} minimizedIds={[]} index={i} isDragging={false} draggable onToggleMax={noopFn} onToggleMin={noopFn} onClose={noopFn} onDragStartCell={noopFn} onDragEndCell={noopFn}/>)}
</div><GlobalPromptDialog/><SettingsModal/></I18nProvider>);
const cell=id=>document.querySelector('[data-pane-cell="'+id+'"]');
const setInput=(el,v)=>{const proto=el instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(proto,'value').set.call(el,v);el.dispatchEvent(new Event('input',{bubbles:true}))};
const setSelect=(el,v)=>{Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(el,v);el.dispatchEvent(new Event('change',{bubbles:true}))};
window.smoke={writes,dict,app:useAppStore,dictStore:useDictationStore,setFocusedPane,
 ready:()=>isBracketedPaste('agent')!==null&&isBracketedPaste('shell')!==null&&subs.length>=2,
 emit:e=>dict.listeners.forEach(cb=>cb(e)),
 progress:p=>dict.progress.forEach(cb=>cb(p)),
 resolveInstall:r=>{const f=dict.installRes.shift();if(!f)throw new Error('no install pending');f(r)},
 caps:()=>(window.__caps||[]).map(c=>c.stopped),
 chunk:()=>{const c=(window.__caps||[]).slice(-1)[0];if(!c)throw new Error('no capture');c.onChunk(new Int16Array(1600).buffer)},
 capError:code=>{const c=(window.__caps||[]).slice(-1)[0];if(!c||!c.onError)throw new Error('no capture error callback');c.onError(code)},
 sid:()=>'s'+seq,
 click:sel=>{const el=document.querySelector(sel);if(!el)throw new Error('missing '+sel);el.click()},
 has:sel=>!!document.querySelector(sel),
 text:sel=>document.querySelector(sel)?.textContent??null,
 attr:(sel,a)=>document.querySelector(sel)?.getAttribute(a)??null,
 disabled:sel=>{const el=document.querySelector(sel);if(!el)throw new Error('missing '+sel);return el.disabled},
 setInput:(sel,v)=>setInput(document.querySelector(sel),v),
 setSelect:(sel,v)=>setSelect(document.querySelector(sel),v),
 micBeforeClock:id=>{const h=cell(id).querySelector('header');const kids=[...h.querySelectorAll('button')];const m=kids.findIndex(b=>b.hasAttribute('data-pane-mic')),c=kids.findIndex(b=>b.hasAttribute('data-pane-clock'));return m>=0&&c>=0&&m<c},
 key:(k,mods)=>window.dispatchEvent(new KeyboardEvent('keydown',{key:k,ctrlKey:!!mods.ctrl,shiftKey:!!mods.shift,bubbles:true,cancelable:true})),
 ctxMenu:id=>cell(id).querySelector('header').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:200,clientY:80})),
 menuItems:()=>[...document.querySelectorAll('[role=menu] [role=menuitem]')].map(e=>e.textContent.trim()),
 clickMenu:label=>{const el=[...document.querySelectorAll('[role=menu] [role=menuitem]')].find(e=>e.textContent.trim()===label);if(!el)throw new Error('no menu item '+label);el.click()},
 typeField:v=>{const ta=document.querySelector('[data-global-prompt-text]');setInput(ta,v);ta.focus();ta.setSelectionRange(v.length,v.length);ta.dispatchEvent(new Event('select',{bubbles:true}))},
 fieldValue:()=>document.querySelector('[data-global-prompt-text]')?.value??null,
 hOverflow:sel=>{const el=document.querySelector(sel);if(!el)throw new Error('missing '+sel);return [el,...el.querySelectorAll('*')].some(n=>n.scrollWidth>n.clientWidth+1&&getComputedStyle(n).overflowX!=='hidden'&&getComputedStyle(n).overflowX!=='auto'&&n.clientWidth>0)},
 overflow:()=>document.documentElement.scrollWidth>innerWidth};
`, resolveDir: root, loader: 'tsx' }, bundle: true, platform: 'browser', format: 'iife', outfile: path.join(dir, 'renderer.js'), alias: { '@shared': path.join(root, 'src/shared'), '@': path.join(root, 'src/renderer') }, plugins: [captureStub], jsx: 'automatic', loader: { '.css': 'empty' }, define: { 'process.env.NODE_ENV': '"production"' } }).then(() => {
fs.writeFileSync(path.join(dir, 'index.html'), `<html><head><meta charset="utf-8"><link rel="stylesheet" href="${pathToFileURL(path.join(assets, css))}"></head><body><div id="root"></div><script src="renderer.js"></script></body></html>`)
fs.writeFileSync(path.join(dir, 'main.cjs'), `
const {app,BrowserWindow}=require('electron');const fs=require('fs'),path=require('path');
app.setPath('userData',path.join(__dirname,'profile'));
app.whenReady().then(async()=>{
 const w=new BrowserWindow({width:1200,height:720,show:false,webPreferences:{sandbox:true,backgroundThrottling:false}});
 let failures=[];w.webContents.on('console-message',(_e,level,message)=>{if(level>=3)failures.push(message)});
 const js=s=>w.webContents.executeJavaScript(s);const wait=ms=>new Promise(r=>setTimeout(r,ms));
 // A hidden window may paint at about 1 fps here, so state flushes wait on a task, not on frames;
 // only screenshots wait for paint (capturePage forces frames).
 const frame=()=>js('new Promise(r=>setTimeout(r,40))');
 const paint=()=>js('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
 const shot=async name=>{await frame();await paint();await wait(150);fs.writeFileSync(path.join(__dirname,name+'.png'),(await w.webContents.capturePage()).toPNG())};
 let n=0;const eq=(a,b,label)=>{if(JSON.stringify(a)!==JSON.stringify(b))throw new Error(label+': got '+JSON.stringify(a)+' expected '+JSON.stringify(b));n++};
 const ok=(c,label)=>{if(!c)throw new Error(label);n++};
 const emit=async e=>{await js('smoke.emit('+JSON.stringify(e)+')');await frame()};
 const progress=async p=>{await js('smoke.progress('+JSON.stringify(p)+')');await frame()};
 const take=async()=>{await frame();return js('smoke.writes.splice(0).map(w=>({ptyId:w.ptyId,data:w.data,origin:w.origin??null}))')};
 const noEnter=(list,label)=>ok(list.every(x=>!/[\\r\\n]/.test(x.data)&&x.origin!=='auto'),label+': no CR/LF and typed as the user '+JSON.stringify(list));
 await w.loadFile(path.join(__dirname,'index.html'));
 for(let i=0;i<50&&!(await js('smoke.ready()'));i++)await wait(100);
 ok(await js('smoke.ready()'),'both terminals mounted');
 await take();

 // Header mic, before the clock, on every console.
 eq(await js("[...document.querySelectorAll('[data-pane-mic]')].map(b=>b.dataset.paneMic)"),['off','off'],'a mic in each header');
 ok(await js("smoke.micBeforeClock('agent')"),'the mic sits before the clock');
 await js("smoke.click('[data-pane-cell=agent] [data-pane-mic]')");await frame();
 const req1=(await js('smoke.dict.start'))[0];
 ok(req1&&req1.lang==='es-AR'&&!('engine' in req1)&&(req1.paneId===undefined||req1.paneId==='agent'),'the mic starts with the saved language, the console and no engine '+JSON.stringify(req1));
 eq(await js("smoke.attr('[data-pane-cell=agent] [data-pane-mic]','data-pane-mic')"),'on','the mic shows it is on');
 ok(await js("smoke.has('[data-dictation-overlay=agent]')"),'the listening overlay shows on that console');
 ok(!(await js("smoke.has('[data-dictation-overlay=shell]')")),'and only there');
 eq(await js('smoke.caps()'),[false],'the microphone capture started');
 await js('smoke.chunk()');await frame();
 eq(await js('smoke.dict.audio'),[['s1',3200]],'a captured chunk goes to the session');

 // Ready on the GPU, the phrase so far, the slow notice.
 await emit({sessionId:'s1',t:'ready',engine:'gpu',lang:'es-AR'});
 await emit({sessionId:'s1',t:'hyp',text:'hola mun'});
 eq(await js("smoke.text('[data-dictation-overlay=agent] [data-dictation-interim]')"),'hola mun','the overlay shows the phrase being heard');
 eq(await js("smoke.text('[data-dictation-engine=gpu]')"),'GPU','GPU badge');
 ok(!(await js("smoke.has('[data-dictation-fallback]')")),'no fallback notice on the GPU');
 await js('smoke.dictStore.setState({slow:true})');await frame();
 eq(await js("smoke.text('[data-dictation-overlay=agent] [data-dictation-slow]')"),'Cargando el modelo. La primera vez puede tardar un minuto\\u2026','the slow notice shows');
 await shot('dictation-listening');
 await js('smoke.dictStore.setState({slow:false})');await frame();
 ok(!(await js("smoke.has('[data-dictation-slow]')")),'and goes');

 // Finals are typed, never with Enter.
 await emit({sessionId:'s1',t:'final',text:'Hola mundo'});
 await emit({sessionId:'s1',t:'final',text:'Esto va sin enter'});
 let got=await take();
 noEnter(got,'finals');
 eq(got.map(x=>x.ptyId),['pty-agent','pty-agent'],'typed into the dictated console only');
 ok(got.map(x=>x.data).join('').includes('Hola mundo esto va sin enter'),'phrases joined with a space, mid-sentence lowercase '+JSON.stringify(got));

 // Menu guard: a pending permission holds "2 archivos" back.
 await js("smoke.app.setState({paneStatus:{agent:{state:'action',precise:true,provider:'claude',reason:'permission',pendingCount:1,pending:[{id:'t1',kind:'permission',summary:'Bash'}]}}})");
 await emit({sessionId:'s1',t:'final',text:'2 archivos'});
 eq(await take(),[],'nothing typed while the agent waits on a permission');
 ok((await js("smoke.text('[data-dictation-held]')")||'').includes('2 archivos'),'the held text shows in the overlay');
 await shot('dictation-held');
 await js("smoke.app.setState({paneStatus:{}})");
 await js("smoke.click('[data-dictation-insert]')");
 got=await take();
 noEnter(got,'insert');
 ok(got.length>=1&&got.map(x=>x.data).join('').includes('2 archivos'),'Insert types the held text '+JSON.stringify(got));
 ok(!(await js("smoke.has('[data-dictation-held]')")),'and the held box goes');

 // A timeout is not fatal: the error line shows while it keeps listening.
 await emit({sessionId:'s1',t:'error',code:'timeout'});
 eq(await js("smoke.text('[data-dictation-overlay=agent] [data-dictation-error=timeout]')"),'El modelo tard\\u00f3 demasiado; se descart\\u00f3 una frase.','a timeout shows its line');
 ok(!(await js("smoke.has('[data-dictation-error=timeout] [data-dictation-action]')")),'with no action button');

 // Stop.
 await js("smoke.click('[data-dictation-stop]')");await frame();
 eq(await js('smoke.dict.stop'),['s1'],'Stop asks main to stop the session');
 eq(await js('smoke.caps()'),[true],'Stop closes the microphone');
 await emit({sessionId:'s1',t:'end'});
 ok(!(await js("smoke.has('[data-dictation-overlay=agent]')")),'end closes the overlay (the timeout notice does not outlive the session)');
 eq(await js("smoke.attr('[data-pane-cell=agent] [data-pane-mic]','data-pane-mic')"),'off','the mic is off again');

 // Shortcut on the focused console (an SSH one: the text goes to the local pty), CPU after a GPU failure.
 await js("smoke.setFocusedPane('shell','ws-1')");
 await js("smoke.key('H',{ctrl:true,shift:true})");await frame();
 eq(await js('smoke.dict.start.length'),2,'Ctrl+Shift+H starts dictation');
 ok(await js("smoke.has('[data-dictation-overlay=shell]')"),'on the focused console');
 await emit({sessionId:'s2',t:'ready',engine:'cpu',lang:'es-AR',fallback:'gpu_failed'});
 eq(await js("smoke.text('[data-dictation-engine=cpu]')"),'CPU','CPU badge');
 eq(await js("smoke.text('[data-dictation-overlay=shell] [data-dictation-fallback=gpu_failed]')"),'La GPU no respondi\\u00f3; se usa la CPU (m\\u00e1s lento).','the GPU fallback notice');
 await shot('dictation-fallback');
 await emit({sessionId:'s2',t:'final',text:'ls menos la'});
 got=await take();noEnter(got,'shortcut');
 eq(got.map(x=>x.ptyId),['pty-shell'],'typed into the focused console');
 await js("smoke.key('H',{ctrl:true,shift:true})");await frame();
 eq(await js('smoke.dict.stop'),['s1','s2'],'the shortcut again stops it');
 await emit({sessionId:'s2',t:'end'});
 await js("document.querySelector('[data-dictation-overlay=shell] [data-dictation-dismiss]')?.click()");await frame();

 // Context menu entry; a microphone blocked by Windows: the microphone page.
 await js("smoke.ctxMenu('agent')");await frame();
 ok((await js('smoke.menuItems()')).includes('Dictar'),'the console menu has Dictar');
 await js("smoke.clickMenu('Dictar')");await frame();
 eq(await js('smoke.dict.start.length'),3,'Dictar starts a session');
 await js("smoke.capError('mic_denied')");await frame();
 await emit({sessionId:'s3',t:'end'});
 eq(await js("smoke.text('[data-dictation-overlay=agent] [data-dictation-interim]')"),'El micr\\u00f3fono est\\u00e1 bloqueado. Revis\\u00e1 la privacidad del micr\\u00f3fono en Windows.','mic_denied explains the block');
 ok(await js("smoke.has('[data-dictation-overlay=agent] [data-dictation-action=microphone]')"),'mic_denied offers the microphone settings page');
 await shot('dictation-error');
 await js("smoke.click('[data-dictation-overlay=agent] [data-dictation-action=microphone]')");
 eq(await js('smoke.dict.settings'),['microphone'],'and opens it');
 await js("smoke.click('[data-dictation-dismiss]')");await frame();
 ok(!(await js("smoke.has('[data-dictation-overlay=agent]')")),'dismiss closes the notice');

 // VC++ runtime missing: main refuses the start, the button opens the download.
 await js("smoke.dict.nextStart={ok:false,error:'vcredist'}");
 await js("smoke.click('[data-pane-cell=agent] [data-pane-mic]')");await frame();
 ok(await js("smoke.has('[data-dictation-overlay=agent] [data-dictation-error=vcredist] [data-dictation-action=vcredist]')"),'vcredist offers the VC++ runtime');
 eq(await js("smoke.text('[data-dictation-action=vcredist]')"),'Instalar Visual C++','with its label');
 await js("smoke.click('[data-dictation-action=vcredist]')");
 eq(await js('smoke.dict.settings'),['microphone','vcredist'],'and opens the download');
 await js("smoke.click('[data-dictation-dismiss]')");await frame();

 // Header mic off by setting: the menu entry stays.
 await js("smoke.app.setState(s=>({settings:{...s.settings,dictation:{...s.settings.dictation,headerButton:false}}}))");await frame();
 eq(await js("document.querySelectorAll('[data-pane-mic]').length"),0,'headerButton off hides the mic');
 await js("smoke.ctxMenu('agent')");await frame();
 ok((await js('smoke.menuItems()')).includes('Dictar'),'the menu entry is still there');
 await js("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))");await js("document.body.dispatchEvent(new MouseEvent('mousedown',{bubbles:true}))");await frame();
 await js("smoke.app.setState(s=>({settings:{...s.settings,dictation:{...s.settings.dictation,headerButton:true}}}))");await frame();

 // Global prompt: the mic inserts at the caret, the shortcut toggles it, no pty write.
 await js('smoke.app.getState().setGlobalPromptOpen(true)');await frame();await wait(100);
 ok(await js("smoke.has('[data-field-mic]')"),'the global prompt has a mic');
 await js("smoke.typeField('Revisa ')");await frame();
 await js("smoke.click('[data-field-mic]')");await frame();
 eq(await js('smoke.dict.start.length'),5,'the field mic starts a session');
 eq(await js('smoke.dict.start[4].paneId'),undefined,'a field session names no console');
 await emit({sessionId:'s4',t:'ready',engine:'gpu'});
 await emit({sessionId:'s4',t:'hyp',text:'el arch'});
 ok((await js("smoke.text('[data-field-dictation] [data-dictation-interim]')")||'').includes('el arch'),'the phrase shows under the field');
 await emit({sessionId:'s4',t:'final',text:'El archivo'});
 await emit({sessionId:'s4',t:'final',text:'de config'});
 eq(await js('smoke.fieldValue()'),'Revisa el archivo de config','finals land at the caret of the field');
 eq(await take(),[],'nothing reaches a pty from the field');
 await shot('dictation-global-prompt');
 await js("smoke.key('H',{ctrl:true,shift:true})");await frame();
 eq(await js('smoke.dict.stop.slice(-1)'),['s4'],'Ctrl+Shift+H in the dialog stops the field session');
 await emit({sessionId:'s4',t:'end'});
 await js("smoke.click('[data-field-mic]')");await frame();
 await js('smoke.app.getState().setGlobalPromptOpen(false)');await frame();
 eq(await js('smoke.dict.stop.slice(-1)'),['s5'],'closing the dialog stops its session');
 ok(!(await js('smoke.overflow()')),'no horizontal overflow');

 // model_missing: the button opens Settings at the packs row.
 await js("smoke.dict.nextStart={ok:false,error:'model_missing'}");
 await js("smoke.click('[data-pane-cell=agent] [data-pane-mic]')");await frame();
 eq(await js("smoke.text('[data-dictation-overlay=agent] [data-dictation-interim]')"),'Falta descargar el modelo de dictado.','model_missing says so');
 eq(await js("smoke.text('[data-dictation-overlay=agent] [data-dictation-action=models]')"),'Descargar modelo','and offers the download');
 await js("smoke.click('[data-dictation-overlay=agent] [data-dictation-action=models]')");
 for(let i=0;i<20&&!(await js("smoke.has('[data-dictation-packs]')"));i++)await wait(50);
 eq(await js('smoke.app.getState().settingsOpen'),true,'Settings opens');
 ok(await js("smoke.has('#setting-terminal-dictationModels [data-dictation-packs]')"),'on Terminal, with the packs row');
 ok(await js("!!document.querySelector('#setting-terminal-dictationModels[data-setting-flash]')"),'the packs row is the deep-link target');
 eq(await js('smoke.dict.settings.length'),2,'without opening a Windows page');

 // The packs card: sizes, recommended (NVIDIA found), the VC++ row, folder and privacy.
 eq(await js("[...document.querySelectorAll('[data-dictation-pack]')].map(e=>[e.dataset.dictationPack,e.dataset.packState])"),[['cpu','available'],['gpu','available']],'both packs, not installed');
 eq(await js("smoke.text('[data-dictation-pack=cpu] [data-pack-sizes]')"),'Descarga 200 MB \\u00b7 212 MB en disco','CPU sizes');
 eq(await js("smoke.text('[data-dictation-pack=gpu] [data-pack-sizes]')"),'Descarga 1,8 GB \\u00b7 3,1 GB en disco','GPU sizes');
 ok((await js("smoke.text('[data-dictation-pack=gpu]')")).includes('1,3 GB de memoria de video'),'the GPU pack names its VRAM');
 eq(await js("[...document.querySelectorAll('[data-pack-recommended]')].map(e=>e.closest('[data-dictation-pack]').dataset.dictationPack)"),['gpu'],'the GPU pack is recommended with an NVIDIA GPU');
 ok(await js("smoke.has('[data-dictation-vcredist]')"),'the missing VC++ runtime shows a warning');
 await js("smoke.click('[data-dictation-open-vcredist]')");
 eq(await js('smoke.dict.settings.slice(-1)'),['vcredist'],'with the download button');
 eq(await js("smoke.text('[data-dictation-folder]')"),'Carpeta: D:/Portable/snagentsos-data/whisper','the data folder');
 eq(await js("smoke.text('[data-dictation-privacy]')"),'El audio se procesa en esta PC; no sale a internet.','the privacy note');
 await shot('dictation-settings');

 // Download the GPU pack: progress, Cancel, then a retry through verify, extract and warmup.
 await js("smoke.click('[data-dictation-pack=gpu] [data-pack-install]')");await frame();
 eq(await js('smoke.dict.install'),['gpu'],'Download asks main for the pack');
 ok(await js("smoke.disabled('[data-dictation-pack=cpu] [data-pack-install]')"),'one install at a time');
 await progress({pack:'gpu',phase:'download',transferred:880000000,total:1759000704});
 eq(await js("smoke.attr('[data-dictation-pack=gpu]','data-pack-state')"),'download','the GPU pack is downloading');
 ok(await js("smoke.has('[data-dictation-pack=gpu] [data-pack-progress]')"),'with the progress bar');
 eq(await js("smoke.text('[data-dictation-pack=gpu] [data-pack-progress]')"),'Descargando 50%880 MB de 1,8 GB','percent and bytes');
 await shot('dictation-settings-download');
 await js("smoke.click('[data-dictation-pack=gpu] [data-pack-cancel]')");await frame();
 eq(await js('smoke.dict.cancel'),['gpu'],'Cancel asks main to stop it');
 await js("smoke.dict.status.install={pack:'gpu',phase:'error',transferred:880000000,total:1759000704,error:'cancelled'}");
 await progress({pack:'gpu',phase:'error',transferred:880000000,total:1759000704,error:'cancelled'});
 await js("smoke.resolveInstall({ok:false,error:'cancelled'})");await frame();await frame();
 eq(await js("smoke.text('[data-dictation-pack=gpu] [data-pack-error=cancelled]')"),'Descarga cancelada. Se retoma desde donde qued\\u00f3.','cancelled says it resumes');
 eq(await js("smoke.text('[data-dictation-pack=gpu] [data-pack-install]')"),'Reintentar','and offers a retry');
 await js("smoke.click('[data-dictation-pack=gpu] [data-pack-install]')");await frame();
 eq(await js('smoke.dict.install'),['gpu','gpu'],'Retry installs again');
 ok(!(await js("smoke.has('[data-pack-error]')")),'the old error goes');
 await progress({pack:'gpu',phase:'verify',transferred:1759000704,total:1759000704});
 eq(await js("smoke.text('[data-dictation-pack=gpu] [data-pack-phase=verify]')"),'Verificando\\u2026','verify phase');
 ok(!(await js("smoke.has('[data-pack-cancel]')")),'Cancel only while downloading');
 await progress({pack:'gpu',phase:'extract',transferred:1759000704,total:1759000704});
 eq(await js("smoke.text('[data-dictation-pack=gpu] [data-pack-phase=extract]')"),'Descomprimiendo\\u2026','extract phase');
 await progress({pack:'gpu',phase:'warmup',transferred:1759000704,total:1759000704});
 ok((await js("smoke.text('[data-dictation-pack=gpu] [data-pack-phase=warmup]')")||'').startsWith('Preparando la GPU'),'warmup phase');
 await js("smoke.dict.status.install={pack:'gpu',phase:'done',transferred:1759000704,total:1759000704};smoke.dict.status.packs.forEach(p=>p.installed=true);smoke.dict.status.vcRuntime=true");
 await progress({pack:'gpu',phase:'done',transferred:1759000704,total:1759000704});
 await js("smoke.resolveInstall({ok:true})");await frame();await frame();
 eq(await js("[...document.querySelectorAll('[data-dictation-pack]')].map(e=>e.dataset.packState)"),['installed','installed'],'both packs installed');
 eq(await js("smoke.text('[data-dictation-pack=gpu] [data-pack-installed]')"),'Instalado \\u00b7 3,1 GB','installed with its disk size');
 ok(!(await js("smoke.has('[data-dictation-vcredist]')")),'the VC++ warning goes once the runtime is there');
 ok(!(await js("smoke.has('[data-pack-recommended]')")),'no recommendation once installed');
 ok(await js("smoke.disabled('[data-dictation-pack=cpu] [data-pack-delete]')"),'the CPU pack cannot be deleted while the GPU pack uses it');
 ok(await js("smoke.has('[data-dictation-pack=cpu] [data-pack-cpu-needed]')"),'and says why');
 ok(!(await js("smoke.disabled('[data-dictation-pack=gpu] [data-pack-delete]')")),'the GPU pack can be deleted');
 ok(!(await js("smoke.hOverflow('[data-dictation-settings]')")),'the dictation block has no horizontal overflow');
 await shot('dictation-settings-installed');

 // Delete the GPU pack (confirmed), then a refused delete of the CPU pack.
 await js("smoke.click('[data-dictation-pack=gpu] [data-pack-delete]')");await frame();
 ok(await js("!!document.querySelector('[data-confirm]')"),'Delete asks first');
 ok((await js("document.querySelector('[data-confirm]').closest('.rounded-modal').textContent")).includes('El pack CPU queda instalado.'),'the confirm says the CPU pack stays');
 eq(await js('smoke.dict.remove'),[],'nothing removed before the confirm');
 await js("smoke.dict.status.packs[1].installed=false;smoke.dict.status.install=null");
 await js("document.querySelector('[data-confirm]').click()");await frame();await frame();
 eq(await js('smoke.dict.remove'),['gpu'],'confirmed: main removes the GPU pack');
 eq(await js("[...document.querySelectorAll('[data-dictation-pack]')].map(e=>e.dataset.packState)"),['installed','available'],'the GPU pack can be downloaded again');
 ok(!(await js("smoke.disabled('[data-dictation-pack=cpu] [data-pack-delete]')")),'the CPU pack can be deleted now');
 await js("smoke.dict.removeRes={ok:false,error:'busy'}");
 await js("smoke.click('[data-dictation-pack=cpu] [data-pack-delete]')");await frame();
 ok((await js("document.querySelector('[data-confirm]').closest('.rounded-modal').textContent")).includes('212 MB'),'the CPU confirm names the size');
 await js("document.querySelector('[data-confirm]').click()");await frame();await frame();
 eq(await js("smoke.text('[data-dictation-pack=cpu] [data-pack-error=busy]')"),'Hay otra descarga o un dictado en curso. Prob\\u00e1 de nuevo cuando termine.','a busy delete says why');
 eq(await js("smoke.attr('[data-dictation-pack=cpu]','data-pack-state')"),'installed','and the pack stays');

 // Without an NVIDIA GPU the GPU pack cannot be downloaded and the CPU one is recommended.
 await js("smoke.dict.status.nvidia=false;smoke.dict.status.packs[0].installed=false");
 await js("smoke.app.getState().setSettingsOpen(false)");await frame();
 await js("smoke.app.getState().openSettings('terminal#dictationModels')");
 for(let i=0;i<20&&!(await js("smoke.has('[data-dictation-pack=gpu] [data-pack-no-gpu]')"));i++)await wait(50);
 ok(await js("smoke.has('[data-dictation-pack=gpu] [data-pack-no-gpu]')"),'no NVIDIA GPU: the GPU pack says so');
 ok(await js("smoke.disabled('[data-dictation-pack=gpu] [data-pack-install]')"),'and cannot be downloaded');
 eq(await js("[...document.querySelectorAll('[data-pack-recommended]')].map(e=>e.closest('[data-dictation-pack]').dataset.dictationPack)"),['cpu'],'the CPU pack is recommended');

 // Device, live preview and vocabulary write settings.dictation.
 await js("smoke.setSelect('[data-dictation-device-select]','cpu')");await frame();
 eq(await js('smoke.app.getState().settings.dictation.device'),'cpu','the device select saves');
 eq(await js("[...document.querySelectorAll('[data-dictation-device-select] option')].map(o=>[o.value,o.textContent])"),[['auto','Autom\\u00e1tico'],['gpu','GPU (NVIDIA)'],['cpu','CPU']],'device options');
 await js("document.querySelector('[data-setting-id=\\"terminal.dictationInterim\\"] [role=switch]').click()");await frame();
 eq(await js('smoke.app.getState().settings.dictation.interim'),false,'the preview switch saves');
 eq(await js("smoke.attr('[data-dictation-vocabulary]','maxlength')"),'400','the vocabulary is capped at 400');
 await js("smoke.setInput('[data-dictation-vocabulary]','  Vite, zustand, pnpm  ')");await frame();
 eq(await js('smoke.app.getState().settings.dictation.vocabulary'),'','the vocabulary saves on blur, not per key');
 await js("document.querySelector('[data-dictation-vocabulary]').dispatchEvent(new FocusEvent('focusout',{bubbles:true}))");await frame();
 eq(await js('smoke.app.getState().settings.dictation.vocabulary'),'Vite, zustand, pnpm','blur saves it trimmed');
 eq(await js("JSON.stringify(Object.keys(smoke.app.getState().settings.dictation).sort())"),JSON.stringify(['device','headerButton','interim','language','vocabulary']),'settings.dictation keeps the v18 shape');
 ok(!(await js("smoke.hOverflow('[data-dictation-settings]')")),'still no horizontal overflow');
 ok(!(await js('smoke.overflow()')),'no page overflow');

 if(failures.length)throw new Error(failures.join('\\n'));
 console.log('PASS: '+n+' dictation UI checks (header mic, overlay, GPU/CPU badge, slow and fallback notices, audio to the session, no Enter, menu guard and Insert, shortcut, context menu, error actions, global prompt, Settings packs with progress, cancel, phases, delete and device/preview/vocabulary); screenshots '+__dirname);w.destroy();app.quit();
}).catch(e=>{console.error(e);app.exit(1)});
`)
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
const res = spawnSync(require('electron'), [path.join(dir, 'main.cjs')], { env, windowsHide: true, encoding: 'utf8', timeout: 120000 })
process.stdout.write(res.stdout ?? ''); if (res.status !== 0) process.stderr.write(res.stderr ?? '')
process.exitCode = res.status ?? 1
}).catch((e) => { console.error(e); process.exitCode = 1 })
