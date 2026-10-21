// v2.4 item 5 (`/rename` renames the console) rendered from the production
// useStatusEvents hook, Settings > Agents and the toast stack in an isolated
// hidden Electron window. The status:agentRename events are fed through a fake
// snApi.status.onAgentRename, so no pty, hook server, user config or real
// agent is touched. Checks: the console takes the name and the toast reads
// "Consola renombrada a Foo"; a hand-renamed console keeps its name against an
// `initial` name and loses it to a new /rename; a stale pty is ignored; the
// two toggles (syncAgentRename, shellAgentDetect) exist, are on by default,
// are found by the settings search and turning the first off stops renames.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path')
const { pathToFileURL } = require('node:url')
const { spawnSync } = require('node:child_process')
const { buildSync } = require('esbuild')
const root = path.resolve(__dirname, '..'), dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snagentsos-rename-ui-'))
const assets = path.join(root, 'out/renderer/assets')
const css = fs.readdirSync(assets).find(f => /^index-.*\.css$/.test(f))
if (!css) throw new Error('Run npm run build first')
buildSync({ stdin: { contents: `
import React from 'react'; import {createRoot} from 'react-dom/client';
import {SettingsModal} from './src/renderer/components/settings/SettingsModal';
import {NotificationStack} from './src/renderer/components/ui/NotificationStack';
import {I18nProvider} from './src/renderer/i18n';
import {useAppStore} from './src/renderer/lib/store';
import {useToastStore} from './src/renderer/lib/toast';
import {useStatusEvents} from './src/renderer/lib/useStatusEvents';
import {registerPty} from './src/renderer/lib/ptyRegistry';
import {applyTheme} from './src/renderer/themes/applyTheme';
const noop=()=>()=>{};
const fallback=(base)=>new Proxy(base,{get:(t,k)=>k in t?t[k]:(typeof k==='string'?fallback(noop):undefined)});
let fire=null;
window.snApi=fallback({platform:'win32',
 status:fallback({onState:noop,onSessionEnd:noop,onReveal:noop,snapshot:async()=>[],setViewed(){},setConfig(){},
  onAgentRename:(cb)=>{fire=cb;return()=>{fire=null}},
  health:async()=>({claude:{installed:false},codex:{enabled:true,available:false,connected:0},discord:{lastSuccessAt:null,error:null,queued:0}}),
  hooksStatus:async()=>({installed:false,settingsPath:'x'})}),
 config:fallback({save(){}}),pty:fallback({write(){}}),
 app:fallback({info:async()=>({version:'2.4.0',portable:false,platform:'win32'})})});
const preset={id:'pc',name:'Claude Code',type:'claude',command:'claude',args:[],color:'#d97757',icon:'claude'};
const s0=useAppStore.getState();
useAppStore.setState({hydrated:true,presets:[preset],activeWorkspaceId:'w1',settings:{...s0.settings,language:'es'},
 workspaces:[{id:'w1',name:'Uno',cwd:'C:/r',panes:[
  {id:'pa',type:'claude',presetId:'pc',title:'Claude Code',color:'#d97757',icon:'claude'},
  {id:'pb',type:'claude',presetId:'pc',title:'Backend',color:'#d97757',icon:'claude'}],layout:{grid:2,order:['pa','pb']}}]});
registerPty('pa','pty-a');registerPty('pb','pty-b');
applyTheme('midnight');
function Wire(){useStatusEvents();return null}
createRoot(document.getElementById('root')).render(<I18nProvider lang="es"><div style={{height:'100vh'}} className="flex bg-bg-primary text-text-primary"><Wire/><main className="flex-1 p-6">rename</main><SettingsModal/><NotificationStack/></div></I18nProvider>);
const SID='0b7c2f4e-1a2b-4c3d-8e9f-0123456789ab';
window.smoke={
 app:useAppStore.getState,set:useAppStore.setState,
 fire:(e)=>{if(!fire)return false;fire({paneId:'pa',ptyId:'pty-a',provider:'claude',sessionId:SID,title:'Foo',initial:false,...e});return true},
 title:(id)=>useAppStore.getState().workspaces[0].panes.find(p=>p.id===id).title,
 toasts:()=>useToastStore.getState().items.map(t=>t.title),
 shown:()=>document.body.textContent||'',
 openSettings:(t)=>useAppStore.getState().openSettings(t),
 toggle:(id)=>{const row=document.querySelector('[data-setting-id="'+id+'"]');const sw=row&&row.querySelector('[role=switch]');return sw?sw.getAttribute('aria-checked'):null},
 click:(id)=>{const sw=document.querySelector('[data-setting-id="'+id+'"] [role=switch]');if(sw)sw.click();return !!sw},
};
`, resolveDir: root, loader: 'tsx' }, bundle: true, platform: 'browser', format: 'iife', outfile: path.join(dir, 'renderer.js'), alias: { '@shared': path.join(root, 'src/shared'), '@': path.join(root, 'src/renderer') }, jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' } })
fs.writeFileSync(path.join(dir, 'index.html'), `<html><head><meta charset="utf-8"><link rel="stylesheet" href="${pathToFileURL(path.join(assets, css))}"></head><body><div id="root"></div><script src="renderer.js"></script></body></html>`)
fs.writeFileSync(path.join(dir, 'main.cjs'), `
const {app,BrowserWindow}=require('electron');const fs=require('fs'),path=require('path');
app.setPath('userData',path.join(__dirname,'profile'));
const wait=ms=>new Promise(r=>setTimeout(r,ms));
app.whenReady().then(async()=>{
 const w=new BrowserWindow({width:1200,height:860,show:false,webPreferences:{sandbox:true,backgroundThrottling:false}});
 let failures=[];w.webContents.on('console-message',(_e,level,message)=>{if(level>=3)failures.push(message)});
 await w.loadFile(path.join(__dirname,'index.html'));await wait(400);
 const js=c=>w.webContents.executeJavaScript(c);
 const frames=()=>wait(120);
 const shot=async name=>{await js('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');await wait(150);fs.writeFileSync(path.join(__dirname,name+'.png'),(await w.webContents.capturePage()).toPNG())};
 let checks=0;const ok=(cond,what,data)=>{if(!cond)throw new Error(what+' '+JSON.stringify(data));checks++};

 ok(await js('smoke.fire({})'),'useStatusEvents subscribes to status.onAgentRename');await frames();
 ok(await js("smoke.title('pa')")==='Foo','a /rename renames the console',await js("smoke.title('pa')"));
 const toasts=await js('smoke.toasts()');
 ok(toasts.includes('Consola renombrada a Foo')&&(await js('smoke.shown()')).includes('Consola renombrada a Foo'),'the agents.renamed toast is shown',toasts);
 await shot('renamed-toast');
 await js("smoke.fire({ptyId:'pty-old',title:'Viejo'})");await frames();
 ok(await js("smoke.title('pa')")==='Foo','a rename of a dead pty is ignored');
 await js("smoke.fire({paneId:'pb',ptyId:'pty-b',title:'Resumida',initial:true})");await frames();
 ok(await js("smoke.title('pb')")==='Backend','an initial name never overwrites a console renamed by hand');
 await js("smoke.fire({paneId:'pb',ptyId:'pty-b',title:'Baz'})");await frames();
 ok(await js("smoke.title('pb')")==='Baz','a new /rename wins over the manual name');

 // Settings > Agents: both toggles, on by default, and the search finds them.
 await js("smoke.openSettings('agents')");await frames();await frames();
 ok(await js("smoke.toggle('agents.syncAgentRename')")==='true','the "/rename renombra la consola" toggle is on by default',await js("smoke.toggle('agents.syncAgentRename')"));
 ok(await js("smoke.toggle('agents.shellAgentDetect')")==='true','the shell agent detection toggle is on by default',await js("smoke.toggle('agents.shellAgentDetect')"));
 const copy=await js("document.querySelector('[data-setting-id=\\"agents.syncAgentRename\\"]')?.textContent||''");
 ok(copy.includes('/rename renombra la consola')&&!/[\\u2013\\u2014]/.test(copy),'toggle copy in Spanish, no dashes',copy);
 await shot('agents-toggles');
 ok(await js("smoke.click('agents.syncAgentRename')"),'the toggle is clickable');await frames();
 ok(await js("smoke.app().settings.agents.syncAgentRename")===false,'clicking it turns agents.syncAgentRename off');
 await js("smoke.fire({title:'Apagado'})");await frames();
 ok(await js("smoke.title('pa')")==='Foo','with the setting off the console keeps its name');
 ok(await js("smoke.click('agents.shellAgentDetect')"),'the shell toggle is clickable');await frames();
 ok(await js("smoke.app().settings.agents.shellAgentDetect")===false,'clicking it turns agents.shellAgentDetect off');

 if(failures.length)throw new Error(failures.join('\\n'));
 console.log('PASS: '+checks+' agent rename UI checks (rename, toast, stale pty, initial vs manual, toggles); screenshots '+__dirname);w.destroy();app.quit();
}).catch(e=>{console.error(e);app.exit(1)});
`)
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
const res = spawnSync(require('electron'), [path.join(dir, 'main.cjs')], { env, windowsHide: true, encoding: 'utf8', timeout: 90000 })
process.stdout.write(res.stdout ?? ''); if (res.status !== 0) process.stderr.write((res.stderr ?? '') + (res.error ? String(res.error) : ''))
process.exitCode = res.status ?? 1
