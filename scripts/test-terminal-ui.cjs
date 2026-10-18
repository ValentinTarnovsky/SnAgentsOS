// Exit card, in-place restart and "Claude exited" chip (E6-FR-17/18/22/23)
// rendered from the production TerminalPane (real xterm + Canvas), ExitCard and
// AgentEndChip in an isolated hidden Electron window with a fake window.snApi:
// Enter/Esc on the card never reach the pty, Restart goes through pty.restart
// (fallback shell after a failure), the chip types the validated resume line,
// and nothing overflows in es/en, midnight/light, wide and narrow. No pty,
// user config or real agent is touched.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path')
const { pathToFileURL } = require('node:url')
const { spawnSync } = require('node:child_process')
const { buildSync } = require('esbuild')
const root = path.resolve(__dirname, '..'), dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snagentsos-terminal-ui-'))
const assets = path.join(root, 'out/renderer/assets')
const css = fs.readdirSync(assets).find(f => /^index-.*\.css$/.test(f))
if (!css) throw new Error('Run npm run build first')
buildSync({ stdin: { contents: `
import React from 'react'; import {createRoot} from 'react-dom/client';
import {TerminalPane} from './src/renderer/components/terminal/TerminalPane';
import {ExitCard} from './src/renderer/components/terminal/ExitCard';
import {AgentEndChip} from './src/renderer/components/terminal/AgentEndChip';
import {I18nProvider} from './src/renderer/i18n';
import {useAppStore} from './src/renderer/lib/store';
import {registerPty} from './src/renderer/lib/ptyRegistry';
import {applyTheme} from './src/renderer/themes/applyTheme';
const listeners={data:new Set(),exit:new Set()};
const calls={spawn:[],restart:[],writes:[],kills:[],killPanes:[],reattach:[],seq:[],resize:[]};
let restartMode='ok';
let reattachRes=null;
window.snApi={platform:'win32',
 pty:{reattach:async(id)=>{calls.reattach.push(id);calls.seq.push('reattach');return reattachRes},
  killPanes:async(ids)=>{calls.killPanes.push(ids);calls.seq.push('killPanes');return ids.length},
  spawn:async(req)=>{calls.spawn.push(req);return{ptyId:'pty-'+calls.spawn.length,shellKind:'powershell'}},
  write:(r)=>{calls.writes.push(r)},resize:(r)=>{calls.resize.push(r)},kill:async(id)=>{calls.kills.push(id)},setActive(){},flow(){},
  onData:(cb)=>{listeners.data.add(cb);return()=>listeners.data.delete(cb)},
  onExit:(cb)=>{listeners.exit.add(cb);return()=>listeners.exit.delete(cb)},
  restart:async(req)=>{calls.restart.push(req);if(restartMode==='fail')throw new Error("Error invoking remote method 'pty:restart': Error: File not found: nope.exe");return{ptyId:'pty-r'+calls.restart.length,tail:'--- reiniciado ---'+String.fromCharCode(13,10),shellKind:'powershell'}}},
 system:{openExternal(){},onDisplayRecovered:()=>()=>{}},
 status:{reportTitle(){}},
 clipboard:{writeText(){},readText:async()=>''},
 agents:{list:async()=>[],startup:async()=>({trigger:null,interrupted:[]}),consumeStartup:async()=>false,onChanged:()=>()=>{},onReady:()=>()=>{},forget(){}},
};
const preset={id:'preset-claude',name:'Claude Code',type:'claude',command:'claude',args:['--model','opus'],color:'#d97757',icon:'claude'};
const pane=(id,title)=>({id,type:'claude',presetId:'preset-claude',title,color:'#d97757',icon:'claude'});
useAppStore.setState({hydrated:true,presets:[preset],activeWorkspaceId:'w1',workspaces:[{id:'w1',name:'Uno',cwd:'C:/repo',panes:[pane('pa','Claude'),pane('pd','Chip')],layout:{grid:4,order:['pa','pd']}}]});
registerPty('pd','pty-d');
applyTheme('midnight');
const noop=()=>{};
const cell='relative min-h-0 min-w-0 overflow-hidden rounded border border-border';
function Root(){const [lang,setLang]=React.useState('es');window.smoke.setLang=setLang;
 const [show,setShow]=React.useState(true);window.smoke.setShow=setShow;
 return <I18nProvider lang={lang}><div style={{height:'100vh',display:'grid',gridTemplateColumns:'repeat(2,minmax(0,1fr))',gridTemplateRows:'repeat(2,minmax(0,1fr))',gap:6,padding:6}} className="bg-bg-primary text-text-primary">
  <div data-cell="term" className={cell}>{show&&<TerminalPane paneId="pa" workspaceId="w1" cwd="C:/repo" initialCommand="claude --model opus" isActive/>}</div>
  <div data-cell="exit" className={cell}><ExitCard code={3} onRestart={noop} onClose={noop}/></div>
  <div data-cell="error" className={cell}><ExitCard code={-1} error="File not found: C:/Program Files/PowerShell/7/pwsh-que-no-existe-en-esta-maquina.exe" onRestart={noop} onClose={noop}/></div>
  <div data-cell="chip" className={cell}><AgentEndChip paneId="pd" initialCommand="claude --model opus" shellKind={()=>'powershell'} onDone={noop}/></div>
 </div></I18nProvider>}
window.smoke={calls,theme:applyTheme,app:useAppStore.getState,set:useAppStore.setState,
 exit:(ptyId,exitCode,natural)=>listeners.exit.forEach(cb=>cb({ptyId,exitCode,natural})),
 data:(ptyId,data)=>listeners.data.forEach(cb=>cb({ptyId,data})),
 restartMode:(m)=>{restartMode=m},
 reattachWith:(r)=>{reattachRes=r},
 key:(key,keyCode)=>{const ta=document.querySelector('[data-cell=term] .xterm-helper-textarea');ta.focus();ta.dispatchEvent(new KeyboardEvent('keydown',{key,code:key,keyCode,which:keyCode,bubbles:true,cancelable:true}))},
 card:(c)=>{const el=document.querySelector('[data-cell='+c+'] [data-exit-card]');return el?{kind:el.dataset.exitCard,text:el.textContent}:null},
 chip:(c)=>{const el=document.querySelector('[data-cell='+c+'] [data-agent-end-chip]');return el?{state:el.dataset.agentEndChip,text:el.textContent,buttons:[...el.querySelectorAll('button')].map(b=>({k:b.dataset.agentEnd||'x',t:b.textContent,d:b.disabled}))}:null},
 click:(sel)=>document.querySelector(sel).click(),
 end:(paneId,sessionId)=>useAppStore.getState().setAgentEnded({paneId,ptyId:'pty',provider:'claude',sessionId,reason:'prompt_input_exit',cwd:'C:/repo',at:Date.now()}),
 CR:String.fromCharCode(13),ESC:String.fromCharCode(27)};
createRoot(document.getElementById('root')).render(<Root/>);
`, resolveDir: root, loader: 'tsx' }, bundle: true, platform: 'browser', format: 'iife', outfile: path.join(dir, 'renderer.js'), alias: { '@shared': path.join(root, 'src/shared'), '@': path.join(root, 'src/renderer') }, jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' }, loader: { '.ttf': 'empty', '.woff': 'empty', '.woff2': 'empty' } })
fs.writeFileSync(path.join(dir, 'index.html'), `<html><head><meta charset="utf-8"><link rel="stylesheet" href="${pathToFileURL(path.join(assets, css))}"><link rel="stylesheet" href="renderer.css"></head><body><div id="root"></div><script src="renderer.js"></script></body></html>`)
fs.writeFileSync(path.join(dir, 'main.cjs'), `
const {app,BrowserWindow}=require('electron');const fs=require('fs'),path=require('path');
app.setPath('userData',path.join(__dirname,'profile'));
const wait=ms=>new Promise(r=>setTimeout(r,ms));
const UUID='0b7c2f4e-1a2b-4c3d-8e9f-0123456789ab';
app.whenReady().then(async()=>{
 const w=new BrowserWindow({width:1280,height:720,show:false,webPreferences:{sandbox:true,backgroundThrottling:false}});
 let failures=[];w.webContents.on('console-message',(_e,level,message)=>{if(level>=3)failures.push(message)});
 await w.loadFile(path.join(__dirname,'index.html'));await wait(500);
 const js=c=>w.webContents.executeJavaScript(c);
 const fail=(what,v)=>{throw new Error(what+' '+JSON.stringify(v))};
 const shot=async name=>{await js('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');await wait(150);fs.writeFileSync(path.join(__dirname,name+'.png'),(await w.webContents.capturePage()).toPNG())};
 let n=0;
 // Mount spawns with the pane launch.
 let v=await js("smoke.calls.spawn.map(r=>({p:r.paneId,c:r.cwd,i:r.initialCommand}))");
 if(v.length!==1||v[0].p!=='pa'||v[0].c!=='C:/repo'||v[0].i!=='claude --model opus')fail('mount spawn',v);n++;
 // E6-FR-17: a natural exit shows the card and the exited flag.
 await js("smoke.data('pty-1','hola');smoke.exit('pty-1',3,true)");await wait(150);
 v=await js("({card:smoke.card('term'),exit:smoke.app().paneExit.pa})");
 if(!v.card||v.card.kind!=='exited'||!v.card.text.includes('La consola terminó')||!v.card.text.includes('Código de salida 3. La salida se conserva.')||v.exit!==3)fail('exit card',v);n++;
 // Enter restarts in place and is not sent to the pty.
 await js("smoke.key('Enter',13)");await wait(250);
 v=await js("({r:smoke.calls.restart.map(r=>({p:r.paneId,i:r.initialCommand,c:r.cwd,f:r.fallbackDefaultShell,s:r.shell})),w:smoke.calls.writes,card:smoke.card('term'),exit:smoke.app().paneExit.pa})");
 if(v.r.length!==1||v.r[0].p!=='pa'||v.r[0].i!=='claude --model opus'||v.r[0].c!=='C:/repo'||v.r[0].f!==undefined)fail('Enter restarts through pty.restart with the pane launch',v);n++;
 if(v.w.length!==0)fail('Enter on the card never reaches the pty',v);n++;
 if(v.card||v.exit!==undefined)fail('a restart clears the card and the exited flag',v);n++;
 // With the card gone, Enter is a normal key again, written to the new pty.
 await js("smoke.key('Enter',13)");await wait(100);
 v=await js("smoke.calls.writes");
 if(v.length!==1||v[0].ptyId!=='pty-r1'||v[0].data!==await js('smoke.CR'))fail('Enter after the restart goes to the new pty',v);n++;
 // Esc hides the card, never reaches the pty, and the pane stays dead.
 await js("smoke.exit('pty-r1',1,true)");await wait(150);
 await js("smoke.key('Escape',27)");await wait(150);
 v=await js("({card:smoke.card('term'),w:smoke.calls.writes.length,r:smoke.calls.restart.length,exit:smoke.app().paneExit.pa})");
 if(v.card||v.w!==1||v.r!==1||v.exit!==1)fail('Esc hides the card without writing or restarting',v);n++;
 // E6-FR-18: a failed respawn shows the error; the next Restart uses the default shell.
 await js("smoke.restartMode('fail');smoke.app().restartPane('pa')");await wait(250);
 v=await js("smoke.card('term')");
 if(!v||v.kind!=='error'||!v.text.includes('No se pudo iniciar el shell: File not found: nope.exe'))fail('failed restart card',v);n++;
 await shot('restart-error');
 await js("smoke.restartMode('ok');smoke.click('[data-cell=term] [data-exit-restart]')");await wait(250);
 v=await js("({f:smoke.calls.restart.at(-1).fallbackDefaultShell,card:smoke.card('term'),n:smoke.calls.restart.length})");
 if(v.f!==true||v.card||v.n!==3)fail('the retry after a failure asks for the default shell',v);n++;
 // A kill from elsewhere (not natural) keeps only the gray line.
 await js("smoke.exit('pty-r3',0,false)");await wait(150);
 v=await js("({card:smoke.card('term'),exit:smoke.app().paneExit.pa})");
 if(v.card||v.exit!==undefined)fail('a non-natural exit shows no card',v);n++;
 // E6-FR-22/23: the chip waits for the shell, then types the validated line.
 await js("smoke.end('pd','"+UUID+"')");await wait(100);
 v=await js("smoke.chip('chip')");
 if(!v||v.state!=='waiting'||!v.text.includes('Claude terminó')||v.buttons.filter(b=>b.k!=='x').some(b=>!b.d))fail('chip buttons wait 800 ms',v);n++;
 await wait(900);
 v=await js("smoke.chip('chip')");
 if(v.state!=='ready'||v.buttons.map(b=>b.k).join()!=='resume,new,x'||v.buttons.some(b=>b.d))fail('chip ready with Resume, New, x',v);n++;
 await shot('chip-ready');
 await js("smoke.click('[data-cell=chip] [data-agent-end=resume]')");await wait(100);
 v=await js("({w:smoke.calls.writes.at(-1),chip:smoke.chip('chip')})");
 if(v.w.ptyId!=='pty-d'||v.w.data!=="Set-Location -LiteralPath 'C:/repo'; claude --model opus --resume "+UUID+await js('smoke.CR')||v.chip)fail('Resume types cd + resume + Enter and hides the chip',v);n++;
 await js("smoke.end('pd','"+UUID+"')");await wait(900);
 await js("smoke.click('[data-cell=chip] [data-agent-end=new]')");await wait(100);
 v=await js("smoke.calls.writes.at(-1)");
 if(v.data!=='claude --model opus'+await js('smoke.CR'))fail('New types the pane command',v);n++;
 await js("smoke.end('pd','x; rm -rf ~')");await wait(900);
 v=await js("smoke.chip('chip')");
 if(!v||v.buttons.map(b=>b.k).join()!=='new,x')fail('an unsafe session id leaves only New',v);n++;
 await js("smoke.set({settings:{...smoke.app().settings,terminalAgentEndChip:false}})");await wait(100);
 if(await js("smoke.chip('chip')"))fail('the setting off hides the chip',null);n++;
 await js("smoke.set({settings:{...smoke.app().settings,terminalAgentEndChip:true}})");
 // Any key in the pane hides its chip.
 await js("smoke.end('pa','"+UUID+"')");await wait(100);
 if(!(await js("smoke.chip('term')")))fail('chip over the live terminal',null);
 await js("smoke.key('Enter',13)");await wait(100);
 if(await js("smoke.chip('term')")||await js("smoke.app().agentEnded.pa"))fail('a key in the pane hides the chip',null);n++;
 // E4-FR-36: unmounting the terminal never kills; the remount reattaches.
 v=await js("({k:smoke.calls.kills.length,kp:smoke.calls.killPanes.length,s:smoke.calls.spawn.length})");
 await js("smoke.reattachWith({ptyId:'pty-r3',replay:'restored',cols:40,rows:12,shellKind:'powershell'});smoke.setShow(false)");await wait(200);
 let u=await js("({k:smoke.calls.kills.length,kp:smoke.calls.killPanes.length})");
 if(u.k!==v.k||u.kp!==v.kp)fail('an unmount never kills the pty',{before:v,after:u});n++;
 const rz=await js("smoke.calls.resize.length");
 await js("smoke.setShow(true)");await wait(300);
 u=await js("({s:smoke.calls.spawn.length,r:smoke.calls.reattach.at(-1),k:smoke.calls.kills.length})");
 if(u.s!==v.s||u.r!=='pa'||u.k!==v.k)fail('the remount reattaches to the live pty instead of spawning',u);n++;
 // E6-FR-04: the snapshot is written at the pty's 40x12, then the forced refit
 // tells the pty the container's real size (the mount fit alone never would).
 u=await js("smoke.calls.resize.slice("+rz+").filter(r=>r.ptyId==='pty-r3')");
 if(!u.length||u.at(-1).cols<=40||u.at(-1).rows<=12)fail('a reattach at 40x12 ends with pty.resize to the container size',u);n++;
 await js("smoke.app().restartPaneClean('pa')");await wait(100);
 u=await js("({kp:smoke.calls.killPanes.at(-1),seq:smoke.calls.seq.at(-1)})");
 if(!u.kp||u.kp.join()!=='pa'||u.seq!=='killPanes')fail('Restart clean kills by paneId',u);n++;
 // Layout: es/en, midnight/light, wide and narrow, 100% and 150%.
 await js("smoke.exit('pty-r3',2,true)");await wait(100);
 for(const lang of ['es','en'])for(const theme of ['midnight','light'])for(const [W,H,zoom] of [[1280,720,1],[760,520,1],[860,560,1.5]]){
  await js("smoke.setLang('"+lang+"');smoke.theme('"+theme+"');smoke.end('pd','"+UUID+"')");w.setSize(W,H);w.webContents.setZoomFactor(zoom);await wait(250);
  const bad=await js("(()=>{const out=[];for(const el of document.querySelectorAll('[data-exit-card],[data-agent-end-chip]')){const r=el.getBoundingClientRect(),c=el.closest('[data-cell]').getBoundingClientRect();if(r.left<c.left-1||r.right>c.right+1||r.bottom>c.bottom+1||r.top<c.top-1)out.push(['outside',el.closest('[data-cell]').dataset.cell,r,c]);for(const b of el.querySelectorAll('button')){const q=b.getBoundingClientRect();if(b.scrollWidth>b.clientWidth+1||q.right>r.right+1||q.left<r.left-1)out.push(['button',b.textContent])}}if(document.documentElement.scrollWidth>innerWidth)out.push(['page overflow']);return out})()");
  if(bad.length)fail('overflow at '+lang+' '+theme+' '+W+'x'+H+'@'+zoom,bad);
  const texts=await js("[...document.querySelectorAll('[data-exit-card],[data-agent-end-chip]')].map(e=>e.textContent).join(' | ')");
  if(lang==='en'&&(!texts.includes('The console exited')||!texts.includes('Exit code 3. The output is kept.')||!texts.includes('Could not start the shell')||!texts.includes('Claude exited')||!texts.includes('Resume')))fail('english texts',texts);
  if(W===760||zoom===1.5)await shot('terminal-'+lang+'-'+theme+'-'+W+(zoom>1?'-150':''));
 }
 n++;
 if(failures.length)throw new Error(failures.join('\\n'));
 console.log('PASS: '+n+' terminal UI checks (exit card Enter/Esc, in-place restart and fallback, unmount never kills, reattach refit, Claude exited chip, es/en midnight/light layouts); screenshots '+__dirname);w.destroy();app.quit();
}).catch(e=>{console.error(e);app.exit(1)});
`)
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
const res = spawnSync(require('electron'), [path.join(dir, 'main.cjs')], { env, windowsHide: true, encoding: 'utf8', timeout: 60000 })
process.stdout.write(res.stdout ?? ''); if (res.status !== 0) process.stderr.write(res.stderr ?? '')
process.exitCode = res.status ?? 1
