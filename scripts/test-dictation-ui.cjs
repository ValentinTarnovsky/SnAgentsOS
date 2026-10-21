// Desktop dictation (app 2.4.0) with the production PaneCell, TerminalPane
// overlay, GlobalPromptDialog and the global keymap in an isolated hidden
// Electron window. window.snApi.dictation is a fake that emits ready, hyp,
// final, error and end; the pty is a fake too. Checks: the header mic and
// the context menu entry, the listening overlay (phrase, engine, fallback
// with its settings button), typed text never carries CR or LF, the menu
// guard (nothing typed while a permission is pending; Insert types it), the
// Ctrl+Shift+H shortcut, the global prompt mic inserting at the caret, and
// an error with the microphone settings button. Requires npm run build (CSS).
const fs = require('node:fs'), os = require('node:os'), path = require('node:path')
const { pathToFileURL } = require('node:url')
const { spawnSync } = require('node:child_process')
const { buildSync } = require('esbuild')
const root = path.resolve(__dirname, '..'), dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snagentsos-dictation-ui-'))
const assets = path.join(root, 'out/renderer/assets')
const css = fs.readdirSync(assets).find(f => /^index-.*\.css$/.test(f))
if (!css) throw new Error('Run npm run build first')
buildSync({ stdin: { contents: `
import React from 'react'; import {createRoot} from 'react-dom/client';
import {PaneCell} from './src/renderer/components/layout/PaneCell';
import {GlobalPromptDialog} from './src/renderer/components/workspace/GlobalPromptDialog';
import {I18nProvider} from './src/renderer/i18n';
import {useAppStore} from './src/renderer/lib/store';
import {useGlobalKeys} from './src/renderer/lib/useGlobalKeys';
import {setFocusedPane} from './src/renderer/lib/focus';
import {isBracketedPaste} from './src/renderer/lib/pasteRegistry';
import {useDictationStore} from './src/renderer/lib/dictation';
import {applyTheme} from './src/renderer/themes/applyTheme';
const writes=[], subs=[], dict={start:[],stop:[],settings:[],listeners:new Set()};
let seq=0;
const noop=()=>()=>{};
const fallback=(base)=>new Proxy(base,{get:(t,k)=>k in t?t[k]:(typeof k==='string'?fallback(noop):undefined)});
window.snApi=fallback({platform:'win32',filePath:()=>'',
 pty:fallback({reattach:async()=>null,spawn:async r=>({ptyId:'pty-'+r.paneId}),onData:cb=>{subs.push(cb);return()=>{}},onExit:noop,write:w=>writes.push(w),resize(){},flow(){},kill:async()=>{}}),
 dictation:{start:async req=>{dict.start.push(req);return{ok:true,sessionId:'s'+(++seq)}},stop:async id=>{dict.stop.push(id)},onEvent:cb=>{dict.listeners.add(cb);return()=>dict.listeners.delete(cb)},openSettings:async page=>{dict.settings.push(page);return true}},
 system:fallback({onDisplayRecovered:noop,openExternal(){}}),status:fallback({reportTitle(){}}),clipboard:fallback({readText:async()=>'',writeText(){}})});
const ws={id:'ws-1',name:'Dictado',cwd:'',panes:[{id:'agent',type:'claude',title:'Claude',icon:'bot'},{id:'shell',type:'shell',title:'SSH',icon:'terminal'}]};
useAppStore.setState({hydrated:true,activeWorkspaceId:'ws-1',workspaces:[ws]});
useAppStore.setState(s=>({settings:{...s.settings,language:'es',dictation:{engine:'auto',language:'es-AR',headerButton:true}}}));
applyTheme('midnight');
const noopFn=()=>{};
function Keys(){useGlobalKeys();return null}
createRoot(document.getElementById('root')).render(<I18nProvider lang="es"><Keys/><div style={{height:'100vh',display:'grid',gridTemplateColumns:'1fr 1fr',gap:6,padding:6}} className="bg-bg-primary text-text-primary">
 {ws.panes.map((p,i)=><PaneCell key={p.id} workspace={ws} pane={p} presets={[]} workspaceActive maximizedId={null} minimizedIds={[]} index={i} isDragging={false} draggable onToggleMax={noopFn} onToggleMin={noopFn} onClose={noopFn} onDragStartCell={noopFn} onDragEndCell={noopFn}/>)}
</div><GlobalPromptDialog/></I18nProvider>);
const cell=id=>document.querySelector('[data-pane-cell="'+id+'"]');
window.smoke={writes,dict,app:useAppStore,dictStore:useDictationStore,setFocusedPane,
 ready:()=>isBracketedPaste('agent')!==null&&isBracketedPaste('shell')!==null&&subs.length>=2,
 emit:e=>dict.listeners.forEach(cb=>cb(e)),
 sid:()=>'s'+seq,
 click:sel=>{const el=document.querySelector(sel);if(!el)throw new Error('missing '+sel);el.click()},
 has:sel=>!!document.querySelector(sel),
 text:sel=>document.querySelector(sel)?.textContent??null,
 attr:(sel,a)=>document.querySelector(sel)?.getAttribute(a)??null,
 micBeforeClock:id=>{const h=cell(id).querySelector('header');const kids=[...h.querySelectorAll('button')];const m=kids.findIndex(b=>b.hasAttribute('data-pane-mic')),c=kids.findIndex(b=>b.hasAttribute('data-pane-clock'));return m>=0&&c>=0&&m<c},
 key:(k,mods)=>window.dispatchEvent(new KeyboardEvent('keydown',{key:k,ctrlKey:!!mods.ctrl,shiftKey:!!mods.shift,bubbles:true,cancelable:true})),
 ctxMenu:id=>cell(id).querySelector('header').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:200,clientY:80})),
 menuItems:()=>[...document.querySelectorAll('[role=menu] [role=menuitem]')].map(e=>e.textContent.trim()),
 clickMenu:label=>{const el=[...document.querySelectorAll('[role=menu] [role=menuitem]')].find(e=>e.textContent.trim()===label);if(!el)throw new Error('no menu item '+label);el.click()},
 typeField:v=>{const ta=document.querySelector('[data-global-prompt-text]');const set=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set;set.call(ta,v);ta.dispatchEvent(new Event('input',{bubbles:true}));ta.focus();ta.setSelectionRange(v.length,v.length);ta.dispatchEvent(new Event('select',{bubbles:true}))},
 fieldValue:()=>document.querySelector('[data-global-prompt-text]')?.value??null,
 overflow:()=>document.documentElement.scrollWidth>innerWidth};
`, resolveDir: root, loader: 'tsx' }, bundle: true, platform: 'browser', format: 'iife', outfile: path.join(dir, 'renderer.js'), alias: { '@shared': path.join(root, 'src/shared'), '@': path.join(root, 'src/renderer') }, jsx: 'automatic', loader: { '.css': 'empty' }, define: { 'process.env.NODE_ENV': '"production"' } })
fs.writeFileSync(path.join(dir, 'index.html'), `<html><head><meta charset="utf-8"><link rel="stylesheet" href="${pathToFileURL(path.join(assets, css))}"></head><body><div id="root"></div><script src="renderer.js"></script></body></html>`)
fs.writeFileSync(path.join(dir, 'main.cjs'), `
const {app,BrowserWindow}=require('electron');const fs=require('fs'),path=require('path');
app.setPath('userData',path.join(__dirname,'profile'));
app.whenReady().then(async()=>{
 const w=new BrowserWindow({width:1200,height:640,show:false,webPreferences:{sandbox:true,backgroundThrottling:false}});
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
 eq(await js('smoke.dict.start'),[{engine:'auto',lang:'es-AR'}],'the mic starts with the saved engine and language');
 eq(await js("smoke.attr('[data-pane-cell=agent] [data-pane-mic]','data-pane-mic')"),'on','the mic shows it is on');
 ok(await js("smoke.has('[data-dictation-overlay=agent]')"),'the listening overlay shows on that console');
 ok(!(await js("smoke.has('[data-dictation-overlay=shell]')")),'and only there');

 // Ready (offline fallback), phrase so far, settings button.
 await emit({sessionId:'s1',t:'ready',engine:'offline',lang:'es-ES',fallback:'privacy'});
 await emit({sessionId:'s1',t:'hyp',text:'hola mun'});
 eq(await js("smoke.text('[data-dictation-overlay=agent] [data-dictation-interim]')"),'hola mun','the overlay shows the phrase being heard');
 ok(await js("smoke.has('[data-dictation-engine=offline]')"),'engine badge');
 ok(await js("smoke.has('[data-dictation-fallback=privacy] [data-dictation-open-settings=speech]')"),'offline fallback notice with the speech settings button');
 await shot('dictation-listening');
 await js("smoke.click('[data-dictation-fallback] [data-dictation-open-settings]')");await frame();
 eq(await js('smoke.dict.settings'),['speech'],'the button opens the speech privacy page');

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

 // Stop.
 await js("smoke.click('[data-dictation-stop]')");await frame();
 eq(await js('smoke.dict.stop'),['s1'],'Stop asks main to stop the session');
 await emit({sessionId:'s1',t:'end'});
 ok(!(await js("smoke.has('[data-dictation-overlay=agent]')")),'end closes the overlay');
 eq(await js("smoke.attr('[data-pane-cell=agent] [data-pane-mic]','data-pane-mic')"),'off','the mic is off again');

 // Shortcut on the focused console (an SSH one: the text goes to the local pty).
 await js("smoke.setFocusedPane('shell','ws-1')");
 await js("smoke.key('H',{ctrl:true,shift:true})");await frame();
 eq(await js('smoke.dict.start.length'),2,'Ctrl+Shift+H starts dictation');
 ok(await js("smoke.has('[data-dictation-overlay=shell]')"),'on the focused console');
 await emit({sessionId:'s2',t:'ready',engine:'online',lang:'es-AR'});
 await emit({sessionId:'s2',t:'final',text:'ls menos la'});
 got=await take();noEnter(got,'shortcut');
 eq(got.map(x=>x.ptyId),['pty-shell'],'typed into the focused console');
 await js("smoke.key('H',{ctrl:true,shift:true})");await frame();
 eq(await js('smoke.dict.stop'),['s1','s2'],'the shortcut again stops it');
 await emit({sessionId:'s2',t:'end'});

 // Context menu entry.
 await js("smoke.ctxMenu('agent')");await frame();
 ok((await js('smoke.menuItems()')).includes('Dictar'),'the console menu has Dictar');
 await js("smoke.clickMenu('Dictar')");await frame();
 eq(await js('smoke.dict.start.length'),3,'Dictar starts a session');
 // An error from the helper: microphone settings button, then dismiss.
 await emit({sessionId:'s3',t:'error',code:'mic_denied'});
 await emit({sessionId:'s3',t:'end'});
 ok(await js("smoke.has('[data-dictation-overlay=agent] [data-dictation-open-settings=microphone]')"),'mic_denied offers the microphone settings page');
 await shot('dictation-error');
 await js("smoke.click('[data-dictation-overlay=agent] [data-dictation-open-settings=microphone]')");
 eq(await js('smoke.dict.settings'),['speech','microphone'],'and opens it');
 await js("smoke.click('[data-dictation-dismiss]')");await frame();
 ok(!(await js("smoke.has('[data-dictation-overlay=agent]')")),'dismiss closes the notice');

 // Header mic off by setting: the menu entry stays.
 await js("smoke.app.setState(s=>({settings:{...s.settings,dictation:{...s.settings.dictation,headerButton:false}}}))");await frame();
 eq(await js("document.querySelectorAll('[data-pane-mic]').length"),0,'headerButton off hides the mic');
 await js("smoke.ctxMenu('agent')");await frame();
 ok((await js('smoke.menuItems()')).includes('Dictar'),'the menu entry is still there');
 await js("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))");await js("document.body.dispatchEvent(new MouseEvent('mousedown',{bubbles:true}))");await frame();

 // Global prompt: the mic inserts at the caret, the shortcut toggles it, no pty write.
 await js('smoke.app.getState().setGlobalPromptOpen(true)');await frame();await wait(100);
 ok(await js("smoke.has('[data-field-mic]')"),'the global prompt has a mic');
 await js("smoke.typeField('Revisa ')");await frame();
 await js("smoke.click('[data-field-mic]')");await frame();
 eq(await js('smoke.dict.start.length'),4,'the field mic starts a session');
 await emit({sessionId:'s4',t:'ready',engine:'online'});
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
 if(failures.length)throw new Error(failures.join('\\n'));
 console.log('PASS: '+n+' dictation UI checks (header mic, overlay, fallback and settings, no Enter, menu guard and Insert, shortcut, context menu, global prompt); screenshots '+__dirname);w.destroy();app.quit();
}).catch(e=>{console.error(e);app.exit(1)});
`)
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
const res = spawnSync(require('electron'), [path.join(dir, 'main.cjs')], { env, windowsHide: true, encoding: 'utf8', timeout: 90000 })
process.stdout.write(res.stdout ?? ''); if (res.status !== 0) process.stderr.write(res.stderr ?? '')
process.exitCode = res.status ?? 1
