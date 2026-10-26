// Render the production components in an isolated hidden Electron window.
// No user config, real terminal or external notification service is touched.
// App 2.7.0 (A6): also two workspaces' headers and grids (not active, so no
// console spawns), the agent rows and the board with the status signals.
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
import {useAgentStore} from './src/renderer/lib/agentStore';
import {WorkspaceView} from './src/renderer/components/workspace/WorkspaceView';
import {AgentsBoard} from './src/renderer/components/agents/AgentsBoard';
// App 2.7.0 (A6): the pane menu and the silence chip call main through these.
const calls={markRead:[],mute:[],silenceAck:[]};
window.snApi={status:{hooksStatus:async()=>({installed:false,settingsPath:'test/settings.json'}),health:async()=>({claude:{installed:false},codex:{enabled:true,available:false,connected:0,missing:true},discord:{lastSuccessAt:null,error:null,queued:0}}),testDiscord:async()=>({ok:true}),
 markRead:async(id)=>{calls.markRead.push(id);return true},mute:async(id,muted)=>{calls.mute.push([id,muted]);return true},silenceAck:async(id)=>{calls.silenceAck.push(id);return true}}};
// A6 stage: the two signal workspaces' headers and grids (not active, so no console spawns) under the agents board.
function A6Stage(){const ws=useAppStore(s=>s.workspaces).filter(w=>w.id.startsWith('a6-'));return <main className="relative flex min-h-0 min-w-0 flex-1 flex-col">{ws.length===0?<div className="p-6">Prueba de luces de estado</div>:ws.map(w=><div key={w.id} className="min-h-0 flex-1"><WorkspaceView workspace={w} isActive={false}/></div>)}<AgentsBoard/></main>}
const MIN=60000,fx={};
const usage=(cost,unknown)=>({inputTokens:20000,outputTokens:5000,cacheReadTokens:70000,cacheWriteTokens:5000,...(cost===undefined?{}:{costUSD:cost}),...(unknown?{unknownCost:true}:{}),estimated:true});
const pane=(id,title,type)=>({id,type:type||'claude',title,icon:type==='shell'?'terminal':'claude'});
function seedA6(){const now=Date.now();fx.t0=now;fx.until=now+40*MIN;
 useAppStore.setState({settingsOpen:false,sidebarCollapsed:false,activeWorkspaceId:'a6-a',paneAttention:{},
  workspaces:[{id:'a6-a',name:'Señales A',cwd:'',panes:[pane('pa-edit','Editor'),pane('pa-fail','Limite'),pane('pa-quiet','Callado'),pane('pa-needs','Pide')]},{id:'a6-b',name:'Señales B',cwd:'',panes:[pane('pa-stalled','Trabado'),pane('pa-bare','Shell','shell'),pane('pa-done','Listo')]}],
  paneStatus:{
   'pa-edit':{state:'working',precise:true,provider:'claude',stateSince:now-2*MIN,activity:'Edit a.ts',toolFamily:'edit',detail:{kind:'tool',text:'Edit a.ts'},context:{pct:0.42,used:84000,window:200000,exact:false},usage:usage(1.25)},
   'pa-fail':{state:'error',precise:true,provider:'claude',stateSince:now-MIN,attention:true,failure:{kind:'limit',until:fx.until,code:'rate_limit'}},
   'pa-quiet':{state:'working',precise:true,provider:'claude',stateSince:now-15*MIN,silence:{level:'quiet',since:now-12*MIN-5000}},
   'pa-needs':{state:'working',precise:true,provider:'codex',stateSince:now-4*MIN,attention:true,activity:'Bash: npm test',toolFamily:'run',needs:{text:'Revisá el PR 12 antes de seguir',at:now-3*MIN},usage:usage(0.5)},
   'pa-stalled':{state:'working',precise:true,provider:'claude',stateSince:now-30*MIN,silence:{level:'stalled',since:now-25*MIN+4000},context:{pct:0.9,used:180000,window:200000,exact:true},usage:usage(undefined,true)},
   'pa-bare':{state:'idle',precise:false,bare:true,attention:true,pendingCount:0,stateSince:now-MIN,updatedAt:now-MIN,needs:{text:'Elegí una opción',at:now-MIN}},
   'pa-done':{state:'done',precise:true,provider:'claude',stateSince:now-6*MIN,attention:true,muted:true}}})}
const states=['working','action','done','error','unknown','idle'];
useAppStore.setState({hydrated:true,activeWorkspaceId:'ws-1',workspaces:states.map((state,i)=>({id:'ws-'+i,name:i===1?'Proyecto con nombre muy largo para probar truncado y acciones':'Workspace '+i,cwd:'',panes:[{id:'pane-'+i,type:'shell',title:'Console '+i,icon:'terminal'}]})),paneStatus:Object.fromEntries(states.map((state,i)=>['pane-'+i,{state,precise:true,provider:i%2?'claude':'codex',pendingCount:state==='action'?2:0}])),paneAttention:{'pane-1':true}});
applyTheme('midnight');
createRoot(document.getElementById('root')).render(<I18nProvider lang="es"><div style={{height:'100vh'}} className="flex bg-bg-primary text-text-primary"><Sidebar/><A6Stage/><div style={{position:'fixed',right:0,bottom:0}}><Tooltip label="Nombre largo para probar que el tooltip se ajusta al borde de la ventana sin cortar el texto"><button id="edge-tooltip">i</button></Tooltip></div><SettingsModal/></div></I18nProvider>);
window.smoke={set:useAppStore.setState,theme:applyTheme,open:()=>useAppStore.getState().openSettings('notifications'),
 a6:seedA6,fx,calls:()=>calls,board:(on)=>useAgentStore.getState().setView(on?'board':'grid'),
 patch:(id,p)=>useAppStore.setState(s=>({paneStatus:{...s.paneStatus,[id]:{...s.paneStatus[id],...p}}})),
 text:(sel)=>document.querySelector(sel)?.textContent||'',has:(sel)=>!!document.querySelector(sel),
 hover:async(sel,tip)=>{const el=document.querySelector(sel);if(!el)return'';el.dispatchEvent(new MouseEvent('mouseover',{bubbles:true}));await new Promise(r=>setTimeout(r,320));const t=document.querySelector(tip)?.textContent||'';el.dispatchEvent(new MouseEvent('mouseout',{bubbles:true}));await new Promise(r=>setTimeout(r,200));return t},
 menu:async(id)=>{const h=document.querySelector('[data-pane-cell='+id+'] header');const r=h.getBoundingClientRect();h.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:r.left+40,clientY:r.top+10}));await new Promise(r=>setTimeout(r,120));return [...document.querySelectorAll('[role=menu] [role=menuitem]')].map(b=>({label:b.textContent,disabled:b.getAttribute('aria-disabled')==='true'}))},
 pick:async(label)=>{const b=[...document.querySelectorAll('[role=menu] [role=menuitem]')].find(e=>e.textContent===label);if(!b)return false;b.click();await new Promise(r=>setTimeout(r,120));return true},
 closeMenu:async()=>{window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}));await new Promise(r=>setTimeout(r,120))},
 time:(at)=>new Date(at).toLocaleTimeString('es',{hour:'2-digit',minute:'2-digit'}),
 tokens:(n)=>new Intl.NumberFormat('es',{notation:'compact',maximumFractionDigits:1}).format(n),
 usd:(n)=>new Intl.NumberFormat('es',{style:'currency',currency:'USD',minimumFractionDigits:2,maximumFractionDigits:2}).format(n),
 // Each visible pane header: its overflow, the close button inside it, and the title (its box, the text, how much of it shows and how far the text runs past its span).
 headers:()=>[...document.querySelectorAll('[data-pane-cell] header')].filter(h=>h.clientWidth>0).map(h=>{const box=h.querySelector('[data-pane-title-box]'),tt=h.querySelector('[data-pane-title]');return{id:h.closest('[data-pane-cell]').dataset.paneCell,width:Math.round(h.clientWidth),over:h.scrollWidth-h.clientWidth,close:(()=>{const b=h.lastElementChild.getBoundingClientRect(),c=h.getBoundingClientRect();return b.right<=c.right+1})(),box:box?Math.round(box.getBoundingClientRect().width):0,title:tt?tt.textContent:'',shown:tt?Math.round(tt.getBoundingClientRect().width):0,whole:tt?tt.scrollWidth:0,cut:(()=>{if(!tt)return 99;const r=document.createRange();r.selectNodeContents(tt);return Math.max(0,r.getBoundingClientRect().width-tt.getBoundingClientRect().width)})()}}),
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
 // v2.3 attention: the red badge reads main's attention; the legacy fixture (no field) keeps pendingCount / paneAttention.
 const badges=()=>w.webContents.executeJavaScript("[...document.querySelectorAll('aside nav [data-attention-badge]')].map(b=>{let e=b;while(e&&!/Workspace \\\\d|Proyecto/.test(e.textContent||''))e=e.parentElement;const m=/Workspace (\\\\d)|Proyecto/.exec(e?e.textContent:'');return (m?(m[1]||'1'):'?')+':'+b.textContent}).join()");
 let b0=await badges();if(b0!=='1:1')throw new Error('Legacy badge: the action workspace only '+JSON.stringify(b0));
 await w.webContents.executeJavaScript("smoke.set(s=>({paneAttention:{},paneStatus:{...s.paneStatus,'pane-1':{...s.paneStatus['pane-1'],attention:false},'pane-2':{...s.paneStatus['pane-2'],attention:true},'pane-3':{...s.paneStatus['pane-3'],attention:false}}}))");await new Promise(r=>setTimeout(r,250));
 b0=await badges();if(b0!=='2:1')throw new Error('Attention badge: an answered action (pendingCount 2, attention false) does not count, an unseen done does '+JSON.stringify(b0));
 const answered=await w.webContents.executeJavaScript("({row:document.querySelector('[data-agent-row=pane-1]')?.dataset.agentState,dot:document.querySelectorAll('aside [data-status-dot]')[1]?.dataset.statusDot})");
 if(answered.row!=='working'||answered.dot!=='working')throw new Error('An answered action shows as working in the row and the dot '+JSON.stringify(answered));
 await shot('sidebar-attention');
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
 // v2.4: Codex on by default; no codex.exe is a neutral line, never a red error.
 const codexLine=await w.webContents.executeJavaScript("(()=>{const p=document.querySelector('[data-codex-health]');return p?{text:p.textContent,red:!!p.parentElement.querySelector('.text-red-400')}:null})()");
 if(!codexLine||!codexLine.text.startsWith('No se encontró la CLI de Codex')||codexLine.red)throw new Error('Codex missing line '+JSON.stringify(codexLine));
 for(const scale of [1,1.25,1.5]){w.setSize(860,560);w.webContents.setZoomFactor(scale);await new Promise(r=>setTimeout(r,200));const overflow=await w.webContents.executeJavaScript('document.documentElement.scrollWidth>innerWidth');if(overflow)throw new Error('Viewport overflow at '+scale);if(scale===1.5)await shot('notifications-150')}
 w.webContents.setZoomFactor(1);w.setSize(1280,820);await w.webContents.executeJavaScript("smoke.theme('light');document.getElementById('discord-webhook').scrollIntoView({block:'center'})");await new Promise(r=>setTimeout(r,300));await shot('discord-light');
 // App 2.7.0 (A6): what each agent is doing now, the signal chips, the pane menu, a bare needs and the workspace usage total.
 const js=c=>w.webContents.executeJavaScript(c),wait=ms=>new Promise(r=>setTimeout(r,ms));
 let a6=0;const ok=(cond,what,data)=>{if(!cond)throw new Error('A6: '+what+' '+JSON.stringify(data===undefined?null:data));a6++};
 const q=v=>JSON.stringify(v),text=sel=>js('smoke.text('+q(sel)+')'),has=sel=>js('smoke.has('+q(sel)+')'),hover=(sel,tip)=>js('smoke.hover('+q(sel)+','+q(tip)+')');
 await js("smoke.theme('midnight');smoke.a6()");await wait(350);
 let s=await text('[data-pane-cell=pa-stalled] [data-silence-chip=stalled]');
 ok(s==='¿Trabado? 24 min','a stalled chip counts whole minutes since the last signal, short in the pane header',s);
 s=await js("document.querySelector('[data-pane-cell=pa-stalled] [data-silence-chip=stalled]')?.getAttribute('aria-label')");
 ok(s==='Quizás trabado: 24 min sin señales','its accessible name is the long form',s);
 ok(await js("!!document.querySelector('[data-pane-cell=pa-stalled] [data-silence-chip=stalled] svg')"),'the header silence chip leads with its icon');
 await shot('a6-panes');
 s=await text('[data-pane-cell=pa-edit] [data-pane-doing]');ok(s.endsWith('Editando a.ts'),'the header says what the agent does now (verb + what the open tool works on)',s);
 s=await text('[data-pane-cell=pa-needs] [data-pane-doing]');ok(s.endsWith('Ejecutando npm test'),'a run tool reads as its command',s);
 s=await text('[data-agent-row=pa-edit] [data-agent-phrase]');ok(s.startsWith('Editando a.ts'),'so does the agent row',s);
 await js('smoke.board(true)');await wait(250);
 s=await text('[data-board-card=pa-edit] [data-board-detail]');ok(s==='Editando a.ts','so does the board card',s);
 ok((await has('[data-board-card=pa-needs] [data-needs-chip]'))&&(await has('[data-board-card=pa-fail] [data-failure-chip]'))&&(await has('[data-board-card=pa-quiet] [data-silence-chip=quiet]')),'board cards carry the chips');
 s=await text('[data-board-card=pa-quiet] [data-silence-chip=quiet]');ok(s==='Sin señales hace 12 min','a board card keeps the long silence form',s);
 ok(!(await has('[data-board-card=pa-bare] [data-glyph]'))&&(await has('[data-board-card=pa-bare] [data-needs-chip]')),'a bare card is its needs chip, no glyph');
 ok(!(await has('[data-agents-board] [data-silence-ack]')),'no ack button inside a card (a button in a button)');
 s=await js("[...document.querySelectorAll('[data-board-column=waiting] [data-board-card]')].map(e=>e.dataset.boardCard).sort().join()");ok(s==='pa-bare,pa-fail,pa-needs','a snaos needs puts the card in Te esperan, like the badge',s);
 ok(await js("['pa-needs','pa-fail'].every(id=>{const e=document.querySelector('[data-board-card='+id+'] [data-needs-chip] span,[data-board-card='+id+'] [data-failure-chip] span');return e&&e.scrollWidth<=e.clientWidth})"),'a card gives the needs and failure chips the whole line (they wrap)');
 s=await text('[data-board-card=pa-edit] [data-context-chip]');ok(s==='42% estimado','a board card keeps the long context chip ("estimado" spelled out)',s);
 s=await text('[data-board-card=pa-stalled] [data-context-chip]');ok(s==='90%','an exact context on a card has no estimate mark',s);
 await shot('a6-board');await js('smoke.board(false)');await wait(200);
 await js("smoke.patch('pa-edit',{activity:undefined,toolFamily:undefined,detail:undefined})");await wait(200);
 ok(!(await has('[data-pane-cell=pa-edit] [data-pane-doing]')),'no stale tool in the header once activity is gone');
 s=await text('[data-agent-row=pa-edit] [data-agent-phrase]');ok(s.startsWith('Trabajando')&&!s.includes('a.ts'),'nor on the row',s);
 s=await text('[data-pane-cell=pa-fail] [data-failure-chip]');const until=await js('smoke.time(smoke.fx.until)');
 ok(s.startsWith('Límite de uso hasta ')&&s.includes(until),'the failure chip names the kind and the reset time',{s,until});
 s=await hover('[data-pane-cell=pa-fail] [data-failure-chip]','[data-failure-tip]');ok(s.includes('Código: rate_limit'),'its tooltip has the code',s);
 s=await js("getComputedStyle(document.querySelector('[data-pane-cell=pa-fail] [data-failure-chip]')).color");ok(s==='rgb(239, 68, 68)','a failure reads in the error red',s);
 s=await text('[data-pane-cell=pa-quiet] [data-silence-chip=quiet]');ok(s==='12 min','a quiet chip in the header is its icon and the minutes',s);
 s=await hover('[data-pane-cell=pa-quiet] [data-silence-chip=quiet]','[data-silence-tip]');ok(s.includes('Sin señales hace 12 min')&&s.includes('Última señal: '),'its tooltip has the long form and the last signal time',s);
 ok((await js("document.querySelector('[data-silence-ack=pa-quiet]')?.getAttribute('aria-label')"))==='Ignorar este turno','the ack button is named');
 await js("document.querySelector('[data-silence-ack=pa-quiet]').click()");await wait(100);
 let c=await js('smoke.calls()');ok(c.silenceAck.join()==='pa-quiet','Ignorar este turno calls status.silenceAck with the pane',c);
 const needs=await js("(()=>{const e=document.querySelector('[data-pane-cell=pa-needs] [data-needs-chip]');return e?{text:e.textContent,color:getComputedStyle(e).color,aria:e.getAttribute('aria-label')}:null})()");
 ok(needs&&needs.text==='Revisá el PR 12 antes de seguir'&&needs.color==='rgb(245, 158, 11)'&&needs.aria==='Te necesita: Revisá el PR 12 antes de seguir','the needs chip is amber (state-action) with its text',needs);
 s=await hover('[data-pane-cell=pa-needs] [data-needs-chip]','[data-needs-tip]');ok(s.includes('Te necesita: Revisá el PR 12 antes de seguir')&&s.includes('Lo pidió: '),'its tooltip has the whole text and the time',s);
 const caps=await js("['pa-needs','pa-fail'].map(id=>{const e=document.querySelector('[data-pane-cell='+id+'] [data-needs-chip],[data-pane-cell='+id+'] [data-failure-chip]');return e?Math.round(e.getBoundingClientRect().width):-1})");
 ok(caps.every(n=>n>0&&n<=144),'the header caps the needs and failure chips (9rem), their tooltips carry the whole text',caps);
 const ctx=await js("(()=>{const e=document.querySelector('[data-pane-cell=pa-edit] [data-context-chip]');return e?{pct:e.dataset.contextChip,exact:e.dataset.contextExact,text:e.textContent,now:e.getAttribute('aria-valuenow'),aria:e.getAttribute('aria-label')}:null})()");
 ok(ctx&&ctx.pct==='42'&&ctx.exact==='false'&&ctx.text==='~42%'&&ctx.now==='42'&&ctx.aria==='Contexto al 42% (estimado)','the header words an approximate context short ("~42%"), the estimate spelled out in its label',ctx);
 s=await hover('[data-pane-cell=pa-edit] [data-context-chip]','[data-context-tip]');const cost=await js('smoke.usd(1.25)'),used=await js('smoke.tokens(84000)');
 ok(s.includes('(estimado)')&&s.includes(used)&&s.includes('Tokens: ')&&s.includes('Costo estimado: '+cost),'its tooltip says estimado, with used of the window, the tokens and the cost',{s,cost,used});
 s=await text('[data-pane-cell=pa-stalled] [data-context-chip]');ok(s==='90%','an exact context has no estimate mark',s);
 s=await hover('[data-pane-cell=pa-stalled] [data-context-chip]','[data-context-tip]');ok(!s.includes('Contexto: '+(await js('smoke.tokens(180000)'))+' de '+(await js('smoke.tokens(200000)'))+' tokens (estimado)')&&s.includes('Tokens: ')&&s.includes('(estimado)'),'an exact context is not called an estimate, its usage tokens still are',s);
 ok(await js("(()=>{const e=document.querySelector('[data-pane-cell=pa-edit] header [data-pane-title]');return !!e&&e.textContent==='Editor'&&e.scrollWidth<=e.clientWidth})()"),'the header title of a console with a context chip stays whole');
 s=await hover('[data-pane-cell=pa-stalled] [data-context-chip]','[data-context-tip]');ok(s.includes('Costo desconocido'),'an unknown cost says so',s);
 let items=await js("smoke.menu('pa-done')");ok(items.some(i=>i.label==='Marcar leído'&&!i.disabled)&&items.some(i=>i.label==='Quitar silencio'),'a done, muted pane offers Marcar leído and Quitar silencio',items);
 await js("smoke.pick('Marcar leído')");
 await js("smoke.menu('pa-done')");await js("smoke.pick('Quitar silencio')");
 items=await js("smoke.menu('pa-edit')");ok(items.some(i=>i.label==='Marcar leído'&&i.disabled)&&items.some(i=>i.label==='Silenciar hasta que cambie'),'a working pane has Marcar leído disabled',items);
 await js("smoke.pick('Marcar leído')");await js("smoke.pick('Silenciar hasta que cambie')");
 c=await js('smoke.calls()');ok(c.markRead.join()==='pa-done'&&q(c.mute)===q([['pa-done',false],['pa-edit',true]]),'the menu calls markRead and mute with the pane id',c);
 ok(!items.some(i=>i.label==='Ignorar este turno'),'a pane with no silence has no Ignorar este turno item',items);
 // The silence ack is in the pane menu too (the header chip can shrink to its icon).
 items=await js("smoke.menu('pa-quiet')");ok(items.some(i=>i.label==='Ignorar este turno'&&!i.disabled),'a silent pane offers Ignorar este turno in its menu',items);
 await js("smoke.pick('Ignorar este turno')");c=await js('smoke.calls()');ok(c.silenceAck.join()==='pa-quiet,pa-quiet','the menu item calls status.silenceAck with the pane, like the chip button',c);
 items=await js("smoke.menu('pa-bare')");ok(!items.some(i=>i.label==='Marcar leído'||i.label.startsWith('Silenciar')),'a bare status has no agent menu items',items);await js('smoke.closeMenu()');
 ok((await has('[data-pane-cell=pa-done] [data-pane-muted]'))&&!(await has('[data-pane-cell=pa-edit] [data-pane-muted]')),'a muted pane shows the muted mark');
 const bare=await js("(()=>{const c=document.querySelector('[data-pane-cell=pa-bare]'),r=document.querySelector('[data-agent-row=pa-bare]');return{dot:!!c.querySelector('[data-status-dot]'),needs:c.querySelector('[data-needs-chip]')?.textContent,other:c.querySelectorAll('[data-failure-chip],[data-silence-chip],[data-context-chip],[data-pane-doing],[data-pane-muted]').length,row:r?.dataset.agentState,glyph:!!r?.querySelector('[data-glyph]'),rowNeeds:!!r?.querySelector('[data-needs-chip]')}})()");
 ok(!bare.dot&&bare.needs==='Elegí una opción'&&bare.other===0&&bare.row==='bare'&&!bare.glyph&&bare.rowNeeds,'a bare status shows only its needs chip, no agent dot',bare);
 const rows=await js("[...document.querySelectorAll('[data-agent-row]')].filter(r=>r.querySelector('[data-needs-chip],[data-failure-chip],[data-silence-chip]')&&r.querySelector('[data-agent-phrase]')).map(r=>({id:r.dataset.agentRow,phrase:Math.round(r.querySelector('[data-agent-phrase]').getBoundingClientRect().width),over:r.scrollWidth-r.clientWidth}))");
 ok(rows.length===4&&rows.every(r=>r.phrase>=40&&r.over<=1),'agent rows keep room for the phrase next to their chips',rows);
 s=await text('[data-agent-row=pa-quiet] [data-silence-chip=quiet]');ok(s==='12 min sin señales','a row words the silence short',s);
 const usageA=await text('[data-workspace-usage=a6-a]'),usageB=await text('[data-workspace-usage=a6-b]');
 const expA='Uso estimado: '+(await js('smoke.tokens(200000)'))+' tokens · '+(await js('smoke.usd(1.75)'));
 ok(usageA===expA,'the workspace header sums its consoles usage as an estimate',{usageA,expA});
 ok(usageB==='Uso estimado: '+(await js('smoke.tokens(100000)'))+' tokens · costo desconocido','a workspace total with an unknown cost says so',usageB);
 // Every A6 pane header (about 365 px wide at 1.25, 490 at 1) fits its chips and keeps its title readable: the chips truncate first.
 const a6Panes='pa-bare,pa-done,pa-edit,pa-fail,pa-needs,pa-quiet,pa-stalled';
 const readable=h=>h.box>=40&&h.title.trim()!==''&&h.shown+1>=Math.min(40,h.whole);
 for(const zoom of [1,1.25]){w.webContents.setZoomFactor(zoom);await wait(250);const hs=await js('smoke.headers()');
  ok(hs.map(h=>h.id).sort().join()===a6Panes&&hs.every(h=>h.over<=1&&h.close),'pane headers fit their chips at '+zoom,hs);
  ok(hs.every(readable),'every pane header keeps a readable title (a 40 px box, 40 px of the title or all of it) at '+zoom,hs.filter(h=>!readable(h)));
  // cut: how far the text runs past its span. One layout unit (1/64 px at 100%) is rounding and draws no ellipsis; two do ("Traba...").
  ok(hs.every(h=>h.cut<=1/64),'every fixture title (all under 5rem) shows whole, no ellipsis, at '+zoom,hs.map(h=>h.id+' '+h.cut));
  ok(!(await js('document.documentElement.scrollWidth>innerWidth')),'no horizontal overflow at '+zoom);if(zoom!==1.25)continue;await shot('a6-chips-125');
  // A long title keeps its first 5rem next to the stalled chip, the ack and the context chip; the chips give way.
  const retitle=n=>js("smoke.set(s=>({workspaces:s.workspaces.map(w=>({...w,panes:w.panes.map(p=>p.id==='pa-stalled'?{...p,title:"+q(n)+"}:p)}))}))");
  await retitle('Trabado con un título largo');await wait(200);const lt=(await js('smoke.headers()')).find(h=>h.id==='pa-stalled');
  ok(lt&&lt.shown>=79&&lt.over<=1&&lt.close,'a long title keeps its first 5rem in a narrow header',lt);await retitle('Trabado');await wait(150)}
 w.webContents.setZoomFactor(1);await wait(200);await shot('a6-chips');
 const left=await js('smoke.fx.t0+4300-Date.now()');if(left>0)await wait(left);
 s=await text('[data-pane-cell=pa-stalled] [data-silence-chip=stalled]');ok(s==='¿Trabado? 25 min','the silence chip moves to the next minute on its own (one timeout, no polling)',s);
 // A workspace whose only status is bare (a snaos needs on a shell): no agent dot on its row nor on the rail, its badge still counts it.
 await js("smoke.set(s=>{const ps={...s.paneStatus};delete ps['pa-stalled'];delete ps['pa-done'];return {paneStatus:ps}})");await wait(150);
 const dots=async()=>js("({a:!!document.querySelector('[data-sidebar-ws=a6-a] [data-status-dot]'),b:!!document.querySelector('[data-sidebar-ws=a6-b] [data-status-dot]'),railA:!!document.querySelector('[data-sidebar-ws=a6-a] [data-rail-status]'),railB:!!document.querySelector('[data-sidebar-ws=a6-b] [data-rail-status]'),badgeB:document.querySelector('[data-sidebar-ws=a6-b] [data-attention-badge]')?.dataset.attentionBadge??null})");
 let d=await dots();ok(d.a&&!d.b&&d.badgeB==='1','a bare-only workspace has no aggregate agent dot, its badge counts the needs',d);
 await js('smoke.set({sidebarCollapsed:true})');await wait(250);
 d=await dots();ok(d.railA&&!d.railB&&d.badgeB==='1','nor a rail dot when the sidebar is collapsed',d);
 await js('smoke.set({sidebarCollapsed:false})');await wait(150);
 // A pane too narrow for the title floor (225 px, like a 5 column grid on a laptop): the chips go first, then the title truncates, never the buttons (pa-edit keeps a fixed context chip).
 await js("document.querySelectorAll('[data-pane-cell]').forEach(c=>{c.style.width='225px'})");await wait(200);
 const narrow=(await js('smoke.headers()')).filter(h=>h.id!=='pa-edit');
 ok(narrow.length===6&&narrow.every(h=>h.width<=225&&h.over<=1&&h.close),'a header too narrow for the title floor truncates the title, never pushes its buttons out',narrow);
 await js("document.querySelectorAll('[data-pane-cell]').forEach(c=>{c.style.width=''})");await wait(150);
 // A muted request still open: main sends it with attention false, which is not an answer. It keeps the
 // action look, never says the tool that waits for approval runs, and leaves Te esperan and Trabajando.
 await js("smoke.patch('pa-edit',{state:'action',reason:'permission',attention:false,muted:true,pendingCount:1,pending:[{id:'r1',kind:'permission',toolName:'Bash',summary:'npm test'}],activity:'Bash: npm test',toolFamily:'run',detail:{kind:'permission',text:'Bash: npm test'}})");await wait(250);
 const mutedAsk=await js("(()=>{const c=document.querySelector('[data-pane-cell=pa-edit]'),r=document.querySelector('[data-agent-row=pa-edit]');return{doing:!!c.querySelector('[data-pane-doing]'),dot:c.querySelector('[data-status-dot]')?.dataset.statusDot,muted:!!c.querySelector('[data-pane-muted]'),row:r?.dataset.agentState,phrase:r?.querySelector('[data-agent-phrase]')?.textContent||''}})()");
 ok(!mutedAsk.doing&&mutedAsk.dot==='action'&&mutedAsk.muted&&mutedAsk.row==='action'&&!mutedAsk.phrase.includes('Ejecutando'),'a muted open request keeps the action dot and row and says nothing runs',mutedAsk);
 await js('smoke.board(true)');await wait(250);
 s=await js("(()=>{const e=document.querySelector('[data-board-card=pa-edit]');return e?{col:e.closest('[data-board-column]')?.dataset.boardColumn,state:e.dataset.boardState,detail:e.querySelector('[data-board-detail]')?.textContent||''}:null})()");
 ok(s&&s.col==='idle'&&s.state==='action'&&!s.detail.includes('Ejecutando'),'its board card goes with the rest (not Te esperan nor Trabajando) with the action glyph',s);
 await js('smoke.board(false)');await wait(200);
 if(failures.length)throw new Error(failures.join('\\n'));console.log('PASS: six sidebar lights and agent rows expanded/collapsed, folded usage list, centered rail phone, rail dots beside the icon, dot tooltip under 300 ms, settings at 100/125/150%, light/dark, '+a6+' A6 status surface checks (doing now, chips, short header chips, readable pane titles at 100/125%, buttons kept in a narrow pane, pane menu with the silence ack, bare needs, workspace usage, a muted open request); screenshots '+__dirname);w.destroy();app.quit();
}).catch(e=>{console.error(e);app.exit(1)});
`)
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
const res = spawnSync(require('electron'), [path.join(dir, 'main.cjs')], { env, windowsHide: true, encoding: 'utf8', timeout: 90000 })
process.stdout.write(res.stdout ?? ''); if (res.status !== 0) process.stderr.write((res.stderr ?? '') + (res.error ? String(res.error) : ''))
process.exitCode = res.status ?? 1
