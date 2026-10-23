// Recurring automations UI (E8-FR-28..32) from the production components in
// an isolated hidden Electron window: the pane header clock (active, paused,
// none), ScheduleDialog (chips, weekly days, hourly minute, wait checkbox,
// Active switch, history with "See all", "Run now" waiting then sending, Esc
// that closes only the dialog) and the Settings > Automation table (switch,
// run now, edit), in dark and light at 100/125/150%. Consoles stay unmounted
// placeholders and pty.submit is a stub: no pty, user config or agent is touched.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path')
const { pathToFileURL } = require('node:url')
const { spawnSync } = require('node:child_process')
const { buildSync } = require('esbuild')
const root = path.resolve(__dirname, '..'), dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snagentsos-schedule-ui-'))
const assets = path.join(root, 'out/renderer/assets')
const css = fs.existsSync(assets) && fs.readdirSync(assets).find(f => /^index-.*\.css$/.test(f))
if (!css) throw new Error('Run npm run build first')
buildSync({ stdin: { contents: `
import React from 'react'; import {createRoot} from 'react-dom/client';
import {PaneCell} from './src/renderer/components/layout/PaneCell';
import {AutomationSection} from './src/renderer/components/settings/sections/AutomationSection';
import {I18nProvider} from './src/renderer/i18n';
import {useAppStore} from './src/renderer/lib/store';
import {usePaneScheduler, useScheduleRuntime} from './src/renderer/lib/usePaneScheduler';
import {registerPty} from './src/renderer/lib/ptyRegistry';
import {applyTheme} from './src/renderer/themes/applyTheme';
window.__submits=[];window.__mounted=[];window.__bubbleEsc=0;
window.addEventListener('keydown',e=>{if(e.key==='Escape')window.__bubbleEsc++});
window.snApi={platform:'win32',agents:{forget(){},list:async()=>[],startup:async()=>({trigger:null,interrupted:[]}),startupPending:async()=>[],consumeStartup:async()=>false,onChanged:()=>()=>{},onReady:()=>()=>{}},
 pty:{kill:async()=>{},write(){},submit:async(req)=>{window.__submits.push(req);return {ok:true}},onPromptResult:()=>()=>{}},config:{save(){}},
 app:{info:async()=>null},cli:{setEnabled(){},state:async()=>null,skill:async()=>null,userPath:async()=>false}};
const preset={id:'preset-claude',name:'Claude Code',type:'claude',command:'claude',args:[],color:'#d97757',icon:'claude'};
const now=Date.now();
const nextWeekday=(()=>{const d=new Date(now);for(let i=0;i<9;i++){const c=new Date(now);c.setDate(c.getDate()+i);c.setHours(9,0,0,0);if(c.getTime()>now&&c.getDay()>=1&&c.getDay()<=5)return c.getTime()}return now+3600000})();
const run=(minsAgo,status,extra)=>({at:now-minsAgo*60000,scheduledFor:now-minsAgo*60000,trigger:'scheduled',status,...extra});
const history=[run(600,'sent'),run(500,'missed'),run(400,'skipped_busy'),run(300,'failed',{reason:'agent_not_running'}),run(200,'sent_unconfirmed'),run(100,'sent',{trigger:'manual'}),run(5,'sent')];
const pane=(id,title,type,extra)=>({id,type,title,color:'#6366f1',icon:type==='claude'?'claude':'terminal',...extra});
const w1={id:'w1',name:'Backend con un nombre de workspace bastante largo',cwd:'C:/repo',panes:[
 pane('pa','Revisor','shell',{schedule:{time:'09:00',prompt:'revisa los PR abiertos',dueAt:nextWeekday,recurrence:{kind:'weekdays'}}}),
 pane('pp','Claude Code','claude',{presetId:'preset-claude',schedule:{time:'18:30',prompt:'resumi el dia',dueAt:now-3600000,enabled:false,history}}),
 pane('pn','Shell','shell')],layout:{grid:3,order:['pa','pp','pn']}};
const st=useAppStore.getState();
useAppStore.setState({hydrated:true,presets:[preset],workspaces:[w1],activeWorkspaceId:'w1',settings:{...st.settings,language:'es'}});
useAppStore.setState({ensureMounted:(id,o)=>window.__mounted.push(id+':'+((o&&o.only)||[]).join('+'))});
const noop=()=>{};
const cell=(p,i)=><PaneCell key={p.id} workspace={useAppStore.getState().workspaces[0]} pane={p} presets={[preset]} workspaceActive={false} maximizedId={null} minimizedIds={[]} index={i} isDragging={false} draggable={false} onToggleMax={noop} onToggleMin={noop} onClose={noop} onDragStartCell={noop} onDragEnterCell={noop} onDragEndCell={noop}/>;
function Ticker(){usePaneScheduler();return null}
function Root(){const ws=useAppStore(s=>s.workspaces[0]);return <div style={{height:'100vh'}} className="flex flex-col bg-bg-primary text-text-primary"><Ticker/>
 <div style={{height:150,display:'grid',gridTemplateColumns:'repeat(3,minmax(0,1fr))',gap:6,padding:6}}>{ws.panes.map(cell)}</div>
 <div data-settings-pane style={{maxWidth:640,padding:16,overflow:'auto'}} className="min-h-0 flex-1"><AutomationSection/></div></div>}
window.smoke={theme:applyTheme,app:useAppStore.getState,setApp:useAppStore.setState,registerPty,runtime:useScheduleRuntime.getState,
 sched:id=>useAppStore.getState().workspaces[0].panes.find(p=>p.id===id).schedule};
createRoot(document.getElementById('root')).render(<I18nProvider lang="es"><Root/></I18nProvider>);
`, resolveDir: root, loader: 'tsx' }, bundle: true, platform: 'browser', format: 'iife', outfile: path.join(dir, 'renderer.js'), alias: { '@shared': path.join(root, 'src/shared'), '@': path.join(root, 'src/renderer') }, jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' } })
fs.writeFileSync(path.join(dir, 'index.html'), `<html><head><meta charset="utf-8"><link rel="stylesheet" href="${pathToFileURL(path.join(assets, css))}"></head><body><div id="root"></div><script src="renderer.js"></script></body></html>`)
fs.writeFileSync(path.join(dir, 'main.cjs'), `
const {app,BrowserWindow}=require('electron');const fs=require('fs'),path=require('path');
app.setPath('userData',path.join(__dirname,'profile'));
const wait=ms=>new Promise(r=>setTimeout(r,ms));
app.whenReady().then(async()=>{
 const w=new BrowserWindow({width:1100,height:820,show:false,webPreferences:{sandbox:true,backgroundThrottling:false}});
 const failures=[];w.webContents.on('console-message',(_e,level,message)=>{if(level>=3)failures.push(message)});
 await w.loadFile(path.join(__dirname,'index.html'));await wait(500);
 const js=c=>w.webContents.executeJavaScript(c);
 const shot=async name=>{await js('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');await wait(150);fs.writeFileSync(path.join(__dirname,name+'.png'),(await w.webContents.capturePage()).toPNG())};
 let n=0;const ok=(c,label,extra)=>{if(!c)throw new Error(label+(extra!==undefined?' '+JSON.stringify(extra):''));n++};
 const eq=(a,b,label)=>ok(JSON.stringify(a)===JSON.stringify(b),label,{got:a,want:b});
 const click=sel=>js("document.querySelector("+JSON.stringify(sel)+").click()").then(()=>wait(120));
 const has=sel=>js("!!document.querySelector("+JSON.stringify(sel)+")");
 const text=sel=>js("document.querySelector("+JSON.stringify(sel)+")?.textContent??null");
 const clock=id=>js("(()=>{const b=document.querySelector('[data-pane-cell="+id+"] [data-pane-clock]');return {state:b.dataset.paneClock,label:b.getAttribute('aria-label'),cls:b.className}})()");

 // --- Header clock (E8-FR-28) ---------------------------------------------
 let c=await clock('pa');
 ok(c.state==='active'&&/^Próxima: (lun|mar|mié|jue|vie) 09:00 \\(Lun-Vie\\)$/.test(c.label)&&c.cls.includes('text-accent-violet ')&&!c.cls.includes('/40'),'an active schedule lights the clock with "Próxima: <día> 09:00 (Lun-Vie)"',c);
 c=await clock('pp');
 ok(c.state==='paused'&&c.label==='Pausada'&&c.cls.includes('text-accent-violet/40'),'a paused schedule is dimmed and says "Pausada"',c);
 c=await clock('pn');
 ok(c.state==='none'&&c.label==='Programar prompt','a console without a schedule offers "Programar prompt"',c);

 // --- Settings > Automation table (E8-FR-32) --------------------------------
 const rows=()=>js("[...document.querySelectorAll('[data-automation-row]')].map(r=>({id:r.dataset.automationRow,rec:r.querySelector('[data-automation-rec]').textContent,next:r.querySelector('[data-automation-next]').textContent,last:r.querySelector('[data-automation-last]').textContent,on:r.querySelector('[role=switch]').getAttribute('aria-checked')}))");
 let r=await rows();
 eq(r.map(x=>x.id),['pa','pp'],'the table lists every scheduled console, in order');
 ok(r[0].rec==='Lun-Vie'&&/^(lun|mar|mié|jue|vie) 09:00$/.test(r[0].next)&&r[0].last==='Nunca se ejecutó'&&r[0].on==='true','active row: recurrence, next run, never ran, switch on',r[0]);
 ok(r[1].rec==='Una vez'&&r[1].next==='Pausada'&&/^Enviado hace 5 min/.test(r[1].last)&&r[1].on==='false','paused row: "Pausada" and the last result',r[1]);
 ok((await text('[data-automation-row=pa]')).includes('Backend con un nombre'),'the row names workspace / console');

 // --- Dialog from the header clock ------------------------------------------
 await click('[data-pane-cell=pa] [data-pane-clock]');
 ok(await has('[data-schedule-dialog=pa]'),'the clock opens the dialog');
 eq(await js("document.activeElement?.hasAttribute('data-schedule-prompt')"),true,'focus lands in the prompt');
 eq(await js("[...document.querySelectorAll('[data-schedule-kind]')].map(b=>b.textContent+(b.getAttribute('aria-checked')==='true'?'*':''))"),['Una vez','Diario','Lun-Vie*','Semanal','Cada hora'],'repeat chips with the current one checked');
 eq(await js("[document.querySelector('[data-schedule-wait]').checked,document.querySelector('[data-schedule-enabled] [role=switch]').getAttribute('aria-checked')]"),[true,'true'],'"Esperar a que el agente esté libre" on and Active on by default');
 ok((await text('[data-schedule-history]')).includes('Todavía no se ejecutó.'),'an empty history says so');
 // Weekly: day toggles L M X J V S D, at least one.
 await click('[data-schedule-kind=weekly]');
 eq(await js("[...document.querySelectorAll('[data-schedule-day]')].map(b=>b.textContent)"),['L','M','X','J','V','S','D'],'weekly shows L M X J V S D');
 for(const d of await js("[...document.querySelectorAll('[data-schedule-day][aria-pressed=true]')].map(b=>b.dataset.scheduleDay)"))await click('[data-schedule-day="'+d+'"]');
 ok(await has('[data-schedule-days-error]')&&await js("document.querySelector('[data-schedule-save]').disabled"),'no day selected: error and Save disabled');
 await click('[data-schedule-day="1"]');await click('[data-schedule-day="3"]');
 ok(!(await has('[data-schedule-days-error]'))&&!(await js("document.querySelector('[data-schedule-save]').disabled")),'with days picked Save is enabled');
 // Hourly shows the minute only.
 await click('[data-schedule-kind=hourly]');
 ok(await has('[data-schedule-minute]')&&!(await has('[data-schedule-time]')),'hourly asks for the minute');
 eq(await js("document.querySelector('[data-schedule-minute]').value"),'0','the minute comes from the time (09:00)');
 await click('[data-schedule-kind=weekly]');
 await click('[data-schedule-wait]');
 await click('[data-schedule-save]');
 let s=await js("smoke.sched('pa')");
 ok(!(await has('[data-schedule-dialog]'))&&s.recurrence.kind==='weekly'&&s.recurrence.days.join()==='1,3'&&s.waitIdle===false&&s.dueAt>Date.now()&&s.prompt==='revisa los PR abiertos','saving stores weekly L/X, waitIdle off and the next run',s);
 ok(new Date(s.dueAt).getHours()===9&&[1,3].includes(new Date(s.dueAt).getDay()),'the next run is a Monday or Wednesday at 09:00');

 // --- Paused dialog: history, See all, Run now -----------------------------
 await click('[data-pane-cell=pp] [data-pane-clock]');
 ok((await text('[data-schedule-next]'))==='Pausada','the dialog header says "Pausada"');
 eq(await js("[...document.querySelectorAll('[data-schedule-run]')].map(e=>e.dataset.scheduleRun)"),['sent','sent','sent_unconfirmed','failed','skipped_busy'],'the last 5 runs, newest first');
 ok((await text('[data-schedule-run=failed]')).includes('el agente no estaba corriendo')&&(await js("document.querySelectorAll('[data-schedule-run]')[1].textContent")).includes('(manual)'),'reason and manual trigger are shown');
 eq(await text('[data-schedule-show-all]'),'Ver todo (7)','"Ver todo (7)"');
 await shot('dialog-history-dark');
 for(const theme of ['midnight','light'])for(const scale of [1,1.25,1.5]){
  await js("smoke.theme('"+theme+"')");w.setSize(860,560);w.webContents.setZoomFactor(scale);await wait(250);
  const fit=await js("(()=>{const d=document.querySelector('[data-schedule-dialog]').getBoundingClientRect();const inner=document.querySelector('[data-schedule-dialog]');const btns=[...inner.querySelectorAll('button')].every(b=>b.scrollWidth<=b.clientWidth+1&&b.getBoundingClientRect().right<=d.right+1);const rows=[...inner.querySelectorAll('[data-schedule-run] span')].every(e=>e.scrollWidth<=e.clientWidth+1);return {ok:d.left>=0&&d.top>=0&&d.right<=innerWidth+0.5&&d.bottom<=innerHeight+0.5&&btns&&rows&&document.documentElement.scrollWidth<=innerWidth,d:[d.left,d.top,d.right,d.bottom],vp:[innerWidth,innerHeight],btns,rows}})()");
  ok(fit.ok,'dialog fits at '+theme+' '+scale,fit);
  if(scale===1.5)await shot('dialog-'+theme+'-150');
 }
 w.webContents.setZoomFactor(1);w.setSize(1100,820);await js("smoke.theme('midnight')");await wait(200);
 await click('[data-schedule-show-all]');
 eq(await js("document.querySelectorAll('[data-schedule-run]').length"),7,'"Ver todo" lists the whole history');
 // Run now on an agent console with no pty yet: "Esperando..." until its spawn reports back.
 await click('[data-schedule-run-now]');
 ok((await text('[data-schedule-run-now]')).includes('Esperando...')&&(await js('window.__submits.length'))===0,'"Probar ahora" shows "Esperando..." while the console has no pty');
 ok(await js("window.__mounted.includes('w1:pp')")===true&&await js("smoke.app().pendingPrompts.pp?.source")==='schedule','an unmounted agent console mounts alone and gets the run as its initial prompt');
 await js("smoke.setApp({pendingPrompts:{}})");
 // Esc closes only the dialog (a Settings modal behind it keeps its Esc).
 const before=await js('window.__bubbleEsc');
 await js("(document.activeElement||document.body).dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))");await wait(150);
 ok(!(await has('[data-schedule-dialog]'))&&(await js('window.__bubbleEsc'))===before,'Esc closes the dialog and stops there');

 // --- Table actions ----------------------------------------------------------
 await js("smoke.registerPty('pn','pty-pn')");
 await js("document.querySelector('[data-automation-row=pp] [role=switch]').click()");await wait(150);
 r=await rows();c=await clock('pp');
 ok(r[1].on==='true'&&/^(lun|mar|mié|jue|vie|sáb|dom) 18:30$/.test(r[1].next)&&c.state==='active'&&await js("smoke.sched('pp').dueAt>Date.now()"),'switching a paused one-shot on re-arms it (table and clock)',{r:r[1],c});
 // Run now from the table on a live shell console sends right away.
 await js("smoke.registerPty('pa','pty-pa')");
 await click('[data-automation-run=pa]');await wait(200);
 eq(await js('window.__submits.map(s=>[s.ptyId,s.text,s.enter,s.userGate])'),[['pty-pa','revisa los PR abiertos',true,true]],'"Probar ahora" from the table submits the saved prompt with Enter, gated on main (userGate)');
 r=await rows();
 ok(/^Enviado/.test(r[0].last)&&await js("smoke.sched('pa').history.length===1&&smoke.sched('pa').history[0].trigger==='manual'"),'the table shows the run result',r[0]);
 await click('[data-automation-edit=pp]');
 ok(await has('[data-schedule-dialog=pp]')&&(await js("document.getElementById('schedule-dialog-title').closest('[data-schedule-dialog]').textContent")).includes('Backend con un nombre de workspace bastante largo / Claude Code'),'"Editar" opens that console\\'s dialog');
 await click('[data-schedule-remove]');
 r=await rows();c=await clock('pp');
 ok(r.length===1&&c.state==='none','removing the schedule drops it from the table and the header',{r,c});
 for(const theme of ['midnight','light'])for(const scale of [1,1.25,1.5]){
  await js("smoke.theme('"+theme+"')");w.setSize(860,560);w.webContents.setZoomFactor(scale);await wait(250);
  const fit=await js("(()=>{const p=document.querySelector('[data-settings-pane]');const t=document.querySelector('[data-automation-table]');const cut=[...t.querySelectorAll('button')].some(b=>b.scrollWidth>b.clientWidth+1);return {ok:p.scrollWidth<=p.clientWidth+1&&!cut,sw:p.scrollWidth,cw:p.clientWidth,cut}})()");
  ok(fit.ok,'automation table fits at '+theme+' '+scale,fit);
  if(scale===1.5)await shot('table-'+theme+'-150');
 }
 if(failures.length)throw new Error(failures.join('\\n'));
 console.log('PASS: '+n+' schedule UI checks (header clock active/paused/none, dialog chips/days/minute/wait/active, history + see all, run now waiting and sending, Esc, automation table switch/run/edit/remove) at 100/125/150% dark/light; screenshots '+__dirname);w.destroy();app.quit();
}).catch(e=>{console.error(e);app.exit(1)});
`)
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
const res = spawnSync(require('electron'), [path.join(dir, 'main.cjs')], { env, windowsHide: true, encoding: 'utf8', timeout: 90000 })
process.stdout.write(res.stdout ?? ''); if (res.status !== 0) process.stderr.write(res.stderr ?? '')
process.exitCode = res.status ?? 1
