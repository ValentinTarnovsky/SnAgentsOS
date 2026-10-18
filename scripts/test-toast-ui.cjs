// Toast stack UI (E4-FR-03): the production NotificationStack over a common
// Modal and under RemotePairingPrompt, in an isolated hidden Electron window.
// main is a fake: no config, pty or notification service is touched.
// Requires npm run build (CSS).
const fs = require('node:fs'), os = require('node:os'), path = require('node:path')
const { pathToFileURL } = require('node:url')
const { spawnSync } = require('node:child_process')
const { buildSync } = require('esbuild')
const root = path.resolve(__dirname, '..'), dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snagentsos-toast-'))
const assets = path.join(root, 'out/renderer/assets')
const css = fs.readdirSync(assets).find(f => /^index-.*\.css$/.test(f))
if (!css) throw new Error('Run npm run build first')
buildSync({ stdin: { contents: `
import React from 'react'; import {createRoot} from 'react-dom/client';
import {NotificationStack} from './src/renderer/components/ui/NotificationStack';
import {RemotePairingPrompt} from './src/renderer/components/remote/RemotePairingPrompt';
import {Modal} from './src/renderer/components/common/Modal';
import {I18nProvider} from './src/renderer/i18n';
import {useAppStore} from './src/renderer/lib/store';
import {useRemoteStore} from './src/renderer/lib/remoteStore';
import {toast, useToastStore} from './src/renderer/lib/toast';
import {applyTheme} from './src/renderer/themes/applyTheme';
const noop=()=>()=>{};
const fallback=(base)=>new Proxy(base,{get:(t,k)=>k in t?t[k]:(typeof k==='string'?fallback(noop):undefined)});
window.snApi=fallback({platform:'win32',remote:fallback({pairingResolve(){}})});
useAppStore.setState({hydrated:true,workspaces:[],activeWorkspaceId:null});
applyTheme('midnight');
let setModal;
function Root(){const [open,setOpen]=React.useState(false);setModal=setOpen;return <I18nProvider lang="es"><div style={{height:'100vh'}} className="flex flex-col bg-bg-primary text-text-primary"><main className="p-6">Pila de toasts</main><Modal open={open} onClose={()=>setOpen(false)} title="Modal de prueba"><p id="modal-body" className="p-5">Contenido</p></Modal><RemotePairingPrompt/></div><NotificationStack/></I18nProvider>}
createRoot(document.getElementById('root')).render(<Root/>);
window.smoke={
 toast,
 clear:()=>useToastStore.setState({items:[]}),
 modal:v=>setModal(v),
 modalOpen:()=>!!document.getElementById('modal-body'),
 pairing:v=>useRemoteStore.setState({pendingPairing:v?{requestId:'r',deviceName:'Pixel',ip:'192.168.0.9',expiresAt:Date.now()+60000}:null}),
 cards:()=>[...document.querySelectorAll('[data-toast-id]')].map(e=>{const r=e.getBoundingClientRect();return {id:e.getAttribute('data-toast-id'),l:r.left,t:r.top,r:r.right,b:r.bottom}}),
 more:()=>document.querySelector('[data-toast-root] > button')?.textContent??null,
 inViewport:()=>{const r=document.querySelector('[data-toast-root]').getBoundingClientRect();return r.left>=0&&r.top>=0&&r.right<=innerWidth&&r.bottom<=innerHeight},
 newestVisible:()=>{const root=document.querySelector('[data-toast-root]').getBoundingClientRect();const all=[...document.querySelectorAll('[data-toast-id]')];const r=all[all.length-1].getBoundingClientRect();return r.bottom<=root.bottom+1&&r.top>=root.top-1},
 overflow:()=>document.documentElement.scrollWidth>innerWidth,
 topAt:(x,y)=>{const el=document.elementFromPoint(x,y);return el?(el.closest('[data-toast-root]')?'toast':el.closest('.z-\\\\[85\\\\]')?'pairing':el.closest('.z-50')?'modal':'page'):null},
 zOf:sel=>Number(getComputedStyle(document.querySelector(sel)).zIndex),
 pairingZ:()=>Number(getComputedStyle(document.querySelector('.z-\\\\[85\\\\]')).zIndex),
 roles:()=>[...document.querySelectorAll('[data-toast-id]')].map(e=>e.getAttribute('role')),
 region:()=>{const r=document.querySelector('[data-toast-root]');return r.getAttribute('role')+'|'+r.getAttribute('aria-label')},
};
`, resolveDir: root, loader: 'tsx' }, bundle: true, platform: 'browser', format: 'iife', outfile: path.join(dir, 'renderer.js'), alias: { '@shared': path.join(root, 'src/shared'), '@': path.join(root, 'src/renderer') }, jsx: 'automatic', loader: { '.css': 'empty' }, define: { 'process.env.NODE_ENV': '"production"' } })
fs.writeFileSync(path.join(dir, 'index.html'), `<html><head><meta charset="utf-8"><link rel="stylesheet" href="${pathToFileURL(path.join(assets, css))}"></head><body><div id="root"></div><script src="renderer.js"></script></body></html>`)
fs.writeFileSync(path.join(dir, 'main.cjs'), `
const {app,BrowserWindow}=require('electron');const fs=require('fs'),path=require('path');
app.setPath('userData',path.join(__dirname,'profile'));
app.whenReady().then(async()=>{
 const w=new BrowserWindow({width:860,height:560,useContentSize:true,show:false,webPreferences:{sandbox:true,backgroundThrottling:false}});
 let failures=[];w.webContents.on('console-message',(_e,level,message)=>{if(level>=3)failures.push(message)});
 const js=s=>w.webContents.executeJavaScript(s);const wait=ms=>new Promise(r=>setTimeout(r,ms));
 const frame=()=>js('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
 const settle=async()=>{await frame();await wait(320)};
 // Exit animations run on rAF, slower in a hidden window: poll for the card count.
 const count=async(expected,ms=3000)=>{const end=Date.now()+ms;let c;do{c=(await js('smoke.cards()')).length;if(c===expected)return c;await wait(50)}while(Date.now()<end);return c};
 const shot=async name=>{await settle();fs.writeFileSync(path.join(__dirname,name+'.png'),(await w.webContents.capturePage()).toPNG())};
 let n=0;const eq=(a,b,label)=>{if(JSON.stringify(a)!==JSON.stringify(b))throw new Error(label+': got '+JSON.stringify(a)+' expected '+JSON.stringify(b));n++};
 const ok=(c,label)=>{if(!c)throw new Error(label);n++};
 // Synthetic pointer sequence on whatever element is on top at (x, y).
 const click=async(x,y)=>{await js('(()=>{const el=document.elementFromPoint('+x+','+y+');for(const t of ["pointerdown","mousedown","pointerup","mouseup","click"])el.dispatchEvent(new MouseEvent(t,{bubbles:true,cancelable:true,clientX:'+x+',clientY:'+y+'}))})()');await settle()};
 await w.loadFile(path.join(__dirname,'index.html'));await wait(300);
 eq(await js('smoke.region()'),'region|Avisos','stack is a labelled region');

 // Five toasts show four, inside the viewport at 100/125/150% zoom.
 for(const zoom of [1,1.25,1.5]){
  w.webContents.setZoomFactor(zoom);await js('smoke.clear()');
  await js("for(let i=1;i<=5;i++)smoke.toast.success('Aviso de prueba numero '+i+' con un texto algo largo para envolver')");await settle();
  eq(await count(4),4,'five toasts show four at zoom '+zoom);
  ok(await js('smoke.inViewport()'),'the stack stays inside the viewport at zoom '+zoom);
  ok(await js('smoke.newestVisible()'),'the newest card (bottom) is scrolled into view at zoom '+zoom);
  ok(!(await js('smoke.overflow()')),'no horizontal overflow at zoom '+zoom);
  if(zoom===1.5)await shot('toasts-150');
 }
 w.webContents.setZoomFactor(1);

 // Six persistent actions: four cards and the "+2" row that expands the stack.
 await js('smoke.clear()');
 await js("for(let i=1;i<=6;i++)smoke.toast.warning('Claude necesita tu respuesta en W / C'+i,{durationMs:null,priority:2})");await settle();
 eq(await count(4),4,'six actions show four cards');
 eq(await js('smoke.more()'),'+2 avisos','overflow row reads +2');
 await shot('toasts-overflow');
 await js("document.querySelector('[data-toast-root] > button').click()");await settle();
 eq(await count(6),6,'the +N row expands the stack');
 ok(await js('smoke.inViewport()'),'expanded stack scrolls inside its max-height');

 // Over a common Modal: on top, and clicking a toast does not close the modal.
 await js('smoke.clear()');await js("smoke.toast.error('Error persistente sobre un modal')");await js('smoke.modal(true)');await settle();
 let card=(await js('smoke.cards()'))[0];
 eq(await js('smoke.topAt('+((card.l+card.r)/2)+','+((card.t+card.b)/2)+')'),'toast','toast is above the Modal');
 ok(await js("smoke.zOf('[data-toast-root]')")>50,'stack z-index above Modal z-50');
 await click(card.l+20,(card.t+card.b)/2);
 ok(await js('smoke.modalOpen()'),'clicking a toast keeps the modal open');
 eq(await js('smoke.roles()'),['alert'],'errors use role=alert');
 await shot('toast-over-modal');
 await js("window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))");await settle();
 ok(!(await js('smoke.modalOpen()')),'Esc reached the Modal (it closed)');
 eq(await count(1),1,'Esc does not close toasts');
 await js('smoke.modal(false)');
 // The X closes a persistent toast.
 card=(await js('smoke.cards()'))[0];
 await js("document.querySelector('[data-toast-id] button[aria-label]').click()");await settle();
 eq(await count(0),0,'an error stays until its X');

 // Under RemotePairingPrompt.
 await js("smoke.toast.warning('Aviso bajo el emparejamiento',{durationMs:null})");await js('smoke.pairing(true)');await settle();
 card=(await js('smoke.cards()'))[0];
 eq(await js('smoke.topAt('+((card.l+card.r)/2)+','+((card.t+card.b)/2)+')'),'pairing','RemotePairingPrompt covers the stack');
 ok(await js("smoke.zOf('[data-toast-root]')")<await js('smoke.pairingZ()'),'stack z-index below the pairing prompt');
 await shot('toast-under-pairing');
 await js('smoke.pairing(false)');await js('smoke.clear()');await settle();

 // Hover pauses a success timer; leaving resumes it.
 await js("smoke.toast.success('Pausa con hover',{durationMs:1500})");eq(await count(1),1,'success card shows');
 await js("document.querySelector('[data-toast-id]').dispatchEvent(new MouseEvent('mouseover',{bubbles:true,relatedTarget:document.body}))");
 await wait(2200);
 eq(await count(1),1,'hover pauses the timer');
 await js("document.querySelector('[data-toast-id]').dispatchEvent(new MouseEvent('mouseout',{bubbles:true,relatedTarget:document.body}))");
 eq(await count(0,4000),0,'leaving resumes and the toast goes away');
 await js("smoke.toast.success('Tres segundos')");await wait(3500);await settle();
 eq(await count(0),0,'a success leaves after 3 s');

 // Narrow window: 16 px side margins.
 w.setContentSize(420,560);await settle();await js("smoke.toast.info('Ventana angosta')");await settle();
 card=(await js('smoke.cards()'))[0];
 ok(Math.abs(card.l-16)<=1&&Math.abs((await js('innerWidth'))-card.r-16)<=1,'below 480 px the stack keeps 16 px side margins '+JSON.stringify(card));
 await shot('toast-narrow');

 if(failures.length)throw new Error(failures.join('\\n'));
 console.log('PASS: '+n+' toast stack UI checks (4 visible at 100/125/150%, +N row, over Modal, under pairing, hover pause); screenshots '+__dirname);w.destroy();app.quit();
}).catch(e=>{console.error(e);app.exit(1)});
`)
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
const res = spawnSync(require('electron'), [path.join(dir, 'main.cjs')], { env, windowsHide: true, encoding: 'utf8', timeout: 60000 })
process.stdout.write(res.stdout ?? ''); if (res.status !== 0) process.stderr.write(res.stderr ?? '')
process.exitCode = res.status ?? 1
