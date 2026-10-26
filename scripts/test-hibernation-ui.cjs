// Hibernation, agents board and cache timer UI (E5-FR-25..28) from the
// production PaneCell, Sidebar, AgentsBoard, AgentsSection, scheduler, phone
// executor and global keys in an isolated hidden Electron window: the
// sleeping overlay and its wakes (click, Enter, phone restartPane resume:true,
// a schedule 30 s away whose prompt waits for the resumed agent), what the
// renderer pushes to main, the moon on the sidebar row, the cache chip in the
// header and on the row, the board (Ctrl+Shift+A, columns, arrows, Enter, Esc)
// and the Settings rows. Consoles stay unmounted (ensureMounted is a no-op
// here) and every pty call is a stub: no pty, user config or agent is touched.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path')
const { pathToFileURL } = require('node:url')
const { spawnSync } = require('node:child_process')
const { buildSync } = require('esbuild')
const root = path.resolve(__dirname, '..'), dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snagentsos-hibernation-ui-'))
const assets = path.join(root, 'out/renderer/assets')
const css = fs.existsSync(assets) && fs.readdirSync(assets).find(f => /^index-.*\.css$/.test(f))
if (!css) throw new Error('Run npm run build first')
buildSync({ stdin: { contents: `
import React from 'react'; import {createRoot} from 'react-dom/client';
import {PaneCell} from './src/renderer/components/layout/PaneCell';
import {Sidebar} from './src/renderer/components/sidebar/Sidebar';
import {AgentsBoard} from './src/renderer/components/agents/AgentsBoard';
import {AgentsSection} from './src/renderer/components/settings/sections/AgentsSection';
import {I18nProvider} from './src/renderer/i18n';
import {useAppStore} from './src/renderer/lib/store';
import {useAgentStore} from './src/renderer/lib/agentStore';
import {useGlobalKeys} from './src/renderer/lib/useGlobalKeys';
import {initHibernation, isWaking} from './src/renderer/lib/hibernation';
import {schedulerTick} from './src/renderer/lib/usePaneScheduler';
import {initRemoteCommands} from './src/renderer/lib/remoteCommands';
import {registerPty} from './src/renderer/lib/ptyRegistry';
import {applyTheme} from './src/renderer/themes/applyTheme';
window.log={pushes:[],kills:[],submits:[],results:[]};
const cbs={hibernate:[],ready:[],command:[]};
window.snApi={platform:'win32',
 agents:{forget(){},list:async()=>[],startup:async()=>({trigger:null,interrupted:[]}),startupPending:async()=>[],consumeStartup:async()=>false,onChanged:()=>()=>{},
  onReady:(cb)=>{cbs.ready.push(cb);return()=>{}},setHibernation:(cfg)=>window.log.pushes.push(cfg),onHibernate:(cb)=>{cbs.hibernate.push(cb);return()=>{}}},
 pty:{kill:async()=>{},killPanes:async(ids)=>{window.log.kills.push(ids.join());return ids.length},write(){},submit:async(req)=>{window.log.submits.push(req);return {ok:true}},onPromptResult:()=>()=>{}},
 remote:{onCommand:(cb)=>{cbs.command.push(cb);return()=>{}},commandResult:(r)=>window.log.results.push(r)},
 status:{},config:{save(){}},app:{info:async()=>null}};
const now=Date.now(), M=60000;
const preset={id:'pc',name:'Claude Code',type:'claude',command:'claude',args:[],color:'#d97757',icon:'claude'};
const pane=(id,title,extra)=>({id,type:'claude',presetId:'pc',title,color:'#d97757',icon:'claude',...extra});
const w1={id:'w1',name:'Uno',cwd:'C:/uno',panes:[pane('a1','Front'),pane('a2','Minimizada')],layout:{grid:2,order:['a1','a2']}};
const w2={id:'w2',name:'Dos',cwd:'C:/dos',panes:[pane('b1','Dormilona'),pane('b2','Revisor'),{id:'b3',type:'shell',title:'Shell',color:'#888',icon:'terminal'}],layout:{grid:3,order:['b1','b2','b3']}};
const st=(state,ago,extra)=>({state,precise:true,provider:'claude',stateSince:now-ago*M,updatedAt:now,...extra});
const s0=useAppStore.getState();
useAppStore.setState({hydrated:true,presets:[preset],workspaces:[w1,w2],activeWorkspaceId:'w1',minimized:{w1:['a2']},mountedWorkspaces:{w1:'full'},
 paneStatus:{a1:st('working',1),a2:st('action',3,{reason:'permission'}),b2:st('done',2,{lastMessage:'Listo el fix'})},
 settings:{...s0.settings,language:'es',notifications:{...s0.settings.notifications,hooksEnabled:true}},
 // Consoles never mount here: the wake path still kills, bumps the epoch and sets the intent.
 ensureMounted:()=>{}});
// setActive would also mount the workspace: keep only the switch.
useAppStore.setState({setActive:(id)=>useAppStore.setState({activeWorkspaceId:id})});
const noop=()=>{};
const cell=(w,p,i)=><PaneCell key={p.id} workspace={w} pane={p} presets={[preset]} workspaceActive={false} maximizedId={null} minimizedIds={[]} index={i} isDragging={false} draggable={false} onToggleMax={noop} onToggleMin={noop} onClose={noop} onDragStartCell={noop} onDragEnterCell={noop} onDragEndCell={noop}/>;
function Keys(){useGlobalKeys();return null}
function Root(){
 const ws=useAppStore((s)=>s.workspaces.find((w)=>w.id==='w2'));
 return <div style={{height:'100vh'}} className="flex bg-bg-primary text-text-primary"><Keys/><Sidebar/>
  <main className="relative min-w-0 flex-1"><div style={{display:'grid',gridTemplateColumns:'repeat(3,minmax(0,1fr))',gap:6,padding:6,height:'60vh'}}>{ws.panes.map((p,i)=>cell(ws,p,i))}</div>
  <div id="settings" style={{height:'40vh',overflow:'auto',padding:8}}><AgentsSection/></div><AgentsBoard/></main></div>}
applyTheme('midnight');
initRemoteCommands();
initHibernation();
createRoot(document.getElementById('root')).render(<I18nProvider lang="es"><Root/></I18nProvider>);
window.smoke={theme:applyTheme,set:useAppStore.setState,app:useAppStore.getState,agents:useAgentStore.getState,setAgents:useAgentStore.setState,isWaking,schedulerTick,registerPty,
 hibernate:(evt)=>cbs.hibernate.forEach((cb)=>cb(evt)),ready:(evt)=>cbs.ready.forEach((cb)=>cb(evt)),command:(cmd)=>cbs.command.forEach((cb)=>cb(cmd)),
 key(sel,key,mods){const el=sel?document.querySelector(sel):document.body;if(el&&el.focus)el.focus();const e=new KeyboardEvent('keydown',{key,bubbles:true,cancelable:true,...(mods||{})});(el||document.body).dispatchEvent(e);return e.defaultPrevented},
 typeInto(sel,value){const i=document.querySelector(sel);i.focus();const set=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;set.call(i,value);i.dispatchEvent(new Event('input',{bubbles:true}))},
 now};
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
 const frames=()=>wait(80);
 let checks=0;const ok=(cond,what,data)=>{if(!cond)throw new Error(what+' '+JSON.stringify(data));checks++};

 // What the renderer tells main (agents:setHibernation).
 let pushes=await js('log.pushes');
 ok(pushes.length===1&&pushes[0].idleMinutes===0&&pushes[0].keep.join()==='a1','first push: off, only the visible console (the minimized one is not visible)',pushes);
 await js("smoke.set({settings:{...smoke.app().settings,hibernateIdleMinutes:30}})");
 await js("smoke.set({activeWorkspaceId:'w2'})");
 await js("smoke.set({activeWorkspaceId:'w1'})");
 pushes=await js('log.pushes');
 ok(pushes[1].idleMinutes===30&&pushes[1].keep.join()==='a1'&&pushes[2].keep.join()==='b1,b2,b3'&&pushes[3].keep.join()==='a1','pushes on the setting and on every visible-set change',pushes);
 await js("smoke.set({activeWorkspaceId:'w1'})");
 ok((await js('log.pushes')).length===4,'nothing changed: no push');

 // Main put b1 to sleep.
 await js("smoke.hibernate({paneId:'b1',at:smoke.now-2*3600000,idleMinutes:30})");await frames();
 let s=await js("({sleep:!!smoke.agents().sleeping.b1,kills:log.kills.slice(),overlay:document.querySelector('[data-pane-sleeping=b1]')?.textContent,btn:document.querySelector('[data-pane-sleeping=b1] [data-sleep-resume]')?.textContent,xterm:document.querySelectorAll('.xterm').length})");
 ok(s.sleep&&s.kills.join('|')==='b1','the event marks b1 asleep and drops its local pty binding',s);
 ok(s.overlay.includes('Durmiendo · el chat está guardado')&&s.overlay.includes('Se durmió tras 30 min inactivo (hace 2 h)')&&s.btn==='Retomar','overlay: title, why and when, [Retomar]',s);
 ok(s.xterm===0,'no terminal is mounted for a sleeping console');
 await js("smoke.hibernate({paneId:'ghost',at:smoke.now,idleMinutes:30})");
 ok(!(await js('!!smoke.agents().sleeping.ghost')),'an event for an unknown console is ignored');
 const row=await js("(()=>{const b=document.querySelector('[data-agent-row=b1]');return b&&{state:b.dataset.agentState,glyph:b.querySelector('[data-glyph]')?.dataset.glyph,text:b.textContent}})()");
 ok(row&&row.state==='sleeping'&&row.glyph==='sleeping'&&row.text.includes('Durmiendo · 2h'),'sidebar row: the moon and "Durmiendo · 2h"',row);
 await shot('sleeping-dark');

 // Wake 1: click [Retomar].
 await js("document.querySelector('[data-pane-sleeping=b1] [data-sleep-resume]').click()");await frames();
 s=await js("({sleep:!!smoke.agents().sleeping.b1,intent:smoke.agents().launchIntent.b1,epoch:smoke.app().paneEpoch.b1,kills:log.kills.slice(),overlay:!!document.querySelector('[data-pane-sleeping=b1]'),waking:smoke.isWaking('b1'),keep:log.pushes.at(-1).keep})");
 ok(!s.sleep&&!s.overlay&&s.intent==='resume'&&s.epoch===1&&s.kills.join('|')==='b1|b1','[Retomar] relaunches resuming the chat (intent resume, explicit kill, new mount)',s);
 ok(s.waking&&s.keep.includes('b1'),'a waking console is held and kept awake',s);
 await js("smoke.ready({paneId:'b1',sessionId:'x',phase:'idle'})");
 ok(!(await js("smoke.isWaking('b1')")),'the resumed agent reaching idle ends the hold');

 // Wake 2: Enter on the overlay.
 await js("smoke.hibernate({paneId:'b2',at:smoke.now,idleMinutes:30})");await frames();
 await js("smoke.key('[data-pane-sleeping=b2]','Enter')");await frames();
 s=await js("({sleep:!!smoke.agents().sleeping.b2,intent:smoke.agents().launchIntent.b2})");
 ok(!s.sleep&&s.intent==='resume','Enter on the overlay wakes it, resuming',s);
 await js("smoke.ready({paneId:'b2',sessionId:'x',phase:'idle'})");

 // Wake 3: the phone (restartPane resume:true).
 await js("smoke.setAgents({launchIntent:{}})");
 await js("smoke.hibernate({paneId:'b1',at:smoke.now,idleMinutes:30})");await frames();
 await js("smoke.command({id:'c1',action:{kind:'restartPane',workspaceId:'w2',paneId:'b1',resume:true}})");await frames();
 s=await js("({sleep:!!smoke.agents().sleeping.b1,intent:smoke.agents().launchIntent.b1,res:log.results.at(-1),waking:smoke.isWaking('b1')})");
 ok(!s.sleep&&s.intent==='resume'&&s.res.ok===true&&s.res.id==='c1','the phone\\'s "Relaunch resuming" wakes a sleeping console',s);
 ok(s.waking,'the phone wake holds scheduled prompts like the overlay',s);
 await js("smoke.ready({paneId:'b1',sessionId:'x',phase:'idle'})");

 // Wake 4: a schedule 30 s away; its prompt waits for the resumed agent.
 await js("smoke.setAgents({launchIntent:{}})");
 await js("smoke.hibernate({paneId:'b2',at:smoke.now,idleMinutes:30})");
 await js("smoke.set({workspaces:smoke.app().workspaces.map(w=>w.id!=='w2'?w:{...w,panes:w.panes.map(p=>p.id!=='b2'?p:{...p,schedules:[{id:'s1',time:'10:00',prompt:'hola',dueAt:smoke.now+10*60000,enabled:true}]})})})");
 await js("smoke.schedulerTick(smoke.now)");
 ok(await js("!!smoke.agents().sleeping.b2"),'a schedule 10 min away leaves it asleep');
 await js("smoke.set({workspaces:smoke.app().workspaces.map(w=>w.id!=='w2'?w:{...w,panes:w.panes.map(p=>p.id!=='b2'?p:{...p,schedules:[{...p.schedules[0],dueAt:smoke.now+20000}]})})})");
 await js("smoke.schedulerTick(smoke.now)");await frames();
 s=await js("({sleep:!!smoke.agents().sleeping.b2,intent:smoke.agents().launchIntent.b2,waking:smoke.isWaking('b2'),submits:log.submits.length})");
 ok(!s.sleep&&s.intent==='resume'&&s.waking&&s.submits===0,'a schedule 20 s away wakes it, resuming, and sends nothing yet',s);
 await js("smoke.registerPty('b2','pty-b2');smoke.set({paneStatus:{...smoke.app().paneStatus,b2:{state:'idle',precise:true,provider:'claude',stateSince:Date.now()}}})");
 await js("smoke.schedulerTick(smoke.now+25000)");
 ok((await js('log.submits.length'))===0,'due, live and idle, but still waking: the prompt waits');
 await js("smoke.ready({paneId:'b2',sessionId:'x',phase:'start'})");
 ok(await js("smoke.isWaking('b2')"),'a session start holds one more second');
 await wait(1200);
 ok(!(await js("smoke.isWaking('b2')")),'1 s after the start the hold ends');
 await js("smoke.schedulerTick(smoke.now+27000)");await wait(50);
 s=await js('log.submits.slice()');
 ok(s.length===1&&s[0].paneId==='b2'&&s[0].text==='hola'&&s[0].enter===true,'then the scheduled prompt goes, with Enter',s);
 await js("smoke.set({workspaces:smoke.app().workspaces.map(w=>w.id!=='w2'?w:{...w,panes:w.panes.map(p=>p.id!=='b2'?p:{...p,schedules:undefined})})})");

 // Cache timer chip (E5-FR-28): header and sidebar row.
 await js("smoke.set({paneStatus:{...smoke.app().paneStatus,b2:{state:'done',precise:true,provider:'claude',stateSince:Date.now()-60000,cacheSince:Date.now()-60000,lastMessage:'Listo el fix'}}})");await frames();
 ok(!(await js("!!document.querySelector('[data-cache-chip]')")),'timer off by default: no chip');
 await js("smoke.set({settings:{...smoke.app().settings,agents:{...smoke.app().settings.agents,cacheTimer:{enabled:true,ttlMinutes:5}}}})");await frames();
 s=await js("({header:document.querySelector('[data-pane-cell=b2] header [data-cache-chip]')?.textContent,state:document.querySelector('[data-pane-cell=b2] header [data-cache-chip]')?.dataset.cacheChip,row:document.querySelector('[data-agent-row=b2] [data-cache-chip]')?.textContent,rowText:document.querySelector('[data-agent-row=b2]')?.textContent})");
 ok(/^(4:00|3:59)$/.test(s.header)&&s.state==='ok','header chip counts from done (5 min TTL): "4:00"',s);
 ok(s.row===s.header&&!s.rowText.includes('hace'),'the sidebar row shows the same chip in place of the age',s);
 await js("smoke.set({paneStatus:{...smoke.app().paneStatus,b2:{...smoke.app().paneStatus.b2,cacheSince:Date.now()-(5*60000-30000)}}})");await frames();
 s=await js("({t:document.querySelector('[data-pane-cell=b2] header [data-cache-chip]')?.textContent,state:document.querySelector('[data-pane-cell=b2] header [data-cache-chip]')?.dataset.cacheChip})");
 ok(/^0:(30|29)$/.test(s.t)&&s.state==='warn','amber in the last minute',s);
 await shot('cache-chip-dark');
 await js("smoke.set({paneStatus:{...smoke.app().paneStatus,b2:{...smoke.app().paneStatus.b2,cacheSince:Date.now()-(5*60000-1500)}}})");await wait(2300);
 ok(!(await js("!!document.querySelector('[data-pane-cell=b2] header [data-cache-chip]')")),'gone at 0:00');
 await js("smoke.set({paneStatus:{...smoke.app().paneStatus,b2:{...smoke.app().paneStatus.b2,state:'working',cacheSince:undefined}}})");await frames();
 ok(!(await js("!!document.querySelector('[data-cache-chip]')")),'a new prompt (working) removes it');
 await js("smoke.set({paneStatus:{...smoke.app().paneStatus,b2:{state:'done',precise:true,provider:'claude',stateSince:Date.now()-60000,cacheSince:Date.now()-60000}}})");

 // Agents board (E5-FR-27).
 const epochs=await js('JSON.stringify(smoke.app().paneEpoch)');const killsBefore=await js('log.kills.length');
 await js("smoke.hibernate({paneId:'b1',at:smoke.now-3600000,idleMinutes:30})");await frames();
 const killsAfterSleep=await js('log.kills.length');
 ok(await js("smoke.key(null,'A',{ctrlKey:true,shiftKey:true})"),'Ctrl+Shift+A handled');await frames();
 let b=await js("(()=>{const r=document.querySelector('[data-agents-board]');if(!r)return null;return {cols:[...r.querySelectorAll('[data-board-column]')].map(c=>c.dataset.boardColumn),titles:[...r.querySelectorAll('[data-board-column] h3')].map(h=>h.textContent),cards:[...r.querySelectorAll('[data-board-card]')].map(c=>c.dataset.boardCard),idle:document.querySelector('[data-board-count=idle]').textContent,focused:document.activeElement?.dataset?.boardCard,cache:r.querySelector('[data-board-cache]')?.textContent}})()");
 ok(b&&b.cols.join()==='waiting,working,done,idle','four columns in order',b);
 ok(b.titles[0].startsWith('Te esperan')&&b.titles[1].startsWith('Trabajando')&&b.titles[2].startsWith('Listos')&&b.titles[3].startsWith('Inactivos'),'column titles in Spanish',b.titles);
 ok(b.cards.join()==='a2,a1,b2,b1'&&b.idle==='1','cards: action, working, done and the idle column expanded by default (the sleeping one)',b);
 ok(b.focused==='a2','the keyboard lands on the first card',b);
 ok(/^Caché (4:00|3:59)$/.test(b.cache),'header: the most urgent cache countdown',b);
 const card=await js("(()=>{const c=document.querySelector('[data-board-card=b2]');return {text:c.textContent,glyph:c.querySelector('[data-glyph]')?.dataset.glyph,ws:c.textContent.includes('Dos'),detail:c.querySelector('[data-board-detail]')?.textContent}})()");
 ok(card.ws&&card.detail.includes('Listo')&&card.glyph,'card: glyph, title, workspace and detail',card);
 ok(await js("!!document.querySelector('[data-board-card=b1][data-board-state=sleeping]')"),'Inactivos shows the sleeping console with its moon');
 await js("document.querySelector('[data-board-idle-toggle]').click()");await frames();
 ok(await js("!document.querySelector('[data-board-card=b1]')&&document.querySelector('[data-board-idle-toggle]').getAttribute('aria-expanded')==='false'"),'the toggle still collapses Inactivos');
 await js("document.querySelector('[data-board-idle-toggle]').click()");await frames();
 await js("smoke.key('[data-board-card=a2]','ArrowRight')");await frames();
 ok((await js('document.activeElement?.dataset?.boardCard'))==='a1','ArrowRight moves to the next column');
 await js("smoke.key('[data-board-card=a1]','ArrowRight')");await js("smoke.key('[data-board-card=b2]','ArrowRight')");await frames();
 ok((await js('document.activeElement?.dataset?.boardCard'))==='b1','into the expanded idle column');
 await js("smoke.key('[data-board-card=b1]','ArrowLeft')");await frames();
 ok((await js('document.activeElement?.dataset?.boardCard'))==='b2','ArrowLeft goes back');
 await shot('board-dark');
 await js("smoke.key('[data-board-card=b2]','Enter')");await js("document.activeElement?.click()");await frames();
 s=await js("({open:!!document.querySelector('[data-agents-board]'),view:smoke.agents().view,active:smoke.app().activeWorkspaceId})");
 ok(!s.open&&s.view==='grid'&&s.active==='w2','Enter on a card reveals its console and goes back to the grid',s);
 await js("document.querySelector('[data-agents-board-toggle]').click()");await frames();
 ok(await js("!!document.querySelector('[data-agents-board]')"),'the sidebar header button opens the board');
 await js("smoke.key('[data-agents-board]','Escape')");await frames();
 ok(!(await js("!!document.querySelector('[data-agents-board]')")),'Esc goes back to the grid');
 await js("smoke.key(null,'A',{ctrlKey:true,shiftKey:true})");await frames();
 await js("smoke.key(null,'A',{ctrlKey:true,shiftKey:true})");await frames();
 ok(!(await js("!!document.querySelector('[data-agents-board]')")),'Ctrl+Shift+A toggles it closed');
 ok((await js('JSON.stringify(smoke.app().paneEpoch)'))===epochs&&(await js('log.kills.length'))===killsAfterSleep&&killsAfterSleep===killsBefore+1,'the board never respawns or kills a terminal');

 // Settings rows (E5-FR-25/28).
 await js("smoke.set({settings:{...smoke.app().settings,hibernateIdleMinutes:0,agents:{...smoke.app().settings.agents,cacheTimer:{enabled:false,ttlMinutes:5}}}})");await frames();
 ok(await js("document.querySelector('[data-hibernate-minutes]').disabled"),'minutes field disabled while hibernation is off');
 await js("document.querySelector('[data-setting-id=\\"agents.hibernate\\"] [role=switch]').click()");await frames();
 ok((await js('smoke.app().settings.hibernateIdleMinutes'))===30,'turning it on proposes 30');
 await js("smoke.typeInto('[data-hibernate-minutes]','3')");
 ok((await js('smoke.app().settings.hibernateIdleMinutes'))===30,'typing does not commit mid-word');
 // A hidden window never owns the focus, so blur() fires nothing: send the focusout React listens to.
 await js("document.querySelector('[data-hibernate-minutes]').dispatchEvent(new FocusEvent('focusout',{bubbles:true}))");await frames();
 ok((await js('smoke.app().settings.hibernateIdleMinutes'))===5,'blur commits, clamped to 5');
 await js("smoke.typeInto('[data-hibernate-minutes]','2000')");await js("smoke.key('[data-hibernate-minutes]','Enter')");await frames();
 ok((await js('smoke.app().settings.hibernateIdleMinutes'))===1440,'Enter commits, clamped to 1440');
 await js("document.querySelector('[data-setting-id=\\"agents.hibernate\\"] [role=switch]').click()");await frames();
 ok((await js('smoke.app().settings.hibernateIdleMinutes'))===0,'turning it off stores 0');
 ok(await js("document.querySelector('[data-cache-ttl=\\"60\\"]').disabled"),'TTL disabled while the cache timer is off');
 await js("document.querySelector('[data-setting-id=\\"agents.cacheTimer\\"] [role=switch]').click()");await frames();
 await js("document.querySelector('[data-cache-ttl=\\"60\\"]').click()");await frames();
 s=await js('smoke.app().settings.agents.cacheTimer');
 ok(s.enabled===true&&s.ttlMinutes===60,'cache timer on with a 60 min TTL',s);

 for(const theme of ['midnight','light'])for(const scale of [1,1.25,1.5]){
  await js("smoke.theme('"+theme+"')");w.webContents.setZoomFactor(scale);await wait(150);
  await js("smoke.hibernate({paneId:'b1',at:smoke.now-3600000,idleMinutes:30})");
  await js("smoke.setAgents({view:'board'})");await wait(150);
  const fit=await js("document.documentElement.scrollWidth<=innerWidth&&[...document.querySelectorAll('[data-board-column]')].every(c=>c.getBoundingClientRect().right<=innerWidth+1)");
  ok(fit,'board fits at '+theme+' '+scale);
  if(scale===1.5)await shot('board-'+theme+'-150');
  await js("smoke.setAgents({view:'grid'})");await wait(100);
  const ov=await js("(()=>{const o=document.querySelector('[data-pane-sleeping=b1]');const r=o&&o.getBoundingClientRect();return !!o&&r.width>0&&o.scrollWidth<=o.clientWidth+1})()");
  ok(ov,'sleeping overlay fits its cell at '+theme+' '+scale);
  if(scale===1.5)await shot('sleeping-'+theme+'-150');
 }
 if(failures.length)throw new Error(failures.join('\\n'));
 console.log('PASS: '+checks+' hibernation UI checks (pushes to main, sleeping overlay, wake by click/Enter/phone/schedule with the prompt held until ready, moon row, cache chip header+row, board columns/keys/Enter/Esc, settings, dark/light 100-150%); screenshots '+__dirname);w.destroy();app.quit();
}).catch(e=>{console.error(e);app.exit(1)});
`)
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
const res = spawnSync(require('electron'), [path.join(dir, 'main.cjs')], { env, windowsHide: true, encoding: 'utf8', timeout: 120000 })
process.stdout.write(res.stdout ?? ''); if (res.status !== 0) process.stderr.write((res.stderr ?? '') + (res.error ? String(res.error) : ''))
process.exitCode = res.status ?? 1
