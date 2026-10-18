// Saved scrollback in the renderer (E6-FR-08/11/12/13), rendered from the
// production components in an isolated hidden Electron window with a fake
// window.snApi: a pane's first spawn asks for its saved history unless it
// resumes a chat, closing a pane or deleting a workspace trashes the saved
// files, and Settings > Terminal shows the toggle, the line count and the
// "clear all" button (confirmations, the 'off' snapshot note) without overflow
// in es/en, midnight/light. No pty, user config or saved file is touched.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path')
const { pathToFileURL } = require('node:url')
const { spawnSync } = require('node:child_process')
const { buildSync } = require('esbuild')
const root = path.resolve(__dirname, '..'), dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snagentsos-scrollback-ui-'))
const assets = path.join(root, 'out/renderer/assets')
const css = fs.readdirSync(assets).find(f => /^index-.*\.css$/.test(f))
if (!css) throw new Error('Run npm run build first')
buildSync({ stdin: { contents: `
import React from 'react'; import {createRoot} from 'react-dom/client';
import {TerminalPane} from './src/renderer/components/terminal/TerminalPane';
import {TerminalSection} from './src/renderer/components/settings/sections/TerminalSection';
import {I18nProvider} from './src/renderer/i18n';
import {useAppStore} from './src/renderer/lib/store';
import {applyTheme} from './src/renderer/themes/applyTheme';
const calls={spawn:[],clear:[],clearAll:0,stats:0};
let stats={files:3,bytes:1572864};
const SESSION='0b7c2f4e-1a2b-4c3d-8e9f-0123456789ab';
window.snApi={platform:'win32',
 pty:{reattach:async()=>null,killPanes:async(ids)=>ids.length,
  spawn:async(req)=>{calls.spawn.push(req);return{ptyId:'pty-'+req.paneId,shellKind:'powershell',seed:req.restoreScrollback?'saved history'+String.fromCharCode(13,10):undefined}},
  write(){},resize(){},kill:async()=>{},setActive(){},flow(){},
  onData:()=>()=>{},onExit:()=>()=>{},restart:async()=>({ptyId:'x',tail:'',shellKind:'powershell'})},
 scrollback:{clear:async(paneId,opts)=>{calls.clear.push({paneId,trash:!!(opts&&opts.trash)})},
  clearAll:async()=>{calls.clearAll++;stats={files:0,bytes:0}},stats:async()=>{calls.stats++;return stats},load:async()=>null},
 system:{openExternal(){},onDisplayRecovered:()=>()=>{}},
 status:{reportTitle(){}},
 clipboard:{writeText(){},readText:async()=>''},
 agents:{list:async()=>[{paneId:'pr',provider:'claude',sessionId:SESSION,spawnCwd:'C:/repo',activity:'idle',updatedAt:Date.now(),available:true}],
  startup:async()=>({trigger:null,interrupted:[]}),consumeStartup:async()=>false,onChanged:()=>()=>{},onReady:()=>()=>{},forget(){}},
};
const preset={id:'preset-claude',name:'Claude Code',type:'claude',command:'claude',args:[],color:'#d97757',icon:'claude'};
const pane=(id,type)=>type==='claude'?{id,type:'claude',presetId:'preset-claude',title:'Claude',color:'#d97757',icon:'claude'}:{id,type:'shell',title:'Shell',color:'#888',icon:'terminal'};
useAppStore.setState({hydrated:true,presets:[preset],activeWorkspaceId:'w1',workspaces:[
 {id:'w1',name:'Uno',cwd:'C:/repo',panes:[pane('ps','shell'),pane('pr','claude'),pane('px','shell')],layout:{grid:4,order:['ps','pr','px']}},
 {id:'w2',name:'Dos',cwd:'C:/b',panes:[pane('q1','shell'),pane('q2','shell')],layout:{grid:2,order:['q1','q2']}}]});
applyTheme('midnight');
const cell='relative min-h-0 min-w-0 overflow-hidden rounded border border-border';
function Root(){const [lang,setLang]=React.useState('es');window.smoke.setLang=setLang;
 return <I18nProvider lang={lang}><div style={{height:'100vh',display:'grid',gridTemplateColumns:'minmax(0,1fr) minmax(0,1.4fr)',gap:6,padding:6}} className="bg-bg-primary text-text-primary">
  <div style={{display:'grid',gridTemplateRows:'1fr 1fr',gap:6,minHeight:0}}>
   <div data-cell="shell" className={cell}><TerminalPane paneId="ps" workspaceId="w1" cwd="C:/repo" isActive/></div>
   <div data-cell="resume" className={cell}><TerminalPane paneId="pr" workspaceId="w1" cwd="C:/repo" initialCommand="claude" isActive/></div>
  </div>
  <div data-cell="settings" className={cell+' overflow-y-auto p-4'}><TerminalSection/></div>
 </div></I18nProvider>}
window.smoke={calls,theme:applyTheme,app:useAppStore.getState,
 settings:()=>useAppStore.getState().settings,
 update:(p)=>useAppStore.getState().updateSettings(p),
 section:()=>{const el=document.querySelector('[data-persist-scrollback]');return el?el.textContent:null},
 toggle:()=>document.querySelector('[data-persist-scrollback] button[role=switch]'),
 clearBtn:()=>{const b=document.querySelector('[data-clear-scrollback]');return b?{t:b.textContent,d:b.disabled}:null},
 lines:()=>document.querySelector('[data-persist-scrollback] input[type=number]'),
 dialog:()=>{const b=document.querySelector('[data-confirm]');const d=b&&b.closest('.rounded-modal');return d?d.textContent:null},
 confirm:()=>document.querySelector('[data-confirm]').click(),
 click:(el)=>el.click(),
 clickText:(txt)=>{const b=[...document.querySelectorAll('button')].find(x=>x.textContent.trim()===txt);if(!b)return false;b.click();return true},
 setInput:(el,v)=>{const set=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;set.call(el,v);el.dispatchEvent(new Event('input',{bubbles:true}))}};
createRoot(document.getElementById('root')).render(<Root/>);
`, resolveDir: root, loader: 'tsx' }, bundle: true, platform: 'browser', format: 'iife', outfile: path.join(dir, 'renderer.js'), alias: { '@shared': path.join(root, 'src/shared'), '@': path.join(root, 'src/renderer') }, jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' }, loader: { '.ttf': 'empty', '.woff': 'empty', '.woff2': 'empty' } })
fs.writeFileSync(path.join(dir, 'index.html'), `<html><head><meta charset="utf-8"><link rel="stylesheet" href="${pathToFileURL(path.join(assets, css))}"><link rel="stylesheet" href="renderer.css"></head><body><div id="root"></div><script src="renderer.js"></script></body></html>`)
fs.writeFileSync(path.join(dir, 'main.cjs'), `
const {app,BrowserWindow}=require('electron');const fs=require('fs'),path=require('path');
app.setPath('userData',path.join(__dirname,'profile'));
const wait=ms=>new Promise(r=>setTimeout(r,ms));
app.whenReady().then(async()=>{
 const w=new BrowserWindow({width:1280,height:760,show:false,webPreferences:{sandbox:true,backgroundThrottling:false}});
 let failures=[];w.webContents.on('console-message',(_e,level,message)=>{if(level>=3)failures.push(message)});
 await w.loadFile(path.join(__dirname,'index.html'));await wait(700);
 const js=c=>w.webContents.executeJavaScript(c);
 const fail=(what,v)=>{throw new Error(what+' '+JSON.stringify(v))};
 const shot=async name=>{await js("document.querySelector('[data-persist-scrollback]').scrollIntoView({block:'center'})");await js('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');await wait(150);fs.writeFileSync(path.join(__dirname,name+'.png'),(await w.webContents.capturePage()).toPNG())};
 let n=0;
 // E6-FR-11/13: a plain pane asks for its saved history; a pane that resumes its chat does not.
 let v=await js("smoke.calls.spawn.map(r=>({p:r.paneId,r:r.restoreScrollback,i:r.initialCommand||''}))");
 const shell=v.find(s=>s.p==='ps'),resume=v.find(s=>s.p==='pr');
 if(!shell||shell.r!==true)fail('a fresh pane spawns with restoreScrollback',v);n++;
 if(!resume||resume.r!==false||!resume.i.includes('--resume'))fail('a pane that resumes its chat spawns without restoreScrollback',v);n++;
 // E6-FR-12: closing a pane and deleting a workspace trash their saved history.
 await js("smoke.app().removePane('w1','px')");await wait(100);
 v=await js("smoke.calls.clear");
 if(v.length!==1||v[0].paneId!=='px'||v[0].trash!==true)fail('removePane trashes the pane history',v);n++;
 await js("smoke.app().deleteWorkspace('w2')");await wait(100);
 v=await js("smoke.calls.clear.slice(1).map(c=>c.paneId+':'+c.trash).join()");
 if(v!=='q1:true,q2:true')fail('deleteWorkspace trashes every pane history',v);n++;
 // Settings > Terminal: toggle, lines and the global button with N and MB.
 v=await js("({s:smoke.section(),b:smoke.clearBtn(),l:smoke.lines()&&smoke.lines().value})");
 if(!v.s||!v.s.includes('Guardar historial de consolas entre reinicios')||!v.s.includes('Líneas a guardar')||v.l!=='2000')fail('the persist section with its defaults',v);n++;
 if(!v.b||v.b.d||v.b.t!=='Borrar todo el historial guardado (3 consolas, 1.5 MB)')fail('the clear-all button shows N consoles and MB',v);n++;
 await js("smoke.setInput(smoke.lines(),'99999')");await wait(50);
 if(await js("smoke.settings().persistScrollbackLines")!==5000)fail('lines are clamped to 5000',await js("smoke.settings().persistScrollbackLines"));
 await js("smoke.setInput(smoke.lines(),'2500')");await wait(50);
 if(await js("smoke.settings().persistScrollbackLines")!==2500)fail('lines follow the input',null);n++;
 await shot('scrollback-es-midnight');
 // Clear all asks first, then empties and refreshes the counts.
 await js("smoke.click(document.querySelector('[data-clear-scrollback]'))");await wait(100);
 v=await js("smoke.dialog()");
 if(!v||!v.includes('¿Borrar el historial guardado?'))fail('clear all asks for confirmation',v);n++;
 await js("smoke.confirm()");await wait(150);
 v=await js("({c:smoke.calls.clearAll,b:smoke.clearBtn(),d:smoke.dialog()})");
 if(v.c!==1||!v.b.d||v.b.t!=='Borrar todo el historial guardado (0 consolas, 0 MB)'||v.d)fail('confirming clears all and the button shows 0',v);n++;
 // Turning it off asks and deletes; cancelling keeps it on.
 await js("smoke.click(smoke.toggle())");await wait(100);
 v=await js("smoke.dialog()");
 if(!v||!v.includes('¿Dejar de guardar el historial de consolas?'))fail('turning off asks for confirmation',v);n++;
 await js("smoke.clickText('Cancelar')");await wait(100);
 if(await js("smoke.settings().persistScrollback")!==true||await js("smoke.calls.clearAll")!==1)fail('cancel keeps persistence on and deletes nothing',null);n++;
 await js("smoke.click(smoke.toggle())");await wait(100);
 await js("smoke.confirm()");await wait(150);
 v=await js("({p:smoke.settings().persistScrollback,c:smoke.calls.clearAll,l:smoke.lines().disabled})");
 if(v.p!==false||v.c!==2||v.l!==true)fail('confirming turns it off, deletes everything and disables the line count',v);n++;
 await js("smoke.click(smoke.toggle())");await wait(100);
 if(await js("smoke.settings().persistScrollback")!==true||await js("smoke.dialog()"))fail('turning it back on needs no confirmation',null);n++;
 // 'off' snapshots: the toggle is disabled with its note.
 await js("smoke.update({terminalSnapshotMode:'off'})");await wait(100);
 v=await js("({s:smoke.section(),d:smoke.toggle().disabled||smoke.toggle().getAttribute('aria-disabled')==='true'})");
 if(!v.s.includes('Desactivado por el modo de snapshot')||!v.d)fail("snapshot 'off' disables the toggle with its note",v);n++;
 await shot('scrollback-es-off');
 await js("smoke.update({terminalSnapshotMode:'auto'})");
 // Layout: es/en, midnight/light, wide and narrow, 100% and 150%.
 for(const lang of ['es','en'])for(const theme of ['midnight','light'])for(const [W,H,zoom] of [[1280,760,1],[820,560,1],[900,600,1.5]]){
  await js("smoke.setLang('"+lang+"');smoke.theme('"+theme+"')");w.setSize(W,H);w.webContents.setZoomFactor(zoom);await wait(250);
  const bad=await js("(()=>{const out=[];const sec=document.querySelector('[data-persist-scrollback]');const c=sec.closest('[data-cell]').getBoundingClientRect();for(const el of sec.querySelectorAll('button,input,h4,p')){const r=el.getBoundingClientRect();if(r.width===0)continue;if(r.left<c.left-1||r.right>c.right+1)out.push(['outside',el.tagName,el.textContent,r.left,r.right,c.left,c.right]);if(el.tagName==='BUTTON'&&el.scrollWidth>el.clientWidth+1)out.push(['clipped',el.textContent])}if(document.documentElement.scrollWidth>innerWidth)out.push(['page overflow']);return out})()");
  if(bad.length)fail('overflow at '+lang+' '+theme+' '+W+'x'+H+'@'+zoom,bad);
  const text=await js("smoke.section()");
  if(lang==='en'&&(!text.includes('Save console history between restarts')||!text.includes('Lines to save')||!text.includes('Clear all saved history (0 consoles, 0 MB)')))fail('english texts',text);
  if(W===820||zoom===1.5)await shot('scrollback-'+lang+'-'+theme+'-'+W+(zoom>1?'-150':''));
 }
 n++;
 if(failures.length)throw new Error(failures.join('\\n'));
 console.log('PASS: '+n+' scrollback UI checks (restoreScrollback vs resume, trash on close/delete, settings toggle/lines/clear-all with confirmations, snapshot off note, es/en midnight/light layouts); screenshots '+__dirname);w.destroy();app.quit();
}).catch(e=>{console.error(e);app.exit(1)});
`)
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
const res = spawnSync(require('electron'), [path.join(dir, 'main.cjs')], { env, windowsHide: true, encoding: 'utf8', timeout: 60000 })
process.stdout.write(res.stdout ?? ''); if (res.status !== 0) process.stderr.write(res.stderr ?? '')
process.exitCode = res.status ?? 1
