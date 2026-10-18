// Agents v2.2 UI (E5-FR-12, 21, 22) rendered from the production components in
// an isolated hidden Electron window: the "resume interrupted chats?" dialog
// (groups, tri-state, countdown, Esc, Enter, timeout, 0 = never) at
// 100/125/150% in dark and light, the gated console placeholder, the topic in
// the pane header (truncated before the title) and the Smart sidebar order
// frozen under the pointer. Consoles stay unmounted, so no pty, user config or
// real agent is touched.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path')
const { pathToFileURL } = require('node:url')
const { spawnSync } = require('node:child_process')
const { buildSync } = require('esbuild')
const root = path.resolve(__dirname, '..'), dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snagentsos-resume-dialog-ui-'))
const assets = path.join(root, 'out/renderer/assets')
const css = fs.readdirSync(assets).find(f => /^index-.*\.css$/.test(f))
if (!css) throw new Error('Run npm run build first')
buildSync({ stdin: { contents: `
import React from 'react'; import {createRoot} from 'react-dom/client';
import {PaneCell} from './src/renderer/components/layout/PaneCell';
import {ResumeDialog} from './src/renderer/components/agents/ResumeDialog';
import {Sidebar} from './src/renderer/components/sidebar/Sidebar';
import {I18nProvider} from './src/renderer/i18n';
import {useAppStore} from './src/renderer/lib/store';
import {useAgentStore} from './src/renderer/lib/agentStore';
import {applyTheme} from './src/renderer/themes/applyTheme';
window.__forgot=[];window.__mounted=[];
window.snApi={platform:'win32',agents:{forget(id){window.__forgot.push(id)},list:async()=>[],startup:async()=>({trigger:null,interrupted:[]}),startupPending:async()=>[],consumeStartup:async()=>false,onChanged:()=>()=>{},onReady:()=>()=>{}},pty:{kill:async()=>{},write(){}},config:{save(){}}};
const preset={id:'preset-claude',name:'Claude Code',type:'claude',command:'claude',args:[],color:'#d97757',icon:'claude'};
const pane=(id,title,extra)=>({id,type:'claude',presetId:'preset-claude',title,color:'#d97757',icon:'claude',...extra});
const w1={id:'w1',name:'Backend con un nombre de workspace bastante largo para el truncado',cwd:'C:/repo',panes:[pane('pa','Claude Code'),pane('pb','Claude Code')],layout:{grid:2,order:['pa','pb']}};
const w2={id:'w2',name:'Frontend',cwd:'C:/web',panes:[pane('pc','Codex',{type:'codex',presetId:undefined,icon:'openai'}),pane('pt','Claude Code')],layout:{grid:2,order:['pc','pt']}};
const w3={id:'w3',name:'Docs',cwd:'C:/docs',panes:[pane('pz','Claude Code')]};
const st=useAppStore.getState();
useAppStore.setState({hydrated:true,presets:[preset],workspaces:[w1,w2,w3],activeWorkspaceId:'w1',
  paneStatus:{pt:{state:'working',precise:true,provider:'claude',stateSince:Date.now()-60000,topic:'Arreglar el login de usuarios con un topic muy largo que no entra en el header'},pz:{state:'idle',precise:true,provider:'claude',stateSince:Date.now()-1000}},
  settings:{...st.settings,notifications:{...st.settings.notifications,hooksEnabled:true},agents:{...st.settings.agents,resumeNudge:false,resumeModalTimeoutSec:60,sidebarSort:'smart'}}});
// Consoles stay placeholders: mounting is recorded, never performed (no xterm, no pty).
useAppStore.setState({ensureMounted:(id,o)=>window.__mounted.push(id+':'+((o&&o.only)||[]).join('+'))});
const now=Date.now();
const view=(paneId,provider,extra)=>({paneId,provider,sessionId:'0b7c2f4e-1a2b-4c3d-8e9f-0123456789ab',spawnCwd:'C:/repo',activity:'unknown',updatedAt:now-2*3600000,available:true,...extra});
const sessions={
  pa:view('pa','claude',{topic:'Fix login bug en el formulario de acceso con un titulo larguisimo para probar el truncado',lastPrompt:'arreglá el login y corré los tests de integración que fallan desde ayer',interrupted:{activity:'working',trigger:'update',at:now}}),
  pb:view('pb','claude',{firstPrompt:'refactor del store',interrupted:{activity:'action',reason:'permission',trigger:'update',at:now}}),
  pc:view('pc','codex',{interrupted:{activity:'action',reason:'plan',trigger:'update',at:now}}),
};
window.smoke={theme:applyTheme,setApp:useAppStore.setState,app:useAppStore.getState,agents:useAgentStore.getState,setAgents:useAgentStore.setState,
  open:(timeout)=>{useAppStore.setState({settings:{...useAppStore.getState().settings,agents:{...useAppStore.getState().settings.agents,resumeModalTimeoutSec:timeout}}});useAgentStore.setState({sessions,launchIntent:{}});useAgentStore.getState().setModal({paneIds:['pa','pb','pc'],trigger:'update',openedAt:Date.now()})}};
const noop=()=>{};
const cell=(w,p,i)=><PaneCell key={p.id} workspace={w} pane={p} presets={[preset]} workspaceActive={false} maximizedId={null} minimizedIds={[]} index={i} isDragging={false} draggable={false} onToggleMax={noop} onToggleMin={noop} onClose={noop} onDragStartCell={noop} onDragEnterCell={noop} onDragEndCell={noop}/>;
function Root(){return <div style={{height:'100vh'}} className="flex bg-bg-primary text-text-primary"><Sidebar/><div style={{flex:1,display:'grid',gridTemplateColumns:'repeat(2,minmax(0,1fr))',gap:6,padding:6}}>{cell(w1,w1.panes[0],0)}{cell(w1,w1.panes[1],1)}{cell(w2,w2.panes[0],0)}{cell(w2,w2.panes[1],1)}</div><ResumeDialog/></div>}
window.smoke.open(60);
createRoot(document.getElementById('root')).render(<I18nProvider lang="es"><Root/></I18nProvider>);
`, resolveDir: root, loader: 'tsx' }, bundle: true, platform: 'browser', format: 'iife', outfile: path.join(dir, 'renderer.js'), alias: { '@shared': path.join(root, 'src/shared'), '@': path.join(root, 'src/renderer') }, jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' } })
fs.writeFileSync(path.join(dir, 'index.html'), `<html><head><meta charset="utf-8"><link rel="stylesheet" href="${pathToFileURL(path.join(assets, css))}"></head><body><div id="root"></div><script src="renderer.js"></script></body></html>`)
fs.writeFileSync(path.join(dir, 'main.cjs'), `
const {app,BrowserWindow}=require('electron');const fs=require('fs'),path=require('path');
app.setPath('userData',path.join(__dirname,'profile'));
const wait=ms=>new Promise(r=>setTimeout(r,ms));
app.whenReady().then(async()=>{
 const w=new BrowserWindow({width:1280,height:760,show:false,webPreferences:{sandbox:true,backgroundThrottling:false}});
 let failures=[];w.webContents.on('console-message',(_e,level,message)=>{if(level>=3)failures.push(message)});
 await w.loadFile(path.join(__dirname,'index.html'));await wait(500);
 const js=c=>w.webContents.executeJavaScript(c);
 const shot=async name=>{await js('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');await wait(150);fs.writeFileSync(path.join(__dirname,name+'.png'),(await w.webContents.capturePage()).toPNG())};
 const q="document.querySelector('[data-resume-dialog]')";
 let c=await js("({title:document.getElementById('resume-dialog-title')?.textContent,sub:document.querySelector('[data-resume-subtitle]')?.textContent,groups:[...document.querySelectorAll('[data-resume-ws]')].map(g=>g.dataset.resumeWs),rows:[...document.querySelectorAll('[data-resume-row]')].map(r=>r.dataset.resumeRow),apply:document.querySelector('[data-resume-apply]')?.textContent,focus:document.activeElement?.hasAttribute('data-resume-apply'),count:document.querySelector('[data-resume-countdown]')?.textContent,gated:[...document.querySelectorAll('[data-pane-gated]')].map(g=>g.dataset.paneGated),gatedText:document.querySelector('[data-pane-gated]')?.textContent,nudge:!!document.querySelector('[data-resume-nudge]'),rowText:document.querySelector('[data-resume-row=pb]')?.textContent})");
 if(c.title!=='¿Retomar chats interrumpidos?'||c.sub!=='Se cortaron al actualizar.')throw new Error('dialog title/subtitle '+JSON.stringify(c));
 if(c.groups.join()!=='w1,w2'||c.rows.join()!=='pa,pb,pc')throw new Error('2 groups, 3 rows in order '+JSON.stringify(c));
 if(!c.apply.startsWith('Retomar 3')||!c.focus)throw new Error('"Retomar 3" is the focused primary '+JSON.stringify(c));
 if(!/^Se retoman automáticamente en (1:00|0:59|0:58)$/.test(c.count))throw new Error('countdown text '+JSON.stringify(c));
 if(c.gated.join()!=='pa,pb,pc'||c.gatedText!=='Esperando tu decisión sobre retomar el chat…')throw new Error('gated placeholders '+JSON.stringify(c));
 if(!c.nudge||!c.rowText.includes('refactor del store')||!c.rowText.includes('esperando tu respuesta: permiso')||!c.rowText.includes('hace 2 h'))throw new Error('row content / nudge row '+JSON.stringify(c));
 // FR-21: the topic follows the title and is truncated first.
 const topic=await js("(()=>{const t=[...document.querySelectorAll('[data-pane-topic]')].find(e=>e.textContent.includes('Arreglar'));const title=t.previousElementSibling;return {text:t.textContent,cut:t.scrollWidth>t.clientWidth,titleWhole:title.scrollWidth<=title.clientWidth,title:title.textContent}})()");
 if(!topic.text.startsWith(' · Arreglar el login')||!topic.cut||!topic.titleWhole||topic.title!=='Claude Code')throw new Error('topic truncated before the title '+JSON.stringify(topic));
 await shot('dialog-dark-100');
 for(const theme of ['midnight','light'])for(const scale of [1,1.25,1.5]){
  await js("smoke.theme('"+theme+"')");w.setSize(860,560);w.webContents.setZoomFactor(scale);await wait(250);
  const fit=await js("(()=>{const d=document.querySelector('[role=dialog]').getBoundingClientRect();const btns=[...document.querySelectorAll('[role=dialog] button')].every(b=>b.scrollWidth<=b.clientWidth+1&&b.getBoundingClientRect().right<=d.right+1);return {ok:d.left>=0&&d.top>=0&&d.right<=innerWidth+0.5&&d.bottom<=innerHeight+0.5&&btns&&document.documentElement.scrollWidth<=innerWidth,d:[d.left,d.top,d.right,d.bottom],vp:[innerWidth,innerHeight],btns}})()");
  if(!fit.ok)throw new Error('dialog overflows at '+theme+' '+scale+' '+JSON.stringify(fit));
  if(scale===1.5)await shot('dialog-'+theme+'-150');
 }
 w.webContents.setZoomFactor(1);w.setSize(1280,760);await js("smoke.theme('midnight')");await wait(200);
 // Esc never closes; it is an interaction, so the countdown stops.
 await js("window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))");await wait(150);
 c=await js("({open:!!"+q+",count:!!document.querySelector('[data-resume-countdown]')})");
 if(!c.open||c.count)throw new Error('Esc keeps the dialog and cancels the countdown '+JSON.stringify(c));
 // Untick one row: "Retomar 2" and the workspace checkbox goes mixed.
 await js("document.querySelector('[data-resume-row=pb] input').click()");await wait(100);
 c=await js("({apply:document.querySelector('[data-resume-apply]').textContent,mixed:document.querySelector('[data-resume-group=w1]').indeterminate,other:document.querySelector('[data-resume-group=w2]').indeterminate})");
 if(!c.apply.startsWith('Retomar 2')||!c.mixed||c.other)throw new Error('untick -> Retomar 2 and a mixed group '+JSON.stringify(c));
 // Enter applies "Retomar N" with the selection.
 await js("window.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}))");await wait(200);
 c=await js("({open:!!"+q+",intents:smoke.agents().launchIntent,gated:document.querySelectorAll('[data-pane-gated]').length,pending:smoke.agents().modalPending,mounted:window.__mounted.join()})");
 if(c.open||c.gated||c.pending||c.intents.pa!=='resume'||c.intents.pb!=='fresh'||c.intents.pc!=='resume'||c.mounted!=='w1:pa,w2:pc')throw new Error('Enter resumes the selection, mounts the resumed consoles and releases the gates '+JSON.stringify(c));
 // A click cancels the countdown.
 await js('smoke.open(60)');await wait(200);
 await js("document.querySelector('[data-resume-row=pa]').dispatchEvent(new PointerEvent('pointerdown',{bubbles:true}))");await wait(150);
 c=await js("({count:!!document.querySelector('[data-resume-countdown]'),open:!!"+q+"})");
 if(c.count||!c.open)throw new Error('a click in the dialog cancels the countdown '+JSON.stringify(c));
 // "Empezar de cero" forgets every listed chat.
 await js("document.querySelector('[data-resume-fresh]').click()");await wait(150);
 c=await js("({open:!!"+q+",forgot:window.__forgot.join(),intents:smoke.agents().launchIntent})");
 if(c.open||c.forgot!=='pa,pb,pc'||c.intents.pa!=='fresh')throw new Error('"Empezar de cero" '+JSON.stringify(c));
 // Unattended: with a 1 s timeout the selection resumes by itself.
 await js('smoke.open(1)');await wait(1600);
 c=await js("({open:!!"+q+",intents:smoke.agents().launchIntent})");
 if(c.open||c.intents.pa!=='resume'||c.intents.pb!=='resume'||c.intents.pc!=='resume')throw new Error('the countdown applies "Retomar N" at 0 '+JSON.stringify(c));
 // 0 = never: no countdown.
 await js('smoke.open(0)');await wait(300);
 c=await js("({open:!!"+q+",count:!!document.querySelector('[data-resume-countdown]')})");
 if(!c.open||c.count)throw new Error('resumeModalTimeoutSec=0 has no countdown '+JSON.stringify(c));
 await js("document.querySelector('[data-resume-apply]').click()");await wait(150);
 // FR-22: Smart order, frozen while the pointer is over the sidebar.
 const order=()=>js("[...document.querySelectorAll('[data-sidebar-ws]')].map(e=>e.dataset.sidebarWs).join()");
 let o=await order();
 if(o!=='w2,w3,w1')throw new Error('Smart order: working before idle, agentless last '+o);
 await js("document.querySelector('aside[data-sidebar]').dispatchEvent(new PointerEvent('pointerover',{bubbles:true}));document.querySelector('aside[data-sidebar]').dispatchEvent(new PointerEvent('pointerenter',{bubbles:false}))");await wait(100);
 await js("smoke.setApp({paneStatus:{...smoke.app().paneStatus,pa:{state:'action',precise:true,provider:'claude',stateSince:Date.now()}}})");await wait(150);
 const frozen=await js("document.querySelector('aside[data-sidebar]').hasAttribute('data-sidebar-frozen')");
 o=await order();
 if(!frozen||o!=='w2,w3,w1')throw new Error('frozen under the pointer '+JSON.stringify({frozen,o}));
 await js("document.querySelector('aside[data-sidebar]').dispatchEvent(new PointerEvent('pointerout',{bubbles:true,relatedTarget:document.body}));document.querySelector('aside[data-sidebar]').dispatchEvent(new PointerEvent('pointerleave',{bubbles:false,relatedTarget:document.body}))");await wait(150);
 o=await order();
 if(o!=='w1,w2,w3')throw new Error('reorders once the pointer leaves (action first) '+o);
 await shot('sidebar-smart');
 if(failures.length)throw new Error(failures.join('\\n'));
 console.log('PASS: resume dialog (groups, tri-state, countdown, Esc, Enter, click cancel, start fresh, timeout, 0 = never) at 100/125/150% dark/light, gated placeholders, topic truncated before the title, Smart order frozen under the pointer; screenshots '+__dirname);w.destroy();app.quit();
}).catch(e=>{console.error(e);app.exit(1)});
`)
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
const res = spawnSync(require('electron'), [path.join(dir, 'main.cjs')], { env, windowsHide: true, encoding: 'utf8', timeout: 60000 })
process.stdout.write(res.stdout ?? ''); if (res.status !== 0) process.stderr.write(res.stderr ?? '')
process.exitCode = res.status ?? 1
