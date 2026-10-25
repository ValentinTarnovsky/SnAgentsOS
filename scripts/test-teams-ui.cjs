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
// error and no en or em dash. Agents section (B2): the roster from a stubbed
// `roster` (Lead first and full width, line 2, elapsed, usage "estimado",
// context, failure and pause chips), Ejecutar ahora opens the drawer composer
// and sends `runNow` with the request (Enter is a new line, never a pty
// write or submit), `deferred` shows its reason inline, the drawer renders
// `runPage` through ChatScroller, a pushed `teams:runAppend` of the watched
// run appends and one of another run does not, Load earlier, a link behind
// a confirm, RunLog's cut row (decoded by the real RunLog, English in main)
// worded in es and en, Frenar confirms and sends `stop`, the agent and team
// pauses, usage today in the header, the drawer at zoom, and Settings > Labs
// (the production SettingsModal) asking before turning Teams off with a live
// run, Esc on that confirm cancelling it while Settings stays open. Board
// section (B3): an empty board shows the definition summary; the Lead card's
// last two messages (a `sys` one worded from its key), the Lead thread with
// `leadSay` (Enter is a new line, the queued chip), Conversación / Corrida, a
// Lead drawer opened before the roster (a loading line or Reintentar, never
// the run view first); placement by column (qa -> Revisión), counts, bands and the card chips;
// drag todo -> blocked sends `moveTask` with `baseRev` and the reply's
// userOwned pins the card, a drop on En curso sends nothing and says why, a
// band drop sends `updateTask {priority}`, a card the flow moves mid-drag
// ends the drag (no column stays dimmed), a running task asks and sends
// `stopRun`; keyboard roving and Shift+F10 "Mover a" / "Prioridad" parity,
// cancel and "Mostrar canceladas"; the task drawer (field save with the rev,
// the conflict kept with Reintentar, the title edited and Esc, the card's
// comment count kept from main over the drawer's page, a block by the Lead
// worded as the Lead's, "Que decida el Líder" handing the assignee back, comments with
// the queued chip (the recipient main fixed, kept over a reassignment) and a
// `sys` one, activity to the run chat, a trusted click
// on another card switches it and one beside closes it); Nueva tarea from the
// header (only touched fields, Ctrl+Enter) and the palette (Esc cancels);
// 1280 px and zoom without page overflow; en. No pty, user config or real
// main is touched.
// Requires npm run build (for the CSS).
const fs = require('node:fs'), os = require('node:os'), path = require('node:path')
const { pathToFileURL } = require('node:url')
const { spawnSync } = require('node:child_process')
const { buildSync } = require('esbuild')
const root = path.resolve(__dirname, '..'), dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snagentsos-teams-ui-'))
const assets = path.join(root, 'out/renderer/assets')
const css = fs.existsSync(assets) ? fs.readdirSync(assets).find(f => /^index-.*\.css$/.test(f)) : null
if (!css) throw new Error('Run npm run build first')
// The cut text is one string, RUN_LOG_CUT_TEXT of src/shared/teams.ts, that RunLog writes and the run chat
// matches: a private copy on either side could drift and the row would show main's English.
const cutCopies = fs.readdirSync(path.join(root, 'src'), { recursive: true }).map(f => String(f).replace(/\\/g, '/')).filter(f => /\.tsx?$/.test(f) && fs.readFileSync(path.join(root, 'src', f), 'utf8').includes('[Run log cut:'))
if (cutCopies.join() !== 'shared/teams.ts') throw new Error('the run log cut text must live only in src/shared/teams.ts, found in: ' + cutCopies.join(', '))
// RunLog's cut row exactly as main decodes it (main keeps its text in English); the run chat words it.
buildSync({ stdin: { contents: "export {runDecoder} from './src/main/teams/RunLog'", resolveDir: root, loader: 'ts' }, bundle: true, platform: 'node', format: 'cjs', outfile: path.join(dir, 'runlog.cjs'), alias: { '@shared': path.join(root, 'src/shared') }, logLevel: 'error' })
const CUT_ROW = require(path.join(dir, 'runlog.cjs')).runDecoder('claude')({ type: 'snaos.cut', at: 50 }, 50)[0]
if (!CUT_ROW || CUT_ROW.role !== 'system') throw new Error('RunLog decodes no cut row')
buildSync({ stdin: { contents: `
import React from 'react'; import {createRoot} from 'react-dom/client';
import {I18nProvider} from './src/renderer/i18n';
import {useAppStore} from './src/renderer/lib/store';
import {useAgentStore} from './src/renderer/lib/agentStore';
import {useGlobalKeys} from './src/renderer/lib/useGlobalKeys';
import {useStatusEvents} from './src/renderer/lib/useStatusEvents';
import {useTeamsStore, onTeamChanged, openTeams, openAgentDrawer} from './src/renderer/lib/teamsStore';
import {startTeams} from './src/renderer/lib/teams/start';
import {useRosterStore} from './src/renderer/lib/teams/roster';
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
import {NewTaskDialog} from './src/renderer/components/teams/NewTaskDialog';
import {NotificationStack} from './src/renderer/components/ui/NotificationStack';
import {SettingsModal} from './src/renderer/components/settings/SettingsModal';
import {applyTheme} from './src/renderer/themes/applyTheme';
import {initShareGuest, useShareGuestStore} from './src/renderer/lib/shareGuestStore';
import {onPaneFocusRequest, setFocusedPane} from './src/renderer/lib/focus';
const calls={spawn:[],setActive:[],viewed:[],req:[],save:[],focusReq:[],ptyWrite:[],ptySubmit:[],openExternal:[]};
onPaneFocusRequest(id=>calls.focusReq.push(id));
const subs={changed:new Set(),append:new Set()};
const noop=()=>()=>{};
const fallback=(base)=>new Proxy(base,{get:(t,k)=>k in t?t[k]:(typeof k==='string'?fallback(noop):undefined)});
const TA='tm-aaaaaaaaaaaa', TB='tm-bbbbbbbbbbbb';
const item=(id,name,extra)=>({id,name,repoName:name.toLowerCase()+'-repo',trust:'trusted',paused:null,autoDispatch:false,agents:5,running:0,needsCount:0,rev:1,repoRoot:'C:/repos/'+name.toLowerCase(),takeovers:[],...(extra||{})});
const ROLES=[
 {id:'lead',name:'Líder',kind:'lead',provider:'claude',model:'opus',effort:'high',permission:'readonly',count:1},
 {id:'dev',name:'Dev',kind:'dev',provider:'claude',model:'sonnet',effort:'medium',permission:'total',count:2},
 {id:'qa',name:'QA',kind:'qa',provider:'claude',model:'sonnet',permission:'readonly',count:1},
 {id:'research',name:'Investigación',kind:'research',provider:'codex',permission:'readonly',count:1}];
const viewOf=(it)=>({id:it.id,name:it.name,repoRoot:it.repoRoot,repoName:it.repoName,baseBranch:'main',extraRepos:[],goal:'Meta de '+it.name+': que el login ande con OAuth.',trust:it.trust,defIssues:it.issues||[],autoDispatch:false,paused:it.paused,maxConcurrent:2,maxRunMinutes:45,leadApprovesSmallPlans:true,verify:[{repoId:'main',command:'npm test',confirmed:false}],roles:ROLES,rev:it.rev,needsCount:it.needsCount,running:it.running,providerBlockedUntil:it.limit?{claude:Date.now()+3600000}:{},...(it.usage?{usageToday:it.usage}:{})});
// B2: the roster, the runs and their pages main would answer for Alfa.
const R1='r-111111111111',R2='r-222222222222',R3='r-333333333333';
const NOW0=Date.now();
const use=(i,o,c)=>({inputTokens:i,outputTokens:o,cacheReadTokens:0,cacheWriteTokens:0,...(c===undefined?{}:{costUSD:c}),estimated:true});
const runV=(id,agentId,x)=>({id,agentId,roleId:agentId.replace(/-\\d+$/,''),taskId:null,mode:'free',trigger:'manual',state:'succeeded',outcome:'progress',provider:'claude',model:'sonnet',resumed:false,queuedAt:NOW0-600000,startedAt:NOW0-590000,endedAt:NOW0-300000,...(x||{})});
const agentV=(id,roleId,roleName,kind,index,x)=>({id,roleId,roleName,kind,index,provider:'claude',model:'sonnet',permission:kind==='dev'?'total':'readonly',status:'idle',paused:false,retired:false,...(x||{})});
const msg=(id,role,text)=>({id,role,ts:NOW0,blocks:[{t:'text',text}]});
const RUNS={
 [R1]:{view:runV(R1,'lead',{mode:'lead',usage:use(40000,2000,0.12)}),items:[msg('10','user','Armá el plan del login'),msg('20','assistant','Listo, ya lo armé.')]},
 [R2]:{view:runV(R2,'dev',{state:'running',outcome:undefined,endedAt:undefined,taskId:'t-12',startedAt:NOW0-180000,usage:use(820000,30000,0.4),context:{pct:0.42,used:84000,window:200000,exact:false}}),
  items:[msg('200','user','Arreglá el login'),msg('300','assistant','Mirando la [guía](https://example.com/docs) del proveedor.')],older:[msg('100','user','Contexto previo de la corrida')]},
 'r-444444444444':{view:runV('r-444444444444','qa',{mode:'free',state:'failed',outcome:'failed',failure:{kind:'limit',until:NOW0+3600000}}),items:[msg('5','assistant','Llegué al límite de uso.'),${JSON.stringify(CUT_ROW)}]},
};
const AGENTS={[TA]:[
 agentV('lead','lead','Líder','lead',1,{model:'opus',lastRun:RUNS[R1].view}),
 agentV('dev','dev','Dev','dev',1,{status:'running',taskId:'t-12',run:RUNS[R2].view}),
 agentV('dev-2','dev','Dev','dev',2),
 agentV('qa','qa','QA','qa',1,{lastRun:RUNS['r-444444444444'].view}),
 agentV('research','research','Investigación','research',1,{provider:'codex',model:undefined,paused:true})]};
const AGENT_RUNS={lead:[R1],dev:[R2],'dev-2':[],qa:['r-444444444444']};
// B3: the boards main would answer (empty until the board section fills Alfa's), each task in full, the Lead thread.
const TK=(id,x)=>({id,rev:1,title:'Tarea '+id,state:'todo',phase:'none',column:'todo',priority:'normal',repoId:'main',isolation:'worktree',needsPlan:true,blockedBy:[],createdBy:'user',createdAt:NOW0-100000+Number(id.slice(2))*1000,updatedAt:NOW0,stateSince:NOW0,userOwned:[],needs:0,comments:0,queued:0,...(x||{})});
const BOARD={[TA]:[],[TB]:[]};
const COMMENTS={};
const ACTIVE_RUN=['queued','starting','running','stopping'];
const colOf=t=>t.state==='cancelled'?null:['todo','done','blocked'].includes(t.state)?t.state:['qa','userOk','integrating'].includes(t.phase)?'review':'doing';
const sumOf=t=>{const {body,runs,earlier,...s}=t;return{...s,column:colOf(t)}};
const pageOf=id=>{const live=(BOARD[id]||[]).filter(t=>t.state!=='cancelled');const counts={todo:0,doing:0,review:0,done:0,blocked:0};for(const t of live)counts[colOf(t)]++;return{teamId:id,rev:1,tasks:live.map(sumOf),cursor:null,done:true,counts,cancelled:(BOARD[id]||[]).length-live.length}};
// earlier: the cursor of the comment pages before the newest one (main counts them all in the summary, never the page).
const detailOf=t=>({...sumOf(t),body:t.body||'',reviewInfo:{round:t.review?t.review.round:0,max:3},comments:COMMENTS[t.id]||[],commentsCursor:t.earlier||null,commentsArchived:0,runs:t.runs||[],approvals:[],cards:[]});
const own=(t,f)=>{if(!t.userOwned.includes(f))t.userOwned=[...t.userOwned,f]};
const findTask=r=>(BOARD[r.teamId]||[]).find(x=>x.id===r.taskId);
const cm=(id,author,authorName,text,x)=>({id,author,authorName,kind:'comment',text,at:NOW0-60000+Number(id.slice(2))*1000,queued:false,...(x||{})});
const LEAD={[TA]:[cm('m-1','user','Vos','Armá el plan del login'),cm('m-2','lead','Líder','Listo: armé **tres tareas** con sus bloqueos.'),cm('m-3','system','Sistema','',{kind:'system',sys:{key:'hireRejected',vars:{roleId:'designer'}}})]};
function fillBoard(){
 BOARD[TA]=[
  TK('t-1',{title:'Arreglar el login',assignee:'dev-2',comments:62,earlier:'m-10',queued:1,body:'El login falla con **OAuth**.',runs:[RUNS[R2].view]}),
  TK('t-2',{title:'Configurar la base',priority:'urgent'}),
  TK('t-3',{title:'Plan del pago',state:'doing',phase:'planning',assignee:'dev',run:{id:R2,agentId:'dev',mode:'plan',state:'running',startedAt:NOW0-60000}}),
  TK('t-4',{title:'Revisar el registro',state:'review',phase:'qa',assignee:'dev',review:{round:1,max:3}}),
  TK('t-5',{title:'Pantalla de perfil',state:'review',phase:'userOk',assignee:'dev',branch:'sn/t-aaaaaa-5',needs:1}),
  TK('t-6',{title:'Readme',state:'done'}),
  TK('t-7',{title:'Deploy',state:'blocked',blockedBy:['t-2'],blocked:{kind:'deps',waitingOn:['t-2']}}),
  TK('t-8',{title:'Tests e2e',priority:'high',userOwned:['priority']})];
 COMMENTS['t-1']=[cm('m-10','dev-2','Dev 2','Empiezo por el refresh.'),cm('m-11','system','Sistema','',{kind:'system',sys:{key:'noQaRole'}})];
}
const fake={on:false,reveal:{ok:true},failGet:new Set(),conflictNext:false,cid:100,tid:8,teams:[item(TA,'Alfa',{running:1,usage:use(1200000,40000,1.75)}),item(TB,'Beta',{trust:'changed',needsCount:1,rev:5,paused:{reason:'user',at:1},limit:true})],
 runNow:r=>{
  if(r.agentId==='qa')return{ok:false,error:'deferred',defer:{reason:'globalCap'}};
  if(r.agentId!=='dev-2')return{ok:false,error:'running'};
  RUNS[R3]={view:runV(R3,'dev-2',{state:'starting',outcome:undefined,endedAt:undefined,startedAt:Date.now(),queuedAt:Date.now()}),items:[msg('0','user',r.prompt||'')]};
  AGENT_RUNS['dev-2']=[R3];
  Object.assign(AGENTS[TA][2],{status:'running',run:RUNS[R3].view});
  return{ok:true,runId:R3}}};
const areaEvents=[];
onTeamChanged(e=>areaEvents.push(e));
window.snApi=fallback({platform:'win32',filePath:()=>'',
 pty:fallback({reattach:async()=>null,spawn:async r=>{calls.spawn.push(r.paneId);return{ptyId:'pty-'+r.paneId,shellKind:'powershell'}},
  write:(...a)=>{calls.ptyWrite.push(a)},submit:async r=>{calls.ptySubmit.push(r);return{ok:true}},resize(){},setActive:ids=>calls.setActive.push(ids),flow(){},kill:async()=>{},killPanes:async()=>0,onData:noop,onExit:noop}),
 system:fallback({openExternal:url=>{calls.openExternal.push(url)}}),
 config:fallback({save:cfg=>{calls.save.push(1);return Promise.resolve()}}),
 status:fallback({snapshot:async()=>[],setViewed:ids=>calls.viewed.push(ids),markRead:async()=>true}),
 agents:fallback({list:async()=>[],startup:async()=>({trigger:null,interrupted:[]})}),
 share:{host:fallback({}),guest:fallback({links:async()=>({persisted:true,guestFingerprint:null,links:[],states:{}})})},
 teams:{
  req:async r=>{calls.req.push(r);if(!fake.on)return{ok:false,error:'disabled'};
   switch(r.op){
    case 'list':return{ok:true,teams:fake.teams.map(({limit,issues,usage,...x})=>x)};
    case 'get':{if(fake.failGet.has(r.teamId))return{ok:false,error:'io'};const it=fake.teams.find(x=>x.id===r.teamId);return it?{ok:true,team:viewOf(it)}:{ok:false,error:'not_found'}}
    case 'trustDiff':return{ok:true,trust:{sha256:'ab'.repeat(32),approvedSha:'cd'.repeat(32),diff:{files:[],risks:[],truncated:false},issues:[]}};
    case 'remove':fake.teams=fake.teams.filter(x=>x.id!==r.teamId);return{ok:true};
    case 'reveal':return fake.reveal;
    case 'roster':{if(fake.rosterGate)await fake.rosterGate.promise;if(fake.rosterFail)return{ok:false,error:'io'};const a=AGENTS[r.teamId];return a?{ok:true,agents:JSON.parse(JSON.stringify(a)),rev:3}:{ok:false,error:'not_found'}}
    case 'runs':return{ok:true,runs:(AGENT_RUNS[r.agentId]||[]).map(id=>RUNS[id].view),cursor:null};
    case 'runPage':{const x=RUNS[r.runId];if(!x)return{ok:false,error:'not_found'};const live=['queued','starting','running','stopping'].includes(x.view.state);
     return r.before?{ok:true,run:x.view,items:x.older||[],cursor:null,done:true,live}:{ok:true,run:x.view,items:x.items,cursor:x.older?x.items[0].id:null,done:!x.older,live}}
    case 'watchRun':return{ok:true};
    case 'runNow':return fake.runNow(r);
    case 'stop':return{ok:true};
    case 'pauseAgent':{const a=(AGENTS[r.teamId]||[]).find(x=>x.id===r.agentId);if(!a)return{ok:false,error:'not_found'};a.paused=r.on;return{ok:true}}
    case 'settings':{const it=fake.teams.find(x=>x.id===r.teamId);if(!it)return{ok:false,error:'not_found'};if(r.patch.paused!==undefined)it.paused=r.patch.paused?{reason:'user',at:Date.now()}:null;return{ok:true,team:viewOf(it)}}
    // B3, as main answers: a user write marks the fields it touched userOwned and bumps the task rev.
    case 'board':return{ok:true,page:pageOf(r.teamId)};
    case 'task':{const t=findTask(r);return t?{ok:true,task:detailOf(t)}:{ok:false,error:'not_found'}}
    case 'moveTask':{const t=findTask(r);if(!t)return{ok:false,error:'not_found'};if(t.rev!==r.baseRev)return{ok:false,error:'conflict',reason:'rev',current:detailOf(t)};
     if(t.run&&ACTIVE_RUN.includes(t.run.state)&&!r.stopRun)return{ok:false,error:'running'};
     if(r.stopRun)delete t.run;t.state=r.to;if(r.to!=='blocked')t.phase='none';if(r.to==='blocked')t.blocked={kind:'user',by:'user'};else delete t.blocked;
     if(r.priority){t.priority=r.priority;own(t,'priority')}own(t,'state');t.rev++;return{ok:true,task:sumOf(t)}}
    case 'updateTask':{const t=findTask(r);if(!t)return{ok:false,error:'not_found'};
     if(fake.conflictNext){fake.conflictNext=false;t.rev++;t.title=t.title+' (Líder)';return{ok:false,error:'conflict',reason:'rev',current:detailOf(t)}}
     if(t.rev!==r.baseRev)return{ok:false,error:'conflict',reason:'rev',current:detailOf(t)};
     // "Que decida el Líder" (assignee null) hands the field back to the Lead instead of owning it.
     for(const [k,val] of Object.entries(r.patch)){if(k==='assignee'&&val===null){delete t.assignee;t.userOwned=t.userOwned.filter(f=>f!=='assignee')}else{t[k]=val;own(t,k)}}t.rev++;return{ok:true,task:detailOf(t)}}
    case 'releaseOwned':{const t=findTask(r);if(!t)return{ok:false,error:'not_found'};t.userOwned=t.userOwned.filter(f=>!r.fields.includes(f));t.rev++;return{ok:true,task:sumOf(t)}}
    // A user comment: main fixes its recipient (the assignee now) when it is written, with that agent's name; the
    // comments live beside the task, so its rev stays.
    case 'comment':{const t=findTask(r);if(!t)return{ok:false,error:'not_found'};const to=(AGENTS[r.teamId]||[]).find(a=>a.id===t.assignee);
     const c=cm('m-'+(++fake.cid),'user','Vos',r.text,{at:Date.now(),queued:true,...(to?{recipient:to.id,recipientName:to.index>1?to.roleName+' '+to.index:to.roleName}:{})});(COMMENTS[t.id]=COMMENTS[t.id]||[]).push(c);t.comments++;t.queued++;return{ok:true,comment:c}}
    case 'createTask':{const id='t-'+(++fake.tid);const d=r.task;const t=TK(id,{...d,createdAt:Date.now(),userOwned:Object.keys(d).filter(k=>k!=='title'&&k!=='body')});(BOARD[r.teamId]=BOARD[r.teamId]||[]).push(t);return{ok:true,task:sumOf(t)}}
    case 'lead':return{ok:true,lead:{messages:LEAD[r.teamId]||[],cursor:null,agent:null}};
    case 'leadSay':{const c=cm('m-'+(++fake.cid),'user','Vos',r.text,{at:Date.now(),queued:true});(LEAD[r.teamId]=LEAD[r.teamId]||[]).push(c);return{ok:true,comment:c}}
    default:return{ok:false,error:'unsupported'}}},
  onChanged:cb=>{subs.changed.add(cb);return()=>subs.changed.delete(cb)},onRunAppend:cb=>{subs.append.add(cb);return()=>subs.append.delete(cb)},onIntegrateProgress:noop},
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
 // Settings opens on Labs through the production SettingsModal (the Labs off confirm, B2, sits inside its Modal).
 return <I18nProvider lang={lang}><Keys/><TeamsWiring/><div style={{height:'100vh'}} className="flex w-full overflow-hidden bg-bg-primary text-text-primary">
  <Sidebar/>
  <main className="relative min-w-0 flex-1"><WorkspaceHost/><SharedWorkspaceHost/><TeamHost/><AgentsBoard/></main>
  <CommandPalette/><TeamSetupDialog/><TeamTrustDialog/><NewTaskDialog/><SettingsModal/>
 </div><NotificationStack/></I18nProvider>}
const seen=[];
window.addEventListener('keydown',e=>{if(e.key==='O')seen.push({prevented:e.defaultPrevented})});
const key=(target,o)=>{const ev=new KeyboardEvent('keydown',{bubbles:true,cancelable:true,...o});target.dispatchEvent(ev);return ev.defaultPrevented};
window.smoke={calls,fake,TA,TB,areaEvents,seen,item,
 app:()=>useAppStore.getState(),agents:()=>useAgentStore.getState(),teams:()=>useTeamsStore.getState(),
 labs:on=>useAppStore.setState(s=>({settings:{...s.settings,labs:{...s.settings.labs,teams:on}}})),
 showLabs:on=>on?useAppStore.getState().openSettings('labs'):useAppStore.getState().setSettingsOpen(false),
 collapse:on=>useAppStore.setState({sidebarCollapsed:on}),
 shared:on=>useShareGuestStore.setState(on?{links:{L1:LINK},activeLinkId:'L1'}:{activeLinkId:null,links:{}}),
 sharedActive:()=>useShareGuestStore.getState().activeLinkId,
 // A hidden window fires no focus events, so useXterm never records the console the user typed in.
 typedIn:(paneId,wsId)=>setFocusedPane(paneId,wsId),
 openTeams,visibleName,
 push:e=>subs.changed.forEach(cb=>cb(e)),
 pushAppend:e=>subs.append.forEach(cb=>cb(e)),
 RUNS,AGENTS,R1,R2,R3,
 reqs:op=>calls.req.filter(r=>r.op===op),
 // A controlled field typed like a user would (React reads the native value setter).
 type:(sel,text)=>{const el=document.querySelector(sel);if(!el)throw new Error('missing '+sel);const set=Object.getOwnPropertyDescriptor(el instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value').set;set.call(el,text);el.dispatchEvent(new Event('input',{bubbles:true}))},
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
 // B3: the board fixtures, toasts of any kind, a native select changed like a user, and one native drag in steps
 // (each step its own call: React renders between them, as between real drag events).
 fillBoard,BOARD,
 toastsOf:kind=>[...document.querySelectorAll('[data-toast-kind='+kind+']')].map(e=>e.textContent),
 select:(sel,value)=>{const el=document.querySelector(sel);if(!el)throw new Error('missing '+sel);Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(el,value);el.dispatchEvent(new Event('change',{bubbles:true}))},
 dragStart:sel=>{const el=document.querySelector(sel);if(!el)throw new Error('missing '+sel);window.__dt=new DataTransfer();el.dispatchEvent(new DragEvent('dragstart',{bubbles:true,cancelable:true,dataTransfer:window.__dt}))},
 dragOver:sel=>{const el=document.querySelector(sel);if(!el)throw new Error('missing '+sel);for(const type of ['dragenter','dragover'])el.dispatchEvent(new DragEvent(type,{bubbles:true,cancelable:true,dataTransfer:window.__dt}))},
 dropOn:sel=>{const el=document.querySelector(sel);if(!el)throw new Error('missing '+sel);el.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:window.__dt}))},
 dragEnd:sel=>{const el=document.querySelector(sel);if(el)el.dispatchEvent(new DragEvent('dragend',{bubbles:true,dataTransfer:window.__dt}))},
 colIds:col=>[...document.querySelectorAll('[data-board-column='+col+'] [data-task-card]')].map(e=>e.dataset.taskCard).join(),
 center:sel=>{const el=document.querySelector(sel);if(!el)throw new Error('missing '+sel);const r=el.getBoundingClientRect();return{x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)}},
 activeCard:()=>document.activeElement?.dataset?.taskCard??null,
 // A focus() that scrolls an overflow-hidden ancestor shifts the whole app sideways (the sidebar slides out of view).
 shifted:()=>{let s=0;for(let el=document.querySelector('[data-team-host]')?.parentElement;el;el=el.parentElement)s+=Math.abs(el.scrollLeft||0)+Math.abs(el.scrollTop||0);return s},
 // B3: a drawer opened before the roster is in (its answer held back), and every selector that showed at any commit
 // while a watch ran (a flash React replaces before the next poll still counts).
 openAgentDrawer,
 dropRoster:()=>useRosterStore.setState({rosters:{},failed:{}}),
 holdRoster:()=>{let release;const promise=new Promise(r=>{release=r});fake.rosterGate={promise,release}},
 releaseRoster:()=>{const g=fake.rosterGate;fake.rosterGate=null;if(g)g.release()},
 watchSeen:sels=>{const seen=new Set();const look=()=>{for(const s of sels)if(document.querySelector(s))seen.add(s)};look();const mo=new MutationObserver(look);mo.observe(document.body,{childList:true,subtree:true,attributes:true});window.__watch=()=>{mo.disconnect();look();return [...seen]}},
 watchStop:()=>window.__watch(),
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
 // B3: Tablero is the board now; an empty board shows the definition summary under its first steps.
 ok(await until("smoke.has('[data-board-empty] [data-team-goal]')",3000),'an empty board shows the definition summary');
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
 ok((await js("smoke.attr('[data-team-tab=agents]','aria-selected')"))==='true'&&(await until("smoke.has('[data-agents-roster]')",2000)),'Agentes selected shows the roster (B2)');
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
 // Alfa remembers the Agentes tab: the roster (B2) is its body.
 ok(await until("!smoke.has('[data-team-load-failed]')&&(smoke.has('[data-team-role]')||smoke.has('[data-agents-roster]'))",3000),'Reintentar loads the team');
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

 // B2, the Agentes tab: the roster from main, Ejecutar ahora (runNow, never a pty), deferred, the run chat
 // (ChatScroller over runPage, pushed lines of the watched run only), links, Frenar, pauses, usage today.
 const R2='r-222222222222',R3='r-333333333333',R4='r-444444444444';
 await js("smoke.click('[data-team-tab=agents]')");
 ok(await until("smoke.count('[data-agent-card]')===5",3000),'the roster shows the five agents of Alfa');
 v=await js("({first:document.querySelector('[data-agents-roster] [data-agent-card]')?.dataset.agentCard,lead:smoke.has('[data-lead-card=lead] [data-agent-card=lead]'),leadW:document.querySelector('[data-lead-card]').getBoundingClientRect().width,rosterW:document.querySelector('[data-agents-roster]').getBoundingClientRect().width,devStatus:smoke.attr('[data-agent-card=dev]','data-agent-status'),devLine:smoke.text('[data-agent-card=dev] [data-agent-line]'),dev2Line:smoke.text('[data-agent-card=dev-2] [data-agent-line]'),name2:smoke.text('[data-agent-card=dev-2] [data-agent-name]'),elapsed:smoke.text('[data-agent-card=dev] [data-run-elapsed]'),usage:smoke.text('[data-agent-card=dev] [data-run-usage]'),ctx:smoke.attr('[data-agent-card=dev] [data-context-chip]','data-context-chip'),fail:smoke.attr('[data-agent-card=qa] [data-failure-chip]','data-failure-chip'),paused:smoke.attr('[data-agent-card=research] [data-agent-pause]','data-agent-pause'),pausedChip:smoke.text('[data-agent-card=research]').includes('En pausa')})");
 ok(v.first==='lead'&&v.lead&&Math.abs(v.leadW-v.rosterW)<2,'the Lead card goes first, full width',v);
 ok(v.devStatus==='running'&&v.devLine==='Trabajando en t-12'&&v.dev2Line==='Libre'&&v.name2==='Dev 2','line 2: Trabajando en t-12, Libre; the second Dev is Dev 2',v);
 ok(/^\\d+ min$/.test(v.elapsed)&&v.usage.includes('tokens')&&v.usage.includes('estimado')&&v.ctx==='42','a live run: elapsed, usage (estimado) and context chips',v);
 ok(v.fail==='limit'&&v.paused==='on'&&v.pausedChip,'the failure chip of the last run, a paused agent',v);
 v=await js("({runNow:[...document.querySelectorAll('[data-run-now]')].map(e=>e.dataset.runNow).sort().join(),stop:[...document.querySelectorAll('[data-agent-card] [data-run-stop]')].map(e=>e.dataset.runStop).join(),chat:smoke.count('[data-agent-chat]')})");
 ok(v.runNow==='dev-2,lead,qa,research'&&v.stop===R2&&v.chat===5,'Ejecutar ahora on idle agents only, Frenar on the live run, a chat on every card',v);
 await settle(600);await shot('teams-agents');

 // Ejecutar ahora: the drawer opens on the agent, its composer takes the keyboard; Enter is a new line.
 await js("smoke.click('[data-run-now=dev-2]')");
 ok(await until("smoke.has('[data-drawer=team-agent] [data-agent-drawer=dev-2]')",2000),'Ejecutar ahora opens the agent drawer');
 ok(await until("smoke.activeIs('data-run-now-input')",2000),'the composer takes the keyboard');
 v=await js("({empty:smoke.text('[data-run-empty]'),send:document.querySelector('[data-run-now-send]').disabled,note:smoke.attr('[data-run-now-note]','data-run-now-note'),title:smoke.text('[data-drawer=team-agent]')})");
 ok(v.empty.includes('Todavía no corrió')&&v.send&&v.note==='hint'&&v.title.includes('Dev 2'),'no run yet: the empty line; Ejecutar ahora is off until there is text',v);
 const ptyBefore=await js("smoke.calls.ptyWrite.length+smoke.calls.ptySubmit.length");
 await js("smoke.type('[data-run-now-input]','  Revisá el README\\\\ny los links  ')");await settle();
 await js("smoke.keyActive({key:'Enter',code:'Enter',keyCode:13})");await settle();
 ok((await js("smoke.reqs('runNow').length"))===0,'Enter in the composer sends nothing');
 await js("smoke.click('[data-run-now-send]')");
 ok(await until("smoke.reqs('runNow').length===1",2000),'the button sends runNow');
 v=await js("smoke.reqs('runNow')[0]");
 ok(v.teamId===TA&&v.agentId==='dev-2'&&v.prompt==='Revisá el README\\ny los links'&&!('taskId' in v),'runNow carries the request text (trimmed), no task',v);
 ok((await js("smoke.calls.ptyWrite.length+smoke.calls.ptySubmit.length"))===ptyBefore,'Ejecutar ahora never writes to a pty');
 ok(await until("smoke.has('[data-chat-view=\\"team:"+R3+"\\"]')",3000),'the drawer moves to the new run and reads it through the chat scroller');
 ok(await until("smoke.attr('[data-run-now-note]','data-run-now-note')==='blocked'",2000),'the roster reloads: the new run is live');
 v=await js("({watch:smoke.reqs('watchRun').at(-1),page:smoke.reqs('runPage').some(r=>r.runId==='"+R3+"'&&!r.before),noteText:smoke.text('[data-run-now-note]'),draft:document.querySelector('[data-run-now-input]').value,send:document.querySelector('[data-run-now-send]').disabled,first:smoke.text('[data-drawer=team-agent] [data-chat-row=user]')})");
 ok(v.watch&&v.watch.runId===R3&&v.page,'watchRun, then runPage of the new run',v);
 ok(v.draft===''&&v.send&&v.noteText.includes('Dev 2 está trabajando'),'the box empties; while the run lives the composer says so',v);
 ok(v.first.includes('Revisá el README'),'the run page shows the request as the first message',v);
 // A pushed line of the watched run appends; one of another run does not.
 await js("smoke.pushAppend({teamId:'"+TA+"',runId:'"+R3+"',agentId:'dev-2',items:[{id:'40',role:'assistant',ts:Date.now(),blocks:[{t:'text',text:'Listo el README nuevo'}]}],state:'running'})");
 ok(await until("smoke.text('[data-drawer=team-agent] [data-chat-scroll]').includes('Listo el README nuevo')",2000),'teams:runAppend of the watched run appends to its chat');
 v=await js("({state:smoke.attr('[data-run-header]','data-run-state'),working:smoke.text('[data-chat-working]')})");
 ok(v.state==='running'&&v.working.includes('Dev 2 está trabajando'),'the pushed state reaches the run header and the working row',v);
 await js("smoke.pushAppend({teamId:'"+TA+"',runId:'"+R2+"',agentId:'dev',items:[{id:'900',role:'assistant',ts:Date.now(),blocks:[{t:'text',text:'Esto es de otra corrida'}]}]})");await settle();
 ok(!(await js("smoke.text('[data-drawer=team-agent] [data-chat-scroll]').includes('otra corrida')")),'a line of another run does not append here');

 // Deferred: main's reason in words, inline, and the draft stays (Ctrl+Enter sends).
 await js("smoke.click('[data-run-now=qa]')");
 ok(await until("smoke.has('[data-agent-drawer=qa]')&&smoke.activeIs('data-run-now-input')",2000),'Ejecutar ahora on QA moves the drawer there');
 await js("smoke.type('[data-run-now-input]','Probá el login')");await settle();
 await js("smoke.keyActive({key:'Enter',code:'Enter',keyCode:13,ctrlKey:true})");
 ok(await until("smoke.attr('[data-run-now-note]','data-run-now-note')==='error'",2000),'a deferred answer shows inline');
 v=await js("({text:smoke.text('[data-run-now-note]'),req:smoke.reqs('runNow').at(-1),draft:document.querySelector('[data-run-now-input]').value,fail:smoke.attr('[data-run-header] [data-failure-chip]','data-failure-chip'),state:smoke.attr('[data-run-header]','data-run-state')})");
 ok(v.text==='Ahora no: los equipos ya tienen el máximo de corridas a la vez.'&&v.req.agentId==='qa'&&v.req.prompt==='Probá el login'&&v.draft==='Probá el login','deferred: the reason in words, Ctrl+Enter sent it, the draft stays',v);
 ok(v.state==='failed'&&v.fail==='limit','with no run picked the drawer shows the last run, its failure in the header',v);
 // RunLog's cut row comes from main in English: the run chat words it in the UI language.
 const cutText="smoke.text('[data-drawer=team-agent] [data-chat-system]')";
 ok(await until(cutText+".includes('El registro de la corrida quedó muy grande')",2000),'es: the run log cut row is worded in Spanish',await js(cutText));
 ok(!(await js(cutText)).includes('Run log cut'),'es: the English cut text from main does not show');
 await js("smoke.setLang('en')");
 ok(await until(cutText+".includes('The run log got too big')",2000),'en: the cut row is worded from the en catalog',await js(cutText));
 ok(!(await js(cutText)).includes('[Run log cut'),'en: not the raw text main sent');
 await js("smoke.setLang('es')");
 ok(await until(cutText+".includes('El registro de la corrida')",2000),'back to es: the cut row follows the language');

 // The live run of Dev: its page, Load earlier, a link behind a confirm.
 await js("smoke.click('[data-agent-chat=dev]')");
 ok(await until("smoke.has('[data-chat-view=\\"team:"+R2+"\\"] [data-chat-load-earlier]')",3000),'Ver chat opens the live run of Dev, with Load earlier');
 v=await js("({rows:smoke.text('[data-drawer=team-agent] [data-chat-scroll]'),working:smoke.text('[data-chat-working]'),state:smoke.attr('[data-run-header]','data-run-state'),mode:smoke.text('[data-run-mode]'),trigger:smoke.text('[data-run-trigger]'),watch:smoke.reqs('watchRun').slice(-2).map(r=>r.runId),picker:smoke.attr('[data-run-picker]','value')??document.querySelector('[data-run-picker]')?.value})");
 ok(v.rows.includes('Arreglá el login')&&v.working.includes('Dev está trabajando')&&v.state==='running'&&v.mode==='Pedido directo'&&v.trigger.includes('la ejecutaste vos'),'the run page renders through ChatScroller with its header',v);
 ok(v.watch[0]===null&&v.watch[1]===R2,'leaving the QA run unwatches it, then the Dev run is watched',v);
 await js("smoke.click('[data-chat-load-earlier]')");
 ok(await until("document.querySelector('[data-drawer=team-agent] [data-chat-id]')?.dataset.chatId==='100'",2000),'Load earlier puts the older page in front');
 ok((await js("smoke.reqs('runPage').at(-1).before"))==='200','Load earlier asks for the page before the oldest offset');
 await js("smoke.click('[data-drawer=team-agent] [data-md-link]')");await settle();
 v=await js("({dialog:smoke.has('[data-confirm]'),target:document.body.innerText.includes('https://example.com/docs'),opened:smoke.calls.openExternal.length})");
 ok(v.dialog&&v.target&&v.opened===0,'a link in the run chat asks first and shows its target',v);
 await js("smoke.click('[data-confirm]')");await settle();
 ok(JSON.stringify(await js('smoke.calls.openExternal'))==='[\\"https://example.com/docs\\"]','confirmed: it opens in the browser');

 // Frenar asks first; cancelled sends nothing, confirmed sends stop.
 await js("smoke.click('[data-agent-card=dev] [data-run-stop]')");await settle();
 ok((await js("smoke.text('body')")).includes('¿Frenar la corrida de Dev?'),'Frenar asks first');
 await js("smoke.cancelConfirm()");await settle();
 ok((await js("smoke.reqs('stop').length"))===0,'cancelled: nothing is stopped');
 await js("smoke.click('[data-agent-card=dev] [data-run-stop]')");await settle();
 await js("smoke.click('[data-confirm]')");
 ok(await until("smoke.reqs('stop').length===1",2000),'confirmed: stop goes to main');
 v=await js("smoke.reqs('stop')[0]");
 ok(v.teamId===TA&&v.runId===R2,'stop carries the team and the run',v);

 // The agent pause and the team pause; usage today in the header.
 await js("smoke.click('[data-agent-card=dev-2] [data-agent-pause]')");
 ok(await until("smoke.reqs('pauseAgent').length===1",2000),'Pausar sends pauseAgent');
 v=await js("smoke.reqs('pauseAgent')[0]");
 ok(v.teamId===TA&&v.agentId==='dev-2'&&v.on===true,'pauseAgent on for Dev 2',v);
 ok(await until("smoke.attr('[data-agent-card=dev-2] [data-agent-pause]','data-agent-pause')==='on'",2000),'the roster reloads: Dev 2 shows paused');
 v=await js("({usage:smoke.text('[data-team-usage]'),pause:smoke.attr('[data-team-pause]','data-team-pause')})");
 ok(v.usage.startsWith('Hoy:')&&v.usage.includes('estimado')&&v.pause==='off','header: usage today (estimado) and Pausar equipo',v);
 await js("smoke.click('[data-team-pause]')");
 ok(await until("smoke.attr('[data-team-pause]','data-team-pause')==='on'&&smoke.has('[data-team-paused-chip=user]')",2000),'Pausar equipo: the header shows the pause');
 v=await js("smoke.reqs('settings').at(-1)");
 ok(v.teamId===TA&&v.patch.paused===true,'settings carries paused true',v);
 await js("smoke.click('[data-team-pause]')");
 ok(await until("smoke.attr('[data-team-pause]','data-team-pause')==='off'&&!smoke.has('[data-team-paused-chip]')",2000),'Reanudar equipo lifts it');
 // A run that starts or ends moves the header (usage today, the Agentes count): main tags that commit 'team' too, as
 // TeamService.commit sends it, and the core pulls the view once; the roster sync pulls the roster only, once: the
 // core hands each scope over from its own timer, and the sync folds them (SCOPE_FOLD_MS).
 const pulls="({gets:smoke.gets(smoke.TA),rosters:smoke.reqs('roster').length})";
 const p0=await js(pulls);
 await js("Object.assign(smoke.fake.teams.find(x=>x.id===smoke.TA),{running:2,usage:{inputTokens:2000000,outputTokens:500000,cacheReadTokens:0,cacheWriteTokens:0,costUSD:3.5,estimated:true}});smoke.push({teamId:smoke.TA,rev:3,scopes:['agents','run','list','team'],runId:'"+R2+"'})");
 ok(await until("smoke.text('[data-team-usage]').includes('3,50')&&smoke.attr('[data-team-tab=agents] [data-team-tab-count]','data-team-tab-count')==='2'",2000),'a run start (run and team) pulls the view again: usage today and the running count follow',await js("({usage:smoke.text('[data-team-usage]'),count:smoke.attr('[data-team-tab=agents] [data-team-tab-count]','data-team-tab-count')})"));
 await settle(400);
 const p1=await js(pulls);
 ok(p1.gets-p0.gets===1&&p1.rosters-p0.rosters===1,'one run event: one get of the view (the core, on team), and one of the roster',{p0,p1});
 // A run commit that leaves the header alone carries no 'team': the roster only, no get.
 await js("smoke.push({teamId:smoke.TA,rev:3,scopes:['agents','run','list'],runId:'"+R2+"'})");
 ok(await until("smoke.reqs('roster').length>"+p1.rosters,2000),'a run event without team pulls the roster');
 await settle(400);
 v=await js(pulls);
 ok(v.gets===p1.gets&&v.rosters-p1.rosters===1,'a run event without team pulls no view, and the roster once',{p1,v});
 await js("smoke.fake.teams.find(x=>x.id===smoke.TA).running=1;smoke.push({teamId:smoke.TA,rev:3,scopes:['agents','run','list','team'],runId:'"+R2+"'})");
 ok(await until("smoke.attr('[data-team-tab=agents] [data-team-tab-count]','data-team-tab-count')==='1'",2000),'and back: the running count follows the run end');

 // Zoom with the drawer open: no page overflow, the composer button on screen.
 for(const z of [1.25,1.5]){
  // The drawer lays out again after the zoom (its clamp width): wait for it instead of one fixed settle.
  w.webContents.setZoomFactor(z);await settle(250);
  const laid=await until("!smoke.overflow()&&smoke.inView('[data-run-now-send]')&&smoke.inView('[data-team-close]')",2000);
  v=await js("({over:smoke.overflow(),send:smoke.inView('[data-run-now-send]'),close:smoke.inView('[data-team-close]')})");
  ok(laid&&!v.over&&v.send&&v.close,'zoom '+z+' with the agent drawer: no overflow, composer and close on screen',v);
 }
 w.webContents.setZoomFactor(1);await settle(200);
 await settle(600);await shot('teams-agent-drawer');
 await js("smoke.click('[data-drawer=team-agent] [data-drawer-close]')");await settle(200);
 v=await js("({drawer:smoke.has('[data-drawer=team-agent]'),watch:smoke.reqs('watchRun').at(-1)})");
 ok(!v.drawer&&v.watch.runId===null,'closing the drawer unwatches the run',v);

 // B3, the Lead conversation: the card shows the last two messages; Escribile al Líder opens the thread.
 v=await js("({last:smoke.count('[data-lead-card] [data-lead-msg]'),sys:smoke.text('[data-lead-card] [data-comment-sys=hireRejected]'),write:smoke.has('[data-lead-card] [data-lead-write]')})");
 ok(v.last===2&&v.sys.includes('Rechazaste contratar el rol designer')&&v.write,'the Lead card shows its last two messages (a sys one worded from its key) and Escribile al Líder',v);
 await js("smoke.click('[data-lead-write]')");
 ok(await until("smoke.has('[data-drawer=team-agent] [data-lead-thread]')",2000),'Escribile al Líder opens the Lead drawer on the conversation');
 v=await js("({view:smoke.attr('[data-lead-view]','data-lead-view'),msgs:smoke.count('[data-lead-thread] [data-lead-msg]'),md:smoke.has('[data-lead-thread] [data-lead-msg=m-2] strong'),mine:smoke.attr('[data-lead-thread] [data-lead-msg=m-1]','data-lead-author'),run:smoke.has('[data-drawer=team-agent] [data-run-now-composer]')})");
 ok(v.view==='thread'&&v.msgs===3&&v.md&&v.mine==='user'&&!v.run,'Conversación: the three messages (the Lead in Markdown), no run composer there',v);
 ok(await until("smoke.activeIs('data-lead-composer')",2000),'the Lead composer takes the keyboard');
 await settle(300);
 ok((await js('smoke.shifted()'))===0,'focusing the composer of a drawer sliding in scrolls nothing around Teams',await js('smoke.shifted()'));
 await js("smoke.type('[data-lead-composer]','Sumá una tarea de tests')");await settle();
 await js("smoke.keyActive({key:'Enter',code:'Enter',keyCode:13})");await settle();
 ok((await js("smoke.reqs('leadSay').length"))===0,'Enter in the Lead composer sends nothing');
 await js("smoke.click('[data-lead-send]')");
 ok(await until("smoke.reqs('leadSay').length===1",2000),'Enviar sends leadSay');
 v=await js("smoke.reqs('leadSay')[0]");
 ok(v.teamId===TA&&v.text==='Sumá una tarea de tests','leadSay carries the trimmed text',v);
 ok(await until("smoke.text('[data-lead-thread] [data-lead-queued]').includes('Lo lee en su próxima corrida')&&document.querySelector('[data-lead-composer]').value===''",2000),'the message shows as queued for the next run and the box empties');
 ok((await js("smoke.calls.ptyWrite.length+smoke.calls.ptySubmit.length"))===ptyBefore,'the Lead chat never writes to a pty');
 await js("smoke.click('[data-lead-tab=run]')");
 ok(await until("smoke.attr('[data-lead-view]','data-lead-view')==='run'&&smoke.has('[data-chat-view=\\"team:r-111111111111\\"]')",3000),'Corrida shows the Lead runs (its last run in the chat scroller)');
 await js("smoke.click('[data-drawer=team-agent] [data-drawer-close]')");await settle(200);
 // The Lead drawer opened before the roster is in (from a place that never loaded it): a loading line until the
 // roster says it is the Lead, then the conversation; nothing of the run view shows in between, though its runs
 // are already known (the drawer above listed them).
 const runView="['[data-drawer=team-agent] [data-run-picker]','[data-drawer=team-agent] [data-chat-view]','[data-drawer=team-agent] [data-run-empty]','[data-drawer=team-agent] [data-run-now-composer]','[data-drawer=team-agent] [data-lead-view=run]']";
 const leadRuns="smoke.reqs('runs').filter(r=>r.agentId==='lead').length";
 const leadRuns0=await js(leadRuns);
 await js("smoke.holdRoster();smoke.dropRoster();smoke.watchSeen("+runView+");smoke.openAgentDrawer('lead',undefined,'thread')");
 ok(await until("smoke.has('[data-drawer=team-agent] [data-agent-loading]')",2000),'opened before the roster: the drawer says it is loading the agents');
 ok(await until(leadRuns+">"+leadRuns0,2000),'the drawer still asks for the runs meanwhile');
 await settle(300);
 v=await js("({loading:smoke.text('[data-drawer=team-agent] [data-agent-loading]'),thread:smoke.has('[data-drawer=team-agent] [data-lead-thread]')})");
 ok(v.loading==='Cargando los agentes...'&&!v.thread,'while the roster is out: only the loading line',v);
 await js("smoke.releaseRoster()");
 ok(await until("smoke.has('[data-drawer=team-agent] [data-lead-thread]')&&smoke.attr('[data-lead-view]','data-lead-view')==='thread'",3000),'the roster lands: the Lead drawer shows the conversation');
 v=await js("smoke.watchStop()");
 ok(v.length===0,'no run view showed before the conversation',v);
 await js("smoke.click('[data-drawer=team-agent] [data-drawer-close]')");await settle(200);
 // A roster that does not come: the drawer says so with Reintentar (still no run view), and Reintentar loads it.
 await js("smoke.fake.rosterFail=true;smoke.dropRoster();smoke.watchSeen("+runView+");smoke.openAgentDrawer('lead',undefined,'thread')");
 ok(await until("smoke.has('[data-drawer=team-agent] [data-agent-load-failed] [data-agent-retry]')",2000),'the roster did not come: the drawer says so with Reintentar');
 ok((await js("smoke.text('[data-drawer=team-agent] [data-agent-load-failed]')")).includes('No se pudieron cargar los agentes.'),'its words come from the catalog');
 await js("smoke.fake.rosterFail=false;smoke.click('[data-agent-retry]')");
 ok(await until("smoke.has('[data-drawer=team-agent] [data-lead-thread]')",3000),'Reintentar loads the roster: the conversation');
 v=await js("smoke.watchStop()");
 ok(v.length===0,'no run view while the roster failed either',v);
 await js("smoke.click('[data-drawer=team-agent] [data-drawer-close]')");await settle(200);

 // B3, the board: placement by column (qa -> Revisión), counts, bands and the card chips.
 await js("smoke.fillBoard()");
 await js("smoke.click('[data-team-tab=board]')");
 ok(await until("smoke.count('[data-board-column]')===5&&smoke.count('[data-task-card]')===8",3000),'Tablero shows the five columns and the eight live tasks');
 v=await js("({order:[...document.querySelectorAll('[data-board-column]')].map(c=>c.dataset.boardColumn).join(),todo:smoke.colIds('todo'),doing:smoke.colIds('doing'),review:smoke.colIds('review'),done:smoke.colIds('done'),blocked:smoke.colIds('blocked'),counts:[...document.querySelectorAll('[data-board-column]')].map(c=>c.dataset.columnCount).join(),head:smoke.text('[data-board-column=review] h3')})");
 ok(v.order==='todo,doing,review,done,blocked'&&v.head==='Revisión','columns in order, named in es',v);
 ok(v.todo==='t-2,t-8,t-1'&&v.doing==='t-3'&&v.review==='t-4,t-5'&&v.done==='t-6'&&v.blocked==='t-7','placement by column: qa and userOk in Revisión, Por hacer by band',v);
 ok(v.counts==='3,1,2,1,1','each column counts its tasks',v);
 v=await js("({bands:[...document.querySelectorAll('[data-board-column=todo] [data-band]')].map(e=>e.dataset.band).join(),phase5:smoke.text('[data-task-card=t-5] [data-task-phase-chip]'),amber5:smoke.attr('[data-task-card=t-5] [data-task-phase-chip]','class').includes('state-action'),amber3:smoke.attr('[data-task-card=t-3] [data-task-phase-chip]','class').includes('state-action'),pin:smoke.has('[data-task-card=t-8] [data-task-pinned]'),owned8:smoke.attr('[data-task-card=t-8]','data-user-owned'),owned2:smoke.attr('[data-task-card=t-2]','data-user-owned'),blocked:smoke.text('[data-task-card=t-7] [data-task-blocked]'),qa:smoke.text('[data-task-card=t-4] [data-task-qa]'),run:smoke.has('[data-task-card=t-3] [data-task-running]'),needs:smoke.attr('[data-task-card=t-5] [data-task-needs]','data-task-needs'),queued:smoke.text('[data-task-card=t-1] [data-task-queued]'),assignee:smoke.text('[data-task-card=t-1] [data-task-assignee]'),unassigned:smoke.text('[data-task-card=t-2] [data-task-assignee]'),branch:smoke.text('[data-task-card=t-5] [data-task-branch]'),state:smoke.attr('[data-task-card=t-4]','data-task-state'),phase:smoke.attr('[data-task-card=t-4]','data-task-phase')})");
 ok(v.bands==='urgent,high,normal','Por hacer separates its three bands',v);
 ok(v.phase5==='Esperando tu OK'&&v.amber5&&!v.amber3,'the phase chip is amber only while it waits on the user',v);
 ok(v.pin&&v.owned8==='true'&&v.owned2==='false','the pin and data-user-owned on a task the user owns',v);
 ok(v.blocked==='Esperando a t-2'&&v.qa==='QA 2/3'&&v.run&&v.needs==='1'&&v.queued==='1 en cola','chips: blocked line, QA round, run glyph, need dot, queued comments',v);
 ok(v.assignee==='Dev 2'&&v.unassigned==='Sin asignar'&&v.branch.includes('sn/t-aaaaaa-5')&&v.state==='review'&&v.phase==='qa','assignee label, unassigned, branch, state and phase attributes',v);
 await settle(600);await shot('teams-board');

 // Drag Por hacer -> Bloqueado: moveTask with the rev; the reply's userOwned pins the card.
 const writes="smoke.reqs('moveTask').length+smoke.reqs('updateTask').length";
 await js("smoke.dragStart('[data-task-card=t-1]')");await settle();
 v=await js("({doing:smoke.attr('[data-board-column=doing]','data-drop-refused'),review:smoke.attr('[data-board-column=review]','data-drop-refused'),reason:smoke.text('[data-board-column=doing] [data-drop-reason]'),blocked:smoke.attr('[data-board-column=blocked]','data-drop-refused'),todo:smoke.attr('[data-board-column=todo]','data-drop-refused')})");
 ok(v.doing==='phaseColumn'&&v.review==='phaseColumn'&&v.reason.includes('Acá mueve las tarjetas el equipo')&&v.blocked===null&&v.todo===null,'during a drag En curso and Revisión dim with the reason; Bloqueado and its own column do not',v);
 await js("smoke.dragOver('[data-board-column=blocked]')");await settle();
 ok((await js("smoke.count('[data-board-column=blocked] [data-band-drop]')"))===4,'the column under the drag shows the four band zones');
 const w0=await js(writes);
 await js("smoke.dropOn('[data-board-column=blocked] header')");await js("smoke.dragEnd('[data-task-card=t-1]')");
 ok(await until("smoke.reqs('moveTask').length===1",2000),'the drop sends moveTask');
 v=await js("smoke.reqs('moveTask')[0]");
 ok(v.teamId===TA&&v.taskId==='t-1'&&v.to==='blocked'&&v.baseRev===1&&!('stopRun' in v)&&!('priority' in v),'moveTask: to blocked with the task rev, no stopRun, no priority off a band',v);
 ok(await until("smoke.colIds('blocked').split(',').includes('t-1')&&smoke.attr('[data-task-card=t-1]','data-user-owned')==='true'&&smoke.has('[data-task-card=t-1] [data-task-pinned]')",2000),'the card lands in Bloqueado with the pin of the reply (userOwned)');
 ok((await js("smoke.count('[data-band-drop]')+smoke.count('[data-drop-refused]')"))===0,'after the drop no zone and no dim stay');

 // A drop on En curso sends nothing and says why.
 const w1=await js(writes);
 await js("smoke.dragStart('[data-task-card=t-2]')");await settle();
 await js("smoke.dragOver('[data-board-column=doing]')");await settle();
 v=await js("({zones:smoke.count('[data-board-column=doing] [data-band-drop]'),refused:smoke.attr('[data-board-column=doing]','data-drop-refused')})");
 ok(v.zones===0&&v.refused==='phaseColumn','En curso refuses: no band zones, dimmed with its reason',v);
 await js("smoke.dropOn('[data-board-column=doing] header')");await js("smoke.dragEnd('[data-task-card=t-2]')");await settle(200);
 ok((await js(writes))===w1&&w1===w0+1,'the refused drop sends nothing');
 ok(await until("smoke.toastsOf('warning').some(x=>x.includes('Acá mueve las tarjetas el equipo'))",2000),'a toast says why it was refused');
 ok((await js("smoke.colIds('todo')")).split(',').includes('t-2'),'the card stays in Por hacer');

 // A band inside the same column sends the priority only (updateTask).
 await js("smoke.dragStart('[data-task-card=t-2]')");await settle();
 await js("smoke.dragOver('[data-board-column=todo]')");await settle();
 ok((await js("smoke.count('[data-board-column=todo] [data-band-drop]')"))===4,'its own column shows the band zones');
 await js("smoke.dragOver('[data-board-column=todo] [data-band-drop=low]')");await settle();
 await js("smoke.dropOn('[data-board-column=todo] [data-band-drop=low]')");await js("smoke.dragEnd('[data-task-card=t-2]')");
 ok(await until("smoke.reqs('updateTask').length===1",2000),'the band drop sends updateTask');
 v=await js("smoke.reqs('updateTask')[0]");
 ok(v.taskId==='t-2'&&v.baseRev===1&&v.patch.priority==='low'&&Object.keys(v.patch).length===1,'updateTask {priority: low} with the rev, nothing else',v);
 ok(await until("smoke.attr('[data-task-card=t-2]','data-task-priority')==='low'&&smoke.attr('[data-task-card=t-2]','data-user-owned')==='true'&&smoke.colIds('todo').split(',').pop()==='t-2'",2000),'the card moves to the low band, pinned');
 // A card the flow moves during its drag remounts in another column (its dragend is lost): the drag state goes.
 await js("smoke.dragStart('[data-task-card=t-2]')");await settle();
 ok((await js("smoke.attr('[data-board-column=doing]','data-drop-refused')"))==='phaseColumn','the drag dims En curso');
 await js("(()=>{const t=smoke.BOARD['"+TA+"'].find(x=>x.id==='t-2');t.state='doing';t.phase='planning'})();smoke.push({teamId:'"+TA+"',rev:1,scopes:['board']})");
 ok(await until("smoke.colIds('doing').split(',').includes('t-2')&&smoke.count('[data-drop-refused]')===0",3000),'a dragged card the flow moves meanwhile ends the drag: no column stays dimmed');
 await js("(()=>{const t=smoke.BOARD['"+TA+"'].find(x=>x.id==='t-2');t.state='todo';t.phase='none'})();smoke.push({teamId:'"+TA+"',rev:1,scopes:['board']})");
 ok(await until("smoke.colIds('todo').split(',').pop()==='t-2'",3000),'and back in Por hacer once the flow puts it back');

 // A task with a live run asks first; cancelled sends nothing, confirmed it carries stopRun.
 for(const confirm of [false,true]){
  await js("smoke.dragStart('[data-task-card=t-3]')");await settle();
  await js("smoke.dragOver('[data-board-column=todo]')");await settle();
  await js("smoke.dropOn('[data-board-column=todo] header')");await js("smoke.dragEnd('[data-task-card=t-3]')");await settle();
  ok((await js("smoke.text('body')")).includes('¿Mover t-3 y frenar su corrida?')&&(await js("smoke.text('body')")).includes('Dev está trabajando en esta tarea'),'a drop of a running task asks to stop its run first');
  const m=await js("smoke.reqs('moveTask').length");
  if(!confirm){
   await js("smoke.cancelConfirm()");await settle();
   ok((await js("smoke.reqs('moveTask').length"))===m&&(await js("smoke.colIds('doing')"))==='t-3','cancelled: nothing sent, the card stays in En curso');
  }else{
   await js("smoke.click('[data-confirm]')");
   ok(await until("smoke.reqs('moveTask').length==="+(m+1),2000),'confirmed: moveTask goes');
   v=await js("smoke.reqs('moveTask').at(-1)");
   ok(v.taskId==='t-3'&&v.to==='todo'&&v.stopRun===true&&v.baseRev===1,'the move carries stopRun',v);
   ok(await until("smoke.colIds('todo').split(',').includes('t-3')&&!smoke.has('[data-task-card=t-3] [data-task-running]')",2000),'the card is in Por hacer, its run gone');
  }
 }

 // Keyboard: arrows move the selection (Up/Down in a column, Left/Right across), Enter opens the task.
 const todoIds=(await js("smoke.colIds('todo')")).split(',');
 await js("document.querySelector('[data-task-card="+todoIds[0]+"]').focus({preventScroll:true})");
 await js("smoke.keyActive({key:'ArrowDown',code:'ArrowDown',keyCode:40})");await settle();
 ok((await js('smoke.activeCard()'))===todoIds[1],'ArrowDown moves to the next card of the column',todoIds);
 await js("smoke.keyActive({key:'ArrowRight',code:'ArrowRight',keyCode:39})");await settle();
 v=await js('smoke.activeCard()');
 ok(v==='t-5','ArrowRight skips the empty En curso and lands on the same row of Revisión',v);
 v=await js("({tab:document.querySelector('[data-task-card=t-5]').tabIndex,old:document.querySelector('[data-task-card="+todoIds[1]+"]').tabIndex,sel:smoke.attr('[data-task-card=t-5]','data-task-selected')})");
 ok(v.tab===0&&v.old===-1&&v.sel==='true','the selected card holds the one tab stop (roving tabIndex)',v);
 await js("smoke.keyActive({key:'ArrowLeft',code:'ArrowLeft',keyCode:37})");await settle();
 ok((await js('smoke.activeCard()'))===todoIds[1],'ArrowLeft goes back');
 await js("smoke.keyActive({key:'Enter',code:'Enter',keyCode:13})");
 ok(await until("smoke.has('[data-task-drawer="+todoIds[1]+"]')",2000),'Enter opens the task drawer');
 await js("smoke.keyActive({key:'Escape',code:'Escape',keyCode:27})");await settle(200);
 v=await js("({drawer:smoke.has('[data-drawer=team-task]'),host:smoke.has('[data-team-host]')})");
 ok(!v.drawer&&v.host,'Esc closes the drawer first, Teams stays',v);

 // Shift+F10: the card menu with the same moves as a drag ("Mover a" parity), Prioridad radios, Soltar fijado.
 await js("document.querySelector('[data-task-card=t-8]').focus({preventScroll:true})");
 await js("smoke.keyActive({key:'F10',code:'F10',keyCode:121,shiftKey:true})");await settle();
 v=await js("[...document.querySelectorAll('[role=menu] [role^=menuitem]')].map(e=>e.textContent+'|'+(e.getAttribute('aria-disabled')||'')+'|'+(e.getAttribute('aria-checked')||''))");
 ok(v.includes('Mover a Por hacer|true|')&&v.includes('Mover a Bloqueado||')&&v.includes('Mover a Hecho||'),'Mover a: its own column disabled, the others offered (no En curso, no Revisión)',v);
 ok(v.includes('Prioridad: Alta||true')&&v.includes('Prioridad: Baja||false')&&v.some(x=>x.startsWith('Soltar fijado'))&&v.some(x=>x.startsWith('Cancelar tarea')),'Prioridad radios (Alta checked), Soltar fijado, Cancelar tarea',v);
 await js("smoke.clickText('[role=menu] button','Mover a Hecho')");
 ok(await until("smoke.reqs('moveTask').at(-1).taskId==='t-8'",2000),'Mover a Hecho sends moveTask');
 v=await js("smoke.reqs('moveTask').at(-1)");
 ok(v.to==='done'&&!('stopRun' in v),'the menu move is the same moveTask as a drag',v);
 ok(await until("smoke.colIds('done').split(',').includes('t-8')",2000),'the card is in Hecho');
 ok(await until("smoke.activeCard()==='t-8'",2000),'after the menu the keyboard is back on the card');
 // Prioridad from the menu and Cancelar tarea with its confirm, then Mostrar canceladas.
 await js("document.querySelector('[data-task-card=t-7]').focus({preventScroll:true})");
 await js("smoke.keyActive({key:'ContextMenu',code:'ContextMenu',keyCode:93})");await settle();
 await js("smoke.clickText('[role=menu] button','Prioridad: Urgente')");
 ok(await until("smoke.reqs('updateTask').at(-1).taskId==='t-7'",2000),'Prioridad from the menu sends updateTask');
 ok((await js("smoke.reqs('updateTask').at(-1).patch.priority"))==='urgent','with the chosen band');
 await js("document.querySelector('[data-task-card=t-7]').focus({preventScroll:true})");
 await js("smoke.keyActive({key:'F10',code:'F10',keyCode:121,shiftKey:true})");await settle();
 await js("smoke.clickText('[role=menu] button','Cancelar tarea')");await settle();
 ok((await js("smoke.text('body')")).includes('¿Cancelar t-7?'),'Cancelar tarea asks first');
 await js("smoke.click('[data-confirm]')");
 ok(await until("smoke.reqs('moveTask').at(-1).to==='cancelled'&&!smoke.has('[data-task-card=t-7]')",2000),'confirmed: moveTask to cancelled and the card leaves the board');
 ok(await until("smoke.text('[data-board-show-cancelled]').includes('Mostrar canceladas (1)')",2000),'Hecho offers Mostrar canceladas (1)');
 await js("smoke.click('[data-board-show-cancelled]')");
 ok(await until("smoke.colIds('done').split(',').pop()==='t-7'",2000),'showing the cancelled ones puts them at the end of Hecho');
 await js("smoke.click('[data-board-show-cancelled]')");await settle();

 // Filters: the search and the assignee.
 await js("smoke.type('[data-board-search]','perfil')");await settle(200);
 ok((await js("smoke.count('[data-task-card]')"))===1&&(await js("smoke.has('[data-task-card=t-5]')")),'the search keeps the matching card');
 await js("smoke.click('[data-board-clear]')");await settle(200);
 await js("smoke.select('[data-board-assignee]','dev')");await settle(200);
 v=await js("[...document.querySelectorAll('[data-task-card]')].map(e=>e.dataset.taskCard).sort().join()");
 ok(v==='t-3,t-4,t-5','the assignee filter keeps that agent cards',v);
 await js("smoke.select('[data-board-assignee]','*')");await settle(200);

 // The task drawer: fields save at once with the rev; a conflict keeps the change to retry.
 await js("smoke.click('[data-task-card=t-1]')");
 ok(await until("smoke.has('[data-drawer=team-task] [data-task-drawer=t-1] [data-task-fields]')",3000),'a card opens its drawer');
 v=await js("({title:smoke.text('[data-task-drawer-title]'),body:smoke.has('[data-task-body] strong'),sys:smoke.text('[data-task-drawer] [data-comment-sys=noQaRole]'),runs:smoke.count('[data-task-run]'),owned:smoke.attr('[data-task-owned]','data-task-owned'),blocked:smoke.text('[data-task-drawer-blocked]')})");
 ok(v.title==='Arreglar el login'&&v.body&&v.runs===1,'the drawer shows the title, the description in Markdown and the activity',v);
 ok(v.sys.includes('Este equipo no tiene rol de QA'),'a sys comment is worded from teams.sys.<key>, never its text',v);
 ok(v.owned==='state'&&v.blocked==='Bloqueada por vos','the drawer says what the user owns and why it is blocked',v);
 // The drawer holds the newest comment page only: the card keeps main's count of every comment (62), never the page's 2.
 v=await js("({card:smoke.attr('[data-task-card=t-1] [data-task-comments]','data-task-comments'),page:smoke.count('[data-task-drawer=t-1] [data-comment]'),older:smoke.has('[data-task-drawer=t-1] [data-comment-older]')})");
 ok(v.card==='62'&&v.page===2&&v.older,'opening the drawer leaves the card at main\\'s comment count (the drawer shows its page of 2 and Ver anteriores)',v);
 // A block the Lead made (team task update --state blocked, blocked.by lead) is worded as the Lead's, never as the user's.
 const blockBy=by=>js("(()=>{const t=smoke.BOARD['"+TA+"'].find(x=>x.id==='t-1');t.blocked={kind:'user',by:'"+by+"'}})();smoke.push({teamId:'"+TA+"',rev:1,scopes:['board','task'],taskId:'t-1'})");
 const blockedTexts="({card:smoke.text('[data-task-card=t-1] [data-task-blocked]'),drawer:smoke.text('[data-task-drawer-blocked]')})";
 await blockBy('lead');
 ok(await until("smoke.text('[data-task-card=t-1] [data-task-blocked]')==='Bloqueada por el Líder'&&smoke.text('[data-task-drawer-blocked]')==='Bloqueada por el Líder'",3000),'a block the Lead made reads Bloqueada por el Líder on the card and in the drawer',await js(blockedTexts));
 await js("smoke.setLang('en')");
 ok(await until("smoke.text('[data-task-drawer-blocked]')==='Blocked by the Lead'",2000),'en: Blocked by the Lead',await js(blockedTexts));
 await js("smoke.setLang('es')");
 await blockBy('user');
 ok(await until("smoke.text('[data-task-card=t-1] [data-task-blocked]')==='Bloqueada por vos'&&smoke.text('[data-task-drawer-blocked]')==='Bloqueada por vos'",3000),'the user\\'s own block reads Bloqueada por vos again',await js(blockedTexts));
 const t1rev=await js("smoke.BOARD['"+TA+"'].find(t=>t.id==='t-1').rev");
 const u0=await js("smoke.reqs('updateTask').length");
 await js("smoke.click('[data-task-field=priority] [data-priority=high]')");
 ok(await until("smoke.reqs('updateTask').length==="+(u0+1),2000),'a field change saves at once');
 v=await js("smoke.reqs('updateTask').at(-1)");
 ok(v.taskId==='t-1'&&v.patch.priority==='high'&&Object.keys(v.patch).length===1&&v.baseRev===t1rev,'updateTask carries the field and the task rev',v);
 await js("smoke.fake.conflictNext=true;smoke.click('[data-task-field=priority] [data-priority=urgent]')");
 ok(await until("smoke.attr('[data-task-save-note]','data-task-save-note')==='conflict'",2000),'a conflict keeps the change and offers Reintentar');
 v=await js("({text:smoke.text('[data-task-save-note]'),checked:smoke.attr('[data-task-field=priority] [data-priority=urgent]','aria-checked'),title:smoke.text('[data-task-drawer-title]'),card:smoke.text('[data-task-card=t-1] [data-task-title]')})");
 ok(v.text.includes('La tarea cambió mientras editabas')&&v.checked==='true','the conflict note, and the field shows the change kept',v);
 ok(v.title.includes('(Líder)')&&v.card.includes('(Líder)'),'the new version is loaded in the drawer and on the card',v);
 const before=await js("smoke.reqs('updateTask').at(-1).baseRev");
 await js("smoke.click('[data-task-retry]')");
 ok(await until("!smoke.has('[data-task-save-note]')",2000),'Reintentar sends it again and the note goes');
 v=await js("smoke.reqs('updateTask').at(-1)");
 ok(v.baseRev===before+1&&v.patch.priority==='urgent','the retry carries the new rev',v);
 // The title, edited in place: Enter saves, Esc cancels only the edit.
 await js("smoke.click('[data-task-title-edit]')");
 ok(await until("smoke.activeIs('data-task-title-input')",2000),'Editar título focuses the field');
 await js("smoke.type('[data-task-title-input]','Arreglar el login con OAuth')");await settle();
 await js("smoke.keyActive({key:'Enter',code:'Enter',keyCode:13})");
 ok(await until("smoke.reqs('updateTask').at(-1).patch.title==='Arreglar el login con OAuth'&&!smoke.has('[data-task-title-input]')",2000),'Enter saves the title');
 await js("smoke.click('[data-task-title-edit]')");await settle();
 await js("smoke.keyActive({key:'Escape',code:'Escape',keyCode:27})");await settle(200);
 v=await js("({input:smoke.has('[data-task-title-input]'),drawer:smoke.has('[data-drawer=team-task]'),host:smoke.has('[data-team-host]')})");
 ok(!v.input&&v.drawer&&v.host,'Esc in the title cancels the edit only',v);
 // Comments: Enter is a new line, Comentar sends, the new one is queued for the assignee.
 await js("smoke.type('[data-comment-composer]','Ojo con el refresh token')");await settle();
 await js("document.querySelector('[data-comment-composer]').focus({preventScroll:true});smoke.keyActive({key:'Enter',code:'Enter',keyCode:13})");await settle();
 ok((await js("smoke.reqs('comment').length"))===0,'Enter in the comment box sends nothing');
 await js("smoke.click('[data-comment-send]')");
 ok(await until("smoke.reqs('comment').length===1",2000),'Comentar sends the comment');
 v=await js("smoke.reqs('comment')[0]");
 ok(v.teamId===TA&&v.taskId==='t-1'&&v.text==='Ojo con el refresh token','comment carries the task and the text',v);
 ok(await until("[...document.querySelectorAll('[data-task-drawer] [data-comment-queued]')].some(e=>e.textContent==='En cola para Dev 2')&&document.querySelector('[data-comment-composer]').value===''",2000),'the new comment shows queued for Dev 2 and the box empties');
 // The chip names the recipient main fixed when the comment was written: a reassignment never moves it (4.5).
 const chips="[...document.querySelectorAll('[data-task-drawer] [data-comment-queued]')].map(e=>e.dataset.commentQueued+'|'+e.textContent)";
 const u1=await js("smoke.reqs('updateTask').length");
 await js("smoke.select('[data-task-fields] [data-task-assignee]','dev')");
 ok(await until("smoke.reqs('updateTask').length==="+(u1+1)+"&&document.querySelector('[data-task-fields] [data-task-assignee]').value==='dev'&&smoke.BOARD['"+TA+"'].find(t=>t.id==='t-1').assignee==='dev'",2000),'the task is reassigned to Dev');
 await settle(200);
 v=await js(chips);
 ok(v.length===1&&v[0]==='dev-2|En cola para Dev 2','after the reassignment the queued comment still waits for Dev 2, never Dev',v);
 v=await js("smoke.attr('[data-task-card=t-1] [data-task-comments]','data-task-comments')");
 ok(v==='63','the card counts the new comment on main\\'s count, and the save reply (a detail) leaves it there',v);
 await js("smoke.setLang('en')");
 ok(await until(chips+".join()==='dev-2|Queued for Dev 2'",2000),'en: Queued for Dev 2',await js(chips));
 await js("smoke.setLang('es')");
 await js("smoke.select('[data-task-fields] [data-task-assignee]','dev-2')");
 ok(await until("smoke.BOARD['"+TA+"'].find(t=>t.id==='t-1').assignee==='dev-2'&&document.querySelector('[data-task-fields] [data-task-assignee]').value==='dev-2'",2000),'and back to Dev 2');
 // Que decida el Líder sends assignee null and the drawer and the card follow main's userOwned (assignee handed back).
 v=await js("smoke.attr('[data-task-owned]','data-task-owned')");
 ok(v.split(',').includes('assignee'),'picking an agent pins the assignee',v);
 await js("smoke.select('[data-task-fields] [data-task-assignee]','')");
 ok(await until("smoke.reqs('updateTask').at(-1).patch.assignee===null&&document.querySelector('[data-task-fields] [data-task-assignee]').value===''&&!smoke.attr('[data-task-owned]','data-task-owned').split(',').includes('assignee')&&smoke.attr('[data-task-card=t-1] [data-task-assignee]','data-task-assignee')===''",2000),'Que decida el Líder sends assignee null and the pin drops assignee (the Lead decides again)',await js("({patch:smoke.reqs('updateTask').at(-1).patch,owned:smoke.attr('[data-task-owned]','data-task-owned')})"));
 await js("smoke.select('[data-task-fields] [data-task-assignee]','dev-2')");
 ok(await until("smoke.BOARD['"+TA+"'].find(t=>t.id==='t-1').assignee==='dev-2'&&document.querySelector('[data-task-fields] [data-task-assignee]').value==='dev-2'",2000),'and Dev 2 again');
 await settle(600);await shot('teams-task-drawer');
 ok((await js("smoke.calls.ptyWrite.length+smoke.calls.ptySubmit.length"))===ptyBefore,'the board and the drawer never write to a pty');
 ok((await js('smoke.shifted()'))===0,'the board keyboard, the drawer and its fields scrolled nothing around Teams',await js('smoke.shifted()'));
 // A trusted click on another card switches the drawer (keepOpenOn); one on the board beside it closes it.
 const tclick=async(sel)=>{const p=await js("smoke.center('"+sel+"')");w.webContents.sendInputEvent({type:'mouseDown',x:p.x,y:p.y,button:'left',clickCount:1});w.webContents.sendInputEvent({type:'mouseUp',x:p.x,y:p.y,button:'left',clickCount:1});await settle(200)};
 await tclick('[data-task-card=t-2]');
 ok(await until("smoke.has('[data-drawer=team-task] [data-task-drawer=t-2]')",2000),'a click on another card switches the drawer to it');
 await tclick('[data-board-column=todo] h3');
 ok(await until("!smoke.has('[data-drawer=team-task]')",2000),'a click on the board beside the drawer closes it');
 // Activity: Ver chat opens that run in the agent drawer.
 await js("smoke.click('[data-task-card=t-1]')");
 ok(await until("smoke.has('[data-task-drawer=t-1] [data-task-run-chat]')",2000),'the activity lists the run');
 await js("smoke.click('[data-task-run-chat]')");
 ok(await until("smoke.has('[data-drawer=team-agent] [data-agent-drawer=dev]')&&smoke.has('[data-chat-view=\\"team:"+R2+"\\"]')",3000),'Ver chat opens the run in the agent drawer');
 await js("smoke.click('[data-drawer=team-agent] [data-drawer-close]')");await settle(200);

 // Nueva tarea: defaults, only the touched fields go, Ctrl+Enter creates, the drawer opens on it.
 await js("smoke.click('[data-team-new-task]')");
 ok(await until("smoke.has('[data-new-task]')&&smoke.activeIs('data-new-task-title')",2000),'Nueva tarea opens the dialog with the title focused');
 v=await js("({create:document.querySelector('[data-new-task-create]').disabled,assignee:document.querySelector('[data-new-task-assignee]').value,prio:smoke.attr('[data-new-task-priority=normal]','aria-checked'),iso:smoke.attr('[data-new-task-isolation=worktree]','aria-checked'),plan:smoke.attr('[data-new-task-field=needsPlan] [role=switch]','aria-checked'),lead:smoke.text('[data-new-task-assignee] option'),opts:[...document.querySelectorAll('[data-new-task-assignee] option')].map(o=>o.value).join()})");
 ok(v.create&&v.assignee===''&&v.prio==='true'&&v.iso==='true'&&v.plan==='true'&&v.lead==='Que decida el Líder','defaults: Que decida el Líder, Normal, Worktree propio, Necesita plan; Crear off without a title',v);
 ok(v.opts===',dev,dev-2,qa,research','the assignees never include the Lead',v);
 await js("smoke.type('[data-new-task-title]','Agregar tests e2e')");
 await js("smoke.click('[data-new-task-priority=high]')");
 await js("smoke.select('[data-new-task-assignee]','research')");await settle();
 ok((await js("smoke.text('[data-new-task-field=isolation]')")).includes('Investigación es de solo lectura'),'a read-only assignee: the hint says it runs in the repo folder with no worktree');
 await settle(600);await shot('teams-new-task');
 await js("document.querySelector('[data-new-task-title]').focus({preventScroll:true});smoke.keyActive({key:'Enter',code:'Enter',keyCode:13,ctrlKey:true})");
 ok(await until("smoke.reqs('createTask').length===1",2000),'Ctrl+Enter creates');
 v=await js("smoke.reqs('createTask')[0]");
 ok(v.teamId===TA&&JSON.stringify(Object.keys(v.task).sort())==='[\\"assignee\\",\\"priority\\",\\"title\\"]'&&v.task.title==='Agregar tests e2e'&&v.task.priority==='high'&&v.task.assignee==='research','only the touched fields go (the untouched defaults stay the Lead to change)',v);
 ok(await until("!smoke.has('[data-new-task]')&&smoke.has('[data-task-drawer=t-9]')",2000),'the dialog closes and the drawer opens on the new task');
 ok(await until("smoke.toastsOf('success').some(x=>x.includes('Tarea t-9 creada'))",2000),'a toast names the new task');
 ok(await until("smoke.colIds('todo').split(',').includes('t-9')",2000),'the new card is on the board');
 // The palette entry over Teams; Esc cancels the dialog only.
 await js("smoke.keyActive({key:'k',code:'KeyK',keyCode:75,ctrlKey:true})");await settle();
 v=await js("smoke.text('[data-palette-cmd=\\"teams.newTask\\"]')");
 ok(v.includes('Nueva tarea en Alfa'),'the palette offers Nueva tarea en Alfa over Teams',v);
 await js("smoke.click('[data-palette-cmd=\\"teams.newTask\\"]')");
 ok(await until("smoke.has('[data-new-task]')",2000),'the palette entry opens the dialog');
 const creates=await js("smoke.reqs('createTask').length");
 await js("smoke.keyActive({key:'Escape',code:'Escape',keyCode:27})");await settle(200);
 v=await js("({dialog:smoke.has('[data-new-task]'),host:smoke.has('[data-team-host]'),creates:smoke.reqs('createTask').length})");
 ok(!v.dialog&&v.host&&v.creates===creates,'Esc cancels the dialog only: Teams stays, nothing created',v);

 // 1280 px and zoom: the board scrolls inside itself, never the page; the header stays on screen.
 for(const z of [1,1.25,1.5]){
  w.webContents.setZoomFactor(z);await settle(250);
  const laid=await until("!smoke.overflow()&&smoke.inView('[data-team-close]')&&smoke.inView('[data-team-new-task]')",2000);
  v=await js("({over:smoke.overflow(),close:smoke.inView('[data-team-close]'),neu:smoke.inView('[data-team-new-task]'),grid:(()=>{const g=document.querySelector('[data-board-grid]');return g.getBoundingClientRect().right<=innerWidth+0.5})()})");
  ok(laid&&!v.over&&v.close&&v.neu&&v.grid,'zoom '+z+' with the board: no page overflow, the grid inside the window',v);
  if(z===1.5){await settle(600);await shot('teams-board-zoom150')}
 }
 w.webContents.setZoomFactor(1);await settle(200);
 await js("smoke.setLang('en')");await settle(200);
 v=await js("[...document.querySelectorAll('[data-board-column] h3')].map(e=>e.textContent).join('|')");
 ok(v==='To do|In progress|Review|Done|Blocked','en: the column names',v);
 await js("smoke.setLang('es')");await settle(200);

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

 // Settings > Labs (B2): turning Teams off while a team run is live asks first (Alfa has one).
 await js("smoke.showLabs(true)");
 ok(await until("smoke.has('[data-setting-id=\\"labs.teams\\"] [role=switch]')",2000),'Settings opens on Labs');
 await js("smoke.click('[data-setting-id=\\"labs.teams\\"] [role=switch]')");await settle();
 v=await js("({dialog:smoke.has('[data-confirm]'),text:smoke.text('body').includes('Se frena una corrida del equipo'),on:smoke.app().settings.labs.teams})");
 ok(v.dialog&&v.text&&v.on===true,'Labs: turning Teams off with a live run asks first',v);
 await js("smoke.cancelConfirm()");await settle();
 v=await js("({on:smoke.app().settings.labs.teams,section:smoke.has('[data-teams-section]'),settings:smoke.app().settingsOpen})");
 ok(v.on===true&&v.section&&v.settings,'cancelled: Teams stays on and Settings stays open',v);
 // Esc on the confirm (its own capture listener uses it) cancels only the confirm: the Modal of Settings stays.
 await js("smoke.click('[data-setting-id=\\"labs.teams\\"] [role=switch]')");await settle();
 ok(await js("smoke.has('[data-confirm]')"),'the confirm asks again');
 const escUsed=await js("smoke.keyActive("+ESC+")");await settle(200);
 v=await js("({dialog:smoke.has('[data-confirm]'),settings:smoke.app().settingsOpen,on:smoke.app().settings.labs.teams,labs:smoke.has('[data-setting-id=\\"labs.teams\\"]')})");
 ok(escUsed&&!v.dialog&&v.on===true,'Esc cancels the Labs off confirm: Teams stays on',v);
 ok(v.settings&&v.labs,'and Settings stays open on Labs (Modal ignores an Esc already used)',v);
 await js("smoke.click('[data-setting-id=\\"labs.teams\\"] [role=switch]')");await settle();
 await js("smoke.click('[data-confirm]')");await settle(250);
 v=await js("({on:smoke.app().settings.labs.teams,section:smoke.has('[data-teams-section]'),settings:smoke.app().settingsOpen})");
 ok(v.on===false&&!v.section&&v.settings,'confirmed: Teams goes off, Settings still open',v);
 // With nothing over it, Esc still closes Settings.
 await js("document.querySelector('[data-settings-search]').focus();smoke.keyActive("+ESC+")");await settle(200);
 ok(!(await js("smoke.app().settingsOpen")),'a plain Esc closes Settings');
 await js("smoke.labs(true)");
 ok(await until("smoke.has('[data-teams-section] [data-team-row]')",4000),'lab on again: rows back');

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
 console.log('PASS: '+n+' teams UI checks (part 1: section, shortcut, palette, host, overlay, refetch policy; agents: roster, run now, run chat, stop, pauses, Labs confirm; board: columns, drag, bands, stopRun, keyboard, drawer, comments, new task, Lead thread); screenshots '+__dirname);w.destroy();app.quit();
}).catch(e=>{console.error(e);app.exit(1)});
`)
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL
const res = spawnSync(require('electron'), [path.join(dir, 'main.cjs')], { env, windowsHide: true, encoding: 'utf8', timeout: 120000 })
process.stdout.write(res.stdout ?? ''); if (res.status !== 0) process.stderr.write((res.stderr ?? '') + (res.error ? String(res.error) : ''))
process.exitCode = res.status ?? 1
