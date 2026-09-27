// Render the production components in an isolated hidden Electron window.
// No user config, real terminal or external notification service is touched.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path')
const { pathToFileURL } = require('node:url')
const { spawnSync } = require('node:child_process')
const { buildSync } = require('esbuild')
const root = path.resolve(__dirname, '..'), dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snmulticc-ui-'))
const assets = path.join(root, 'out/renderer/assets')
const css = fs.readdirSync(assets).find(f => /^index-.*\.css$/.test(f))
if (!css) throw new Error('Run npm run build first')
buildSync({ stdin: { contents: `
import React from 'react'; import {createRoot} from 'react-dom/client';
import {Sidebar} from './src/renderer/components/sidebar/Sidebar';
import {SettingsModal} from './src/renderer/components/settings/SettingsModal';
import {I18nProvider} from './src/renderer/i18n';
import {useAppStore} from './src/renderer/lib/store';
import {applyTheme} from './src/renderer/themes/applyTheme';
import {Tooltip} from './src/renderer/components/ui/Tooltip';
window.snApi={status:{hooksStatus:async()=>({installed:false,settingsPath:'test/settings.json'}),health:async()=>({claude:{installed:false},codex:{enabled:false,available:true,connected:0},discord:{lastSuccessAt:null,error:null,queued:0}}),testDiscord:async()=>({ok:true})}};
const states=['working','action','done','error','unknown','idle'];
useAppStore.setState({hydrated:true,activeWorkspaceId:'ws-1',workspaces:states.map((state,i)=>({id:'ws-'+i,name:i===1?'Proyecto con nombre muy largo para probar truncado y acciones':'Workspace '+i,cwd:'',panes:[{id:'pane-'+i,type:'shell',title:'Console '+i,icon:'terminal'}]})),paneStatus:Object.fromEntries(states.map((state,i)=>['pane-'+i,{state,precise:true,provider:i%2?'claude':'codex',pendingCount:state==='action'?2:0}])),paneAttention:{'pane-1':true}});
applyTheme('midnight');
createRoot(document.getElementById('root')).render(<I18nProvider lang="es"><div style={{height:'100vh'}} className="flex bg-bg-primary text-text-primary"><Sidebar/><main className="p-6">Prueba de luces de estado</main><div style={{position:'fixed',right:0,bottom:0}}><Tooltip label="Nombre largo para probar que el tooltip se ajusta al borde de la ventana sin cortar el texto"><button id="edge-tooltip">i</button></Tooltip></div><SettingsModal/></div></I18nProvider>);
window.smoke={set:useAppStore.setState,theme:applyTheme,open:()=>useAppStore.getState().openSettings('notifications')};
`, resolveDir: root, loader: 'tsx' }, bundle: true, platform: 'browser', format: 'iife', outfile: path.join(dir, 'renderer.js'), alias: { '@shared': path.join(root, 'src/shared'), '@': path.join(root, 'src/renderer') }, jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' } })
fs.writeFileSync(path.join(dir, 'index.html'), `<html><head><meta charset="utf-8"><link rel="stylesheet" href="${pathToFileURL(path.join(assets, css))}"></head><body><div id="root"></div><script src="renderer.js"></script></body></html>`)
fs.writeFileSync(path.join(dir, 'main.cjs'), `
const {app,BrowserWindow}=require('electron');const fs=require('fs'),path=require('path');
app.setPath('userData',path.join(__dirname,'profile'));
app.whenReady().then(async()=>{
 const w=new BrowserWindow({width:1280,height:820,show:false,webPreferences:{sandbox:true,backgroundThrottling:false}});
 let failures=[];w.webContents.on('console-message',(_e,level,message)=>{if(level>=3)failures.push(message)});
 await w.loadFile(path.join(__dirname,'index.html'));await new Promise(r=>setTimeout(r,400));
 const shot=async name=>{await w.webContents.executeJavaScript('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');await new Promise(r=>setTimeout(r,200));fs.writeFileSync(path.join(__dirname,name+'.png'),(await w.webContents.capturePage()).toPNG())};
 await shot('sidebar');
 let checks=await w.webContents.executeJavaScript("({dots:document.querySelectorAll('aside [role=img]').length,overflow:document.documentElement.scrollWidth>innerWidth})");
 if(checks.dots!==6||checks.overflow)throw new Error('Sidebar layout '+JSON.stringify(checks));
 await w.webContents.executeJavaScript('smoke.set({sidebarCollapsed:true})');await new Promise(r=>setTimeout(r,300));await shot('sidebar-collapsed');
 checks=await w.webContents.executeJavaScript("({dots:document.querySelectorAll('aside [role=img]').length,buttons:[...document.querySelectorAll('aside nav button')].map(e=>e.getBoundingClientRect().width)})");
 if(checks.dots!==6||checks.buttons.some(n=>n<30))throw new Error('Collapsed sidebar '+JSON.stringify(checks));
 await w.webContents.executeJavaScript("document.getElementById('edge-tooltip').dispatchEvent(new MouseEvent('mouseover',{bubbles:true}))");await new Promise(r=>setTimeout(r,500));
 const tipFits=await w.webContents.executeJavaScript("(()=>{const r=document.querySelector('[role=tooltip]')?.getBoundingClientRect();return r&&r.width>=200&&r.left>=7&&r.top>=7&&r.right<=innerWidth-7&&r.bottom<=innerHeight-7})()");await shot('tooltip-edge');if(!tipFits)throw new Error('Tooltip outside viewport '+await w.webContents.executeJavaScript("JSON.stringify({focused:document.activeElement.id,rect:document.querySelector('[role=tooltip]')?.getBoundingClientRect(),viewport:[innerWidth,innerHeight]})"));await w.webContents.executeJavaScript("document.getElementById('edge-tooltip').dispatchEvent(new MouseEvent('mouseout',{bubbles:true}))");
 await w.webContents.executeJavaScript('smoke.open()');await new Promise(r=>setTimeout(r,300));await shot('notifications');
 for(const scale of [1,1.25,1.5]){w.setSize(860,560);w.webContents.setZoomFactor(scale);await new Promise(r=>setTimeout(r,200));const overflow=await w.webContents.executeJavaScript('document.documentElement.scrollWidth>innerWidth');if(overflow)throw new Error('Viewport overflow at '+scale);if(scale===1.5)await shot('notifications-150')}
 w.webContents.setZoomFactor(1);w.setSize(1280,820);await w.webContents.executeJavaScript("smoke.theme('light');document.getElementById('discord-webhook').scrollIntoView({block:'center'})");await new Promise(r=>setTimeout(r,300));await shot('discord-light');
 if(failures.length)throw new Error(failures.join('\\n'));console.log('PASS: six sidebar lights expanded/collapsed, settings at 100/125/150%, light/dark; screenshots '+__dirname);w.destroy();app.quit();
}).catch(e=>{console.error(e);app.exit(1)});
`)
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
const res = spawnSync(require('electron'), [path.join(dir, 'main.cjs')], { env, windowsHide: true, encoding: 'utf8', timeout: 30000 })
process.stdout.write(res.stdout ?? ''); if (res.status !== 0) process.stderr.write(res.stderr ?? '')
process.exitCode = res.status ?? 1
