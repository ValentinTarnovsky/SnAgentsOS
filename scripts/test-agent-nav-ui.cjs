// Agent navigation UI (E5-FR-15..20, E4-FR-10/11) rendered from the production
// Sidebar, CommandPalette, toast stack and global key handler in an isolated
// hidden Electron window: agent rows per state, "+N more", "Not started",
// the chevron, the palette's "Waiting for you" with Ctrl+1, next waiting,
// Ctrl+1..9 and its exclusions, reopen, focus next and the 200 ms tooltips.
// Consoles are never mounted: fake focusers stand in for terminals, so no pty,
// user config or real agent is touched.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path')
const { pathToFileURL } = require('node:url')
const { spawnSync } = require('node:child_process')
const { buildSync } = require('esbuild')
const root = path.resolve(__dirname, '..'), dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snagentsos-nav-ui-'))
const assets = path.join(root, 'out/renderer/assets')
const css = fs.readdirSync(assets).find(f => /^index-.*\.css$/.test(f))
if (!css) throw new Error('Run npm run build first')
buildSync({ stdin: { contents: `
import React from 'react'; import {createRoot} from 'react-dom/client';
import {Sidebar} from './src/renderer/components/sidebar/Sidebar';
import {CommandPalette} from './src/renderer/components/ui/CommandPalette';
import {NotificationStack} from './src/renderer/components/ui/NotificationStack';
import {I18nProvider} from './src/renderer/i18n';
import {useAppStore} from './src/renderer/lib/store';
import {useAgentStore} from './src/renderer/lib/agentStore';
import {useToastStore} from './src/renderer/lib/toast';
import {useGlobalKeys} from './src/renderer/lib/useGlobalKeys';
import {registerFocuser, getFocusedPane} from './src/renderer/lib/focus';
import {applyTheme} from './src/renderer/themes/applyTheme';
window.snApi={platform:'win32',agents:{forget(){},list:async()=>[],startup:async()=>({trigger:null,interrupted:[]}),consumeStartup:async()=>false,onChanged:()=>()=>{},onReady:()=>()=>{}},status:{}};
const now=Date.now(), M=60000;
const preset={id:'pc',name:'Claude Code',type:'claude',command:'claude',args:[],color:'#d97757',icon:'claude'};
const pane=(id,title)=>({id,type:'claude',presetId:'pc',title:title??'Claude Code',color:'#d97757',icon:'claude'});
const wa={id:'wa',name:'Alfa',cwd:'C:/a',panes:['a1','a2','a3','a4','a5','a6','a7','a8'].map(id=>pane(id,id==='a1'?undefined:'Consola '+id)),layout:{grid:8,order:['a1','a2','a3','a4','a5','a6','a7','a8']}};
const wb={id:'wb',name:'Beta',cwd:'C:/b',panes:[pane('b1'),{id:'b2',type:'shell',title:'Shell',color:'#888',icon:'terminal'}]};
const wc={id:'wc',name:'Gamma con un nombre bastante largo para truncar',cwd:'C:/c',panes:[pane('c1','Consola c1'),pane('c2','Consola c2')]};
const st=(state,ago,extra)=>({state,precise:true,provider:'claude',stateSince:ago===null?undefined:now-ago,updatedAt:now,...extra});
const statuses={
 a1:st('working',1*M,{topic:'Arreglar login',detail:{kind:'tool',text:'Edit useXterm.ts'}}),
 a2:st('action',10*M,{reason:'question',detail:{kind:'question',text:'Sigo con el plan?'},pendingCount:2}),
 a3:st('done',3*M,{lastMessage:'Listo el fix del login'}),
 a4:st('error',1*M),a5:st('idle',12*M),a6:st('unknown',null,{updatedAt:now-60*M}),a7:st('working',30000),a8:st('idle',20*M),
 c1:st('action',30*M,{reason:'permission',detail:{kind:'permission',text:'Bash: npm test'}}),c2:st('done',5*M,{lastMessage:'Hecho'})};
const s0=useAppStore.getState();
useAppStore.setState({hydrated:true,presets:[preset],workspaces:[wa,wb,wc],activeWorkspaceId:'wa',mountedWorkspaces:{wa:'full',wc:'full'},paneStatus:statuses,paneAttention:{a3:true,a2:true,c1:true},settings:{...s0.settings,language:'es',notifications:{...s0.settings.notifications,hooksEnabled:true}}});
useAgentStore.setState({sessions:{b1:{paneId:'b1',provider:'claude',sessionId:'0b7c2f4e-1a2b-4c3d-8e9f-0123456789ab',spawnCwd:'C:/b',topic:'Migrar la base',activity:'idle',updatedAt:now-2*3600000,available:true}},closedStack:[{workspaceId:'wa',pane:pane('z1','Cerrada'),orderIndex:1}]});
window.focusLog=[];
for(const id of ['a1','a2','a3','a4','a5','a6','a7','a8','b1','b2','c1','c2','z1'])registerFocuser(id,()=>window.focusLog.push(id));
applyTheme('midnight');
function Keys(){useGlobalKeys();return null}
createRoot(document.getElementById('root')).render(<I18nProvider lang="es"><div style={{height:'100vh'}} className="flex bg-bg-primary text-text-primary"><Keys/><Sidebar/><main className="flex-1 p-6"><textarea id="ta" className="h-24 w-64 border border-border bg-card"/></main><CommandPalette/><NotificationStack/></div></I18nProvider>);
window.smoke={
 theme:applyTheme,set:useAppStore.setState,app:useAppStore.getState,agents:useAgentStore.getState,toasts:()=>useToastStore.getState().items.map(t=>t.title),focused:getFocusedPane,
 key(sel,key,mods){const el=sel?document.querySelector(sel):document.body;if(el&&el.focus)el.focus();const e=new KeyboardEvent('keydown',{key,bubbles:true,cancelable:true,...(mods||{})});(el||document.body).dispatchEvent(e);return e.defaultPrevented},
 rows(wsId){const box=[...document.querySelectorAll('[data-agent-rows]')];return [...document.querySelectorAll('[data-agent-row]')].map(b=>({id:b.dataset.agentRow,state:b.dataset.agentState,glyph:b.querySelector('[data-glyph]')?.dataset.glyph,text:b.textContent,bold:!!b.querySelector('.font-semibold')}))},
};
`, resolveDir: root, loader: 'tsx' }, bundle: true, platform: 'browser', format: 'iife', outfile: path.join(dir, 'renderer.js'), alias: { '@shared': path.join(root, 'src/shared'), '@': path.join(root, 'src/renderer') }, jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' } })
fs.writeFileSync(path.join(dir, 'index.html'), `<html><head><meta charset="utf-8"><link rel="stylesheet" href="${pathToFileURL(path.join(assets, css))}"></head><body><div id="root"></div><script src="renderer.js"></script></body></html>`)
fs.writeFileSync(path.join(dir, 'main.cjs'), `
const {app,BrowserWindow}=require('electron');const fs=require('fs'),path=require('path');
app.setPath('userData',path.join(__dirname,'profile'));
const wait=ms=>new Promise(r=>setTimeout(r,ms));
app.whenReady().then(async()=>{
 const w=new BrowserWindow({width:1280,height:900,show:false,webPreferences:{sandbox:true,backgroundThrottling:false}});
 let failures=[];w.webContents.on('console-message',(_e,level,message)=>{if(level>=3)failures.push(message)});
 await w.loadFile(path.join(__dirname,'index.html'));await wait(400);
 const js=c=>w.webContents.executeJavaScript(c);
 const shot=async name=>{await js('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');await wait(150);fs.writeFileSync(path.join(__dirname,name+'.png'),(await w.webContents.capturePage()).toPNG())};
 // rAF runs at about 1 fps in a hidden window: React commits synchronously here, so a short wait is enough.
 const frames=()=>wait(80);
 const fail=(what,data)=>{throw new Error(what+' '+JSON.stringify(data))};
 const T0=Date.now();let checks=0;const ok=(cond,what,data)=>{if(!cond)fail(what,data);checks++;if(process.env.NAV_UI_TRACE)console.log((Date.now()-T0)+' ok '+what)};

 // Agent rows (E5-FR-19/20).
 let rows=await js('smoke.rows()');
 const ids=rows.map(r=>r.id);
 ok(ids.slice(0,6).join()==='a1,a2,a3,a4,a5,a7','8 agents: the 6 most urgent in layout order',ids);
 const more=await js("document.querySelector('[data-agent-rows-more]')?.textContent");
 ok(more==='+2 más','"+2 más" under the workspace',more);
 ok(ids.includes('b1')&&rows.find(r=>r.id==='b1').text.includes('Sin iniciar · se retoma al abrir')&&rows.find(r=>r.id==='b1').glyph==='notStarted','unmounted record shows "Sin iniciar · se retoma al abrir" with the dotted ring',rows.find(r=>r.id==='b1'));
 ok(rows.find(r=>r.id==='b1').text.includes('Migrar la base'),'not started row titled by its topic',rows.find(r=>r.id==='b1'));
 ok(!ids.includes('b2'),'a plain shell has no row',ids);
 const g=Object.fromEntries(rows.map(r=>[r.id,r.glyph]));
 ok(g.a1==='working'&&g.a2==='action'&&g.a3==='done-unread'&&g.a4==='error'&&g.a5==='idle'&&g.c2==='done','one glyph per state (unread done check, seen done dot)',g);
 ok(rows.find(r=>r.id==='a1').text.startsWith('Arreglar login')&&rows.find(r=>r.id==='a1').text.includes('Edit useXterm.ts · 1m'),'topic as title and "detail · age"',rows.find(r=>r.id==='a1'));
 ok(rows.find(r=>r.id==='a2').text.includes('Pregunta: Sigo con el plan?')&&rows.find(r=>r.id==='c1').text.includes('Permiso: Bash: npm test'),'action phrases',rows.filter(r=>r.id==='a2'||r.id==='c1'));
 ok(rows.find(r=>r.id==='a3').text.includes('Listo: Listo el fix del login · hace 3m')&&rows.find(r=>r.id==='a3').bold&&!rows.find(r=>r.id==='a5').bold,'done phrase and bold while unread',rows.find(r=>r.id==='a3'));
 const labels=await js("[...document.querySelectorAll('[data-agent-row] [data-glyph]')].every(e=>e.getAttribute('role')==='img'&&e.getAttribute('aria-label'))");
 ok(labels,'every glyph has role img and an aria-label');
 const h=await js("Math.round(document.querySelector('[data-agent-row]').getBoundingClientRect().height)");
 ok(h===36,'rows are 36 px',h);
 await shot('rows-dark');
 await js("document.querySelector('[data-agent-rows-more]').click()");await frames();
 rows=await js('smoke.rows()');
 ok(rows.filter(r=>r.id.startsWith('a')).length===8&&await js("document.querySelector('[data-agent-rows-more]').textContent")==='Mostrar menos','"+N más" expands to every agent',rows.map(r=>r.id));
 await js("document.querySelector('[data-agent-rows-more]').click()");await frames();

 // Tooltips at 200 ms (E4-FR-10, E5-FR-20).
 await js("document.querySelector('[data-agent-row=a2]').dispatchEvent(new MouseEvent('mouseover',{bubbles:true}))");
 await wait(110);
 ok(!(await js("!!document.querySelector('[role=tooltip]')")),'no tooltip before the delay');
 await wait(150);
 const rowTip=await js("document.querySelector('[role=tooltip]')?.textContent");
 ok(rowTip&&rowTip.includes('Pregunta: Sigo con el plan?'),'row tooltip within 300 ms',rowTip);
 await js("document.querySelector('[data-agent-row=a2]').dispatchEvent(new MouseEvent('mouseout',{bubbles:true}))");await wait(200);
 await js("document.querySelector('aside [data-status-dot]').dispatchEvent(new MouseEvent('mouseover',{bubbles:true}))");await wait(260);
 const dotTip=await js("({ws:!!document.querySelector('[role=tooltip] [data-workspace-tip]'),text:document.querySelector('[role=tooltip] [data-workspace-tip]')?.textContent})");
 ok(dotTip.ws&&dotTip.text.includes('esperando')&&dotTip.text.includes('Consola a2 - Requiere tu intervención - hace 10 min'),'expanded dot: combined tooltip with summary and per-console lines within 300 ms',dotTip);
 await js("document.querySelector('aside [data-status-dot]').dispatchEvent(new MouseEvent('mouseout',{bubbles:true}))");await wait(200);
 ok(!(await js("[...document.querySelectorAll('aside [data-status-dot]')].some(e=>e.hasAttribute('title'))")),'no native title on status dots');

 // Chevron folds the rows of one workspace and persists on the workspace.
 await js("document.querySelector('[data-agents-chevron=wc]').click()");await frames();
 ok(await js("smoke.app().workspaces.find(w=>w.id==='wc').agentsCollapsed===true&&!document.querySelector('[data-agent-row=c1]')"),'chevron collapses wc and stores agentsCollapsed');
 await js("document.querySelector('[data-agents-chevron=wc]').click()");await frames();
 ok(await js("smoke.app().workspaces.find(w=>w.id==='wc').agentsCollapsed===undefined&&!!document.querySelector('[data-agent-row=c1]')"),'chevron expands it again');

 // Palette "Te esperan" (E5-FR-15/16) and Ctrl+1.
 ok(await js("smoke.key(null,'k',{ctrlKey:true})"),'Ctrl+K handled');await frames();
 const pal=await js("[...document.querySelectorAll('[data-palette-pane]')].map(b=>b.dataset.palettePane)");
 ok(pal.join()==='c1,a2,a4,a3,c2,a7','palette lists at most 6 by urgency',pal);
 const hint=await js("document.querySelector('[data-palette-pane] kbd')?.textContent");
 ok(hint==='Ctrl+1','first row hints Ctrl+1',hint);
 const keyHint=await js("document.querySelector('[data-palette-cmd=next-waiting] kbd')?.textContent");
 ok(keyHint==='Ctrl + Shift + J','commands show their bound shortcut',keyHint);
 await js("smoke.set({paneStatus:{...smoke.app().paneStatus,a7:{...smoke.app().paneStatus.a7,state:'action',stateSince:Date.now()-3600000}}})");await frames();
 const frozen=await js("({ids:[...document.querySelectorAll('[data-palette-pane]')].map(b=>b.dataset.palettePane),glyph:document.querySelector('[data-palette-pane=a7] [data-glyph]')?.dataset.glyph})");
 ok(frozen.ids.join()==='c1,a2,a4,a3,c2,a7'&&frozen.glyph==='action','order frozen while open, glyph live',frozen);
 await js("smoke.set({paneStatus:{...smoke.app().paneStatus,a7:{...smoke.app().paneStatus.a7,state:'working',stateSince:Date.now()-30000}}})");await frames();
 await shot('palette-dark');
 await js("(()=>{const i=document.querySelector('[data-palette-waiting]').closest('.relative').querySelector('input');const set=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;set.call(i,'migrar');i.dispatchEvent(new Event('input',{bubbles:true}))})()");await frames();
 const found=await js("[...document.querySelectorAll('[data-palette-cmd]')].map(b=>b.dataset.paletteCmd)");
 ok(found[0]==='console-b1'&&!(await js("!!document.querySelector('[data-palette-waiting]')")),'a query finds a console by its topic and hides the waiting section',found);
 await js("(()=>{const i=document.querySelector('[data-palette-cmd]').closest('.relative').querySelector('input');const set=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;set.call(i,'');i.dispatchEvent(new Event('input',{bubbles:true}))})()");await frames();
 await js("window.focusLog=[]");
 await js("smoke.key('.relative input','1',{ctrlKey:true})");
 // focusPaneWhenReady waits for animation frames (slow while hidden).
 for(let i=0;i<40&&!(await js("window.focusLog.includes('c1')"));i++)await wait(100);
 let s=await js("({open:smoke.app().paletteOpen,active:smoke.app().activeWorkspaceId,log:window.focusLog,att:!!smoke.app().paneAttention.c1,focused:smoke.focused()})");
 ok(!s.open&&s.active==='wc'&&s.log.includes('c1')&&!s.att&&s.focused==='c1','Ctrl+1 in the palette reveals row 1 (workspace, focus, attention cleared)',s);

 // Next waiting (E5-FR-17): action/error then unread done, longest first; wraps.
 await js("smoke.set({paneAttention:{a3:true}})");
 const walk=[];
 for(let i=0;i<5;i++){await js("smoke.key(null,'J',{ctrlKey:true,shiftKey:true})");await wait(30);walk.push(await js('smoke.focused()'))}
 ok(walk.join()==='c1,a2,a4,a3,c1','Ctrl+Shift+J walks c1, a2, a4, then the unread done a3, and wraps',walk);
 await wait(5100);
 const idle={};for(const [k,v] of Object.entries(await js('smoke.app().paneStatus')))idle[k]={...v,state:'idle'};
 await js('smoke.set({paneStatus:'+JSON.stringify(idle)+',paneAttention:{}})');
 await js("smoke.key(null,'J',{ctrlKey:true,shiftKey:true})");await frames();
 const toasts=await js('smoke.toasts()');
 ok(toasts.includes('Ningún agente te espera')&&await js("!!document.querySelector('[aria-live]')"),'nobody waiting: toast in an aria-live stack',toasts);
 await js("smoke.set({paneStatus:"+JSON.stringify(Object.fromEntries(Object.entries(idle).map(([k,v])=>[k,{...v,state:'working'}])))+"})");

 // Ctrl+1..9 (E5-FR-18) and its exclusions.
 await js("smoke.set({activeWorkspaceId:'wa'})");await frames();
 let prevented=await js("smoke.key(null,'3',{ctrlKey:true})");await frames();
 ok(prevented&&await js('smoke.focused()')==='a3','Ctrl+3 focuses the third visible console',await js('smoke.focused()'));
 prevented=await js("smoke.key('#ta','2',{ctrlKey:true})");await frames();
 ok(!prevented&&await js('smoke.focused()')==='a3','Ctrl+2 inside a textarea does not act');
 await js('smoke.set({settingsOpen:true})');prevented=await js("smoke.key(null,'2',{ctrlKey:true})");await js('smoke.set({settingsOpen:false})');
 ok(!prevented&&await js('smoke.focused()')==='a3','Ctrl+2 with settings open does not move focus');
 await js("smoke.set({settings:{...smoke.app().settings,agents:{...smoke.app().settings.agents,ctrlDigitFocus:false}}})");
 prevented=await js("smoke.key(null,'2',{ctrlKey:true})");
 ok(!prevented&&await js('smoke.focused()')==='a3','ctrlDigitFocus off: Ctrl+2 reaches the terminal');
 await js("smoke.set({settings:{...smoke.app().settings,agents:{...smoke.app().settings.agents,ctrlDigitFocus:true}}})");
 await js("smoke.set({minimized:{wa:['a1']}})");
 await js("smoke.key(null,'1',{ctrlKey:true})");await frames();
 ok(await js('smoke.focused()')==='a2','minimized consoles are skipped (Ctrl+1 = a2)',await js('smoke.focused()'));
 await js("smoke.key(null,'ArrowRight',{ctrlKey:true,altKey:true})");await frames();
 ok(await js('smoke.focused()')==='a3','Ctrl+Alt+Right focuses the next console',await js('smoke.focused()'));
 await js("smoke.key(null,'ArrowLeft',{ctrlKey:true,altKey:true})");await js("smoke.key(null,'ArrowLeft',{ctrlKey:true,altKey:true})");await frames();
 ok(await js('smoke.focused()')==='a8','Ctrl+Alt+Left wraps past the minimized first console',await js('smoke.focused()'));
 await js('smoke.set({minimized:{}})');

 // Reopen closed (E5-FR-14 key): not inside a text field, yes elsewhere.
 prevented=await js("smoke.key('#ta','U',{ctrlKey:true,shiftKey:true})");
 ok(!prevented&&!(await js("smoke.app().workspaces.find(w=>w.id==='wa').panes.some(p=>p.id==='z1')")),'Ctrl+Shift+U inside a textarea stays the field\\'s');
 await js("smoke.key(null,'U',{ctrlKey:true,shiftKey:true})");await frames();
 ok(await js("smoke.app().workspaces.find(w=>w.id==='wa').layout.order[1]==='z1'"),'Ctrl+Shift+U reopens the closed console in its place');

 // Collapsed sidebar: no rows, one combined row tooltip with the name.
 await js('smoke.set({sidebarCollapsed:true})');await wait(250);
 ok(!(await js("!!document.querySelector('[data-agent-row]')")),'collapsed sidebar has no agent rows');
 await js("document.querySelector('aside nav button').dispatchEvent(new MouseEvent('mouseover',{bubbles:true}))");await wait(260);
 const colTip=await js("document.querySelector('[role=tooltip] [data-workspace-tip]')?.textContent");
 ok(colTip&&colTip.startsWith('Alfa')&&colTip.includes('trabajando'),'collapsed row tooltip: name, summary and consoles within 300 ms',colTip);
 await js("document.querySelector('aside nav button').dispatchEvent(new MouseEvent('mouseout',{bubbles:true}))");
 await js('smoke.set({sidebarCollapsed:false})');await wait(250);
 await js("smoke.set({settings:{...smoke.app().settings,agents:{...smoke.app().settings.agents,sidebarAgentRows:false}}})");await frames();
 ok(!(await js("!!document.querySelector('[data-agent-row]')")),'sidebarAgentRows off hides the rows');
 await js("smoke.set({settings:{...smoke.app().settings,agents:{...smoke.app().settings.agents,sidebarAgentRows:true}}})");

 for(const theme of ['midnight','light'])for(const scale of [1,1.25,1.5]){
  await js("smoke.theme('"+theme+"')");w.setSize(900,600);w.webContents.setZoomFactor(scale);await wait(200);
  const fit=await js("[...document.querySelectorAll('[data-agent-row]')].every(b=>{const r=b.getBoundingClientRect(),a=document.querySelector('aside').getBoundingClientRect();return r.right<=a.right+1&&r.left>=a.left-1})&&document.documentElement.scrollWidth<=innerWidth");
  ok(fit,'rows fit the sidebar at '+theme+' '+scale);
  if(scale===1.5)await shot('rows-'+theme+'-150');
 }
 if(failures.length)throw new Error(failures.join('\\n'));
 console.log('PASS: '+checks+' agent navigation UI checks (rows per state, +N, not started, chevron, palette Ctrl+1, next waiting, Ctrl+1..9 rules, reopen, focus next, 200 ms tooltips, dark/light 100-150%); screenshots '+__dirname);w.destroy();app.quit();
}).catch(e=>{console.error(e);app.exit(1)});
`)
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
const res = spawnSync(require('electron'), [path.join(dir, 'main.cjs')], { env, windowsHide: true, encoding: 'utf8', timeout: 90000 })
process.stdout.write(res.stdout ?? ''); if (res.status !== 0) process.stderr.write((res.stderr ?? '') + (res.error ? String(res.error) : ''))
process.exitCode = res.status ?? 1
