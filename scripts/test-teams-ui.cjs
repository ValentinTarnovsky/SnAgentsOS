// Teams on the desktop (app 2.7.0, E10), part 1 (B1): the sidebar section, the
// Ctrl+Shift+O shortcut, the palette entries and the overlay host, rendered
// from the production Sidebar, WorkspaceHost (one local console), TeamHost,
// AgentsBoard, CommandPalette, useGlobalKeys, useStatusEvents and teamsStore
// in an isolated hidden Electron window with a fake window.snApi (teams.req
// included). Checks: with Labs teams off nothing renders, the renderer never
// asks main and Ctrl+Shift+O is not eaten (it reaches the console); with the
// lab on (after main answered `disabled` once, the config save race) the rows,
// the needs badge (not data-attention-badge), the running glyph and the shield
// show; the palette entries; a row opens the host with 3 tabs (ARIA, the tab
// remembered per team), the definition summary, pty.setActive([]) and
// status.setViewed([]); Ctrl+Shift+T adds no pane and Ctrl+1 focuses no
// console under it; Esc closes it and the panes come back; Alt+1, a workspace
// row and the agents board close it; closing it over a shared view keeps that
// view; the trust banner and chip on `changed`; a UNC repo path refused with
// its reason; definition warnings (a
// misnamed file, the Codex allowlist) in the warning style, also on a trusted
// team, with file names escaped; no "Abrir carpeta" on a link or io load
// error; the reveal toast on `not_found` and `io` (catalog words, never the
// system reason); the refetch policy (debounce,
// an older rev dropped, a same-rev trust flip refetched, task scope with ids,
// teams not open only react to list); `disabled` from main and Labs off close it; the
// picker; Esc typed where the focus is (after a picker click, a card, Reintentar,
// the kebab menu, the remove confirm, the focus on body) and the keyboard back on
// the host; remove; zoom 1 / 1.25 / 1.5 without overflow; es/en; no console
// error and no en or em dash. No pty, user config or real main is touched.
// Requires npm run build (for the CSS).
const fs = require('node:fs'), os = require('node:os'), path = require('node:path')
const { pathToFileURL } = require('node:url')
const { spawnSync } = require('node:child_process')
const { buildSync } = require('esbuild')
const root = path.resolve(__dirname, '..'), dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snagentsos-teams-ui-'))
const assets = path.join(root, 'out/renderer/assets')
const css = fs.existsSync(assets) ? fs.readdirSync(assets).find(f => /^index-.*\.css$/.test(f)) : null
if (!css) throw new Error('Run npm run build first')
buildSync({ stdin: { contents: `
import React from 'react'; import {createRoot} from 'react-dom/client';
import {I18nProvider} from './src/renderer/i18n';
import {useAppStore} from './src/renderer/lib/store';
import {useAgentStore} from './src/renderer/lib/agentStore';
import {useGlobalKeys} from './src/renderer/lib/useGlobalKeys';
import {useStatusEvents} from './src/renderer/lib/useStatusEvents';
import {useTeamsStore, onTeamChanged, openTeams} from './src/renderer/lib/teamsStore';
import {startTeams} from './src/renderer/lib/teams/start';
import {visibleName} from './src/renderer/lib/teams/issues';
import {labOn} from './src/shared/labs';
import {Sidebar} from './src/renderer/components/sidebar/Sidebar';
import {WorkspaceHost} from './src/renderer/components/layout/WorkspaceHost';
import {SharedWorkspaceHost} from './src/renderer/components/share/SharedWorkspaceHost';
import {TeamHost} from './src/renderer/components/teams/TeamHost';
import {AgentsBoard} from './src/renderer/components/agents/AgentsBoard';
import {CommandPalette} from './src/renderer/components/ui/CommandPalette';
import {TeamSetupDialog} from './src/renderer/components/teams/TeamSetupDialog';
import {TeamTrustDialog} from './src/renderer/components/teams/TeamTrustDialog';
import {NotificationStack} from './src/renderer/components/ui/NotificationStack';
import {applyTheme} from './src/renderer/themes/applyTheme';
import {initShareGuest, useShareGuestStore} from './src/renderer/lib/shareGuestStore';
import {onPaneFocusRequest, setFocusedPane} from './src/renderer/lib/focus';
const calls={spawn:[],setActive:[],viewed:[],req:[],save:[],focusReq:[]};
onPaneFocusRequest(id=>calls.focusReq.push(id));
const subs={changed:new Set()};
const noop=()=>()=>{};
const fallback=(base)=>new Proxy(base,{get:(t,k)=>k in t?t[k]:(typeof k==='string'?fallback(noop):undefined)});
const TA='tm-aaaaaaaaaaaa', TB='tm-bbbbbbbbbbbb';
const item=(id,name,extra)=>({id,name,repoName:name.toLowerCase()+'-repo',trust:'trusted',paused:null,autoDispatch:false,agents:5,running:0,needsCount:0,rev:1,repoRoot:'C:/repos/'+name.toLowerCase(),takeovers:[],...(extra||{})});
const ROLES=[
 {id:'lead',name:'Líder',kind:'lead',provider:'claude',model:'opus',effort:'high',permission:'readonly',count:1},
 {id:'dev',name:'Dev',kind:'dev',provider:'claude',model:'sonnet',effort:'medium',permission:'total',count:2},
 {id:'qa',name:'QA',kind:'qa',provider:'claude',model:'sonnet',permission:'readonly',count:1},
 {id:'research',name:'Investigación',kind:'research',provider:'codex',permission:'readonly',count:1}];
const viewOf=(it)=>({id:it.id,name:it.name,repoRoot:it.repoRoot,repoName:it.repoName,baseBranch:'main',extraRepos:[],goal:'Meta de '+it.name+': que el login ande con OAuth.',trust:it.trust,defIssues:it.issues||[],autoDispatch:false,paused:it.paused,maxConcurrent:2,maxRunMinutes:45,leadApprovesSmallPlans:true,verify:[{repoId:'main',command:'npm test',confirmed:false}],roles:ROLES,rev:it.rev,needsCount:it.needsCount,running:it.running,providerBlockedUntil:it.limit?{claude:Date.now()+3600000}:{}});
const fake={on:false,reveal:{ok:true},failGet:new Set(),teams:[item(TA,'Alfa',{running:1}),item(TB,'Beta',{trust:'changed',needsCount:1,rev:5,paused:{reason:'user',at:1},limit:true})]};
const areaEvents=[];
onTeamChanged(e=>areaEvents.push(e));
window.snApi=fallback({platform:'win32',filePath:()=>'',
 pty:fallback({reattach:async()=>null,spawn:async r=>{calls.spawn.push(r.paneId);return{ptyId:'pty-'+r.paneId,shellKind:'powershell'}},
  write(){},resize(){},setActive:ids=>calls.setActive.push(ids),flow(){},kill:async()=>{},killPanes:async()=>0,onData:noop,onExit:noop}),
 config:fallback({save:cfg=>{calls.save.push(1);return Promise.resolve()}}),
 status:fallback({snapshot:async()=>[],setViewed:ids=>calls.viewed.push(ids),markRead:async()=>true}),
 agents:fallback({list:async()=>[],startup:async()=>({trigger:null,interrupted:[]})}),
 share:{host:fallback({}),guest:fallback({links:async()=>({persisted:true,guestFingerprint:null,links:[],states:{}})})},
 teams:{
  req:async r=>{calls.req.push(r);if(!fake.on)return{ok:false,error:'disabled'};
   switch(r.op){
    case 'list':return{ok:true,teams:fake.teams.map(({limit,issues,...x})=>x)};
    case 'get':{if(fake.failGet.has(r.teamId))return{ok:false,error:'io'};const it=fake.teams.find(x=>x.id===r.teamId);return it?{ok:true,team:viewOf(it)}:{ok:false,error:'not_found'}}
    case 'trustDiff':return{ok:true,trust:{sha256:'ab'.repeat(32),approvedSha:'cd'.repeat(32),diff:{files:[],risks:[],truncated:false},issues:[]}};
    case 'remove':fake.teams=fake.teams.filter(x=>x.id!==r.teamId);return{ok:true};
    case 'reveal':return fake.reveal;
    default:return{ok:false,error:'unsupported'}}},
  onChanged:cb=>{subs.changed.add(cb);return()=>subs.changed.delete(cb)},onRunAppend:noop,onIntegrateProgress:noop},
});
const local={id:'local1',type:'shell',title:'Local',icon:'terminal',color:'#888'};
useAppStore.setState(s=>({hydrated:true,activeWorkspaceId:'w1',workspaces:[{id:'w1',name:'Mine',cwd:'C:/repo',panes:[local],layout:{grid:1,order:['local1']}},{id:'w2',name:'Other',cwd:'C:/other',panes:[{...local,id:'local2',title:'Other'}],layout:{grid:1,order:['local2']}}],settings:{...s.settings,language:'es',labs:{...s.settings.labs,teams:false}}}));
applyTheme('midnight');
// App.tsx's guest wiring: the shared view's overlay guard (it leaves on a local focus request).
initShareGuest();
const LINK={id:'L1',hostLabel:'Ana',hostFingerprint:'AB12-CD34-EF56-7890',scope:{kind:'workspace',label:'Repo de Ana'},permHint:'view',addedAt:1,persisted:true,rememberedPassword:false,status:'idle'};
function Keys(){useGlobalKeys();useStatusEvents();return null}
// App.tsx's wiring: startTeams for as long as the lab is on.
function TeamsWiring(){const on=useAppStore(s=>labOn(s.settings,'teams'));React.useEffect(()=>{if(!on)return;return startTeams()},[on]);return null}
function Root(){const [lang,setLang]=React.useState('es');window.smoke.setLang=setLang;
 return <I18nProvider lang={lang}><Keys/><TeamsWiring/><div style={{height:'100vh'}} className="flex w-full overflow-hidden bg-bg-primary text-text-primary">
  <Sidebar/>
  <main className="relative min-w-0 flex-1"><WorkspaceHost/><SharedWorkspaceHost/><TeamHost/><AgentsBoard/></main>
  <CommandPalette/><TeamSetupDialog/><TeamTrustDialog/>
 </div><NotificationStack/></I18nProvider>}
const seen=[];
window.addEventListener('keydown',e=>{if(e.key==='O')seen.push({prevented:e.defaultPrevented})});
const key=(target,o)=>{const ev=new KeyboardEvent('keydown',{bubbles:true,cancelable:true,...o});target.dispatchEvent(ev);return ev.defaultPrevented};
window.smoke={calls,fake,TA,TB,areaEvents,seen,item,
 app:()=>useAppStore.getState(),agents:()=>useAgentStore.getState(),teams:()=>useTeamsStore.getState(),
 labs:on=>useAppStore.setState(s=>({settings:{...s.settings,labs:{...s.settings.labs,teams:on}}})),
 collapse:on=>useAppStore.setState({sidebarCollapsed:on}),
 shared:on=>useShareGuestStore.setState(on?{links:{L1:LINK},activeLinkId:'L1'}:{activeLinkId:null,links:{}}),
 sharedActive:()=>useShareGuestStore.getState().activeLinkId,
 // A hidden window fires no focus events, so useXterm never records the console the user typed in.
 typedIn:(paneId,wsId)=>setFocusedPane(paneId,wsId),
 openTeams,visibleName,
 push:e=>subs.changed.forEach(cb=>cb(e)),
 gets:id=>calls.req.filter(r=>r.op==='get'&&r.teamId===id).length,
 lists:()=>calls.req.filter(r=>r.op==='list').length,
 has:sel=>!!document.querySelector(sel),count:sel=>document.querySelectorAll(sel).length,
 text:sel=>document.querySelector(sel)?.textContent||'',
 attr:(sel,a)=>document.querySelector(sel)?.getAttribute(a)??null,
 click:sel=>{const el=document.querySelector(sel);if(!el)throw new Error('missing '+sel);el.click()},
 // A real click focuses the button it lands on; el.click() alone does not.
 focusClick:sel=>{const el=document.querySelector(sel);if(!el)throw new Error('missing '+sel);el.focus();el.click()},
 blur:()=>document.activeElement?.blur?.(),
 activeIs:a=>!!document.activeElement?.hasAttribute?.(a),
 dropViews:()=>useTeamsStore.setState({views:{}}),
 cancelConfirm:()=>{const b=document.querySelector('[data-confirm]')?.previousElementSibling;if(!b)throw new Error('missing confirm cancel');b.click()},
 toasts:()=>[...document.querySelectorAll('[data-toast-kind=error]')].map(e=>e.textContent),
 clickText:(sel,text)=>{const el=[...document.querySelectorAll(sel)].find(e=>e.textContent.includes(text));if(!el)throw new Error('missing '+sel+' '+text);el.click()},
 keyBody:o=>key(document.body,o),
 keyActive:o=>key(document.activeElement||document.body,o),
 activeIn:sel=>!!document.activeElement?.closest?.(sel),
 overflow:()=>document.documentElement.scrollWidth>innerWidth,
 inView:sel=>{const el=document.querySelector(sel);if(!el)return false;const r=el.getBoundingClientRect();return r.right<=innerWidth+0.5&&r.left>=0&&r.width>0},
 copy:()=>document.body.innerText,
};
createRoot(document.getElementById('root')).render(<Root/>);
`, resolveDir: root, loader: 'tsx' }, bundle: true, platform: 'browser', format: 'iife', outfile: path.join(dir, 'renderer.js'), alias: { '@shared': path.join(root, 'src/shared'), '@': path.join(root, 'src/renderer') }, jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' }, loader: { '.ttf': 'empty', '.woff': 'empty', '.woff2': 'empty' }, logLevel: 'error' })
fs.writeFileSync(path.join(dir, 'index.html'), `<html><head><meta charset="utf-8"><link rel="stylesheet" href="${pathToFileURL(path.join(assets, css))}"><link rel="stylesheet" href="renderer.css"></head><body><div id="root"></div><script src="renderer.js"></script></body></html>`)
fs.writeFileSync(path.join(dir, 'main.cjs'), `
const {app,BrowserWindow}=require('electron');const fs=require('fs'),path=require('path');
app.setPath('userData',path.join(__dirname,'profile'));
const wait=ms=>new Promise(r=>setTimeout(r,ms));
app.whenReady().then(async()=>{
 const w=new BrowserWindow({width:1280,height:820,show:false,webPreferences:{sandbox:true,backgroundThrottling:false}});
 let failures=[];w.webContents.on('console-message',(_e,level,message)=>{if(level>=3)failures.push(message)});
 await w.loadFile(path.join(__dirname,'index.html'));
 const js=c=>w.webContents.executeJavaScript(c).catch(e=>{throw new Error(e.message+' | in: '+c.slice(0,240))});
 // Hidden windows paint slowly: settle on tasks (React commits in tasks), not on a rAF chain.
 const settle=async(ms=120)=>{await js('new Promise(r=>setTimeout(r,50))');await wait(ms)};
 const until=async(c,ms=3000)=>{for(let t=0;t<ms;t+=100){if(await js(c))return true;await wait(100)}return false};
 const shot=async name=>{await settle(150);fs.writeFileSync(path.join(__dirname,name+'.png'),(await w.webContents.capturePage()).toPNG())};
 let n=0;const ok=(c,label,v)=>{if(!c)throw new Error(label+(v!==undefined?' '+JSON.stringify(v):'')+(failures.length?' console: '+failures.join(' | '):''));n++};
 const TA='tm-aaaaaaaaaaaa',TB='tm-bbbbbbbbbbbb';
 const OPEN_KEYS="{key:'O',code:'KeyO',keyCode:79,ctrlKey:true,shiftKey:true}";
 ok(await until("smoke.calls.spawn.includes('local1')&&!!document.querySelector('[data-pane-cell] .xterm')",6000),'the local console mounted and spawned');

 // Labs teams off: nothing renders, main is never asked, the shortcut reaches the console.
 ok(!(await js("smoke.has('[data-teams-section]')")),'lab off: no Teams section in the sidebar');
 let v=await js("({prevented:smoke.keyBody("+OPEN_KEYS+"),seen:smoke.seen.at(-1),view:smoke.agents().view})");
 ok(!v.prevented&&v.seen&&v.seen.prevented===false&&v.view==='grid','lab off: Ctrl+Shift+O is neither prevented nor stopped, nothing opens',v);
 await js("smoke.keyBody({key:'k',code:'KeyK',keyCode:75,ctrlKey:true})");await settle();
 v=await js("({palette:smoke.has('[data-palette-cmd=new-ws]'),teams:smoke.has('[data-palette-cmd=teams]'),neu:smoke.has('[data-palette-cmd=\\"teams.new\\"]')})");
 ok(v.palette&&!v.teams&&!v.neu,'lab off: the palette has no Teams entry',v);
 await js("smoke.keyActive({key:'Escape',code:'Escape',keyCode:27})");await settle();
 ok(!(await js("smoke.has('[data-palette-cmd]')")),'the palette closes on Esc');
 ok((await js('smoke.calls.req.length'))===0,'lab off: the renderer never sends teams:req');

 // Lab on while main still has it off (the config save is debounced): it asks again.
 await js('smoke.labs(true)');await settle(250);
 v=await js("({lists:smoke.lists(),disabled:smoke.teams().disabled,section:smoke.has('[data-teams-section]')})");
 ok(v.lists>=1&&v.disabled&&!v.section,'main answers disabled at first: the section waits hidden',v);
 await js('smoke.fake.on=true');
 ok(await until("smoke.has('[data-teams-section] [data-team-row]')",4000),'the retry lands once main has the lab on: rows show');
 v=await js("({rows:smoke.count('[data-teams-section] [data-team-row]'),title:smoke.text('[data-teams-section]'),badge:smoke.attr('[data-team-row=\\""+TB+"\\"] [data-team-badge]','data-team-badge'),wsBadges:smoke.count('aside nav [data-attention-badge]'),run:smoke.has('[data-team-row=\\""+TA+"\\"] [data-team-running]'),shield:smoke.attr('[data-team-row=\\""+TB+"\\"] [data-team-untrusted]','data-team-untrusted'),paused:smoke.has('[data-team-row=\\""+TB+"\\"] [data-team-paused]'),noBadgeA:!smoke.has('[data-team-row=\\""+TA+"\\"] [data-team-badge]')})");
 ok(v.rows===2&&v.title.includes('Equipos')&&v.title.includes('Alfa')&&v.title.includes('Beta'),'two team rows under EQUIPOS',v);
 ok(v.badge==='1'&&v.noBadgeA&&v.wsBadges===0,'the needs badge is data-team-badge and no workspace badge counts it',v);
 ok(v.run&&v.shield==='changed'&&v.paused,'running glyph, untrusted shield and pause glyph',v);
 v=await js("({order:smoke.app().workspaces.map(w=>w.id),new:smoke.has('[data-teams-section] [data-team-new]')})");
 ok(v.order.join()==='w1,w2'&&v.new,'team rows never enter the workspace order; the header has Nuevo equipo',v);
 await shot('teams-sidebar');

 // Palette with the lab on.
 await js("smoke.keyBody({key:'k',code:'KeyK',keyCode:75,ctrlKey:true})");await settle();
 v=await js("({open:smoke.text('[data-palette-cmd=teams]'),neu:smoke.has('[data-palette-cmd=\\"teams.new\\"]'),a:smoke.text('[data-palette-cmd=\\"team:"+TA+"\\"]'),b:smoke.has('[data-palette-cmd=\\"team:"+TB+"\\"]')})");
 ok(v.open.includes('Abrir Equipos')&&v.open.includes('Ctrl + Shift + O')&&v.neu&&v.a.includes('Equipo: Alfa')&&v.b,'palette: Abrir Equipos with its key, Nuevo equipo and one entry per team',v);
 await js("smoke.keyActive({key:'Escape',code:'Escape',keyCode:27})");await settle();

 // A row opens the host over the grid.
 const setActive0=await js('smoke.calls.setActive.length');
 await js("smoke.click('[data-team-row=\\""+TA+"\\"] [data-team-open]')");await settle(250);
 v=await js("({host:smoke.attr('[data-team-host]','data-team-host'),view:smoke.agents().view,tabs:smoke.count('[data-team-tab]'),sel:smoke.attr('[data-team-tab=board]','aria-selected'),list:smoke.attr('[role=tablist]','aria-label'),goal:smoke.text('[data-team-goal]'),roles:smoke.count('[data-team-role]'),perm:smoke.attr('[data-team-role=dev] [data-team-role-permission]','data-team-role-permission'),name:smoke.text('[data-team-name]'),repo:smoke.text('[data-team-repo]'),base:smoke.text('[data-team-base]'),focus:smoke.activeIn('[data-team-host]'),active:!!document.querySelector('[data-team-row=\\""+TA+"\\"].bg-card')})");
 ok(v.host===TA&&v.view==='teams'&&v.focus,'the row opens the host on that team and the host takes the focus',v);
 ok(v.tabs===3&&v.sel==='true'&&v.list==='Secciones del equipo','three tabs, Tablero selected',v);
 ok(v.goal.includes('Meta de Alfa')&&v.roles===4&&v.perm==='total'&&v.name==='Alfa'&&v.repo.includes('alfa-repo')&&v.base.includes('main'),'Tablero shows the definition summary: goal, roles, repo and base',v);
 ok(v.active,'the open team row is highlighted',v);
 v=await js("({setActive:smoke.calls.setActive.slice("+setActive0+"),viewed:smoke.calls.viewed.at(-1)})");
 ok(v.setActive.length>0&&Array.isArray(v.setActive.at(-1))&&v.setActive.at(-1).length===0,'pty.setActive([]) while Teams covers the grid',v);
 ok(Array.isArray(v.viewed)&&v.viewed.length===0,'status.setViewed([]) while Teams covers the grid',v);
 v=await js("(()=>{const m=document.querySelector('main').getBoundingClientRect();return [[m.right-40,m.top+20],[m.left+m.width/2,m.top+m.height/2]].map(([x,y])=>!!document.elementFromPoint(x,y)?.closest('[data-team-host]'))})()");
 ok(v.every(Boolean),'the host covers the workspace header and grid',v);
 v=await js("({agents:smoke.attr('[data-team-tab=agents] [data-team-tab-count]','data-team-tab-count')})");
 ok(v.agents==='1','Agentes counts the running agents',v);
 await shot('teams-host');

 // Pane shortcuts are swallowed under the overlay.
 const panes0=await js("smoke.app().workspaces[0].panes.length");
 v=await js("smoke.keyActive({key:'T',code:'KeyT',keyCode:84,ctrlKey:true,shiftKey:true})");await settle();
 ok(v===true&&(await js("smoke.app().workspaces[0].panes.length"))===panes0,'Ctrl+Shift+T is swallowed and adds no pane',v);
 await js("smoke.keyActive({key:'1',code:'Digit1',keyCode:49,ctrlKey:true})");await settle(300);
 v=await js("({view:smoke.agents().view,local:smoke.activeIn('[data-pane-cell]')})");
 ok(v.view==='teams'&&!v.local,'Ctrl+1 focuses no console and keeps Teams',v);

 // Tabs: click, arrows, remembered per team.
 await js("smoke.click('[data-team-tab=agents]')");await settle();
 ok((await js("smoke.attr('[data-team-tab=agents]','aria-selected')"))==='true'&&(await js("smoke.has('[data-team-empty-tab=agents]')")),'Agentes selected shows its line');
 await js("document.querySelector('[data-team-tab=agents]').focus();smoke.keyActive({key:'ArrowRight',code:'ArrowRight',keyCode:39})");await settle();
 v=await js("({sel:smoke.attr('[data-team-tab=needs]','aria-selected'),focus:document.activeElement?.dataset?.teamTab})");
 ok(v.sel==='true'&&v.focus==='needs','ArrowRight moves to Te necesita and focuses it',v);
 await js("smoke.keyActive({key:'Home',code:'Home',keyCode:36})");await settle();
 ok((await js("smoke.attr('[data-team-tab=board]','aria-selected')"))==='true','Home goes back to Tablero');
 await js("smoke.click('[data-team-tab=agents]')");await settle();

 // Esc closes it and the grid gets its panes back (typed where the focus is: no hand-made focus first).
 await js("smoke.keyActive({key:'Escape',code:'Escape',keyCode:27})");await settle(250);
 v=await js("({host:smoke.has('[data-team-host]'),view:smoke.agents().view,setActive:smoke.calls.setActive.at(-1)})");
 ok(!v.host&&v.view==='grid'&&JSON.stringify(v.setActive)==='[\\"local1\\"]','Esc closes Teams and pty.setActive gets the panes back',v);
 ok(await until("smoke.activeIn('[data-pane-cell]')",4000),'the console gets the keyboard back');

 // Ctrl+Shift+O with the lab on: eaten, reopens the last team on its remembered tab.
 v=await js("smoke.keyActive("+OPEN_KEYS+")");await settle(250);
 ok(v===true,'lab on: Ctrl+Shift+O is consumed');
 v=await js("({host:smoke.attr('[data-team-host]','data-team-host'),tab:smoke.attr('[data-team-tab=agents]','aria-selected')})");
 ok(v.host===TA&&v.tab==='true','it reopens the last team on the tab it had',v);
 await js("smoke.keyActive("+OPEN_KEYS+")");await settle(200);
 ok(!(await js("smoke.has('[data-team-host]')")),'Ctrl+Shift+O again closes it');

 // Alt+1, a workspace row and the agents board close it. Each reopen waits for the
 // console focus of the last switch to land (a hidden window runs rAF slowly).
 const focusOn=id=>until("document.activeElement?.closest?.('[data-pane-cell]')?.dataset.paneCell==='"+id+"'",5000);
 ok(await focusOn('local1'),'focus is back on the local console');
 await js("smoke.openTeams('"+TA+"')");await settle(200);
 ok(await js("smoke.has('[data-team-host]')"),'Teams reopens');
 await js("smoke.keyActive({key:'1',code:'Digit1',keyCode:49,altKey:true})");await settle(250);
 v=await js("({host:smoke.has('[data-team-host]'),active:smoke.app().activeWorkspaceId})");
 ok(!v.host&&v.active==='w1','Alt+1 closes Teams and lands on the first workspace',v);
 ok(await focusOn('local1'),'Alt+1 gives the console the keyboard');
 await js("smoke.openTeams('"+TA+"')");await settle(200);
 ok(await js("smoke.has('[data-team-host]')"),'Teams reopens');
 await js("smoke.click('[data-sidebar-ws=w2] button')");await settle(250);
 v=await js("({host:smoke.has('[data-team-host]'),active:smoke.app().activeWorkspaceId})");
 ok(!v.host&&v.active==='w2','a workspace row closes Teams and switches',v);
 ok(await focusOn('local2'),'the other workspace console gets the keyboard');
 await js("smoke.click('[data-sidebar-ws=w1] button')");
 ok(await focusOn('local1'),'back on the first workspace');
 await js("smoke.openTeams('"+TA+"')");await settle(200);
 ok(await js("smoke.has('[data-team-host]')"),'Teams reopens');
 await js("smoke.click('[data-agents-board-toggle]')");await settle(200);
 v=await js("({host:smoke.has('[data-team-host]'),board:smoke.has('[data-agents-board]')})");
 ok(!v.host&&v.board,'the agents board replaces Teams',v);
 await js("smoke.click('[data-board-close]')");await settle(200);

 // Trust banner, header chips and the trust dialog on a changed definition.
 await js("smoke.click('[data-team-row=\\""+TB+"\\"] [data-team-open]')");await settle(300);
 v=await js("({banner:smoke.attr('[data-team-trust-banner]','data-team-trust-banner'),text:smoke.text('[data-team-trust-banner]'),chip:smoke.text('[data-team-trust-chip]'),paused:smoke.attr('[data-team-paused-chip]','data-team-paused-chip'),limit:smoke.text('[data-team-limit]'),needs:smoke.attr('[data-team-tab=needs] [data-team-tab-count]','data-team-tab-count'),tab:smoke.attr('[data-team-tab=board]','aria-selected')})");
 ok(v.banner==='changed'&&v.text.includes('cambió')&&v.text.includes('Revisar cambios'),'the banner says the definition changed, with Revisar cambios',v);
 ok(v.chip==='Cambió'&&v.paused==='user'&&v.limit.includes('Límite de Claude hasta'),'header chips: Cambió, En pausa, the provider limit',v);
 ok(v.needs==='1'&&v.tab==='true','Te necesita counts 1; a team never opened starts on Tablero',v);
 await js("smoke.click('[data-team-trust-review]')");await settle(300);
 ok(await js("smoke.has('[data-team-trust-dialog=\\""+TB+"\\"]')"),'Revisar cambios opens the trust dialog of that team');
 await js("smoke.keyActive({key:'Escape',code:'Escape',keyCode:27})");await settle(200);
 v=await js("({dialog:smoke.has('[data-team-trust-dialog]'),host:smoke.has('[data-team-host]')})");
 ok(!v.dialog&&v.host,'Esc closes the dialog first and Teams stays open',v);
 ok(await until("smoke.activeIn('[data-team-host]')",2000),'the host gets the keyboard back after the dialog');
 await js("smoke.keyActive({key:'k',code:'KeyK',keyCode:75,ctrlKey:true})");await settle();
 v=await js("({teams:smoke.has('[data-palette-cmd=teams]'),notes:smoke.has('[data-palette-cmd=view-notes]'),ws:smoke.has('[data-palette-cmd=ws-w1]')})");
 ok(v.teams&&!v.notes&&v.ws,'over Teams the palette leaves out the entries that act on the hidden workspace',v);
 await js("smoke.keyActive({key:'Escape',code:'Escape',keyCode:27})");await settle();
 v=await js("({host:smoke.has('[data-team-host]'),focus:smoke.activeIn('[data-team-host]')})");
 ok(v.host&&v.focus,'Esc closes the palette, Teams stays and keeps the keyboard',v);
 await shot('teams-banner');

 // Zoom: no horizontal overflow, the close button stays on screen.
 for(const z of [1,1.25,1.5]){
  w.webContents.setZoomFactor(z);await settle(250);
  v=await js("({over:smoke.overflow(),close:smoke.inView('[data-team-close]'),tabs:smoke.inView('[data-team-tab=needs]')})");
  ok(!v.over&&v.close&&v.tabs,'zoom '+z+': no overflow, close and tabs on screen',v);
  if(z===1.5)await shot('teams-zoom150');
 }
 w.webContents.setZoomFactor(1);await settle(200);

 // Refetch policy: debounce, rev filter, ids, teams not open.
 let gets=await js("smoke.gets('"+TB+"')");
 await js("smoke.fake.teams[1].trust='trusted';smoke.fake.teams[1].rev=6;smoke.push({teamId:'"+TB+"',rev:6,scopes:['team','list']})");
 ok(await until("!smoke.has('[data-team-trust-banner]')",2000),'a team event refetches the view and the banner goes once trusted');
 v=await js("({gets:smoke.gets('"+TB+"'),shield:smoke.has('[data-team-row=\\""+TB+"\\"] [data-team-untrusted]')})");
 ok(v.gets===gets+1&&!v.shield,'one get for the event, the list refreshed the row',v);
 gets=v.gets;
 await js("smoke.push({teamId:'"+TB+"',rev:4,scopes:['team']})");await settle(400);
 ok((await js("smoke.gets('"+TB+"')"))===gets,'an event whose rev is older than the view refetches nothing');
 // Main flips the cached trust state without a runtime rev bump (a definition edit, a trust):
 // an event at the same rev still refetches, and two of them in one window fetch once.
 await js("smoke.fake.teams[1].trust='changed';smoke.push({teamId:'"+TB+"',rev:6,scopes:['team','list']});smoke.push({teamId:'"+TB+"',rev:6,scopes:['team','list']})");
 ok(await until("smoke.attr('[data-team-trust-banner]','data-team-trust-banner')==='changed'",2000),'a same-rev team event (trust flipped in main) brings the banner back');
 await settle(300);
 ok((await js("smoke.gets('"+TB+"')"))===gets+1,'the two same-rev events fetched the view once');
 await js("smoke.fake.teams[1].trust='trusted';smoke.push({teamId:'"+TB+"',rev:6,scopes:['team','list']})");
 ok(await until("!smoke.has('[data-team-trust-banner]')",2000),'trusted again at the same rev: the banner goes');
 // A definition with errors: the banner lists them worded like the trust dialog (a repo problem says why).
 await js("smoke.fake.teams[1].trust='invalid';smoke.fake.teams[1].issues=[{file:'team.md',line:0,code:'repo',key:'repos',detail:'not_git'},{file:'roles/dev.md',line:3,code:'bad_value',key:'permission'}];smoke.push({teamId:'"+TB+"',rev:6,scopes:['team','list']})");
 ok(await until("smoke.attr('[data-team-trust-banner]','data-team-trust-banner')==='invalid'",2000),'an invalid definition shows the error banner');
 v=await js("[...document.querySelectorAll('[data-team-banner-issue]')].map(e=>e.textContent)");
 ok(v.length===2&&v[0].includes('team.md')&&v[0].includes('no es un repo de git')&&v[1].includes('roles/dev.md, línea 3')&&v[1].includes('El valor de permission no es válido'),'the banner issues say where and why',v);
 // A UNC or device path of an extra repo (refused by the parser and by resolveRepos, motive unc) says why.
 await js("smoke.fake.teams[1].issues=[{file:'team.md',line:4,code:'repo',key:'repo.lib.path',detail:'unc',severity:'error'}];smoke.push({teamId:'"+TB+"',rev:6,scopes:['team','list']})");
 ok(await until("smoke.text('[data-team-banner-issue=repo]').includes('es una ruta de red o de dispositivo')",2000),'a UNC repo path: the banner says it is a network or device path',await js("smoke.text('[data-team-banner-issues]')"));
 ok((await js("smoke.text('[data-team-banner-issue=repo]')")).includes('team.md, línea 4'),'the UNC refusal points at its line');
 // One-line repo text: separators, tab, newline, bidi marks and tag characters spelled out.
 v=await js("smoke.visibleName('a\\\\u2028b\\\\u2029c\\\\td\\\\ne\\\\u202Ef\\\\u{E0041}g')");
 ok(v==='a<U+2028>b<U+2029>c<U+0009>d<U+000A>e<U+202E>f<U+E0041>g','visibleName spells out the line and paragraph separators, tab, newline, bidi marks and tag characters',v);
 // Warnings (a misnamed file, the Codex allowlist): listed in the warning style with words that do not
 // block, also for a trusted team; the file name with its bidi mark spelled out.
 const pushB="smoke.push({teamId:'"+TB+"',rev:6,scopes:['team','list']})";
 const W1="{file:'roles/Dev\\\\u202Eevil.md',line:0,code:'bad_name',severity:'warning'}", W2="{file:'roles/qa.md',line:5,key:'allowedTools',code:'bad_value',detail:'codex',severity:'warning'}";
 await js("smoke.fake.teams[1].trust='trusted';smoke.fake.teams[1].issues=["+W1+","+W2+"];"+pushB);
 ok(await until("smoke.has('[data-team-def-warnings]')",2000),'a trusted team with warnings shows them');
 v=await js("({trustBanner:smoke.has('[data-team-trust-banner]'),count:smoke.attr('[data-team-def-warnings]','data-team-def-warnings'),text:smoke.text('[data-team-def-warnings] p'),sev:[...document.querySelectorAll('[data-team-banner-issue]')].map(e=>e.dataset.issueSeverity).join(),items:[...document.querySelectorAll('[data-team-banner-issue]')].map(e=>e.textContent),review:smoke.has('[data-team-trust-review]'),folder:smoke.has('[data-team-open-folder]'),chip:smoke.has('[data-team-trust-chip]')})");
 ok(!v.trustBanner&&v.count==='2'&&v.text.includes('avisos (2)')&&v.text.includes('No frenan al equipo')&&!v.text.includes('errores'),'warnings only: no trust banner, the strip says they do not stop the team',v);
 ok(v.sev==='warning,warning'&&!v.review&&v.folder&&!v.chip,'both items in the warning style; Abrir carpeta to fix them, no review, no trust chip',v);
 ok(v.items[0].includes('roles/Dev<U+202E>evil.md')&&v.items[0].includes('el equipo no lee este archivo')&&!/\\u202E/.test(v.items.join('')),'a misnamed file: its name with the bidi mark spelled out, and that the team does not read it',v.items);
 ok(v.items[1].includes('roles/qa.md, línea 5')&&v.items[1].includes('Codex no tiene lista de herramientas permitidas')&&v.items[1].includes('se ignora allowedTools')&&!v.items[1].includes('codex'),'the Codex allowedTools warning says Codex has no allowlist and the list is ignored',v.items);
 await js("smoke.fake.teams[1].trust='invalid';smoke.fake.teams[1].issues=[{file:'team.md',line:2,key:'verify',code:'bad_value',severity:'error'},"+W2+"];"+pushB);
 ok(await until("smoke.attr('[data-team-trust-banner]','data-team-trust-banner')==='invalid'",2000),'errors and warnings: the error banner');
 v=await js("({text:smoke.text('[data-team-trust-banner] p'),sev:[...document.querySelectorAll('[data-team-banner-issue]')].map(e=>e.dataset.issueSeverity).join(),warn:smoke.attr('[data-team-trust-banner]','data-team-def-warnings'),folder:smoke.has('[data-team-open-folder]')})");
 ok(v.text.includes('tiene errores (1)')&&v.sev==='error,warning'&&v.warn==='1'&&v.folder,'the count is of the errors only, errors first, then the warning; the folder can be opened',v);
 // Abrir carpeta: main refuses (not a real directory) or the system cannot open it: one toast says why.
 await js("smoke.fake.reveal={ok:false,error:'not_found'};smoke.click('[data-team-open-folder]')");
 ok(await until("smoke.toasts().some(x=>x.includes('No se pudo abrir la carpeta')&&x.includes('No es una carpeta común'))",2000),'reveal not_found: the toast says it is not a plain folder',await js('smoke.toasts()'));
 await js("smoke.fake.reveal={ok:false,error:'io',detail:'Access is denied.'};smoke.click('[data-team-open-folder]')");
 ok(await until("smoke.toasts().length===1&&smoke.toasts()[0].includes('No se pudo abrir la carpeta')&&!smoke.toasts()[0].includes('No es una carpeta común')",2000),'reveal io: the catalog text replaces the not_found toast',await js('smoke.toasts()'));
 await settle(100);
 ok(!(await js("smoke.toasts().join('|')")).includes('Access is denied'),'reveal io: the raw system reason never reaches the toast',await js('smoke.toasts()'));
 v=await js("({n:smoke.toasts().length,reqs:smoke.calls.req.filter(r=>r.op==='reveal').slice(-2).map(r=>r.teamId+':'+r.what).join()})");
 ok(v.n===1&&v.reqs===TB+':definition,'+TB+':definition','the banner reveals the definition folder; a second failure replaces the toast',v);
 await js("smoke.fake.reveal={ok:true};smoke.click('[data-team-open-folder]')");
 ok(await until("smoke.toasts().length===0",2000),'a reveal that opens takes the failure toast away');
 await js("smoke.fake.reveal={ok:false,error:'not_found'};smoke.click('[data-team-menu=\\""+TB+"\\"]')");await settle(150);
 await js("smoke.clickText('[role=menuitem]','Abrir carpeta del equipo')");
 ok(await until("smoke.toasts().some(x=>x.includes('No es una carpeta común'))",2000),'the kebab "Abrir carpeta del equipo" toasts a refused reveal too');
 await js("smoke.fake.reveal={ok:true};smoke.click('[data-team-open-folder]')");
 ok(await until("smoke.toasts().length===0",2000),'the toast goes once a reveal opens');
 // A load error that is a link or an unreadable folder: no Abrir carpeta (main would not open it).
 for(const code of ['link','io']){
  await js("smoke.fake.teams[1].issues=[{file:'.snagentsos/team',line:0,code:'"+code+"',severity:'error'}];"+pushB);
  ok(await until("smoke.has('[data-team-banner-issue="+code+"]')",2000),'the '+code+' load error is listed');
  v=await js("({folder:smoke.has('[data-team-open-folder]'),review:smoke.has('[data-team-trust-review]')})");
  ok(!v.folder&&v.review,'a '+code+' load error offers no Abrir carpeta',v);
 }
 await js("smoke.fake.teams[1].trust='trusted';smoke.fake.teams[1].issues=[];smoke.push({teamId:'"+TB+"',rev:6,scopes:['team','list']})");
 ok(await until("!smoke.has('[data-team-trust-banner]')",2000),'fixed and trusted: the banner goes');
 await settle(300);
 gets=await js("smoke.gets('"+TB+"')");
 await js("smoke.areaEvents.length=0;for(const r of [7,8,9])smoke.push({teamId:'"+TB+"',rev:r,scopes:['team','board']})");await settle(400);
 v=await js("({gets:smoke.gets('"+TB+"'),board:smoke.areaEvents.filter(e=>e.scopes[0]==='board').map(e=>e.rev)})");
 ok(v.gets===gets+1&&v.board.length===1&&v.board[0]===9,'three quick events: one get and one board event with the newest rev',v);
 await js("smoke.areaEvents.length=0;smoke.push({teamId:'"+TB+"',rev:2,scopes:['task'],taskId:'t-4'});smoke.push({teamId:'"+TB+"',rev:2,scopes:['task'],taskId:'t-5'})");await settle(400);
 v=await js("smoke.areaEvents.filter(e=>e.scopes[0]==='task').map(e=>e.taskId).sort()");
 ok(JSON.stringify(v)==='[\\"t-4\\",\\"t-5\\"]','task scope ignores the rev and keeps one event per task id',v);
 const lists=await js('smoke.lists()');
 await js("smoke.areaEvents.length=0;smoke.push({teamId:'"+TA+"',rev:50,scopes:['board','needs']});smoke.push({teamId:'"+TA+"',rev:51,scopes:['list']})");await settle(400);
 v=await js("({events:smoke.areaEvents.map(e=>e.scopes[0]),lists:smoke.lists()})");
 ok(JSON.stringify(v.events)==='[\\"list\\"]'&&v.lists===lists+1,'a team not on screen only reacts to list',v);

 // Picker. Each click focuses the button it lands on, which then unmounts with the body swap:
 // the keyboard comes back to the host and Esc (typed where the focus is) still closes Teams.
 const ESC="{key:'Escape',code:'Escape',keyCode:27}";
 await js("smoke.focusClick('[data-team-picker-open]')");await settle(200);
 v=await js("({picker:smoke.has('[data-team-picker]'),cards:smoke.count('[data-team-pick]'),host:smoke.attr('[data-team-host]','data-team-host'),focus:smoke.activeIn('[data-team-host]')})");
 ok(v.picker&&v.cards===2&&v.host==='','the picker lists both teams',v);
 ok(v.focus,'the picker button unmounted under the focus: the host has the keyboard',v);
 await js("smoke.keyActive("+ESC+")");await settle(250);
 ok(!(await js("smoke.has('[data-team-host]')")),'Esc right after the picker click closes Teams');
 // Each reopen waits for the console focus of the close to land (a late one would close Teams again).
 ok(await focusOn('local1'),'the console has the keyboard after the close');
 await js("smoke.openTeams(null)");await settle(200);
 ok(await js("smoke.has('[data-team-picker]')"),'Teams opens on the picker');
 await js("smoke.focusClick('[data-team-pick=\\""+TA+"\\"]')");await settle(250);
 v=await js("({host:smoke.attr('[data-team-host]','data-team-host'),focus:smoke.activeIn('[data-team-host]')})");
 ok(v.host===TA&&v.focus,'a card opens its team and the host takes the keyboard back',v);
 await js("smoke.keyActive("+ESC+")");await settle(250);
 ok(!(await js("smoke.has('[data-team-host]')")),'Esc right after a picker card closes Teams');
 ok(await focusOn('local1'),'the console has the keyboard after the close');
 // The focus nowhere at all (body): the document listener still closes Teams.
 await js("smoke.openTeams('"+TA+"')");await settle(200);
 v=await js("smoke.blur();({body:document.activeElement===document.body,prevented:smoke.keyBody("+ESC+")})");await settle(250);
 ok(v.body&&v.prevented&&!(await js("smoke.has('[data-team-host]')")),'Esc with the focus on body closes Teams',v);
 ok(await focusOn('local1'),'the console has the keyboard after the close');
 // Reintentar unmounts once the view lands: the keyboard comes back to the host.
 await js("smoke.dropViews();smoke.fake.failGet.add('"+TA+"');smoke.openTeams('"+TA+"')");
 ok(await until("smoke.has('[data-team-load-failed]')",3000),'a get that fails offers Reintentar');
 await js("smoke.fake.failGet.clear();smoke.focusClick('[data-team-load-failed] button')");
 ok(await until("!smoke.has('[data-team-load-failed]')&&smoke.has('[data-team-role]')",3000),'Reintentar loads the team');
 ok(await until("smoke.activeIn('[data-team-host]')",2000),'after Reintentar the host has the keyboard');
 // The kebab menu over Teams takes its own Esc; the remove confirm, cancelled or escaped, gives the keyboard back.
 await js("smoke.click('[data-team-menu=\\""+TA+"\\"]')");await settle(150);
 ok(await js("smoke.has('[role=menu]')"),'the kebab menu opens over Teams');
 await js("smoke.keyActive("+ESC+")");await settle(200);
 v=await js("({menu:smoke.has('[role=menu]'),host:smoke.has('[data-team-host]')})");
 ok(!v.menu&&v.host,'Esc closes the kebab menu and Teams stays',v);
 await js("smoke.click('[data-team-menu=\\""+TA+"\\"]')");await settle(150);
 await js("smoke.clickText('[role=menuitem]','Quitar equipo')");await settle(200);
 ok(await js("smoke.activeIs('data-confirm')"),'the remove confirm holds the focus');
 await js("smoke.cancelConfirm()");await settle(200);
 v=await js("({dialog:smoke.has('[data-confirm]'),host:smoke.has('[data-team-host]'),focus:smoke.activeIn('[data-team-host]')})");
 ok(!v.dialog&&v.host&&v.focus,'Cancel on the remove confirm gives the keyboard back to the host',v);
 await js("smoke.click('[data-team-menu=\\""+TA+"\\"]')");await settle(150);
 await js("smoke.clickText('[role=menuitem]','Quitar equipo')");await settle(200);
 await js("smoke.keyActive("+ESC+")");await settle(200);
 v=await js("({dialog:smoke.has('[data-confirm]'),host:smoke.has('[data-team-host]'),focus:smoke.activeIn('[data-team-host]'),teams:smoke.teams().list.length})");
 ok(!v.dialog&&v.host&&v.focus&&v.teams===2,'Esc cancels the confirm only: Teams stays with the keyboard, nothing removed',v);
 await js("smoke.keyActive("+ESC+")");await settle(250);
 ok(!(await js("smoke.has('[data-team-host]')")),'the next Esc closes Teams');
 ok(await focusOn('local1'),'the console has the keyboard after the close');
 await js("smoke.openTeams('"+TA+"')");await settle(250);
 ok((await js("smoke.attr('[data-team-host]','data-team-host')"))===TA,'Teams reopens on Alfa');

 // English.
 await js("smoke.setLang('en')");await settle(200);
 v=await js("({tabs:[...document.querySelectorAll('[data-team-tab]')].map(e=>e.textContent.replace(/\\\\d+/g,'')),section:smoke.text('[data-teams-section]')})");
 ok(v.tabs.join('|')==='Board|Agents|Needs you'&&v.section.includes('Teams'),'en: Board, Agents, Needs you; the section is Teams',v);
 v=await js("smoke.copy()");
 ok(!/[\\u2013\\u2014]/.test(v),'en: no en or em dash in the copy');
 await js("smoke.setLang('es')");await settle(200);
 v=await js("smoke.copy()");
 ok(!/[\\u2013\\u2014]/.test(v),'es: no en or em dash in the copy');

 // Collapsed rail: icons with the badge overlay.
 await js('smoke.collapse(true)');await settle(250);
 v=await js("({rows:smoke.count('[data-teams-section] [data-team-row]'),badge:smoke.has('[data-team-row=\\""+TB+"\\"] [data-team-badge]'),header:smoke.text('[data-teams-section]').includes('Equipos')})");
 ok(v.rows===2&&v.badge&&!v.header,'collapsed: icon rows with the badge, no header',v);
 await shot('teams-rail');
 await js('smoke.collapse(false)');await settle(200);

 // Over a shared view: Teams covers it, and closing Teams gives that view back (no local focus request).
 await js('smoke.shared(true)');await settle(250);
 v=await js("({host:smoke.has('[data-team-host]'),shared:smoke.has('[data-shared-workspace]'),top:!!document.elementFromPoint(innerWidth-60,innerHeight/2)?.closest('[data-team-host]')})");
 ok(v.host&&v.shared&&v.top,'Teams covers a shared view',v);
 await js("smoke.typedIn('local1','w1');smoke.calls.focusReq.length=0;document.querySelector('[data-team-host]').focus();smoke.keyActive({key:'Escape',code:'Escape',keyCode:27})");await settle(300);
 v=await js("({host:smoke.has('[data-team-host]'),shared:smoke.has('[data-shared-workspace]'),link:smoke.sharedActive(),reqs:smoke.calls.focusReq.slice(),setActive:smoke.calls.setActive.at(-1)})");
 ok(!v.host&&v.shared&&v.link==='L1'&&v.reqs.length===0,'Esc closes Teams and the shared view is still there',v);
 ok(JSON.stringify(v.setActive)==='[]','the local panes stay inactive under the shared view',v);
 await js('smoke.shared(false)');await settle(250);
 ok(!(await js("smoke.has('[data-shared-workspace]')")),'the shared view closes');

 // Main turns the lab off: the overlay closes and the section hides.
 await js("smoke.fake.on=false;smoke.push({teamId:'',rev:0,scopes:['disabled']})");await settle(250);
 v=await js("({host:smoke.has('[data-team-host]'),section:smoke.has('[data-teams-section]'),view:smoke.agents().view,disabled:smoke.teams().disabled})");
 ok(!v.host&&!v.section&&v.view==='grid'&&v.disabled,'disabled from main closes Teams and hides the section',v);
 await js('smoke.fake.on=true');
 ok(await until("smoke.has('[data-teams-section] [data-team-row]')",8000),'the section comes back once main answers again');

 // Labs off in the renderer with Teams open.
 await js("smoke.openTeams('"+TA+"')");await settle(200);
 await js('smoke.labs(false)');await settle(250);
 v=await js("({host:smoke.has('[data-team-host]'),section:smoke.has('[data-teams-section]'),view:smoke.agents().view,setActive:smoke.calls.setActive.at(-1)})");
 ok(!v.host&&!v.section&&v.view==='grid'&&JSON.stringify(v.setActive)==='[\\"local1\\"]','Labs off closes Teams, hides the section and gives the panes back',v);
 await js("smoke.openTeams('"+TA+"')");await settle(150);
 ok((await js('smoke.agents().view'))==='grid','openTeams does nothing with the lab off');
 await js('smoke.labs(true)');
 ok(await until("smoke.has('[data-teams-section] [data-team-row]')",4000),'lab on again: rows back');

 // Remove (kebab, confirm) down to zero teams: the Nuevo equipo row and the empty picker. The first
 // one is the team on screen: the host falls back to the picker and keeps the keyboard.
 ok(await focusOn('local1'),'the console has the keyboard after Labs off');
 await js("smoke.openTeams('"+TB+"')");await settle(250);
 ok((await js("smoke.attr('[data-team-host]','data-team-host')"))===TB,'Teams open on Beta before removing it');
 for(const id of [TB,TA]){
  await js("smoke.click('[data-team-menu=\\""+id+"\\"]')");await settle(150);
  await js("smoke.clickText('[role=menuitem]','Quitar equipo')");await settle(150);
  ok(await js("smoke.text('body').includes('Los archivos de .snagentsos/team quedan en el repo')"),'remove asks first and says the repo files stay ('+id+')');
  await js("smoke.click('[data-confirm]')");await settle(300);
  ok((await js("smoke.calls.req.some(r=>r.op==='remove'&&r.teamId==='"+id+"')"))&&!(await js("smoke.has('[data-team-row=\\""+id+"\\"]')")),'the team is removed and its row goes ('+id+')');
  if(id===TB){
   v=await js("({picker:smoke.has('[data-team-picker]'),cards:smoke.count('[data-team-pick]'),focus:smoke.activeIn('[data-team-host]')})");
   ok(v.picker&&v.cards===1&&v.focus,'removing the team on screen: the picker, and the host keeps the keyboard',v);
   await js("smoke.keyActive("+ESC+")");await settle(250);
   ok(!(await js("smoke.has('[data-team-host]')")),'Esc then closes Teams');
  }
 }
 v=await js("({rows:smoke.count('[data-team-row]'),neu:smoke.text('[data-teams-section] [data-team-new]')})");
 ok(v.rows===0&&v.neu.includes('Nuevo equipo'),'zero teams: one Nuevo equipo row',v);
 await js("smoke.keyActive("+OPEN_KEYS+")");await settle(250);
 v=await js("({picker:smoke.has('[data-team-picker-empty]'),text:smoke.text('[data-team-picker]')})");
 ok(v.picker&&v.text.includes('Crear equipo'),'Teams with no team explains it and offers Crear equipo',v);
 await js("smoke.click('[data-team-create]')");await settle(250);
 ok(await js("smoke.has('[data-team-setup]')"),'Crear equipo opens the setup dialog');
 await js("smoke.keyActive({key:'Escape',code:'Escape',keyCode:27})");await settle(200);

 if(failures.length)throw new Error(failures.join('\\n'));
 console.log('PASS: '+n+' teams UI checks (part 1: section, shortcut, palette, host, overlay, refetch policy); screenshots '+__dirname);w.destroy();app.quit();
}).catch(e=>{console.error(e);app.exit(1)});
`)
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL
const res = spawnSync(require('electron'), [path.join(dir, 'main.cjs')], { env, windowsHide: true, encoding: 'utf8', timeout: 120000 })
process.stdout.write(res.stdout ?? ''); if (res.status !== 0) process.stderr.write((res.stderr ?? '') + (res.error ? String(res.error) : ''))
process.exitCode = res.status ?? 1
