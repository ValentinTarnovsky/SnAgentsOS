// Agent resume UI (E5-FR-08/09/14) rendered from the production PaneCell in an
// isolated hidden Electron window: the resume chips, the pane context menu
// (resume entries, disabled reason, reopen) and the header restart tooltip, at
// 100/125/150% in dark and light. Consoles stay unmounted (placeholder), so no
// pty, user config or real agent is touched.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path')
const { pathToFileURL } = require('node:url')
const { spawnSync } = require('node:child_process')
const { buildSync } = require('esbuild')
const root = path.resolve(__dirname, '..'), dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snagentsos-resume-ui-'))
const assets = path.join(root, 'out/renderer/assets')
const css = fs.readdirSync(assets).find(f => /^index-.*\.css$/.test(f))
if (!css) throw new Error('Run npm run build first')
buildSync({ stdin: { contents: `
import React from 'react'; import {createRoot} from 'react-dom/client';
import {PaneCell} from './src/renderer/components/layout/PaneCell';
import {I18nProvider} from './src/renderer/i18n';
import {useAppStore} from './src/renderer/lib/store';
import {useAgentStore} from './src/renderer/lib/agentStore';
import {applyTheme} from './src/renderer/themes/applyTheme';
window.snApi={platform:'win32',agents:{forget(){},list:async()=>[],startup:async()=>({trigger:null,interrupted:[]}),consumeStartup:async()=>false,onChanged:()=>()=>{},onReady:()=>()=>{}},pty:{kill:async()=>{}}};
const preset={id:'preset-claude',name:'Claude Code',type:'claude',command:'claude',args:[],color:'#d97757',icon:'claude'};
const pane=(id,title)=>({id,type:'claude',presetId:'preset-claude',title,color:'#d97757',icon:'claude'});
const ws={id:'w1',name:'Uno',cwd:'C:/repo',panes:[pane('pa','Claude retomado con un titulo bastante largo'),pane('pb','Claude fallido')],layout:{grid:2,order:['pa','pb']}};
const ssh={id:'w2',name:'Dedi',cwd:'/srv',setupId:'conn',panes:[pane('ps','Claude por SSH')]};
const st=useAppStore.getState();
useAppStore.setState({hydrated:true,presets:[preset],workspaces:[ws,ssh],settings:{...st.settings,notifications:{...st.settings.notifications,hooksEnabled:true}}});
const now=Date.now();
const view=(paneId,sessionId,extra)=>({paneId,provider:'claude',sessionId,spawnCwd:'C:/repo',activity:'idle',updatedAt:now-2*3600000,available:true,...extra});
useAgentStore.setState({sessions:{pa:view('pa','0b7c2f4e-1a2b-4c3d-8e9f-0123456789ab'),pb:view('pb','1c8d3a5f-2b3c-4d4e-9fa0-123456789abc',{available:false,unavailableReason:'transcript'})},
  resumeChip:{pa:{kind:'resumed',provider:'claude',updatedAt:now-2*3600000,shownAt:now},pb:{kind:'failed',shownAt:now}},
  closedStack:[{workspaceId:'w1',pane:pane('pz','Cerrada'),orderIndex:0}]});
applyTheme('midnight');
const noop=()=>{};
const cell=(w,p,i)=><PaneCell key={p.id} workspace={w} pane={p} presets={[preset]} workspaceActive={false} maximizedId={null} minimizedIds={[]} index={i} isDragging={false} draggable={false} onToggleMax={noop} onToggleMin={noop} onClose={noop} onDragStartCell={noop} onDragEnterCell={noop} onDragEndCell={noop}/>;
function Root(){return <div style={{height:'100vh',display:'grid',gridTemplateColumns:'repeat(3,minmax(0,1fr))',gap:6,padding:6}} className="bg-bg-primary text-text-primary">{cell(ws,ws.panes[0],0)}{cell(ws,ws.panes[1],1)}{cell(ssh,ssh.panes[0],0)}</div>}
createRoot(document.getElementById('root')).render(<I18nProvider lang="es"><Root/></I18nProvider>);
window.smoke={theme:applyTheme,setApp:useAppStore.setState,app:useAppStore.getState};
`, resolveDir: root, loader: 'tsx' }, bundle: true, platform: 'browser', format: 'iife', outfile: path.join(dir, 'renderer.js'), alias: { '@shared': path.join(root, 'src/shared'), '@': path.join(root, 'src/renderer') }, jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' } })
fs.writeFileSync(path.join(dir, 'index.html'), `<html><head><meta charset="utf-8"><link rel="stylesheet" href="${pathToFileURL(path.join(assets, css))}"></head><body><div id="root"></div><script src="renderer.js"></script></body></html>`)
fs.writeFileSync(path.join(dir, 'main.cjs'), `
const {app,BrowserWindow}=require('electron');const fs=require('fs'),path=require('path');
app.setPath('userData',path.join(__dirname,'profile'));
const wait=ms=>new Promise(r=>setTimeout(r,ms));
app.whenReady().then(async()=>{
 const w=new BrowserWindow({width:1280,height:720,show:false,webPreferences:{sandbox:true,backgroundThrottling:false}});
 let failures=[];w.webContents.on('console-message',(_e,level,message)=>{if(level>=3)failures.push(message)});
 await w.loadFile(path.join(__dirname,'index.html'));await wait(400);
 const js=c=>w.webContents.executeJavaScript(c);
 const shot=async name=>{await js('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');await wait(150);fs.writeFileSync(path.join(__dirname,name+'.png'),(await w.webContents.capturePage()).toPNG())};
 const started=Date.now();
 let c=await js("({resumed:document.querySelector('[data-resume-chip=resumed]')?.textContent,failed:document.querySelector('[data-resume-chip=failed]')?.textContent,button:[...document.querySelectorAll('[data-resume-chip=failed] button')].map(b=>b.textContent||b.getAttribute('aria-label')),ssh:document.querySelectorAll('[data-resume-chip]').length,xterm:document.querySelectorAll('.xterm').length})");
 if(c.resumed!=='Chat retomado · Claude · hace 2 h')throw new Error('resumed chip text '+JSON.stringify(c));
 if(!c.failed.includes('No se pudo retomar el chat')||!c.button.includes('Iniciar chat nuevo'))throw new Error('failed chip '+JSON.stringify(c));
 if(c.ssh!==2||c.xterm!==0)throw new Error('chips only where set, no terminal mounted '+JSON.stringify(c));
 const tip=await js("[...document.querySelectorAll('header button')].map(b=>b.getAttribute('aria-label')).filter(Boolean)");
 if(!tip.includes('Reiniciar (retoma el chat)')||!tip.includes('Reiniciar consola'))throw new Error('header restart tooltips '+JSON.stringify(tip));
 const menu=async idx=>{await js("(()=>{const h=document.querySelectorAll('header')["+idx+"];const r=h.getBoundingClientRect();h.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,clientX:r.left+20,clientY:r.top+10}))})()");await wait(150);
  const items=await js("[...document.querySelectorAll('[role=menu] [role=menuitem]')].map(b=>({t:b.textContent,d:b.getAttribute('aria-disabled'),h:b.getAttribute('title')}))");
  await js("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}));window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}))");await wait(100);return items};
 let items=await menu(0);
 const find=(list,t)=>list.find(i=>i.t===t);
 if(!find(items,'Reiniciar retomando el chat')||find(items,'Reiniciar retomando el chat').d||!find(items,'Reiniciar con chat nuevo')||!find(items,'Reabrir consola cerrada')||find(items,'Reiniciar consola'))throw new Error('agent pane menu '+JSON.stringify(items));
 items=await menu(1);
 const dis=find(items,'Reiniciar retomando el chat');
 if(!dis||dis.d!=='true'||dis.h!=='El chat anterior ya no está disponible')throw new Error('unavailable entry disabled with its reason '+JSON.stringify(items));
 items=await menu(2);
 if(find(items,'Reiniciar retomando el chat')||find(items,'Reiniciar con chat nuevo')||!find(items,'Reiniciar consola'))throw new Error('SSH pane has no resume entries '+JSON.stringify(items));
 await js("smoke.setApp({settings:{...smoke.app().settings,notifications:{...smoke.app().settings.notifications,hooksEnabled:false}}})");await wait(100);
 items=await menu(0);
 const hooks=find(items,'Reiniciar retomando el chat');
 if(!hooks||hooks.d!=='true'||hooks.h!=='Requiere la integración de hooks (Ajustes > Notificaciones)')throw new Error('hooks off disables resume with the PRD tooltip '+JSON.stringify(items));
 await shot('resume-dark');
 for(const theme of ['midnight','light'])for(const scale of [1,1.25,1.5]){
  await js("smoke.theme('"+theme+"')");w.setSize(860,560);w.webContents.setZoomFactor(scale);await wait(200);
  const fit=await js("[...document.querySelectorAll('[data-resume-chip]')].every(ch=>{const r=ch.getBoundingClientRect(),cell=ch.parentElement.parentElement.getBoundingClientRect();const inside=[...ch.querySelectorAll('button')].every(b=>{const q=b.getBoundingClientRect();return q.left>=r.left-1&&q.right<=r.right+1&&b.scrollWidth<=b.clientWidth+1});return r.left>=cell.left-1&&r.right<=cell.right+1&&inside&&(ch.dataset.resumeChip!=='failed'||ch.querySelector('span').scrollWidth<=ch.querySelector('span').clientWidth+1)})&&document.documentElement.scrollWidth<=innerWidth");
  if(!fit)throw new Error('chip overflows its pane at '+theme+' '+scale+' '+await js("JSON.stringify([...document.querySelectorAll('[data-resume-chip]')].map(ch=>({k:ch.dataset.resumeChip,r:ch.getBoundingClientRect(),cell:ch.parentElement.parentElement.getBoundingClientRect(),b:[...ch.querySelectorAll('button')].map(b=>[b.getBoundingClientRect().left,b.getBoundingClientRect().right,b.scrollWidth,b.clientWidth]),sp:[ch.querySelector('span').scrollWidth,ch.querySelector('span').clientWidth]})))"));
  if(scale===1.5)await shot('resume-'+theme+'-150');
 }
 w.webContents.setZoomFactor(1);w.setSize(1280,720);
 await wait(Math.max(0,6300-(Date.now()-started)));
 c=await js("({resumed:!!document.querySelector('[data-resume-chip=resumed]'),failed:!!document.querySelector('[data-resume-chip=failed]')})");
 if(c.resumed||!c.failed)throw new Error('resumed chip leaves after 6 s, the failure stays '+JSON.stringify(c));
 if(failures.length)throw new Error(failures.join('\\n'));
 console.log('PASS: resume chips (resumed 6 s, failed persistent), pane menu (resume / new chat / reopen, disabled reasons, SSH), header tooltip, 100/125/150% dark and light; screenshots '+__dirname);w.destroy();app.quit();
}).catch(e=>{console.error(e);app.exit(1)});
`)
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
const res = spawnSync(require('electron'), [path.join(dir, 'main.cjs')], { env, windowsHide: true, encoding: 'utf8', timeout: 45000 })
process.stdout.write(res.stdout ?? ''); if (res.status !== 0) process.stderr.write(res.stderr ?? '')
process.exitCode = res.status ?? 1
