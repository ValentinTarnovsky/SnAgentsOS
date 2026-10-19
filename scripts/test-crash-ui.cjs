// Error boundaries (E4-FR-19, 20) with the production TilingGrid, PaneCell,
// xterm and TitleBar in an isolated hidden Electron window. The pty is a fake:
// no shell, no user config. Checks that no boundary kills a pty (FR-36), that
// [Reload console] reattaches with the replay, and the fallbacks' controls.
// Requires npm run build (for the CSS).
const fs = require('node:fs'), os = require('node:os'), path = require('node:path')
const { pathToFileURL } = require('node:url')
const { spawnSync } = require('node:child_process')
const { buildSync } = require('esbuild')
const root = path.resolve(__dirname, '..'), dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snagentsos-crash-'))
const assets = path.join(root, 'out/renderer/assets')
const css = fs.readdirSync(assets).find(f => /^index-.*\.css$/.test(f))
if (!css) throw new Error('Run npm run build first')
buildSync({ stdin: { contents: `
import React from 'react'; import {createRoot} from 'react-dom/client';
import {TilingGrid} from './src/renderer/components/layout/TilingGrid';
import {TitleBar} from './src/renderer/components/titlebar/TitleBar';
import {AppErrorBoundary, TitleBarBoundary, isSnBoundary} from './src/renderer/components/common/ErrorBoundary';
import {NotificationStack} from './src/renderer/components/ui/NotificationStack';
import {I18nProvider} from './src/renderer/i18n';
import {useAppStore} from './src/renderer/lib/store';
import {initPtyLifecycle} from './src/renderer/lib/ptyLifecycle';
import {setDevThrow} from './src/renderer/lib/devHooks';
import {getPtyId} from './src/renderer/lib/ptyRegistry';
import {applyTheme} from './src/renderer/themes/applyTheme';
const calls={kill:[],killPanes:[],reattach:[],spawn:[],reload:0,reports:[],clip:[],win:[]};
const alive=new Set(), subs=[];
const noop=()=>()=>{};
const fallback=(base)=>new Proxy(base,{get:(t,k)=>k in t?t[k]:(typeof k==='string'?fallback(noop):undefined)});
window.snApi=fallback({platform:'win32',filePath:()=>'',
 app:fallback({reload:()=>{calls.reload++},reportRenderError:r=>calls.reports.push(r),diagnostics:async()=>'## Diagnostics',takeRecovery:async()=>null}),
 pty:fallback({reattach:async id=>{calls.reattach.push(id);return alive.has(id)?{ptyId:'pty-'+id,replay:'REPLAY-'+id+'\\r\\n'}:null},
  spawn:async r=>{calls.spawn.push(r.paneId);alive.add(r.paneId);return {ptyId:'pty-'+r.paneId}},
  onData:cb=>{subs.push(cb);return()=>{}},onExit:noop,write(){},resize(){},flow(){},setActive(){},
  kill:async id=>{calls.kill.push(id)},killPanes:async ids=>{calls.killPanes.push(ids);ids.forEach(i=>alive.delete(i));return ids.length},reconcile:async()=>0}),
 window:fallback({isMaximized:async()=>false,onMaximizeChange:noop,minimize(){calls.win.push('min')},maximize(){calls.win.push('max')},close(){calls.win.push('close')}}),
 power:fallback({getState:async()=>({blocking:false,reason:null}),onState:noop,setConfig(){}}),
 system:fallback({onDisplayRecovered:noop,openExternal(){}}),status:fallback({reportTitle(){}}),
 clipboard:fallback({readText:async()=>'',writeText:t=>calls.clip.push(t)})});
const ws={id:'ws-1',name:'Crash',cwd:'',panes:[{id:'p1',type:'shell',title:'Uno',icon:'terminal'},{id:'p2',type:'shell',title:'Dos',icon:'terminal'}]};
useAppStore.setState(s=>({hydrated:true,activeWorkspaceId:'ws-1',workspaces:[ws],settings:{...s.settings,language:'es'}}));
initPtyLifecycle();
applyTheme('midnight');
function Grid(){const w=useAppStore(s=>s.workspaces.find(x=>x.id==='ws-1'));return w?<TilingGrid workspace={w} isActive/>:null}
createRoot(document.getElementById('root'),{onCaughtError:(e,info)=>{if(!isSnBoundary(info.errorBoundary))console.error(e)},onUncaughtError:e=>console.error(e)}).render(
 <I18nProvider lang="es"><div style={{height:'100vh'}} className="flex flex-col bg-bg-primary text-text-primary">
  <TitleBarBoundary><TitleBar/></TitleBarBoundary>
  <AppErrorBoundary><div id="body" className="min-h-0 flex-1"><Grid/></div></AppErrorBoundary>
 </div><NotificationStack/></I18nProvider>);
const text=sel=>document.querySelector(sel)?.textContent||'';
window.smoke={calls,setDevThrow,getPtyId,
 ready:()=>calls.spawn.length>=2&&document.querySelectorAll('.xterm').length>=2,
 emit:(ptyId,data)=>subs.forEach(cb=>cb({ptyId,data})),
 has:sel=>!!document.querySelector(sel),text,
 click:sel=>{const el=document.querySelector(sel);if(!el)throw new Error('missing '+sel);el.click()},
 clickText:(t)=>{const el=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===t);if(!el)throw new Error('no button '+t);el.click()},
 overflow:()=>document.documentElement.scrollWidth>innerWidth};
`, resolveDir: root, loader: 'tsx' }, bundle: true, platform: 'browser', format: 'iife', outfile: path.join(dir, 'renderer.js'), alias: { '@shared': path.join(root, 'src/shared'), '@': path.join(root, 'src/renderer') }, jsx: 'automatic', loader: { '.css': 'empty' }, define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'error' })
fs.writeFileSync(path.join(dir, 'index.html'), `<html><head><meta charset="utf-8"><link rel="stylesheet" href="${pathToFileURL(path.join(assets, css))}"></head><body><div id="root"></div><script src="renderer.js"></script></body></html>`)
fs.writeFileSync(path.join(dir, 'main.cjs'), `
const {app,BrowserWindow}=require('electron');const fs=require('fs'),path=require('path');
app.setPath('userData',path.join(__dirname,'profile'));
app.whenReady().then(async()=>{
 const w=new BrowserWindow({width:1100,height:640,show:false,webPreferences:{sandbox:true,backgroundThrottling:false}});
 let failures=[];w.webContents.on('console-message',(_e,level,message)=>{if(level>=3)failures.push(message)});
 const js=s=>w.webContents.executeJavaScript(s);const wait=ms=>new Promise(r=>setTimeout(r,ms));
 const frame=()=>js('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
 const settle=async()=>{await frame();await wait(120)};
 const shot=async name=>{await settle();fs.writeFileSync(path.join(__dirname,name+'.png'),(await w.webContents.capturePage()).toPNG())};
 let n=0;const ok=(c,label)=>{if(!c)throw new Error(label);n++};
 const killed=async()=>js('({kill:smoke.calls.kill.length,killPanes:smoke.calls.killPanes.length})');
 await w.loadFile(path.join(__dirname,'index.html'));
 for(let i=0;i<60&&!(await js('smoke.ready()'));i++)await wait(100);
 ok(await js('smoke.ready()'),'both terminals mounted and spawned');

 // FR-19a: the inner boundary swaps only the terminal; no pty is killed.
 await js("smoke.setDevThrow('pane:p1')");await settle();
 ok(await js("smoke.has('[data-pane-fallback=p1]')"),'pane fallback shows');
 ok((await js("smoke.text('[data-pane-fallback=p1]')")).includes('El proceso sigue corriendo'),'fallback says the process keeps running');
 ok(await js("smoke.has('[data-pane-fallback=p1][data-primary=reload]')"),'[Reload console] is the primary on the first failure');
 ok(await js("smoke.has('[data-pane-fallback=p1]') && document.querySelectorAll('.xterm').length===1"),'the other pane keeps its terminal');
 ok(await js("smoke.calls.reports.some(r=>r.scope==='pane'&&r.paneId==='p1')"),'the pane failure is reported to main');
 await shot('pane-fallback');
 ok(JSON.stringify(await killed())==='{"kill":0,"killPanes":0}','the pane boundary kills nothing');
 await js("smoke.clickText('Copiar detalle')");await settle();
 ok((await js('smoke.calls.clip.at(-1)')).startsWith('Forced render error (pane:p1)') && (await js('smoke.calls.clip.at(-1).length'))<=4096,'[Copy detail] copies the message within 4KB');
 ok(await js("smoke.has('[data-toast-kind=success]')"),'copy shows the Copied toast');
 const before=await js('smoke.calls.reattach.length');
 await js("smoke.click('[data-pane-fallback-reload]')");await settle();
 for(let i=0;i<30&&(await js('document.querySelectorAll(".xterm").length'))<2;i++)await wait(100);
 ok(!(await js("smoke.has('[data-pane-fallback=p1]')")) && (await js('document.querySelectorAll(".xterm").length'))===2,'[Reload console] remounts the terminal');
 ok((await js('smoke.calls.reattach.length'))>before && (await js("smoke.calls.reattach.at(-1)"))==='p1','the remount reattaches to the live pty');
 for(let i=0;i<20&&(await js("smoke.getPtyId('p1')"))!=='pty-p1';i++)await wait(100);
 ok((await js("smoke.getPtyId('p1')"))==='pty-p1','the remounted terminal binds the same pty (replay comes with the reattach)');
 ok((await js('smoke.calls.spawn.length'))===2 && JSON.stringify(await killed())==='{"kill":0,"killPanes":0}','reload neither spawns nor kills');

 // Three failures in 60 s: [Restart console] becomes the primary.
 for(let i=0;i<2;i++){await js("smoke.setDevThrow('pane:p1')");await settle();if(i===0){await js("smoke.click('[data-pane-fallback-reload]')");await settle()}}
 ok(await js("smoke.has('[data-pane-fallback=p1][data-primary=restart]')"),'after 3 failures in 60 s the primary is [Restart console]');
 ok((await js("smoke.text('[data-pane-fallback=p1]')")).includes('Falló 3 veces'),'the fallback says how many times it failed');
 await shot('pane-fallback-repeated');
 await js("smoke.click('[data-pane-fallback-restart]')");await settle();
 for(let i=0;i<30&&(await js('smoke.calls.spawn.length'))<3;i++)await wait(100);
 ok(JSON.stringify(await js('smoke.calls.killPanes'))==='[["p1"]]','[Restart console] kills exactly that pane (explicit restart)');
 ok((await js('smoke.calls.spawn.length'))===3 && !(await js("smoke.has('[data-pane-fallback=p1]')")),'the restart spawns a fresh shell and the boundary resets');

 // FR-19b: the outer boundary leaves a minimal header; the rest stays alive.
 await js("smoke.setDevThrow('paneHeader:p2')");await settle();
 ok(await js("smoke.has('[data-pane-cell-fallback]')"),'header failure shows the minimal cell');
 ok((await js("smoke.text('[data-pane-cell-fallback] header')")).includes('Dos'),'the minimal header keeps the title');
 ok((await js('document.querySelectorAll(".xterm").length'))===1,'the other pane keeps running');
 ok((await js('smoke.calls.killPanes.length'))===1 && (await js('smoke.calls.kill.length'))===0,'the cell boundary kills nothing');
 await shot('cell-fallback');
 await js("smoke.click('[data-pane-cell-fallback-reload]')");await settle();
 for(let i=0;i<30&&(await js('document.querySelectorAll(".xterm").length'))<2;i++)await wait(100);
 ok(!(await js("smoke.has('[data-pane-cell-fallback]')")) && (await js("smoke.calls.reattach.at(-1)"))==='p2','[Reload console] in the cell remounts and reattaches');
 await js("smoke.setDevThrow('paneHeader:p2')");await settle();
 await js("smoke.click('[data-pane-cell-fallback-close]')");await settle();
 ok(JSON.stringify(await js('smoke.calls.killPanes.at(-1)'))==='["p2"]','closing from the fallback X kills that pty (pty lifecycle)');
 ok(!(await js("smoke.has('[data-pane-cell-fallback]')")),'the closed pane leaves the grid');

 // FR-20: title bar and app body fallbacks.
 await js("smoke.setDevThrow('titlebar')");await settle();
 ok(await js("smoke.has('[data-titlebar-fallback].app-drag')"),'title bar fallback is a drag strip');
 await js("document.querySelectorAll('[data-titlebar-fallback] button').forEach(b=>b.click())");
 ok(JSON.stringify(await js('smoke.calls.win'))==='["min","max","close"]','minimize, maximize and close still work');
 await js("smoke.setDevThrow('app')");await settle();
 ok(await js("smoke.has('[data-app-fallback] .app-drag')") && (await js("smoke.text('[data-app-fallback]')")).includes('Tus consolas siguen corriendo'),'app fallback with drag strip and message');
 const k1=await killed();
 await js("smoke.click('[data-app-fallback-reload]')");
 ok((await js('smoke.calls.reload'))===1,'[Reload window] asks main for a manual reload');
 await js("smoke.clickText('Copiar diagnóstico')");await settle();
 ok((await js('smoke.calls.clip.at(-1)'))==='## Diagnostics' && (await js("[...document.querySelectorAll('[data-toast-kind=success]')].some(t=>t.textContent.includes('Diagnóstico copiado (1 KB)'))")),'[Copy diagnostics] copies and confirms with the size');
 ok(JSON.stringify(await killed())===JSON.stringify(k1),'the app and title bar boundaries kill nothing');
 ok(await js("smoke.calls.reports.some(r=>r.scope==='app') && smoke.calls.reports.some(r=>r.scope==='titlebar') && smoke.calls.reports.some(r=>r.scope==='paneCell')"),'every boundary reports its scope');
 ok(!(await js('smoke.overflow()')),'no horizontal overflow');
 await shot('app-fallback');
 if(failures.length)throw new Error(failures.join('\\n'));
 console.log('PASS: '+n+' crash UI checks (pane and cell fallbacks keep ptys, reload reattaches with replay, restart threshold, title bar and app fallbacks); screenshots '+__dirname);w.destroy();app.quit();
}).catch(e=>{console.error(e);app.exit(1)});
`)
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
const res = spawnSync(require('electron'), [path.join(dir, 'main.cjs')], { env, windowsHide: true, encoding: 'utf8', timeout: 60000 })
process.stdout.write(res.stdout ?? ''); if (res.status !== 0) process.stderr.write(res.stderr ?? '')
process.exitCode = res.status ?? 1
