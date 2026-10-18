// Drop files on a pane (E7-FR-01..03) with the production PaneCell + xterm in
// an isolated hidden Electron window. The pty is a fake: no shell, no agent,
// no user config is touched. Requires npm run build (for the CSS).
const fs = require('node:fs'), os = require('node:os'), path = require('node:path')
const { pathToFileURL } = require('node:url')
const { spawnSync } = require('node:child_process')
const { buildSync } = require('esbuild')
const root = path.resolve(__dirname, '..'), dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snagentsos-drop-'))
const assets = path.join(root, 'out/renderer/assets')
const css = fs.readdirSync(assets).find(f => /^index-.*\.css$/.test(f))
if (!css) throw new Error('Run npm run build first')
buildSync({ stdin: { contents: `
import React from 'react'; import {createRoot} from 'react-dom/client';
import {PaneCell} from './src/renderer/components/layout/PaneCell';
import {I18nProvider} from './src/renderer/i18n';
import {useAppStore} from './src/renderer/lib/store';
import {applyTheme} from './src/renderer/themes/applyTheme';
import {isBracketedPaste} from './src/renderer/lib/pasteRegistry';
import {encodeInternalPath} from './src/renderer/lib/dragNonce';
const writes=[], subs=[];
const paths={'a.png':'C:\\\\x\\\\a.png','b.png':'C:\\\\x\\\\b.png','c d.png':'C:\\\\tmp\\\\c d.png','e.ts':'C:\\\\x\\\\e.ts','bad.png':'C:\\\\x\\\\bad\\u0007.png'};
const noop=()=>()=>{};
const fallback=(base)=>new Proxy(base,{get:(t,k)=>k in t?t[k]:(typeof k==='string'?fallback(noop):undefined)});
window.snApi=fallback({platform:'win32',filePath:f=>paths[f.name]??'',
 pty:fallback({reattach:async()=>null,spawn:async r=>({ptyId:'pty-'+r.paneId}),onData:cb=>{subs.push(cb);return()=>{}},onExit:noop,write:w=>writes.push(w),resize(){},flow(){},kill:async()=>{}}),
 system:fallback({onDisplayRecovered:noop,openExternal(){}}),status:fallback({reportTitle(){}}),clipboard:fallback({readText:async()=>'',writeText(){}})});
const ws={id:'ws-1',name:'Drop',cwd:'',panes:[{id:'agent',type:'claude',title:'Claude',icon:'bot'},{id:'shell',type:'shell',title:'Shell',icon:'terminal'}]};
useAppStore.setState({hydrated:true,activeWorkspaceId:'ws-1',workspaces:[ws]});
applyTheme('midnight');
const noopFn=()=>{};
createRoot(document.getElementById('root')).render(<I18nProvider lang="es"><div style={{height:'100vh',display:'grid',gridTemplateColumns:'1fr 1fr',gap:6,padding:6}} className="bg-bg-primary text-text-primary">
 {ws.panes.map((p,i)=><PaneCell key={p.id} workspace={ws} pane={p} presets={[]} workspaceActive maximizedId={null} minimizedIds={[]} index={i} isDragging={false} draggable onToggleMax={noopFn} onToggleMin={noopFn} onClose={noopFn} onDragStartCell={noopFn} onDragEnterCell={noopFn} onDragEndCell={noopFn}/>)}
</div></I18nProvider>);
const dt=(names,internal)=>{const d=new DataTransfer();for(const n of names)d.items.add(new File(['x'],n,{type:'image/png'}));if(internal)d.setData('application/x-snaos-path',internal);return d};
const fire=(el,type,d)=>el.dispatchEvent(new DragEvent(type,{bubbles:true,cancelable:true,dataTransfer:d}));
window.smoke={writes,isBracketedPaste,encodeInternalPath,
 ready:()=>isBracketedPaste('agent')!==null&&isBracketedPaste('shell')!==null&&subs.length>=2,
 emit:(ptyId,data)=>subs.forEach(cb=>cb({ptyId,data})),
 cells:()=>[...document.querySelectorAll('#root > div > div')],
 overlay:i=>!!window.smoke.cells()[i].querySelector('[data-drop-overlay]'),
 drag:(i,type,names,target,internal)=>{const c=window.smoke.cells()[i];const el=target==='header'?c.querySelector('header'):target==='canvas'?(c.querySelector('canvas')||c.querySelector('.xterm')||c):c;fire(el,type,dt(names,internal))},
 dragPlain:(i,type)=>fire(window.smoke.cells()[i].querySelector('header'),type,new DataTransfer()),
 overflow:()=>document.documentElement.scrollWidth>innerWidth};
`, resolveDir: root, loader: 'tsx' }, bundle: true, platform: 'browser', format: 'iife', outfile: path.join(dir, 'renderer.js'), alias: { '@shared': path.join(root, 'src/shared'), '@': path.join(root, 'src/renderer') }, jsx: 'automatic', loader: { '.css': 'empty' }, define: { 'process.env.NODE_ENV': '"production"' } })
fs.writeFileSync(path.join(dir, 'index.html'), `<html><head><meta charset="utf-8"><link rel="stylesheet" href="${pathToFileURL(path.join(assets, css))}"></head><body><div id="root"></div><script src="renderer.js"></script></body></html>`)
fs.writeFileSync(path.join(dir, 'main.cjs'), `
const {app,BrowserWindow}=require('electron');const fs=require('fs'),path=require('path');
app.setPath('userData',path.join(__dirname,'profile'));
app.whenReady().then(async()=>{
 const w=new BrowserWindow({width:1100,height:600,show:false,webPreferences:{sandbox:true,backgroundThrottling:false}});
 let failures=[];w.webContents.on('console-message',(_e,level,message)=>{if(level>=3)failures.push(message)});
 const js=s=>w.webContents.executeJavaScript(s);const wait=ms=>new Promise(r=>setTimeout(r,ms));
 const frame=()=>js('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
 const shot=async name=>{await frame();await wait(150);fs.writeFileSync(path.join(__dirname,name+'.png'),(await w.webContents.capturePage()).toPNG())};
 let n=0;const eq=(a,b,label)=>{if(JSON.stringify(a)!==JSON.stringify(b))throw new Error(label+': got '+JSON.stringify(a)+' expected '+JSON.stringify(b));n++};
 const ok=(c,label)=>{if(!c)throw new Error(label);n++};
 await w.loadFile(path.join(__dirname,'index.html'));
 for(let i=0;i<50&&!(await js('smoke.ready()'));i++)await wait(100);
 ok(await js('smoke.ready()'),'both terminals mounted and registered their paster');
 const take=async()=>{await frame();return js('smoke.writes.splice(0).map(w=>[w.ptyId,w.data])')};
 await take();

 // FR-03: nested enter/leave over header and canvas never flickers; reorder drag never shows.
 const seq=[['dragenter','cell'],['dragenter','header'],['dragleave','cell'],['dragenter','canvas'],['dragleave','header']];
 for(const [type,target] of seq){await js("smoke.drag(0,'"+type+"',['a.png'],'"+target+"')");await frame();ok(await js('smoke.overlay(0)'),'overlay stays on during nested '+type+' '+target)}
 ok(!(await js('smoke.overlay(1)')),'the other pane stays dark');
 await shot('drop-overlay');
 await js("smoke.drag(0,'dragleave',['a.png'],'canvas')");await frame();
 ok(!(await js('smoke.overlay(0)')),'last dragleave hides the overlay');
 await js("smoke.dragPlain(1,'dragenter')");await frame();
 ok(!(await js('smoke.overlay(1)')),'pane reorder drag (no files) shows no overlay');
 await js("smoke.dragPlain(1,'dragleave')");
 await js("smoke.drag(0,'dragenter',['a.png'],'cell')");await frame();await js("window.dispatchEvent(new DragEvent('dragend'))");await frame();
 ok(!(await js('smoke.overlay(0)')),'dragend clears the overlay');

 // FR-02c: no bracketed paste, 1.14.1 quoted write.
 ok((await js("smoke.isBracketedPaste('agent')"))===false,'fresh terminal has bracketed paste off');
 await js("smoke.drag(0,'dragenter',['a.png'],'cell')");await js("smoke.drag(0,'drop',['a.png','c d.png'],'canvas')");
 eq(await take(),[['pty-agent','"C:\\\\x\\\\a.png" "C:\\\\tmp\\\\c d.png" ']],'plain console write');
 ok(!(await js('smoke.overlay(0)')),'drop hides the overlay');

 // FR-01: agent pane with bracketed paste gets the agent format through term.paste.
 await js("smoke.emit('pty-agent','\\\\x1b[?2004h')");await wait(150);
 ok((await js("smoke.isBracketedPaste('agent')"))===true,'mode 2004 turns bracketed paste on');
 await js("smoke.drag(0,'drop',['a.png','b.png'],'cell')");
 eq(await take(),[['pty-agent','\\x1b[200~C:\\\\x\\\\a.pngC:\\\\x\\\\b.png\\x1b[201~']],'two raw images glued inside the paste frame, no Enter');
 await js("smoke.drag(0,'drop',['e.ts','c d.png'],'cell')");
 eq(await take(),[['pty-agent','\\x1b[200~C:\\\\x\\\\e.ts "C:\\\\tmp\\\\c d.png"\\x1b[201~']],'file, space, quoted image');

 // FR-02b: bracketed shell (bash over SSH) separates every path with a space.
 await js("smoke.emit('pty-shell','\\\\x1b[?2004h')");await wait(150);
 await js("smoke.drag(1,'drop',['a.png','b.png'],'cell')");
 eq(await take(),[['pty-shell','\\x1b[200~C:\\\\x\\\\a.png C:\\\\x\\\\b.png \\x1b[201~']],'safe shell format');

 // Control byte voids the drop; an external in-app MIME without a valid nonce writes nothing.
 await js("smoke.drag(0,'drop',['a.png','bad.png'],'cell')");
 eq(await take(),[],'a path with BEL writes nothing');
 await js("smoke.drag(0,'drop',[],'cell',JSON.stringify({nonce:'forged',path:'rm -rf ~\\\\r'}))");
 eq(await take(),[],'forged x-snaos-path payload writes nothing');
 await js("smoke.drag(0,'drop',[],'cell',smoke.encodeInternalPath('C:\\\\\\\\x\\\\\\\\e.ts'))");
 eq(await take(),[],'own nonce but path not listed writes nothing');
 ok(!(await js('smoke.overflow()')),'no horizontal overflow');
 if(failures.length)throw new Error(failures.join('\\n'));
 console.log('PASS: '+n+' drop UI checks (overlay counter, reorder drag, plain/agent/safe payloads, control bytes, forged MIME); screenshots '+__dirname);w.destroy();app.quit();
}).catch(e=>{console.error(e);app.exit(1)});
`)
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
const res = spawnSync(require('electron'), [path.join(dir, 'main.cjs')], { env, windowsHide: true, encoding: 'utf8', timeout: 45000 })
process.stdout.write(res.stdout ?? ''); if (res.status !== 0) process.stderr.write(res.stderr ?? '')
process.exitCode = res.status ?? 1
