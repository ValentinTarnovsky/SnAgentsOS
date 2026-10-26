// Recurring automations UI (E8-FR-28..32; app 2.7.0 A10: several schedules
// per console and cron rules) from the production components in an isolated
// hidden Electron window: the pane header clock (active, paused, none, and
// the nearest next run among a console's schedules), the pane menu label that
// counts them, ScheduleDialog (the console's schedule list with add, select,
// switch and delete, the 8 cap, chips, weekly days, hourly minute, wait
// checkbox, "Advanced (cron)" with its inline errors and the next 3 runs,
// history with "See all", "Run now" waiting then sending, Esc that closes
// only the dialog) and the Settings > Automation table (one row per schedule:
// switch, run now, edit on that schedule), in dark and light at
// 100/125/150%. A next run 6 or more days away names its date in the clock,
// the table and the dialog list; a near one keeps weekday and time. Consoles stay unmounted placeholders and pty.submit is a
// stub: no pty, user config or agent is touched.
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
import {formatWhen} from './src/renderer/lib/scheduleFormat';
import {nextRuns} from './src/shared/cron';
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
 pane('pa','Revisor','shell',{schedules:[{id:'s1',time:'09:00',prompt:'revisa los PR abiertos',dueAt:nextWeekday,recurrence:{kind:'weekdays'}}]}),
 pane('pp','Claude Code','claude',{presetId:'preset-claude',schedules:[{id:'s1',time:'18:30',prompt:'resumi el dia',dueAt:now-3600000,enabled:false,history}]}),
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
const paneOf=id=>useAppStore.getState().workspaces[0].panes.find(p=>p.id===id);
const setScheds=(id,fn)=>useAppStore.setState(s=>({workspaces:s.workspaces.map(w=>({...w,panes:w.panes.map(p=>p.id!==id?p:{...p,schedules:fn(p.schedules||[])})}))}));
window.smoke={theme:applyTheme,app:useAppStore.getState,setApp:useAppStore.setState,registerPty,runtime:useScheduleRuntime.getState,nextRuns,when:at=>formatWhen(at,'es'),
 sched:(id,sid='s1')=>(paneOf(id).schedules||[]).find(s=>s.id===sid),
 ids:id=>(paneOf(id).schedules||[]).map(s=>s.id),
 patch:(id,sid,p)=>setScheds(id,l=>l.map(s=>s.id!==sid?s:{...s,...p})),
 setScheds:(id,list)=>setScheds(id,()=>list),
 menu:id=>{const h=document.querySelector('[data-pane-cell='+id+'] header');const r=h.getBoundingClientRect();h.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:r.left+40,clientY:r.top+10}))},
 setValue:(sel,v)=>{const el=document.querySelector(sel);Object.getOwnPropertyDescriptor(el.constructor.prototype,'value').set.call(el,v);el.dispatchEvent(new Event('input',{bubbles:true}))}};
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
 const setValue=(sel,v)=>js("smoke.setValue("+JSON.stringify(sel)+","+JSON.stringify(v)+")").then(()=>wait(100));
 const clock=id=>js("(()=>{const b=document.querySelector('[data-pane-cell="+id+"] [data-pane-clock]');return {state:b.dataset.paneClock,label:b.getAttribute('aria-label'),cls:b.className}})()");
 const esc=()=>js("(document.activeElement||document.body).dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))").then(()=>wait(150));
 const items=()=>js("[...document.querySelectorAll('[data-schedule-item]')].map(e=>e.dataset.scheduleItem)");
 const editing=()=>js("document.querySelector('[data-schedule-dialog]')?.dataset.scheduleEditing??null");
 const saveDisabled=()=>js("document.querySelector('[data-schedule-save]').disabled");
 const menuItems=async id=>{await js("smoke.menu('"+id+"')");await wait(150);return js("[...document.querySelectorAll('[role=menu] [role=menuitem]')].map(b=>b.textContent)")};
 // A near run reads "<día> HH:MM"; one that lands in the next year (a run on New Year's Eve) names its date and year instead (formatRunWhen).
 const near=async(txt,at,days,hm)=>{const other=await js("new Date("+at+").getFullYear()!==new Date().getFullYear()");return new RegExp('^('+days+')'+(other?', [0-9]{1,2} [a-z]{3,4} [0-9]{4},':'')+' '+hm+'$').test(txt)};

 // --- Header clock (E8-FR-28) ---------------------------------------------
 let c=await clock('pa');
 const paDue=await js("smoke.sched('pa').dueAt");
 const paWhen=/^Próxima: (.+) \\(Lun-Vie\\)$/.exec(c.label);
 ok(c.state==='active'&&paWhen&&await near(paWhen[1],paDue,'lun|mar|mié|jue|vie','09:00')&&c.cls.includes('text-accent-violet ')&&!c.cls.includes('/40'),'an active schedule lights the clock with "Próxima: <día> 09:00 (Lun-Vie)"',c);
 c=await clock('pp');
 ok(c.state==='paused'&&c.label==='Pausada'&&c.cls.includes('text-accent-violet/40'),'a paused schedule is dimmed and says "Pausada"',c);
 c=await clock('pn');
 ok(c.state==='none'&&c.label==='Programar prompt','a console without a schedule offers "Programar prompt"',c);
 let m=await menuItems('pa');
 ok(m.includes('Editar prompt programado')&&!m.some(x=>x.startsWith('Editar programaciones')),'with one schedule the pane menu says "Editar prompt programado"',m);
 await esc();

 // --- Settings > Automation table (E8-FR-32) --------------------------------
 const rows=()=>js("[...document.querySelectorAll('[data-automation-row]')].map(r=>({id:r.dataset.automationRow+':'+r.dataset.automationSchedule,rec:r.querySelector('[data-automation-rec]').textContent,next:r.querySelector('[data-automation-next]').textContent,last:r.querySelector('[data-automation-last]').textContent,on:r.querySelector('[role=switch]').getAttribute('aria-checked')}))");
 let r=await rows();
 eq(r.map(x=>x.id),['pa:s1','pp:s1'],'the table lists every schedule, in order');
 ok(r[0].rec==='Lun-Vie'&&await near(r[0].next,paDue,'lun|mar|mié|jue|vie','09:00')&&r[0].last==='Nunca se ejecutó'&&r[0].on==='true','active row: recurrence, next run, never ran, switch on',r[0]);
 ok(r[1].rec==='Una vez'&&r[1].next==='Pausada'&&/^Enviado hace 5 min/.test(r[1].last)&&r[1].on==='false','paused row: "Pausada" and the last result',r[1]);
 ok((await text('[data-automation-row=pa]')).includes('Backend con un nombre'),'the row names workspace / console');

 // --- A console with no schedule: a new one, no list ---------------------------
 await click('[data-pane-cell=pn] [data-pane-clock]');
 ok(await editing()==='new'&&!(await has('[data-schedule-list]'))&&await js("document.querySelector('[data-schedule-enabled] [role=switch]').getAttribute('aria-checked')")==='true','no schedule yet: the editor starts a new active one, without a list');
 await esc();

 // --- Dialog from the header clock ------------------------------------------
 await click('[data-pane-cell=pa] [data-pane-clock]');
 ok(await has('[data-schedule-dialog=pa]')&&await editing()==='s1','the clock opens the dialog on the schedule');
 eq(await items(),['s1'],'the list holds the console\\'s schedule');
 eq(await js("document.activeElement?.hasAttribute('data-schedule-prompt')"),true,'focus lands in the prompt');
 eq(await js("[...document.querySelectorAll('[data-schedule-kind]')].map(b=>b.textContent+(b.getAttribute('aria-checked')==='true'?'*':''))"),['Una vez','Diario','Lun-Vie*','Semanal','Cada hora','Avanzado (cron)'],'repeat chips with the current one checked, then "Avanzado (cron)"');
 eq(await js("[document.querySelector('[data-schedule-wait]').checked,document.querySelector('[data-schedule-item=s1] [role=switch]').getAttribute('aria-checked'),!!document.querySelector('[data-schedule-enabled]')]"),[true,'true',false],'"Esperar a que el agente esté libre" on; a saved schedule\\'s Active switch is its list row');
 ok((await text('[data-schedule-history]')).includes('Todavía no se ejecutó.'),'an empty history says so');
 // Weekly: day toggles L M X J V S D, at least one.
 await click('[data-schedule-kind=weekly]');
 eq(await js("[...document.querySelectorAll('[data-schedule-day]')].map(b=>b.textContent)"),['L','M','X','J','V','S','D'],'weekly shows L M X J V S D');
 for(const d of await js("[...document.querySelectorAll('[data-schedule-day][aria-pressed=true]')].map(b=>b.dataset.scheduleDay)"))await click('[data-schedule-day="'+d+'"]');
 ok(await has('[data-schedule-days-error]')&&await saveDisabled(),'no day selected: error and Save disabled');
 await click('[data-schedule-day="1"]');await click('[data-schedule-day="3"]');
 ok(!(await has('[data-schedule-days-error]'))&&!(await saveDisabled()),'with days picked Save is enabled');
 // Hourly shows the minute only.
 await click('[data-schedule-kind=hourly]');
 ok(await has('[data-schedule-minute]')&&!(await has('[data-schedule-time]')),'hourly asks for the minute');
 eq(await js("document.querySelector('[data-schedule-minute]').value"),'0','the minute comes from the time (09:00)');
 await click('[data-schedule-kind=weekly]');
 await click('[data-schedule-wait]');
 await click('[data-schedule-save]');
 let s=await js("smoke.sched('pa')");
 ok(!(await has('[data-schedule-dialog]'))&&s.id==='s1'&&s.recurrence.kind==='weekly'&&s.recurrence.days.join()==='1,3'&&s.waitIdle===false&&s.dueAt>Date.now()&&s.prompt==='revisa los PR abiertos','saving stores weekly L/X, waitIdle off and the next run',s);
 ok(new Date(s.dueAt).getHours()===9&&[1,3].includes(new Date(s.dueAt).getDay()),'the next run is a Monday or Wednesday at 09:00');

 // --- Add a cron schedule (A10) ---------------------------------------------
 await click('[data-pane-cell=pa] [data-pane-clock]');
 await click('[data-schedule-add]');
 ok(await editing()==='new'&&(await text('[data-schedule-item=new]'))==='Nueva programación'&&await js("document.querySelector('[data-schedule-add]').disabled"),'"Agregar programación" starts a new one in the list');
 eq(await js("[document.querySelector('[data-schedule-prompt]').value,document.activeElement?.hasAttribute('data-schedule-prompt'),document.querySelector('[data-schedule-enabled] [role=switch]').getAttribute('aria-checked'),!!document.querySelector('[data-schedule-history]')]"),['',true,'true',false],'the new one: empty prompt with focus, Active on, no history yet');
 const tv=await js("document.querySelector('[data-schedule-time]').value");
 await setValue('[data-schedule-prompt]','corré los tests');
 await click('[data-schedule-kind=cron]');
 ok(await has('[data-schedule-cron]')&&!(await has('[data-schedule-time]'))&&!(await has('[data-schedule-minute]')),'"Avanzado (cron)" swaps the time for the expression');
 eq(await js("document.querySelector('[data-schedule-cron]').value"),Number(tv.split(':')[1])+' '+Number(tv.split(':')[0])+' * * *','an empty field starts from what the chips said (once at '+tv+')');
 ok((await js("document.querySelectorAll('[data-schedule-cron-run]').length"))===3&&!(await saveDisabled()),'a valid rule lists 3 runs and can be saved');
 await setValue('[data-schedule-cron]','cada 5 minutos');
 eq([await js("document.querySelector('[data-schedule-cron-error]')?.dataset.scheduleCronError"),await text('[data-schedule-cron-error]'),await has('[data-schedule-cron-runs]'),await saveDisabled(),await js("document.querySelector('[data-schedule-cron]').getAttribute('aria-invalid')")],['invalid','No es una expresión válida: lleva 5 campos (minuto hora día mes día-de-la-semana).',false,true,'true'],'a parse error is inline, without runs, and blocks Save');
 await setValue('[data-schedule-cron]','*/5 * * * *');
 eq([await js("document.querySelector('[data-schedule-cron-error]')?.dataset.scheduleCronError"),await text('[data-schedule-cron-error]'),await saveDisabled()],['interval','Hay dos corridas a menos de 15 minutos. Separalas más.',true],'runs under 15 minutes apart are refused');
 await setValue('[data-schedule-cron]','0 0 31 2 *');
 eq([await js("document.querySelector('[data-schedule-cron-error]')?.dataset.scheduleCronError"),await text('[data-schedule-cron-error]'),await saveDisabled()],['never','Esta regla nunca corre: ninguna fecha coincide.',true],'an impossible rule (Feb 31) is refused');
 await setValue('[data-schedule-cron]','  0  9 * * 1-5 ');
 const want=await js("smoke.nextRuns('0 9 * * 1-5',Date.now(),3)");
 const got=await js("[...document.querySelectorAll('[data-schedule-cron-run]')].map(e=>({at:Number(e.dataset.scheduleCronRun),text:e.textContent}))");
 ok(!(await has('[data-schedule-cron-error]'))&&!(await saveDisabled())&&JSON.stringify(got.map(x=>x.at))===JSON.stringify(want),'a valid rule shows its next 3 runs (nextRuns)',{got,want});
 ok(got.every(x=>x.text.includes('09:00')&&new Date(x.at).getHours()===9&&new Date(x.at).getMinutes()===0&&new Date(x.at).getDay()>=1&&new Date(x.at).getDay()<=5),'the runs are Mon-Fri 09:00 in local time',got);
 // Validation runs on an edit only: with the clock a week back, a re-render
 // (the store moving) keeps the runs; a recompute would list a week earlier.
 await js("window.__now=Date.now;const back=Date.now()-7*86400000;Date.now=()=>back;smoke.patch('pa','s1',{prompt:'revisa los PR abiertos'})");await wait(100);
 const kept=await js("[...document.querySelectorAll('[data-schedule-cron-run]')].map(e=>Number(e.dataset.scheduleCronRun))");
 await js("Date.now=window.__now;0");
 eq(kept,want,'a re-render without an edit leaves the runs as of the last edit');
 await click('[data-schedule-save]');
 s=await js("smoke.sched('pa','s2')");
 ok(!(await has('[data-schedule-dialog]'))&&JSON.stringify(await js("smoke.ids('pa')"))==='["s1","s2"]'&&s.recurrence.kind==='cron'&&s.recurrence.expr==='0 9 * * 1-5'&&s.prompt==='corré los tests'&&s.dueAt===want[0],'saving adds s2 with the trimmed cron rule and its first run as dueAt',s);
 c=await clock('pa');
 ok(c.state==='active'&&/ · 2 programaciones$/.test(c.label),'the clock counts the console\\'s schedules',c);

 // --- A third one from the pane menu --------------------------------------------
 m=await menuItems('pa');
 ok(m.includes('Editar programaciones (2)'),'the pane menu counts them: "Editar programaciones (2)"',m);
 await js("[...document.querySelectorAll('[role=menu] [role=menuitem]')].find(b=>b.textContent==='Editar programaciones (2)').click()");await wait(150);
 eq(await items(),['s1','s2'],'the menu opens the list of both');
 await click('[data-schedule-add]');
 await click('[data-schedule-kind=daily]');
 await setValue('[data-schedule-time]','07:45');
 await setValue('[data-schedule-prompt]','tercera');
 await click('[data-schedule-save]');
 eq(await js("smoke.ids('pa')"),['s1','s2','s3'],'a third one gets s3');
 eq((await rows()).map(x=>x.id),['pa:s1','pa:s2','pa:s3','pp:s1'],'the table has one row per schedule');

 // --- The header clock picks the nearest next run ---------------------------------
 const H=3600000,t0=Date.now();
 await js("smoke.patch('pa','s1',{dueAt:"+(t0+5*H)+"});smoke.patch('pa','s2',{dueAt:"+(t0+3*H)+"});smoke.patch('pa','s3',{dueAt:"+(t0+H)+"})");await wait(100);
 c=await clock('pa');
 eq([c.state,c.label],['active','Próxima: '+(await js("smoke.when("+(t0+H)+")"))+' (Diario) · 3 programaciones'],'the clock shows the nearest of the three (s3, daily)');
 await js("smoke.patch('pa','s3',{enabled:false})");await wait(100);
 c=await clock('pa');
 ok(c.state==='active'&&c.label.startsWith('Próxima: '+(await js("smoke.when("+(t0+3*H)+")"))+' (')&&c.label.endsWith(') · 3 programaciones'),'a paused one is skipped: the cron one is next',c);
 await js("smoke.patch('pa','s1',{enabled:false});smoke.patch('pa','s2',{enabled:false})");await wait(100);
 c=await clock('pa');
 eq([c.state,c.label],['paused','Pausada · 3 programaciones'],'all paused: dimmed, "Pausada"');
 await js("smoke.patch('pa','s1',{enabled:undefined});smoke.patch('pa','s2',{enabled:undefined})");await wait(100);

 // --- A run 6 or more days away names its date (a cron rule can be months ahead) ---
 const far=await js("(()=>{const d=new Date();d.setDate(d.getDate()+40);d.setHours(9,0,0,0);return d.getTime()})()");
 const s2due=await js("smoke.sched('pa','s2').dueAt");
 await js("smoke.patch('pa','s1',{enabled:false});smoke.patch('pa','s2',{dueAt:"+far+"})");await wait(100);
 const farWhen=await js("smoke.when("+far+")");
 const farDay=await js("(()=>{const d=new Date("+far+");return {day:d.getDate(),year:d.getFullYear()!==new Date().getFullYear()?d.getFullYear():null}})()");
 const m40=/^(lun|mar|mié|jue|vie|sáb|dom), (\\d{1,2}) [a-z]{3,4}(?: (\\d{4}))?, 09:00$/.exec(farWhen);
 ok(m40&&Number(m40[2])===farDay.day&&(m40[3]?Number(m40[3]):null)===farDay.year,'a run 40 days away reads "<día>, <d> <mes>, 09:00" (with the year only in another year)',farWhen);
 c=await clock('pa');
 eq(c.label,'Próxima: '+farWhen+' (Cron: 0 9 * * 1-5) · 3 programaciones','the header clock names the date of a far run');
 eq((await rows()).find(x=>x.id==='pa:s2').next,farWhen,'so does its Settings row');
 await click('[data-pane-cell=pa] [data-pane-clock]');
 ok(await editing()==='s2'&&(await text('[data-schedule-item=s2] [data-schedule-item-next]'))===farWhen&&await js("(e=>e.scrollWidth<=e.clientWidth+1)(document.querySelector('[data-schedule-item=s2] [data-schedule-item-next]'))"),'and the dialog list row, untruncated');
 await esc();
 await js("smoke.patch('pa','s1',{enabled:undefined});smoke.patch('pa','s2',{dueAt:"+s2due+"})");await wait(100);
 r=await rows();
 ok(await near(r.find(x=>x.id==='pa:s1').next,await js("smoke.sched('pa','s1').dueAt"),'lun|mar|mié|jue|vie|sáb|dom','[0-9]{2}:[0-9]{2}'),'a run hours away keeps weekday and time',r.find(x=>x.id==='pa:s1'));

 // --- Edit from the table opens that schedule; delete one -------------------------
 await click('[data-automation-row=pa][data-automation-schedule=s2] [data-automation-edit]');
 ok(await editing()==='s2'&&await js("document.querySelector('[data-schedule-kind=cron]').getAttribute('aria-checked')")==='true'&&await js("document.querySelector('[data-schedule-cron]').value")==='0 9 * * 1-5'&&(await js("document.querySelectorAll('[data-schedule-cron-run]').length"))===3,'"Editar" on the cron row opens s2 with its rule and runs');
 eq(await js("document.querySelector('[data-schedule-item=s3] [role=switch]').getAttribute('aria-checked')"),'false','the list shows each schedule\\'s switch');
 await click('[data-schedule-item=s3] [role=switch]');
 ok(await js("smoke.sched('pa','s3').enabled!==false&&smoke.sched('pa','s3').dueAt>Date.now()"),'a list switch re-arms that schedule at once');
 await click('[data-schedule-select=s1]');
 ok(await editing()==='s1'&&await js("document.querySelector('[data-schedule-kind=weekly]').getAttribute('aria-checked')")==='true'&&await js("document.querySelector('[data-schedule-prompt]').value")==='revisa los PR abiertos','picking another one loads it into the editor');
 await click('[data-schedule-select=s2]');
 await click('[data-schedule-delete=s2]');
 ok(await has('[data-schedule-dialog=pa]')&&JSON.stringify(await items())==='["s1","s3"]'&&await editing()==='s1'&&JSON.stringify(await js("smoke.ids('pa')"))==='["s1","s3"]','deleting the open one keeps the dialog on the next one');
 // The cap: 8 per console.
 await esc();
 const eight=await js("Array.from({length:8},(_,i)=>({id:'s'+(i+1),time:'10:00',prompt:'p'+(i+1),dueAt:Date.now()+(i+2)*3600000,recurrence:{kind:'daily'}}))");
 const keep=await js("smoke.app().workspaces[0].panes.find(p=>p.id==='pa').schedules");
 await js("smoke.setScheds('pa',"+JSON.stringify(eight)+")");await wait(100);
 await click('[data-pane-cell=pa] [data-pane-clock]');
 ok((await items()).length===8&&await js("document.querySelector('[data-schedule-add]').disabled")&&(await text('[data-schedule-full]'))==='Hasta 8 por consola.','with 8 schedules "Agregar" is off: "Hasta 8 por consola."');
 await shot('dialog-list-8');
 await esc();
 await js("smoke.setScheds('pa',"+JSON.stringify(keep)+")");await wait(100);

 // --- Paused dialog: history, See all, Run now -----------------------------
 await click('[data-pane-cell=pp] [data-pane-clock]');
 ok((await text('[data-schedule-item=s1] [data-schedule-item-next]'))==='Pausada','the list row says "Pausada"');
 eq(await js("[...document.querySelectorAll('[data-schedule-run]')].map(e=>e.dataset.scheduleRun)"),['sent','sent','sent_unconfirmed','failed','skipped_busy'],'the last 5 runs, newest first');
 ok((await text('[data-schedule-run=failed]')).includes('el agente no estaba corriendo')&&(await js("document.querySelectorAll('[data-schedule-run]')[1].textContent")).includes('(manual)'),'reason and manual trigger are shown');
 eq(await text('[data-schedule-show-all]'),'Ver todo (7)','"Ver todo (7)"');
 await shot('dialog-history-dark');
 const fitDialog=()=>js("(()=>{const d=document.querySelector('[data-schedule-dialog]').getBoundingClientRect();const inner=document.querySelector('[data-schedule-dialog]');const btns=[...inner.querySelectorAll('button')].every(b=>b.scrollWidth<=b.clientWidth+1&&b.getBoundingClientRect().right<=d.right+1);const rows=[...inner.querySelectorAll('[data-schedule-run] span')].every(e=>e.scrollWidth<=e.clientWidth+1);return {ok:d.left>=0&&d.top>=0&&d.right<=innerWidth+0.5&&d.bottom<=innerHeight+0.5&&btns&&rows&&document.documentElement.scrollWidth<=innerWidth,d:[d.left,d.top,d.right,d.bottom],vp:[innerWidth,innerHeight],btns,rows}})()");
 for(const theme of ['midnight','light'])for(const scale of [1,1.25,1.5]){
  await js("smoke.theme('"+theme+"')");w.setSize(860,560);w.webContents.setZoomFactor(scale);await wait(250);
  const fit=await fitDialog();
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
 await esc();
 ok(!(await has('[data-schedule-dialog]'))&&(await js('window.__bubbleEsc'))===before,'Esc closes the dialog and stops there');

 // --- The cron editor fits too ------------------------------------------------
 await click('[data-automation-row=pa][data-automation-schedule=s1] [data-automation-edit]');
 await click('[data-schedule-kind=cron]');
 for(const theme of ['midnight','light'])for(const scale of [1,1.5]){
  await js("smoke.theme('"+theme+"')");w.setSize(860,560);w.webContents.setZoomFactor(scale);await wait(250);
  const fit=await fitDialog();
  ok(fit.ok&&(await js("document.querySelectorAll('[data-schedule-cron-run]').length"))===3,'cron editor fits at '+theme+' '+scale,fit);
  await js("document.querySelector('[data-schedule-cron]').scrollIntoView({block:'center'})");await shot('dialog-cron-'+theme+'-'+scale*100);
 }
 await setValue('[data-schedule-cron]','*/10 9 * * *');
 await js("document.querySelector('[data-schedule-cron]').scrollIntoView({block:'center'})");await shot('dialog-cron-error');
 w.webContents.setZoomFactor(1);w.setSize(1100,820);await js("smoke.theme('midnight')");await wait(200);
 await esc();
 ok(await js("smoke.sched('pa','s1').recurrence.kind")==='weekly','closing without saving keeps the rule');

 // --- Table actions ----------------------------------------------------------
 await js("smoke.registerPty('pn','pty-pn')");
 await js("document.querySelector('[data-automation-row=pp] [role=switch]').click()");await wait(150);
 r=await rows();c=await clock('pp');
 const ppRow=r.find(x=>x.id==='pp:s1');
 ok(ppRow.on==='true'&&await near(ppRow.next,await js("smoke.sched('pp').dueAt"),'lun|mar|mié|jue|vie|sáb|dom','18:30')&&c.state==='active'&&await js("smoke.sched('pp').dueAt>Date.now()"),'switching a paused one-shot on re-arms it (table and clock)',{r:ppRow,c});
 // Run now from the table on a live shell console sends right away.
 await js("smoke.registerPty('pa','pty-pa')");
 await click('[data-automation-row=pa][data-automation-schedule=s1] [data-automation-run]');await wait(200);
 eq(await js('window.__submits.map(s=>[s.ptyId,s.text,s.enter,s.userGate])'),[['pty-pa','revisa los PR abiertos',true,true]],'"Probar ahora" from the table submits that schedule\\'s prompt with Enter, gated on main (userGate)');
 r=await rows();
 ok(/^Enviado/.test(r.find(x=>x.id==='pa:s1').last)&&r.find(x=>x.id==='pa:s3').last==='Nunca se ejecutó'&&await js("smoke.sched('pa').history.length===1&&smoke.sched('pa').history[0].trigger==='manual'&&!smoke.sched('pa','s3').history"),'the table shows the run result on that row only',r);
 await click('[data-automation-edit=pp]');
 ok(await has('[data-schedule-dialog=pp]')&&(await js("document.getElementById('schedule-dialog-title').closest('[data-schedule-dialog]').textContent")).includes('Backend con un nombre de workspace bastante largo / Claude Code'),'"Editar" opens that console\\'s dialog');
 await click('[data-schedule-delete=s1]');
 ok(await editing()==='new'&&!(await has('[data-schedule-list]')),'deleting the last one leaves a new one in the editor');
 await esc();
 r=await rows();c=await clock('pp');
 ok(r.map(x=>x.id).join()==='pa:s1,pa:s3'&&c.state==='none'&&await js("smoke.app().workspaces[0].panes.find(p=>p.id==='pp').schedules===undefined"),'removing the schedule drops it from the table and the header',{r,c});
 // A long cron rule wraps inside its row instead of running under the buttons.
 const longCron='0 9 1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28,29,30,31 * *';
 await js("smoke.patch('pa','s3',{recurrence:{kind:'cron',expr:'"+longCron+"'}})");await wait(100);
 eq(await text('[data-automation-schedule=s3] [data-automation-rec]'),'Cron: '+longCron,'a cron row shows its expression');
 for(const theme of ['midnight','light'])for(const scale of [1,1.25,1.5]){
  await js("smoke.theme('"+theme+"')");w.setSize(860,560);w.webContents.setZoomFactor(scale);await wait(250);
  const fit=await js("(()=>{const p=document.querySelector('[data-settings-pane]');const t=document.querySelector('[data-automation-table]');const cut=[...t.querySelectorAll('button')].some(b=>b.scrollWidth>b.clientWidth+1);const cell=document.querySelector('[data-automation-schedule=s3] [role=cell]').getBoundingClientRect();const rec=document.querySelector('[data-automation-schedule=s3] [data-automation-rec]').getBoundingClientRect();const wrapped=rec.right<=cell.right+1;return {ok:p.scrollWidth<=p.clientWidth+1&&!cut&&wrapped,sw:p.scrollWidth,cw:p.clientWidth,cut,wrapped,rec:rec.right,cell:cell.right}})()");
  ok(fit.ok,'automation table fits at '+theme+' '+scale,fit);
  if(scale===1.5)await shot('table-'+theme+'-150');
 }
 if(failures.length)throw new Error(failures.join('\\n'));
 console.log('PASS: '+n+' schedule UI checks (header clock active/paused/none/nearest of several, menu count, dialog list add/select/switch/delete/cap 8, chips/days/minute/wait, cron errors and next 3 runs, history + see all, run now waiting and sending, Esc, automation table per schedule switch/run/edit/remove) at 100/125/150% dark/light; screenshots '+__dirname);w.destroy();app.quit();
}).catch(e=>{console.error(e);app.exit(1)});
`)
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
const res = spawnSync(require('electron'), [path.join(dir, 'main.cjs')], { env, windowsHide: true, encoding: 'utf8', timeout: 120000 })
process.stdout.write(res.stdout ?? ''); if (res.status !== 0) process.stderr.write(res.stderr ?? '')
process.exitCode = res.status ?? 1
