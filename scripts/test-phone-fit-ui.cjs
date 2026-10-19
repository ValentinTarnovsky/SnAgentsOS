// Phone-fit on the desktop (E3-FR-17/18/19/23) rendered from the production
// TerminalPane (real xterm + Canvas), MobileDriverBanner, fitStore and the
// remoteCommands executor in an isolated hidden Electron window with a fake
// window.snApi: in a 4-pane grid a 50x40 phone grid fits (font of 6px or
// more, strip of 28px at most), the pty is never resized to the container
// while a phone owns it, the strip shows "(Chat)", [Recover] / [Restore all]
// and a real key give the size back before the key is written, a pane that
// mounts while owned starts at the phone grid, in es/en and light/dark.
// No pty, user config or remote server is touched.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path')
const { pathToFileURL } = require('node:url')
const { spawnSync } = require('node:child_process')
const { buildSync } = require('esbuild')
const root = path.resolve(__dirname, '..'), dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snagentsos-fit-ui-'))
const assets = path.join(root, 'out/renderer/assets')
const css = fs.readdirSync(assets).find(f => /^index-.*\.css$/.test(f))
if (!css) throw new Error('Run npm run build first')
buildSync({ stdin: { contents: `
import React from 'react'; import {createRoot} from 'react-dom/client';
import {TerminalPane} from './src/renderer/components/terminal/TerminalPane';
import {I18nProvider} from './src/renderer/i18n';
import {useAppStore} from './src/renderer/lib/store';
import {useFitStore} from './src/renderer/lib/fitStore';
import {runFitPane} from './src/renderer/lib/remoteCommands';
import {applyTheme} from './src/renderer/themes/applyTheme';
const listeners={data:new Set(),exit:new Set()};
const calls={spawn:[],writes:[],resize:[],release:[],seq:[]};
let spawned=0;
window.snApi={platform:'win32',
 pty:{reattach:async()=>null,killPanes:async()=>0,
  spawn:async(req)=>{calls.spawn.push(req);spawned++;return{ptyId:'pty-'+req.paneId,shellKind:'powershell'}},
  write:(r)=>{calls.writes.push(r);calls.seq.push('write')},resize:(r)=>{calls.resize.push(r);calls.seq.push('resize:'+r.ptyId+':'+r.cols+'x'+r.rows)},kill:async()=>{},setActive(){},flow(){},
  onData:(cb)=>{listeners.data.add(cb);return()=>listeners.data.delete(cb)},
  onExit:(cb)=>{listeners.exit.add(cb);return()=>listeners.exit.delete(cb)},
  restart:async()=>({ptyId:'pty-r',tail:'',shellKind:'powershell'})},
 remote:{fitRelease:(r)=>{calls.release.push(r);calls.seq.push('release:'+(r.all?'all':r.paneId))}},
 system:{openExternal(){},onDisplayRecovered:()=>()=>{}},
 status:{reportTitle(){}},
 clipboard:{writeText(){},readText:async()=>''},
 agents:{list:async()=>[],startup:async()=>({trigger:null,interrupted:[]}),consumeStartup:async()=>false,onChanged:()=>()=>{},onReady:()=>()=>{},forget(){}},
};
const pane=(id,title)=>({id,type:'shell',title,color:'#888',icon:'terminal'});
useAppStore.setState({hydrated:true,activeWorkspaceId:'w1',workspaces:[{id:'w1',name:'Uno',cwd:'C:/repo',panes:[pane('pa','A'),pane('pb','B'),pane('pc','C'),pane('pd','D')],layout:{grid:4,order:['pa','pb','pc','pd']}}]});
applyTheme('midnight');
const cell='relative min-h-0 min-w-0 overflow-hidden rounded border border-border';
function Root(){const [lang,setLang]=React.useState('es');window.smoke.setLang=setLang;
 const [show,setShow]=React.useState(true);window.smoke.setShow=setShow;
 return <I18nProvider lang={lang}><div style={{height:'100vh',display:'grid',gridTemplateColumns:'repeat(2,minmax(0,1fr))',gridTemplateRows:'repeat(2,minmax(0,1fr))',gap:6,padding:6}} className="bg-bg-primary text-text-primary">
  {['pa','pb','pc'].map(id=><div key={id} data-cell={id} className={cell}><TerminalPane paneId={id} workspaceId="w1" cwd="C:/repo" isActive/></div>)}
  <div data-cell="pd" className={cell}>{show&&<TerminalPane paneId="pd" workspaceId="w1" cwd="C:/repo" isActive/>}</div>
 </div></I18nProvider>}
window.smoke={calls,theme:applyTheme,
 fit:(paneId,cols,rows,chat)=>runFitPane({kind:'fitPane',workspaceId:'w1',paneId,cols,rows},{ptyId:'pty-'+paneId,chat}),
 owners:()=>useFitStore.getState().owners,
 geom:(id)=>{const c=document.querySelector('[data-cell='+id+'] [data-phone-fit]')||document.querySelector('[data-cell='+id+'] .xterm')?.parentElement;const s=document.querySelector('[data-cell='+id+'] .xterm-screen');const b=document.querySelector('[data-cell='+id+'] [data-mobile-driver]');
  if(!c||!s)return null;const cr=c.getBoundingClientRect(),sr=s.getBoundingClientRect();
  return{cw:cr.width,ch:cr.height,sw:sr.width,sh:sr.height,left:sr.left-cr.left,top:sr.top-cr.top,banner:b?{kind:b.dataset.mobileDriver,h:b.getBoundingClientRect().height,text:b.textContent,over:b.scrollWidth>b.clientWidth+1}:null,dim:!!document.querySelector('[data-cell='+id+'] [data-phone-fit]'),overflow:getComputedStyle(c).overflow,font:Number(c.dataset.fitFont||0)}},
 key:(id,key,keyCode)=>{const ta=document.querySelector('[data-cell='+id+'] .xterm-helper-textarea');ta.focus();ta.dispatchEvent(new KeyboardEvent('keydown',{key,code:'Key'+key.toUpperCase(),keyCode,which:keyCode,bubbles:true,cancelable:true}));ta.dispatchEvent(new KeyboardEvent('keypress',{key,charCode:key.charCodeAt(0),keyCode:key.charCodeAt(0),which:key.charCodeAt(0),bubbles:true,cancelable:true}))},
 click:(sel)=>document.querySelector(sel).click(),
 spawned:()=>spawned,
};
createRoot(document.getElementById('root')).render(<Root/>);
`, resolveDir: root, loader: 'tsx' }, bundle: true, platform: 'browser', format: 'iife', outfile: path.join(dir, 'renderer.js'), alias: { '@shared': path.join(root, 'src/shared'), '@': path.join(root, 'src/renderer') }, jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' }, loader: { '.ttf': 'empty', '.woff': 'empty', '.woff2': 'empty' } })
fs.writeFileSync(path.join(dir, 'index.html'), `<html><head><meta charset="utf-8"><link rel="stylesheet" href="${pathToFileURL(path.join(assets, css))}"><link rel="stylesheet" href="renderer.css"></head><body><div id="root"></div><script src="renderer.js"></script></body></html>`)
fs.writeFileSync(path.join(dir, 'main.cjs'), `
const {app,BrowserWindow}=require('electron');const fs=require('fs'),path=require('path');
app.setPath('userData',path.join(__dirname,'profile'));
const wait=ms=>new Promise(r=>setTimeout(r,ms));
app.whenReady().then(async()=>{
 const w=new BrowserWindow({width:1280,height:820,show:false,webPreferences:{sandbox:true,backgroundThrottling:false}});
 let failures=[];w.webContents.on('console-message',(_e,level,message)=>{if(level>=3)failures.push(message)});
 await w.loadFile(path.join(__dirname,'index.html'));await wait(600);
 const js=c=>w.webContents.executeJavaScript(c);
 const fail=(what,v)=>{throw new Error(what+' '+JSON.stringify(v)+(failures.length?' console: '+failures.join(' | '):''))};
 const shot=async name=>{await js('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');await wait(150);fs.writeFileSync(path.join(__dirname,name+'.png'),(await w.webContents.capturePage()).toPNG())};
 let n=0;
 let v=await js("smoke.spawned()");if(v!==4)fail('four panes spawned',v);n++;
 // E3-FR-17: a 50x40 phone grid in a quarter of the window.
 await js("smoke.calls.resize.length=0;smoke.calls.seq.length=0;smoke.fit('pa',50,40)");await wait(300);
 v=await js("({g:smoke.geom('pa'),others:['pb','pc','pd'].map(id=>smoke.geom(id).banner),resize:smoke.calls.resize.filter(r=>r.ptyId==='pty-pa')})");
 if(!v.g.banner||v.g.banner.kind!=='phone'||v.g.banner.h>28.5||!v.g.banner.text.includes('Tu celular controla esta consola')||v.g.banner.over)fail('the strip: phone, 28px at most, es text, no overflow',v);n++;
 if(v.others.some(b=>b))fail('only the phone-sized pane has a strip',v);n++;
 if(!v.g.dim)fail('the rest of the pane is dimmed (data-phone-fit)',v);n++;
 const cellH=v.g.sh/40,cellW=v.g.sw/50;
 if(v.g.sw>v.g.cw+1||v.g.sh>v.g.ch+1||v.g.left>2||v.g.top>2)fail('the 50x40 grid fits, top-left',v);n++;
 if(v.g.font<6||v.g.font>=14||cellH<7)fail('the font shrinks but stays at 6px or more (cell '+cellW.toFixed(2)+'x'+cellH.toFixed(2)+')',v);n++;
 if(v.resize.some(r=>r.cols!==50||r.rows!==40))fail('the pty only ever gets the phone grid while owned',v);n++;
 await shot('fit-phone-dark');
 // A window resize while owned: the pty is not resized (FR-18), only the baseline.
 await js("smoke.calls.resize.length=0");w.setSize(1000,700);await wait(400);
 v=await js("smoke.calls.resize.filter(r=>r.ptyId==='pty-pa')");
 if(v.some(r=>r.cols!==50||r.rows!==40))fail('a desktop resize never resizes an owned pty',v);n++;
 v=await js("smoke.geom('pa')");if((v.sw>v.cw+1||v.sh>v.ch+1)&&v.overflow!=='auto')fail('below 6px the terminal area scrolls instead of clipping the grid',v);n++;
 w.setSize(1280,820);await wait(300);
 // FR-21: "(Chat)".
 await js("smoke.fit('pa',50,40,true)");await wait(150);
 v=await js("smoke.geom('pa').banner");if(!v||v.kind!=='chat'||!v.text.includes('(Chat)'))fail('the strip says (Chat) while the owner reads the chat',v);n++;
 await js("smoke.theme('light')");await wait(300);await shot('fit-chat-light');
 await js("smoke.setLang('en')");await wait(100);
 v=await js("smoke.geom('pa').banner");if(!v.text.includes('Your phone controls this console (Chat)')||v.over)fail('en text without overflow',v);n++;
 await js("smoke.theme('midnight')");
 // [Recover]: main hears it first, then the pane refits to its own size.
 await js("smoke.calls.seq.length=0;smoke.click('[data-cell=pa] [data-fit-action=recover]')");await wait(300);
 v=await js("({rel:smoke.calls.release,seq:smoke.calls.seq,owners:smoke.owners(),g:smoke.geom('pa')})");
 if(v.rel.at(-1)?.paneId!=='pa'||v.owners.pa||v.g.banner||v.g.dim)fail('Recover releases the pane and the strip goes',v);n++;
 const back=v.seq.find(s=>s.startsWith('resize:pty-pa:'));
 if(!back||back==='resize:pty-pa:50x40'||v.seq.indexOf('release:pa')>v.seq.indexOf(back))fail('the desktop size goes back to the pty after main was told',v);n++;
 // FR-19: a real key takes the size back before it is written.
 await js("smoke.fit('pb',50,40)");await wait(200);
 await js("smoke.calls.seq.length=0;smoke.key('pb','x',88)");await wait(250);
 v=await js("({seq:smoke.calls.seq,owners:smoke.owners()})");
 const iRel=v.seq.indexOf('release:pb'),iRes=v.seq.findIndex(s=>s.startsWith('resize:pty-pb:')),iW=v.seq.indexOf('write');
 if(v.owners.pb||iRel<0||iRes<0||iW<0||!(iRel<iRes&&iRes<iW))fail('a key: release, then the resize, then the write',v);n++;
 // [Restore all].
 await js("smoke.fit('pa',50,40);smoke.fit('pc',40,20)");await wait(200);
 await js("smoke.click('[data-cell=pc] [data-fit-action=restoreAll]')");await wait(250);
 v=await js("({rel:smoke.calls.release.at(-1),owners:smoke.owners(),b:['pa','pc'].map(id=>smoke.geom(id).banner)})");
 if(!v.rel.all||Object.keys(v.owners).length||v.b.some(Boolean))fail('Restore all releases every pane',v);n++;
 // FR-23: a pane that mounts while owned starts at the phone grid with its strip.
 await js("smoke.setShow(false)");await wait(150);
 await js("smoke.calls.spawn.length=0;smoke.fit('pd',44,30);smoke.setShow(true)");await wait(400);
 v=await js("({sp:smoke.calls.spawn.at(-1),g:smoke.geom('pd')})");
 if(!v.sp||v.sp.cols!==44||v.sp.rows!==30||!v.g.banner)fail('a pane mounted while owned spawns at the phone grid with the strip from the start',v);n++;
 for(const scale of [1.25,1.5]){w.webContents.setZoomFactor(scale);await wait(300);/* a hidden window paints (and runs rAF) only on a capture */await shot('fit-zoom-'+scale);await wait(300);v=await js("smoke.geom('pd')");if(!v.banner||v.banner.h>28.5||v.banner.over||v.font<6||((v.sw>v.cw+1||v.sh>v.ch+1)&&v.overflow!=='auto'))fail('strip and grid (or the scroll fallback) at '+scale,v)}n++;
 w.webContents.setZoomFactor(1);await shot('fit-mounted');
 if(failures.length)throw new Error(failures.join('\\n'));
 console.log('PASS: '+n+' phone-fit desktop checks (strip 28px, grid fits at 6px+, no pty resize while owned, (Chat), Recover, a real key, Restore all, mount while owned, 100/125/150%, es/en, light/dark); screenshots '+__dirname);w.destroy();app.quit();
}).catch(e=>{console.error(e);app.exit(1)});
`)
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
const res = spawnSync(require('electron'), [path.join(dir, 'main.cjs')], { env, windowsHide: true, encoding: 'utf8', timeout: 60000 })
process.stdout.write(res.stdout ?? ''); if (res.status !== 0) process.stderr.write(res.stderr ?? '')
process.exitCode = res.status ?? 1
