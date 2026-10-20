// Render the production components in an isolated hidden Electron window.
// No user config, real terminal or external notification service is touched.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path')
const { pathToFileURL } = require('node:url')
const { spawnSync } = require('node:child_process')
const { buildSync } = require('esbuild')
const root = path.resolve(__dirname, '..'), dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snagentsos-ui-'))
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
import {useUsageStore} from './src/renderer/lib/usageStore';
window.snApi={status:{hooksStatus:async()=>({installed:false,settingsPath:'test/settings.json'}),health:async()=>({claude:{installed:false},codex:{enabled:false,available:true,connected:0},discord:{lastSuccessAt:null,error:null,queued:0}}),testDiscord:async()=>({ok:true})}};
const states=['working','action','done','error','unknown','idle'];
useAppStore.setState({hydrated:true,activeWorkspaceId:'ws-1',workspaces:states.map((state,i)=>({id:'ws-'+i,name:i===1?'Proyecto con nombre muy largo para probar truncado y acciones':'Workspace '+i,cwd:'',panes:[{id:'pane-'+i,type:'shell',title:'Console '+i,icon:'terminal'}]})),paneStatus:Object.fromEntries(states.map((state,i)=>['pane-'+i,{state,precise:true,provider:i%2?'claude':'codex',pendingCount:state==='action'?2:0}])),paneAttention:{'pane-1':true}});
applyTheme('midnight');
createRoot(document.getElementById('root')).render(<I18nProvider lang="es"><div style={{height:'100vh'}} className="flex bg-bg-primary text-text-primary"><Sidebar/><main className="p-6">Prueba de luces de estado</main><div style={{position:'fixed',right:0,bottom:0}}><Tooltip label="Nombre largo para probar que el tooltip se ajusta al borde de la ventana sin cortar el texto"><button id="edge-tooltip">i</button></Tooltip></div><SettingsModal/></div></I18nProvider>);
window.smoke={set:useAppStore.setState,theme:applyTheme,open:()=>useAppStore.getState().openSettings('notifications'),
 // v2.2.1: the remote indicator and a folded Usage panel (Claude 0% / 95%, Codex 0%).
 usage:()=>{useAppStore.setState(s=>({settings:{...s.settings,remote:{...s.settings.remote,enabled:true},usage:{...s.settings.usage,enabled:true,collapsed:true}}}));useUsageStore.setState({snapshot:{updatedAt:Date.now(),rows:[{id:'claude.5h',provider:'claude',kind:'5h',label:'5h',percent:0,status:'ok'},{id:'claude.7d',provider:'claude',kind:'7d',label:'7d',percent:95,status:'ok'},{id:'codex.7d',provider:'codex',kind:'7d',label:'7d',percent:0,status:'ok'}]}})},
 folded:()=>{const rows=[...document.querySelectorAll('[data-usage-folded] [data-usage-row]')];return{rows:rows.length,rings:document.querySelectorAll('[data-usage-folded] [data-usage-ring]').length,each:rows.map(r=>{const b=r.getBoundingClientRect(),v=r.querySelector('[data-usage-value]'),f=r.querySelector('[data-usage-fill]');return{id:r.dataset.usageRow,h:b.height,icon:!!r.querySelector('svg'),track:f?f.parentElement.getBoundingClientRect().width:0,value:v?v.textContent:'',color:v?getComputedStyle(v).color:'',clipped:r.scrollWidth>r.clientWidth}}),overflow:document.documentElement.scrollWidth>innerWidth}},
 rail:()=>{const aside=document.querySelector('aside').getBoundingClientRect(),axis=aside.left+document.querySelector('aside').clientWidth/2;const off=e=>{if(!e)return null;const r=e.getBoundingClientRect();return Math.abs(r.left+r.width/2-axis)};return{rings:document.querySelectorAll('[data-usage-rail] [data-usage-ring]').length,remote:off(document.querySelector('[data-remote-indicator]')),newBtn:off(document.querySelector('[data-sidebar-new] svg')),settings:off(document.querySelector('[data-sidebar-settings] svg')),
  dots:[...document.querySelectorAll('aside nav [data-rail-status]')].map(el=>{const d=el.getBoundingClientRect(),i=el.parentElement.querySelector('svg').getBoundingClientRect(),b=el.closest('button').getBoundingClientRect();return{clear:d.left>=i.right-1,inside:d.left>=b.left&&d.right<=b.right&&d.top>=b.top&&d.bottom<=b.bottom,bg:getComputedStyle(el).backgroundColor}})}}};
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
 let checks=await w.webContents.executeJavaScript("({dots:document.querySelectorAll('aside [data-status-dot]').length,rows:[...document.querySelectorAll('[data-agent-row]')].map(r=>r.dataset.agentState).join(),overflow:document.documentElement.scrollWidth>innerWidth})");
 if(checks.dots!==6||checks.overflow)throw new Error('Sidebar layout '+JSON.stringify(checks));
 if(checks.rows!=='working,action,done,error,unknown,idle')throw new Error('One agent row per state '+JSON.stringify(checks));
 await w.webContents.executeJavaScript("document.querySelector('aside [data-status-dot]').dispatchEvent(new MouseEvent('mouseover',{bubbles:true}))");await new Promise(r=>setTimeout(r,280));
 const dotTip=await w.webContents.executeJavaScript("document.querySelector('[role=tooltip]')?.textContent||''");
 if(!dotTip.includes('Console 0 - Trabajando'))throw new Error('Status dot tooltip within 300 ms '+JSON.stringify(dotTip));
 await w.webContents.executeJavaScript("document.querySelector('aside [data-status-dot]').dispatchEvent(new MouseEvent('mouseout',{bubbles:true}))");await new Promise(r=>setTimeout(r,250));
 // Folded Usage (v2.2.1): one compact line per metric (icon, label, bar, percent), no rings; high values in the bar's red.
 await w.webContents.executeJavaScript('smoke.usage()');await new Promise(r=>setTimeout(r,300));await shot('usage-folded');
 const folded=await w.webContents.executeJavaScript('smoke.folded()');
 if(folded.rows!==3||folded.rings!==0||folded.overflow)throw new Error('Folded usage is a compact list '+JSON.stringify(folded));
 for(const r of folded.each)if(!r.icon||r.track<20||r.h>22||r.clipped)throw new Error('Compact usage row '+JSON.stringify(r));
 const hot=folded.each.find(r=>r.id==='claude.7d'),cold=folded.each.find(r=>r.id==='claude.5h');
 if(hot.value!=='95%'||hot.color!=='rgb(239, 68, 68)'||cold.color==='rgb(239, 68, 68)')throw new Error('95% reads red, 0% does not '+JSON.stringify(folded.each));
 await w.webContents.executeJavaScript('smoke.set({sidebarCollapsed:true})');await new Promise(r=>setTimeout(r,300));await shot('sidebar-collapsed');
 // Collapsed rail (v2.2.1): rings stay, the phone sits on the rail's axis, and the status dot sits beside the icon without a backing disc.
 const rail=await w.webContents.executeJavaScript('smoke.rail()');
 if(rail.rings!==3)throw new Error('Rail usage rings '+JSON.stringify(rail));
 if(rail.remote===null||rail.remote>1||rail.newBtn>1||rail.settings>1)throw new Error('Rail items centered '+JSON.stringify(rail));
 if(rail.dots.length!==6||rail.dots.some(d=>!d.clear||!d.inside||d.bg!=='rgba(0, 0, 0, 0)'))throw new Error('Rail status dots beside the icon, unclipped, transparent '+JSON.stringify(rail.dots));
 checks=await w.webContents.executeJavaScript("({dots:document.querySelectorAll('aside [data-status-dot]').length,rows:document.querySelectorAll('[data-agent-row]').length,buttons:[...document.querySelectorAll('aside nav button')].map(e=>e.getBoundingClientRect().width)})");
 if(checks.dots!==6||checks.rows!==0||checks.buttons.some(n=>n<30))throw new Error('Collapsed sidebar '+JSON.stringify(checks));
 await w.webContents.executeJavaScript("document.getElementById('edge-tooltip').dispatchEvent(new MouseEvent('mouseover',{bubbles:true}))");await new Promise(r=>setTimeout(r,500));
 const tipFits=await w.webContents.executeJavaScript("(()=>{const r=document.querySelector('[role=tooltip]')?.getBoundingClientRect();return r&&r.width>=200&&r.left>=7&&r.top>=7&&r.right<=innerWidth-7&&r.bottom<=innerHeight-7})()");await shot('tooltip-edge');if(!tipFits)throw new Error('Tooltip outside viewport '+await w.webContents.executeJavaScript("JSON.stringify({focused:document.activeElement.id,rect:document.querySelector('[role=tooltip]')?.getBoundingClientRect(),viewport:[innerWidth,innerHeight]})"));await w.webContents.executeJavaScript("document.getElementById('edge-tooltip').dispatchEvent(new MouseEvent('mouseout',{bubbles:true}))");
 await w.webContents.executeJavaScript('smoke.open()');await new Promise(r=>setTimeout(r,300));await shot('notifications');
 for(const scale of [1,1.25,1.5]){w.setSize(860,560);w.webContents.setZoomFactor(scale);await new Promise(r=>setTimeout(r,200));const overflow=await w.webContents.executeJavaScript('document.documentElement.scrollWidth>innerWidth');if(overflow)throw new Error('Viewport overflow at '+scale);if(scale===1.5)await shot('notifications-150')}
 w.webContents.setZoomFactor(1);w.setSize(1280,820);await w.webContents.executeJavaScript("smoke.theme('light');document.getElementById('discord-webhook').scrollIntoView({block:'center'})");await new Promise(r=>setTimeout(r,300));await shot('discord-light');
 if(failures.length)throw new Error(failures.join('\\n'));console.log('PASS: six sidebar lights and agent rows expanded/collapsed, folded usage list, centered rail phone, rail dots beside the icon, dot tooltip under 300 ms, settings at 100/125/150%, light/dark; screenshots '+__dirname);w.destroy();app.quit();
}).catch(e=>{console.error(e);app.exit(1)});
`)
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
const res = spawnSync(require('electron'), [path.join(dir, 'main.cjs')], { env, windowsHide: true, encoding: 'utf8', timeout: 30000 })
process.stdout.write(res.stdout ?? ''); if (res.status !== 0) process.stderr.write(res.stderr ?? '')
process.exitCode = res.status ?? 1
