// "Leer plan completo" (app 2.7.0, A6) rendered from the production
// PlanModal, the in-app agent card (agentNotice) and the toast stack in an
// isolated hidden Electron window. main is a fake: status.plan answers from a
// table, so no pty, hook server, user config or real agent is touched.
// Checks: a plan request's card offers the action and other requests do not;
// the modal asks main for that request id, renders the plan as Markdown (never
// HTML), notes a truncated plan, falls back to the request's first line when
// main no longer keeps it (null or a failed call), ignores a late answer, shows
// the loading line only when slow, closes on Esc, Cerrar, the header X or the backdrop and
// gives the focus back, and leaves without it when [Ir] takes the user to the
// console. From the pane itself (a workspace grid that is not active, so no
// console spawns): the menu item and the header button show only while a
// precise plan request waits, and open the same modal. Requires npm run build (CSS).
const fs = require('node:fs'), os = require('node:os'), path = require('node:path')
const { pathToFileURL } = require('node:url')
const { spawnSync } = require('node:child_process')
const { buildSync } = require('esbuild')
const root = path.resolve(__dirname, '..'), dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snagentsos-plan-ui-'))
const assets = path.join(root, 'out/renderer/assets')
const css = fs.existsSync(assets) && fs.readdirSync(assets).find(f => /^index-.*\.css$/.test(f))
if (!css) throw new Error('Run npm run build first')
buildSync({ stdin: { contents: `
import React from 'react'; import {createRoot} from 'react-dom/client';
import {I18nProvider} from './src/renderer/i18n';
import {useAppStore} from './src/renderer/lib/store';
import {useToastStore} from './src/renderer/lib/toast';
import {onAgentStatus} from './src/renderer/lib/agentNotice';
import {openPlan, closePlan, usePlanModal} from './src/renderer/lib/planModal';
import {applyTheme} from './src/renderer/themes/applyTheme';
import {NotificationStack} from './src/renderer/components/ui/NotificationStack';
import {PlanModal} from './src/renderer/components/status/PlanModal';
import {WorkspaceView} from './src/renderer/components/workspace/WorkspaceView';
const noop=()=>()=>{};
const fallback=(base)=>new Proxy(base,{get:(t,k)=>k in t?t[k]:(typeof k==='string'?fallback(noop):undefined)});
const NL=String.fromCharCode(10),FENCE=String.fromCharCode(96).repeat(3);
const PLAN_MD=['# Refactor del parser','','1. Leer el lexer','2. Separar los tokens','',FENCE+'ts','const x = 1',FENCE,'','<b>html crudo</b>'].join(NL);
const plans={
 'pa|toolu_1':{requestId:'toolu_1',text:PLAN_MD,at:1,truncated:false},
 'pb|perm-1':{requestId:'perm-1',text:'## Inicio del plan'+NL+NL+'Paso uno.',at:2,truncated:true},
 'pp|toolu_p':{requestId:'toolu_p',text:'# Plan desde la consola'+NL+NL+'Un paso.',at:4,truncated:false},
};
const calls=[];let late=null;
window.snApi=fallback({platform:'win32',
 config:fallback({save(){}}),pty:fallback({write(){}}),
 app:fallback({info:async()=>({version:'2.7.0',portable:false,platform:'win32'})}),
 status:fallback({plan:(paneId,requestId)=>{calls.push([paneId,requestId===undefined?null:requestId]);
  if(paneId==='pd')return new Promise(r=>{late=r});
  if(paneId==='pe')return Promise.reject(new Error('ipc gone'));
  return Promise.resolve(plans[paneId+'|'+requestId]??null)}})});
const claude=(id,title)=>({id,type:'claude',title,color:'#d97757',icon:'claude'});
const s0=useAppStore.getState();
useAppStore.setState({hydrated:true,activeWorkspaceId:'w1',settings:{...s0.settings,language:'es'},
 workspaces:[{id:'w1',name:'Uno',cwd:'C:/r',panes:[claude('pa','Claude Code'),claude('pb','Backend'),claude('pc','Docs'),claude('pd','Lento'),claude('pe','Roto')],layout:{grid:4,order:['pa','pb','pc','pd','pe']}},
  {id:'w2',name:'Dos',cwd:'C:/d',panes:[claude('pp','Planifica'),claude('pq','Permiso'),claude('pr','Aproximado')]}]});
const st=(paneId,extra)=>useAppStore.getState().setPaneStatus({paneId,state:'action',precise:true,notify:false,provider:'claude',attention:true,...extra});
st('pb',{reason:'permission',pending:[{id:'perm-1',kind:'permission',toolName:'ExitPlanMode',summary:'Inicio del plan'}]});
st('pc',{reason:'plan',pending:[{id:'toolu_9',kind:'plan',toolName:'ExitPlanMode',summary:'Plan: migrar la base'}]});
// The pane's own entry points (w2, not active): a plan request, another tool's permission, a title-only plan stop.
st('pp',{reason:'plan',pending:[{id:'toolu_p',kind:'plan',toolName:'ExitPlanMode',summary:'Plan: desde la consola'}]});
st('pq',{reason:'permission',pending:[{id:'perm-q',kind:'permission',toolName:'Bash',summary:'npm test'}]});
st('pr',{precise:false,reason:'plan'});
function Grid(){const w=useAppStore(s=>s.workspaces.find(x=>x.id==='w2'));return w?<div style={{height:340}} className="flex min-h-0 min-w-0 flex-col"><div className="min-h-0 flex-1"><WorkspaceView workspace={w} isActive={false}/></div></div>:null}
applyTheme('midnight');
createRoot(document.getElementById('root')).render(<I18nProvider lang="es"><div style={{height:'100vh'}} className="flex bg-bg-primary text-text-primary"><main className="min-w-0 flex-1 p-6"><div className="xterm"><textarea id="term" className="xterm-helper-textarea" aria-label="term"/></div><Grid/></main><PlanModal/><NotificationStack/></div></I18nProvider>);
window.smoke={calls:()=>calls,
 st:(paneId,extra)=>st(paneId,extra),
 menu:async(id)=>{const h=document.querySelector('[data-pane-cell='+id+'] header');const r=h.getBoundingClientRect();h.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:r.left+40,clientY:r.top+10}));await new Promise(r=>setTimeout(r,120));return [...document.querySelectorAll('[role=menu] [role=menuitem]')].map(b=>b.textContent)},
 pick:async(label)=>{const b=[...document.querySelectorAll('[role=menu] [role=menuitem]')].find(e=>e.textContent===label);if(!b)return false;b.click();await new Promise(r=>setTimeout(r,120));return true},
 closeMenu:async()=>{window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}));await new Promise(r=>setTimeout(r,120))},
 card:(paneId,extra)=>onAgentStatus({paneId,state:'action',precise:true,notify:true,delivery:'inApp',provider:'claude',attention:true,...extra}),
 cardActions:(paneId)=>(useToastStore.getState().items.find(t=>t.dedupeKey==='agent:'+paneId)?.actions||[]).map(a=>a.label),
 clickButton:(place,label)=>{const card=[...document.querySelectorAll('[data-toast-id]')].find(c=>c.textContent.includes(place));const b=card&&[...card.querySelectorAll('button')].find(x=>x.textContent===label);if(b)b.click();return !!b},
 open:(paneId)=>openPlan(paneId),close:()=>closePlan(),
 view:()=>usePlanModal.getState().view,
 resolveLate:()=>{if(late)late({requestId:'r',text:'# Tarde',at:3,truncated:false});return !!late},
 text:(sel)=>document.querySelector(sel)?.textContent||'',
 has:(sel)=>!!document.querySelector(sel),
 esc:()=>document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true})),
 active:()=>{const a=document.activeElement;return {id:a?.id||'',close:!!a?.hasAttribute('data-plan-close')}},
};
`, resolveDir: root, loader: 'tsx' }, bundle: true, platform: 'browser', format: 'iife', outfile: path.join(dir, 'renderer.js'), alias: { '@shared': path.join(root, 'src/shared'), '@': path.join(root, 'src/renderer') }, jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' } })
fs.writeFileSync(path.join(dir, 'index.html'), `<html><head><meta charset="utf-8"><link rel="stylesheet" href="${pathToFileURL(path.join(assets, css))}"></head><body><div id="root"></div><script src="renderer.js"></script></body></html>`)
fs.writeFileSync(path.join(dir, 'main.cjs'), `
const {app,BrowserWindow}=require('electron');const fs=require('fs'),path=require('path');
app.setPath('userData',path.join(__dirname,'profile'));
const wait=ms=>new Promise(r=>setTimeout(r,ms));
app.whenReady().then(async()=>{
 const w=new BrowserWindow({width:1280,height:820,show:false,webPreferences:{sandbox:true,backgroundThrottling:false}});
 let failures=[];w.webContents.on('console-message',(_e,level,message)=>{if(level>=3)failures.push(message)});
 await w.loadFile(path.join(__dirname,'index.html'));await wait(400);
 const js=c=>w.webContents.executeJavaScript(c);
 const frames=()=>wait(120);
 const shot=async name=>{await js('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');await wait(150);fs.writeFileSync(path.join(__dirname,name+'.png'),(await w.webContents.capturePage()).toPNG())};
 let checks=0;const ok=(cond,what,data)=>{if(!cond)throw new Error(what+' '+JSON.stringify(data));checks++};
 const eq=(a,b,what)=>ok(JSON.stringify(a)===JSON.stringify(b),what,{got:a,want:b});
 w.webContents.focus();

 // The in-app card of a plan request carries the action; other requests do not.
 await js("smoke.card('pa',{reason:'plan',pending:[{id:'toolu_1',kind:'plan',toolName:'ExitPlanMode',summary:'Plan: refactor del parser'}]})");await frames();
 eq(await js("smoke.cardActions('pa')"),['Ir','Leer plan completo'],'a plan card offers Ir and Leer plan completo');
 await js("smoke.card('pc',{reason:'permission',pending:[{id:'perm-9',kind:'permission',toolName:'Bash',summary:'npm test'}]})");await frames();
 eq(await js("smoke.cardActions('pc')"),['Ir'],'a permission card for another tool has only Ir');
 await js("smoke.card('pb',{reason:'permission',pending:[{id:'perm-1',kind:'permission',toolName:'ExitPlanMode',summary:'Inicio del plan'}]})");await frames();
 eq(await js("smoke.cardActions('pb')"),['Ir','Leer plan completo'],'the permission prompt of ExitPlanMode counts as a plan request');
 await js("smoke.card('pd',{precise:false,reason:'plan'})");await frames();
 eq(await js("smoke.cardActions('pd')"),['Ir'],'a title-only (approximate) stop never offers the plan');
 await shot('plan-card');

 // Leer plan completo: main is asked for that request, the plan renders as Markdown.
 await js("document.getElementById('term').focus()");
 ok(await js("smoke.clickButton('Uno / Claude Code','Leer plan completo')"),'the card button is clickable');await frames();
 eq(await js('smoke.calls()'),[['pa','toolu_1']],'the modal asks status.plan for the pane and its pending request id');
 eq([await js("smoke.text('#plan-modal-title')"),await js("smoke.text('[data-plan-place]')")],['Plan del agente','Uno / Claude Code'],'title "Plan del agente" and the console it comes from');
 eq(await js("[...document.querySelectorAll('[data-plan-modal] [data-md-doc] [role=heading]')].map(e=>e.textContent)"),['Refactor del parser'],'the heading renders through MarkdownDoc');
 eq(await js("document.querySelectorAll('[data-plan-modal] [data-md-doc] ol li').length"),2,'the numbered list renders as a list');
 ok((await js("smoke.text('[data-plan-modal] [data-md-doc] pre')")).includes('const x = 1'),'the code block renders');
 ok(await js("!document.querySelector('[data-plan-modal] [data-md-doc] b')&&smoke.text('[data-plan-modal] [data-md-doc]').includes('<b>html crudo</b>')"),'raw HTML in a plan stays text, never markup');
 ok(!(await js("smoke.has('[data-plan-truncated]')"))&&!(await js("smoke.has('[data-plan-unavailable]')")),'a whole plan has no truncated note and no fallback');
 eq(await js('smoke.active()'),{id:'',close:true},'Cerrar takes the focus');
 ok(await js("(()=>{const b=document.querySelector('[data-plan-close]');return b.textContent==='Cerrar'&&/bg-transparent/.test(b.className)&&!b.querySelector('[data-key-hint]')&&!b.hasAttribute('aria-keyshortcuts')})()"),'Cerrar is a ghost button without a key chip');
 await shot('plan-modal');
 for(const scale of [1,1.5]){w.webContents.setZoomFactor(scale);await wait(200);ok(!(await js('document.documentElement.scrollWidth>innerWidth')),'no horizontal overflow at '+scale)}
 w.webContents.setZoomFactor(1);await wait(100);
 await js('smoke.esc()');await frames();
 ok(await js('smoke.view()')===null&&!(await js("smoke.has('[data-plan-modal]')")),'Esc closes the modal');
 eq(await js('smoke.active()'),{id:'term',close:false},'closing gives the focus back to what had it');

 // A plan main cut shows the note (the request came as ExitPlanMode's permission prompt).
 ok(await js("smoke.clickButton('Uno / Backend','Leer plan completo')"),'the ExitPlanMode permission card opens the modal');await frames();
 eq(await js('smoke.calls().at(-1)'),['pb','perm-1'],'with the id of the ExitPlanMode permission prompt');
 eq(await js("smoke.text('[data-plan-truncated]')"),'Este plan es largo: ac\\u00e1 se ve solo el principio.','a truncated plan shows the note');
 ok((await js("smoke.text('[data-plan-modal] [data-md-doc]')")).includes('Paso uno.'),'and still renders what main kept');
 await shot('plan-truncated');
 await js("document.querySelector('[data-plan-close]').click()");await frames();
 ok(await js('smoke.view()')===null,'Cerrar closes the modal');
 await js("smoke.open('pb')");await frames();
 eq([await js('smoke.calls().at(-1)'),await js("smoke.has('[data-plan-truncated]')")],[['pb','perm-1'],true],'opened with only the pane id, the request the status waits on is asked');
 // The toast stack sits above modals and can cover the footer: the header X closes too.
 eq(await js("document.querySelector('[data-plan-modal] [data-plan-close-x]')?.getAttribute('aria-label')"),'Cerrar','the header X is labelled Cerrar');
 await js("document.querySelector('[data-plan-close-x]').click()");await frames();
 ok(await js('smoke.view()')===null,'the header X closes the modal');

 // Gone from main: the request's first line and the unavailable note.
 await js("smoke.open('pc')");await frames();
 eq(await js('smoke.calls().at(-1)'),['pc','toolu_9'],'the plan request id of the status is asked');
 eq([await js("smoke.text('[data-plan-summary]')"),await js("smoke.text('[data-plan-unavailable]')").then(t=>t.endsWith('El plan completo ya no est\\u00e1 disponible.'))],['Plan: migrar la base',true],'null shows the first-line summary and "ya no esta disponible"');
 ok(!(await js("smoke.has('[data-plan-modal] [data-md-doc]')")),'no Markdown body without a plan');
 await shot('plan-unavailable');
 await js("document.querySelector('[data-plan-modal]').parentElement.firstElementChild.click()");await frames();
 ok(await js('smoke.view()')===null,'a click on the backdrop closes the modal');
 await js("smoke.open('pe')");await frames();
 ok(await js("smoke.has('[data-plan-unavailable]')")&&!(await js("smoke.has('[data-plan-summary]')")),'a failed call reads as unavailable (no summary without a pending request)');
 await js('smoke.close()');await frames();

 // Slow and late answers: the loading line only past 300 ms; a late plan never lands on another view.
 await js("smoke.open('pd')");await frames();
 ok(!(await js("smoke.has('[data-plan-loading]')"))&&await js("document.querySelector('[data-plan-modal]').getAttribute('aria-busy')")==='true','no loading line in the first frames');
 await wait(350);
 eq(await js("smoke.text('[data-plan-loading]')"),'Cargando el plan...','a slow answer shows "Cargando el plan..."');
 await js("smoke.open('pc')");await frames();
 ok(await js('smoke.resolveLate()'),'the slow call resolves late');await frames();
 eq([await js('smoke.view().paneId'),await js("smoke.has('[data-plan-unavailable]')"),await js("smoke.text('[data-plan-modal]').includes('Tarde')")],['pc',true,false],'the late plan of the first request is ignored');
 await js('smoke.close()');await frames();

 // [Ir] on the card while the plan is open: the modal leaves and never takes the focus back from the console.
 await js("document.getElementById('term').focus()");
 ok(await js("smoke.clickButton('Uno / Backend','Leer plan completo')"),'the plan opens again from the card');await frames();
 ok(await js("smoke.has('[data-plan-modal]')"),'the modal is open');
 ok(await js("smoke.clickButton('Uno / Backend','Ir')"),'Ir is clickable over the modal');await frames();
 eq([await js('smoke.view()'),(await js('smoke.active()')).id],[null,''],'going to the console closes the plan without refocusing what had the focus before');

 // From the pane itself: the menu item and the header button, only while a precise plan request waits.
 let items=await js("smoke.menu('pp')");
 ok(items.includes('Leer plan completo'),'the pane menu of a console with a plan request offers Leer plan completo',items);
 await js('smoke.closeMenu()');
 for(const id of ['pq','pr']){items=await js("smoke.menu('"+id+"')");ok(!items.includes('Leer plan completo'),'no Leer plan completo in the menu of '+id+' (another tool, or a title-only stop)',items);await js('smoke.closeMenu()')}
 eq(await js("['pp','pq','pr'].map(id=>!!document.querySelector('[data-pane-cell='+id+'] [data-pane-plan]'))"),[true,false,false],'the header button shows only on the console whose plan waits');
 eq(await js("document.querySelector('[data-pane-plan=pp]')?.getAttribute('aria-label')"),'Leer plan completo','the header button is named');
 await js("smoke.menu('pp')");ok(await js("smoke.pick('Leer plan completo')"),'the menu item is clickable');await frames();
 eq([await js('smoke.calls().at(-1)'),await js("smoke.text('[data-plan-place]')")],[['pp','toolu_p'],'Dos / Planifica'],'the menu item asks status.plan for that pane and its request, and names the console');
 eq(await js("[...document.querySelectorAll('[data-plan-modal] [data-md-doc] [role=heading]')].map(e=>e.textContent)"),['Plan desde la consola'],'and shows its plan');
 await shot('plan-from-pane');
 await js("document.querySelector('[data-plan-close]').click()");await frames();
 ok(await js('smoke.view()')===null,'Cerrar closes it');
 await js("document.querySelector('[data-pane-plan=pp]').focus()");
 await js("document.querySelector('[data-pane-plan=pp]').click()");await frames();
 eq([await js('smoke.calls().at(-1)'),await js("smoke.has('[data-plan-modal]')")],[['pp','toolu_p'],true],'the header button opens the same plan');
 await js('smoke.esc()');await frames();
 ok(await js('smoke.view()')===null&&await js("document.activeElement?.getAttribute('data-pane-plan')")==='pp','Esc closes it and the focus goes back to the button');
 // Answered from the console: main takes it out of pending and says attention false, the state stays action (reason plan) until the tool ends.
 await js("smoke.st('pp',{reason:'plan',pending:undefined,attention:false})");await frames();
 items=await js("smoke.menu('pp')");
 ok(!items.includes('Leer plan completo')&&!(await js("smoke.has('[data-pane-plan=pp]')")),'once the plan is answered (still action, out of pending) the item and the button go',items);
 await js('smoke.closeMenu()');
 await js("smoke.st('pp',{reason:'plan',pending:[{id:'toolu_p',kind:'plan',toolName:'ExitPlanMode',summary:'Plan: desde la consola'}],attention:true})");await frames();
 ok(await js("smoke.has('[data-pane-plan=pp]')"),'a plan request again brings the button back');
 await js("smoke.st('pp',{state:'working',reason:undefined,pending:[],attention:false})");await frames();
 items=await js("smoke.menu('pp')");
 ok(!items.includes('Leer plan completo')&&!(await js("smoke.has('[data-pane-plan=pp]')")),'once the plan is answered (working) the item and the button go',items);
 await js('smoke.closeMenu()');

 const copy=await js("document.body.textContent");
 ok(!/[\\u2013\\u2014]/.test(copy),'no dashes in the copy');
 if(failures.length)throw new Error(failures.join('\\n'));
 console.log('PASS: '+checks+' plan modal UI checks (card action, pane menu item and header button, Markdown, truncated, unavailable, late answer, focus); screenshots '+__dirname);w.destroy();app.quit();
}).catch(e=>{console.error(e);app.exit(1)});
`)
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL
const res = spawnSync(require('electron'), [path.join(dir, 'main.cjs')], { env, windowsHide: true, encoding: 'utf8', timeout: 90000 })
process.stdout.write(res.stdout ?? ''); if (res.status !== 0) process.stderr.write((res.stderr ?? '') + (res.error ? String(res.error) : ''))
process.exitCode = res.status ?? 1
