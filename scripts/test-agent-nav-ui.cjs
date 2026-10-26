// Agent navigation UI (E5-FR-15..20, E4-FR-10/11) rendered from the production
// Sidebar, CommandPalette, toast stack and global key handler in an isolated
// hidden Electron window: agent rows per state, "+N more", "Not started",
// the chevron, the palette's "Waiting for you" with Ctrl+1, next waiting,
// Ctrl+1..9 and its exclusions, reopen, focus next and the 200 ms tooltips.
// App 2.7.0 (A6): the badge, the palette and next waiting agree on one mixed
// fixture (src/shared/attention.ts), "Marcar todo leído" and palette ranking.
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
import {registerFocuser, getFocusedPane, setFocusedPane} from './src/renderer/lib/focus';
import {applyTheme} from './src/renderer/themes/applyTheme';
window.markReadLog=[];
window.snApi={platform:'win32',agents:{forget(){},list:async()=>[],startup:async()=>({trigger:null,interrupted:[]}),consumeStartup:async()=>false,onChanged:()=>()=>{},onReady:()=>()=>{}},status:{markRead:async id=>{window.markReadLog.push(id);return true}}};
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
 theme:applyTheme,set:useAppStore.setState,app:useAppStore.getState,agents:useAgentStore.getState,setAgents:useAgentStore.setState,toasts:()=>useToastStore.getState().items.map(t=>t.title),focused:getFocusedPane,setFocused:setFocusedPane,
 badges(){return [...document.querySelectorAll('aside nav [data-sidebar-ws]')].map(el=>el.dataset.sidebarWs+':'+(el.querySelector('[data-attention-badge]')?.dataset.attentionBadge??'0')).join()},
 palettePanes(){return [...document.querySelectorAll('[data-palette-pane]')].map(b=>b.dataset.palettePane)},
 query(q){const i=document.querySelector('.relative input');const set=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;set.call(i,q);i.dispatchEvent(new Event('input',{bubbles:true}))},
 wsMenu(wsId){const row=document.querySelector('[data-sidebar-ws='+wsId+'] button');row.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:120,clientY:120}))},
 menuItem(label){return [...document.querySelectorAll('[role=menu] [role=menuitem]')].find(b=>b.textContent===label)},
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
 // App 2.7.0: only who needs you (the shared rule): the open requests, then the unread done; a legacy error without attention is out.
 ok(pal.join()==='c1,a2,a3','palette lists the consoles that need you by urgency',pal);
 const hint=await js("document.querySelector('[data-palette-pane] kbd')?.textContent");
 ok(hint==='Ctrl+1','first row hints Ctrl+1',hint);
 const keyHint=await js("document.querySelector('[data-palette-cmd=next-waiting] kbd')?.textContent");
 ok(keyHint==='Ctrl + Shift + J','commands show their bound shortcut',keyHint);
 await js("smoke.set({paneStatus:{...smoke.app().paneStatus,a7:{...smoke.app().paneStatus.a7,state:'action',stateSince:Date.now()-3600000},a3:{...smoke.app().paneStatus.a3,state:'error'}}})");await frames();
 const frozen=await js("({ids:[...document.querySelectorAll('[data-palette-pane]')].map(b=>b.dataset.palettePane),glyph:document.querySelector('[data-palette-pane=a3] [data-glyph]')?.dataset.glyph})");
 ok(frozen.ids.join()==='c1,a2,a3'&&frozen.glyph==='error','order frozen while open (a new request is not added), glyph live',frozen);
 await js("smoke.set({paneStatus:{...smoke.app().paneStatus,a7:{...smoke.app().paneStatus.a7,state:'working',stateSince:Date.now()-30000},a3:{...smoke.app().paneStatus.a3,state:'done'}}})");await frames();
 await shot('palette-dark');
 await js("(()=>{const i=document.querySelector('[data-palette-waiting]').closest('.relative').querySelector('input');const set=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;set.call(i,'migrar');i.dispatchEvent(new Event('input',{bubbles:true}))})()");await frames();
 const found=await js("[...document.querySelectorAll('[data-palette-cmd]')].map(b=>b.dataset.paletteCmd)");
 ok(found[0]==='console-b1'&&!(await js("!!document.querySelector('[data-palette-waiting]')")),'a query finds a console by its topic and hides the waiting section',found);
 await js("(()=>{const i=document.querySelector('.relative input');const set=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;set.call(i,'mgrb');i.dispatchEvent(new Event('input',{bubbles:true}))})()");await frames();
 const scattered=await js("[...document.querySelectorAll('[data-palette-cmd]')].map(b=>b.dataset.paletteCmd)");
 ok(!scattered.includes('console-b1'),'topic and first prompt match as a substring, not as a scattered fuzzy subsequence',scattered);
 await js("(()=>{const i=document.querySelector('.relative input');const set=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;set.call(i,'');i.dispatchEvent(new Event('input',{bubbles:true}))})()");await frames();
 await js("window.focusLog=[]");
 await js("smoke.key('.relative input','1',{ctrlKey:true})");
 // focusPaneWhenReady waits for animation frames (slow while hidden).
 for(let i=0;i<40&&!(await js("window.focusLog.includes('c1')"));i++)await wait(100);
 let s=await js("({open:smoke.app().paletteOpen,active:smoke.app().activeWorkspaceId,log:window.focusLog,att:!!smoke.app().paneAttention.c1,focused:smoke.focused()})");
 ok(!s.open&&s.active==='wc'&&s.log.includes('c1')&&!s.att&&s.focused==='c1','Ctrl+1 in the palette reveals row 1 (workspace, focus, attention cleared)',s);

 // Next waiting (E5-FR-17; app 2.7.0 the shared rule): open requests then unread done, longest first; wraps.
 await js("smoke.set({paneAttention:{a3:true}})");
 const walk=[];
 for(let i=0;i<5;i++){await js("smoke.key(null,'J',{ctrlKey:true,shiftKey:true})");await wait(30);walk.push(await js('smoke.focused()'))}
 ok(walk.join()==='c1,a2,a3,c1,a2','Ctrl+Shift+J walks c1, a2, then the unread done a3 (the legacy error a4 is out), and wraps',walk);
 await wait(5100);
 // Open requests closed too: a legacy pendingCount (no attention field) still needs you, as the badge always counted it.
 const idle={};for(const [k,v] of Object.entries(await js('smoke.app().paneStatus')))idle[k]={...v,state:'idle',pendingCount:0};
 await js('smoke.set({paneStatus:'+JSON.stringify(idle)+',paneAttention:{}})');
 await js("smoke.key(null,'J',{ctrlKey:true,shiftKey:true})");await frames();
 const toasts=await js('smoke.toasts()');
 ok(toasts.includes('Ningún agente te espera')&&await js("!!document.querySelector('[aria-live]')"),'nobody waiting: toast in an aria-live stack',toasts);
 await js("smoke.set({paneStatus:"+JSON.stringify(Object.fromEntries(Object.entries(idle).map(([k,v])=>[k,{...v,state:'working'}])))+"})");

 // v2.3 attention: an action answered on any device (attention false) reads working and next waiting skips it.
 await wait(5100);
 await js("smoke.set({paneStatus:{...smoke.app().paneStatus,a2:{...smoke.app().paneStatus.a2,state:'action',attention:false},c1:{...smoke.app().paneStatus.c1,state:'action',attention:true}},paneAttention:{}})");await frames();
 ok(await js("document.querySelector('[data-agent-row=a2]')?.dataset.agentState")==='working','an answered action (attention false) shows the working glyph',await js('smoke.rows()'));
 ok(await js("document.querySelector('[data-agent-row=c1]')?.dataset.agentState")==='action','an action still waiting (attention true) keeps its glyph');
 await js("document.querySelector('aside [data-status-dot]').dispatchEvent(new MouseEvent('mouseover',{bubbles:true}))");await wait(260);
 const answeredTip=await js("document.querySelector('[role=tooltip] [data-workspace-tip]')?.textContent");
 ok(answeredTip&&!answeredTip.includes('esperando')&&answeredTip.includes('Consola a2 - Trabajando'),'the workspace tooltip counts and labels the answered action as working, like its dot',answeredTip);
 await js("document.querySelector('aside [data-status-dot]').dispatchEvent(new MouseEvent('mouseout',{bubbles:true}))");await wait(200);
 const walk2=[];
 for(let i=0;i<2;i++){await js("smoke.key(null,'J',{ctrlKey:true,shiftKey:true})");await wait(30);walk2.push(await js('smoke.focused()'))}
 ok(walk2.join()==='c1,c1','next waiting skips the answered action',walk2);
 await wait(5100);
 await js("smoke.set({paneStatus:{...smoke.app().paneStatus,a2:{...smoke.app().paneStatus.a2,state:'working',attention:false},c1:{...smoke.app().paneStatus.c1,state:'working',attention:false}}})");

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

 // v2.2.1: a Codex console with only its title (no bridge) keeps its row when its turn ends.
 await js("smoke.set({workspaces:[...smoke.app().workspaces,{id:'wd',name:'Delta',cwd:'C:/d',panes:[{id:'d1',type:'claude',presetId:'pc',title:'Claude Code',color:'#d97757',icon:'claude'},{id:'d2',type:'codex',title:'Codex',color:'#10a37f',icon:'openai'}]}],mountedWorkspaces:{...smoke.app().mountedWorkspaces,wd:'full'}})");
 await js("smoke.app().setPaneStatus({paneId:'d1',state:'idle',precise:true,provider:'claude',notify:false,pendingCount:0,updatedAt:Date.now(),stateSince:Date.now()})");
 await js("smoke.app().setPaneStatus({paneId:'d2',state:'working',precise:false,provider:'codex',notify:false,pendingCount:0,topic:'SnAgentsOS',updatedAt:Date.now(),stateSince:Date.now()})");await frames();
 ok(await js("document.querySelector('[data-agent-row=d2]')?.dataset.agentState")==='working','a title-only Codex track has a working row');
 await js("smoke.app().setPaneStatus({paneId:'d2',state:'done',precise:false,provider:'codex',notify:false,pendingCount:0,topic:'SnAgentsOS',updatedAt:Date.now(),stateSince:Date.now()})");await frames();
 const codexRow=await js("({state:document.querySelector('[data-agent-row=d2]')?.dataset.agentState,claude:!!document.querySelector('[data-agent-row=d1]')})");
 ok(codexRow.state==='done'&&codexRow.claude,'its done turn keeps the Codex row next to the Claude one',codexRow);
 await js("smoke.set({workspaces:smoke.app().workspaces.filter(w=>w.id!=='wd'),mountedWorkspaces:Object.fromEntries(Object.entries(smoke.app().mountedWorkspaces).filter(([k])=>k!=='wd'))})");await frames();

 // App 2.7.0 (A6): one rule for "te necesita". Mixed fixture: needs on a working a1 (asked 40 min ago),
 // open requests c1 and a2, an unseen done a3, a muted error a4 (main sends a muted console with attention
 // false), a plain shell b2 that sent a notice; out: a4 (muted), b1 (marked but never started), a8 (marked
 // but asleep), a seen done c2.
 const fix={a1:{state:'working',attention:false,needs:{text:'Aprobá el deploy',at:'40'}},a2:{state:'action',attention:true,since:10},a3:{state:'done',attention:true,since:3},a4:{state:'error',attention:false,muted:true,since:1},a5:{state:'idle',attention:false},a6:{state:'unknown'},a7:{state:'working',attention:false},a8:{state:'idle',attention:false},c1:{state:'action',attention:true,since:30},c2:{state:'done',attention:false,since:5}};
 await js("(()=>{const now=Date.now(),M=60000,fix="+JSON.stringify(fix)+";const ps={};for(const [id,f] of Object.entries(fix)){const {since,needs,...rest}=f;ps[id]={precise:true,provider:'claude',updatedAt:now,stateSince:now-(since??1)*M,...rest,...(needs?{needs:{text:needs.text,at:now-Number(needs.at)*M}}:{})}}smoke.set({activeWorkspaceId:'wa',paneStatus:ps,paneAttention:{b1:true,b2:true,a8:true},mountedWorkspaces:{wa:'full',wb:['b2'],wc:'full'},minimized:{},maximized:{}});smoke.setAgents({sleeping:{a8:{at:now-90*M}}});smoke.setFocused('a5','wa')})()");await frames();
 const mixedBadges=await js('smoke.badges()');
 ok(mixedBadges==='wa:3,wb:1,wc:1','mixed: the sidebar badges count a1, a2, a3 / the marked shell b2 / c1 (muted, asleep, not started and seen are out)',mixedBadges);
 ok(await js("smoke.key(null,'k',{ctrlKey:true})"),'Ctrl+K handled (mixed)');await frames();
 const mixedPal=await js('smoke.palettePanes()');
 ok(mixedPal.join()==='a1,c1,a2,a3,b2','mixed: the palette lists the same consoles, needs first (aged from the ask), then requests oldest first, the unseen done, the shell',mixedPal);
 const mixedRows=await js("({a1:document.querySelector('[data-palette-pane=a1]')?.textContent,b2:document.querySelector('[data-palette-pane=b2]')?.textContent,b2glyph:!!document.querySelector('[data-palette-pane=b2] [data-attention-notice]')&&!document.querySelector('[data-palette-pane=b2] [data-glyph]'),a1glyph:document.querySelector('[data-palette-pane=a1] [data-glyph]')?.dataset.glyph})");
 ok(mixedRows.a1.includes('Te necesita: Aprobá el deploy')&&/(39|40)m/.test(mixedRows.a1)&&mixedRows.a1glyph==='working','mixed: the needs row says what the agent asked, aged from the ask, with the live working glyph',mixedRows);
 ok(mixedRows.b2.includes('Te mandó un aviso')&&mixedRows.b2glyph,'mixed: the shell row reads as a notice with a bell, no agent glyph',mixedRows);
 await shot('palette-needs-dark');
 await js("smoke.key('.relative input','Escape')");await frames();
 ok(!(await js('smoke.app().paletteOpen')),'Escape closes the palette');
 const mixedWalk=[];
 for(let i=0;i<6;i++){await js("smoke.key(null,'J',{ctrlKey:true,shiftKey:true})");await wait(30);mixedWalk.push(await js('smoke.focused()'))}
 ok(mixedWalk.join()==='a1,c1,a2,a3,b2,a1','mixed: Ctrl+Shift+J walks the palette order and wraps',mixedWalk);

 // Workspace menu "Marcar todo leído": markRead for every done and error console (the muted a4 included), local marks cleared.
 await js("smoke.set({paneAttention:{...smoke.app().paneAttention,a5:true}})");await frames();
 ok(await js('smoke.badges()')==='wa:4,wb:0,wc:1','a marked idle console counts (wa:4; revealing b2 cleared its mark)',await js('smoke.badges()'));
 await js("smoke.wsMenu('wa')");await frames();
 const markItem=await js("(()=>{const b=smoke.menuItem('Marcar todo leído');return b?{disabled:b.getAttribute('aria-disabled')}:null})()");
 ok(markItem&&markItem.disabled===null,'the workspace menu offers "Marcar todo leído"',markItem);
 await js("window.markReadLog=[];smoke.menuItem('Marcar todo leído').click()");await frames();
 const marked=await js("({log:window.markReadLog.join(),att:Object.keys(smoke.app().paneAttention).filter(id=>id.startsWith('a')).join(),menu:!!document.querySelector('[role=menu]'),badges:smoke.badges()})");
 ok(marked.log==='a3,a4'&&marked.att===''&&!marked.menu,'"Marcar todo leído" calls markRead for the done a3 and the muted error a4 (attention false) only and clears the marks of the workspace',marked);
 ok(marked.badges==='wa:3,wb:0,wc:1','without the local mark wa counts its own three again (main acknowledges a3 itself)',marked.badges);
 await js("smoke.set({paneStatus:{...smoke.app().paneStatus,c2:{...smoke.app().paneStatus.c2,attention:false}}})");
 await js("smoke.wsMenu('wc')");await frames();
 const wcItem=await js("(()=>{const b=smoke.menuItem('Marcar todo leído');return b?{disabled:b.getAttribute('aria-disabled'),title:b.title}:null})()");
 ok(wcItem&&wcItem.disabled==='true'&&wcItem.title==='No hay nada sin leer en este workspace','with nothing unread the item is disabled and says why',wcItem);
 await js("window.markReadLog=[];smoke.menuItem('Marcar todo leído').click()");await frames();
 ok(await js("window.markReadLog.length===0&&!!document.querySelector('[role=menu]')"),'a disabled item does nothing and keeps the menu open');
 await js("window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}))");await frames();
 ok(!(await js("!!document.querySelector('[role=menu]')")),'Escape closes the workspace menu');

 // A "Te esperan" row with a tool open says what the console is doing now (rowPhrase), like its sidebar row and board card.
 await js("smoke.set({paneAttention:{...smoke.app().paneAttention,a7:true},paneStatus:{...smoke.app().paneStatus,a7:{...smoke.app().paneStatus.a7,activity:'Edit a.ts',toolFamily:'edit',detail:{kind:'tool',text:'Edit a.ts'}}}})");await frames();
 ok(await js("smoke.key(null,'k',{ctrlKey:true})"),'Ctrl+K handled (doing now)');await frames();
 const doingRow=await js("document.querySelector('[data-palette-pane=a7]')?.textContent??''");
 ok(doingRow.includes('Editando a.ts'),'a waiting row with a tool open reads "Editando a.ts"',doingRow);
 await js("smoke.key('.relative input','Escape')");await frames();
 await js("(()=>{const ps={...smoke.app().paneStatus};const {activity,toolFamily,detail,...rest}=ps.a7;ps.a7=rest;const att={...smoke.app().paneAttention};delete att.a7;smoke.set({paneStatus:ps,paneAttention:att})})()");await frames();

 // Palette ranking (app 2.7.0, rankList): exact, then word prefix, substring, subsequence (4+ letters); accents and case ignored; ties keep the list order.
 await js("smoke.set({workspaces:[...smoke.app().workspaces,{id:'n4',name:'Subnube',cwd:'',panes:[]},{id:'n5',name:'Nuevo bebé',cwd:'',panes:[]},{id:'n3',name:'Mi nube',cwd:'',panes:[]},{id:'n1',name:'Nube',cwd:'',panes:[]},{id:'n2',name:'Nube privada',cwd:'',panes:[]}]})");await frames();
 ok(await js("smoke.key(null,'k',{ctrlKey:true})"),'Ctrl+K handled (ranking)');await frames();
 const ranked=async q=>{await js('smoke.query('+JSON.stringify(q)+')');await frames();return js("[...document.querySelectorAll('[data-palette-cmd]')].map(b=>b.dataset.paletteCmd)")};
 let hits=await ranked('nube');
 ok(hits[0]==='ws-n1'&&hits.filter(id=>/^ws-n\\d$/.test(id)).join()==='ws-n1,ws-n3,ws-n2,ws-n4,ws-n5','ranked: Nube (exact), Mi nube and Nube privada (word prefix, list order), Subnube (substring), Nuevo bebé (subsequence)',hits);
 hits=await ranked('NÚBE');
 ok(hits.filter(id=>/^ws-n\\d$/.test(id)).join()==='ws-n1,ws-n3,ws-n2,ws-n4,ws-n5','ranked: case and accents do not matter',hits);
 hits=await ranked('nbe');
 ok(!hits.includes('ws-n5')&&!hits.includes('ws-n1'),'ranked: a 3 letter term never matches as a scattered subsequence',hits);
 // A bare status (a snaos needs on a shell with no agent) has no agent state: no glyph on its console row.
 await js("smoke.set({paneStatus:{...smoke.app().paneStatus,b2:{state:'idle',precise:false,pendingCount:0,attention:true,bare:true,updatedAt:Date.now(),stateSince:Date.now(),needs:{text:'Revisá el log',at:Date.now()}}}})");await frames();
 hits=await ranked('shell');
 const bareRow=await js("({row:!!document.querySelector('[data-palette-cmd=console-b2]'),glyph:!!document.querySelector('[data-palette-cmd=console-b2] [data-glyph]')})");
 ok(bareRow.row&&!bareRow.glyph,'ranked: the console row of a bare needs status shows no agent glyph',{hits,bareRow});
 await js("smoke.key('.relative input','Escape')");await frames();
 await js("(()=>{const ps={...smoke.app().paneStatus};delete ps.b2;smoke.set({workspaces:smoke.app().workspaces.filter(w=>!/^n\\d$/.test(w.id)),paneAttention:{},paneStatus:ps});smoke.setAgents({sleeping:{}})})()");await frames();

 for(const theme of ['midnight','light'])for(const scale of [1,1.25,1.5]){
  await js("smoke.theme('"+theme+"')");w.setSize(900,600);w.webContents.setZoomFactor(scale);await wait(200);
  const fit=await js("[...document.querySelectorAll('[data-agent-row]')].every(b=>{const r=b.getBoundingClientRect(),a=document.querySelector('aside').getBoundingClientRect();return r.right<=a.right+1&&r.left>=a.left-1})&&document.documentElement.scrollWidth<=innerWidth");
  ok(fit,'rows fit the sidebar at '+theme+' '+scale);
  if(scale===1.5)await shot('rows-'+theme+'-150');
 }
 if(failures.length)throw new Error(failures.join('\\n'));
 console.log('PASS: '+checks+' agent navigation UI checks (rows per state, +N, not started, chevron, palette Ctrl+1, next waiting, one needs-you rule for badge, palette and next waiting, mark all read, palette doing now, palette ranking, Ctrl+1..9 rules, reopen, focus next, 200 ms tooltips, dark/light 100-150%); screenshots '+__dirname);w.destroy();app.quit();
}).catch(e=>{console.error(e);app.exit(1)});
`)
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
const res = spawnSync(require('electron'), [path.join(dir, 'main.cjs')], { env, windowsHide: true, encoding: 'utf8', timeout: 90000 })
process.stdout.write(res.stdout ?? ''); if (res.status !== 0) process.stderr.write((res.stderr ?? '') + (res.error ? String(res.error) : ''))
process.exitCode = res.status ?? 1
