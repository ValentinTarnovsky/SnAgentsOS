// Agent race UI (E7-FR-33..35) in an isolated hidden Electron window: the
// global prompt's destination chips and "Send with Enter" (paste path, plain
// console on one line, a console waiting on the user skipped), race mode (counters capped at 4, "this workspace"
// only when it fits, base from the probe, Ctrl+Enter starts), the race bar
// (state glyph, diffstat against base, View changes in "against base" mode,
// Copy git checkout, Discard, Keep this one with its checkbox, close) and the
// Changes panel toggle. A fake window.snApi stands in for main. Needs
// `npm run build` first (CSS). No user config, repo, git or pty is touched.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path')
const { pathToFileURL } = require('node:url')
const { spawnSync } = require('node:child_process')
const { buildSync } = require('esbuild')
const root = path.resolve(__dirname, '..'), dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snagentsos-race-ui-'))
const assets = path.join(root, 'out/renderer/assets')
const css = fs.existsSync(assets) && fs.readdirSync(assets).find((f) => /^index-.*\.css$/.test(f))
if (!css) throw new Error('Run npm run build first')
buildSync({ stdin: { contents: String.raw`
import React from 'react'; import {createRoot} from 'react-dom/client';
import {GlobalPromptDialog} from './src/renderer/components/workspace/GlobalPromptDialog';
import {RaceBar} from './src/renderer/components/workspace/RaceBar';
import {ChangesPanel} from './src/renderer/components/changes/ChangesPanel';
import {WorktreeCloseDialog} from './src/renderer/components/layout/WorktreeCloseDialog';
import {I18nProvider} from './src/renderer/i18n';
import {useAppStore} from './src/renderer/lib/store';
import {useGitStore} from './src/renderer/lib/gitStore';
import {useRaceStore} from './src/renderer/lib/race';
import {useWorktreeStore} from './src/renderer/lib/worktreeStore';
import {registerPaster} from './src/renderer/lib/pasteRegistry';
import {registerPty} from './src/renderer/lib/ptyRegistry';
import {useToastStore} from './src/renderer/lib/toast';
import {applyTheme} from './src/renderer/themes/applyTheme';
const sha='f6c3fc4f451077c2689a52f81295236419257c5d';
const calls={add:[],remove:[],writes:[],clip:[],status:[],stat:[]};
const pasted={};
const fake={inspect:(r)=>({exists:true,dirtyFiles:0,commitsAhead:0,mergedIntoHead:false})};
const noop=()=>()=>{};
const fallback=(base)=>new Proxy(base,{get:(t,k)=>(k in t?t[k]:typeof k==='string'?fallback(noop):undefined)});
const F=(area,p,status,added,removed)=>({path:p,area,status,added,removed,binary:false});
const sum={repoRoot:'C:/data/wt/x',branch:'sn/x',detached:false,unborn:false,headShort:'abc1234',upstream:null,ahead:0,behind:0,files:1,added:2,removed:1,approx:false,staged:0,unstaged:1,untracked:0,conflicts:0,op:null,truncated:false,updatedAt:1};
window.snApi=fallback({platform:'win32',
 pty:fallback({write:(w)=>calls.writes.push(w)}),
 clipboard:fallback({writeText:(t)=>calls.clip.push(t),readText:async()=>''}),
 reviewNotes:fallback({list:async()=>({notes:[],rev:0}),onChanged:noop}),
 git:fallback({setWatch(){},setConfig(){},refresh(){},onUpdate:noop,setPanel(){},info:async()=>({available:true,version:'2.45.1'}),
  worktreeProbe:async()=>({ok:true,repoName:'repo',head:sha,headShort:sha.slice(0,7)}),
  worktreeAdd:async(r)=>{calls.add.push(r);return {ok:true,worktree:{repoRoot:'C:/repo',path:'C:/data/wt/'+r.slug,branch:'sn/'+r.slug,base:r.base}}},
  worktreeRemove:async(r)=>{calls.remove.push(r);return {ok:true}},
  worktreeInspect:async(r)=>fake.inspect(r),
  baseStat:async(r)=>{calls.stat.push(r);return {added:10,removed:3,files:5,approx:false}},
  status:async(key,base)=>{calls.status.push([key,base||null]);return {summary:sum,files:base?[F('unstaged','new.txt','A',3,0),F('unstaged','edit.txt','M',2,1)]:[F('unstaged','edit.txt','M',2,1)]}},
  fileDiff:async(r)=>({path:r.path,area:r.area,binary:false,diffRev:r.path+(r.base||''),hunks:[{header:'@@ -1 +1 @@',oldStart:1,newStart:1,lines:[{kind:'add',newNo:1,text:'x'}]}],totalLines:2}),
 })});
const claude={id:'preset-claude',name:'Claude Code',type:'claude',command:'claude',args:[],color:'#d97757',icon:'claude'};
const codex={id:'preset-codex',name:'Codex',type:'codex',command:'codex',args:[],color:'#10a37f',icon:'codex'};
const pane=(id,type,title)=>({id,type,title,color:'#888',icon:type==='shell'?'terminal':type});
useAppStore.setState({hydrated:true,activeWorkspaceId:'w1',presets:[claude,codex],connections:[],workspaces:[{id:'w1',name:'Repo',cwd:'C:/repo',favorite:false,panes:[pane('a1','claude','Claude A'),pane('sh','shell','PowerShell'),pane('min','claude','Minimizada')]}],minimized:{w1:['min']},paneStatus:{a1:{state:'idle',precise:true,provider:'claude'}}});
function mount(id,bracketed){pasted[id]=[];registerPaster(id,{paste:(t)=>pasted[id].push(t),bracketed:()=>bracketed});registerPty(id,'pty-'+id)}
mount('a1',true);mount('sh',false);mount('min',true);
applyTheme('midnight');
function Bar(){const ws=useAppStore(s=>s.workspaces.find(w=>w.id===s.activeWorkspaceId));return ws?<div data-bar-host className="w-full"><RaceBar workspace={ws}/></div>:null}
function Panel(){const p=useGitStore(s=>s.panel);const ws=useAppStore(s=>s.workspaces.find(w=>w.id===s.activeWorkspaceId));return p&&ws?<div className="relative h-[420px]"><ChangesPanel workspace={ws} targetKey={p.targetKey} base={p.base}/></div>:null}
createRoot(document.getElementById('root')).render(<I18nProvider lang="es"><div style={{height:'100vh'}} className="flex flex-col bg-bg-primary text-text-primary"><Bar/><Panel/><GlobalPromptDialog/><WorktreeCloseDialog/></div></I18nProvider>);
window.smoke={app:useAppStore,git:useGitStore,race:useRaceStore,wt:useWorktreeStore,toasts:useToastStore,calls,pasted,fake,mount,sha,
 key:(k,o)=>document.querySelector('[data-global-prompt-text]').dispatchEvent(new KeyboardEvent('keydown',Object.assign({key:k,bubbles:true},o||{})))};
`, resolveDir: root, loader: 'tsx' }, bundle: true, platform: 'browser', format: 'iife', outfile: path.join(dir, 'renderer.js'), alias: { '@shared': path.join(root, 'src/shared'), '@': path.join(root, 'src/renderer') }, jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' } })
fs.writeFileSync(path.join(dir, 'index.html'), `<html><head><meta charset="utf-8"><link rel="stylesheet" href="${pathToFileURL(path.join(assets, css))}"></head><body><div id="root"></div><script src="renderer.js"></script></body></html>`)
fs.writeFileSync(path.join(dir, 'main.cjs'), String.raw`
const {app,BrowserWindow}=require('electron');const fs=require('fs'),path=require('path');
app.setPath('userData',path.join(__dirname,'profile'));
app.whenReady().then(async()=>{
 const w=new BrowserWindow({width:1100,height:760,show:false,webPreferences:{sandbox:true,backgroundThrottling:false}});
 let failures=[];w.webContents.on('console-message',(_e,level,message)=>{if(level>=3)failures.push(message)});
 await w.loadFile(path.join(__dirname,'index.html'));await new Promise(r=>setTimeout(r,400));
 const js=(s)=>w.webContents.executeJavaScript(s);
 const wait=(ms)=>new Promise(r=>setTimeout(r,ms));
 const shot=async name=>{await js('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');await wait(120);fs.writeFileSync(path.join(__dirname,name+'.png'),(await w.webContents.capturePage()).toPNG())};
 let n=0;const ok=(c,label)=>{if(!c)throw new Error(label);n++};
 const setText=(v)=>js("(()=>{const el=document.querySelector('[data-global-prompt-text]');const set=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set;set.call(el,"+JSON.stringify(v)+");el.dispatchEvent(new Event('input',{bubbles:true}))})()");
 const q=(s)=>js("(()=>{const e=document.querySelector("+JSON.stringify(s)+");return e?e.textContent:null})()");
 const click=(s)=>js("document.querySelector("+JSON.stringify(s)+").click()");

 // FR-33: prompt mode, chips and Enter.
 await js("smoke.app.setState({globalPromptOpen:true})");await wait(250);
 const chips=await js("[...document.querySelectorAll('[data-global-prompt-chip]')].map(c=>[c.dataset.globalPromptChip,c.getAttribute('aria-pressed'),c.hasAttribute('data-plain')])");
 ok(JSON.stringify(chips)==='[["a1","true",false],["sh","true",true]]','one chip per active console, all on, the shell marked plain '+JSON.stringify(chips));
 ok((await js("document.querySelector('[data-global-prompt-enter]').checked"))===false,'Send with Enter starts off');
 ok((await q('[data-global-prompt-count]'))==='Va a 2 de 2 consolas activas','count of the chosen consoles');
 await shot('prompt');
 await click('[data-global-prompt-chip="sh"]');await wait(60);
 ok((await js("document.querySelector('[data-global-prompt-chip=\"sh\"]').getAttribute('aria-pressed')"))==='false'&&(await q('[data-global-prompt-count]'))==='Va a 1 de 2 consolas activas','a click turns a destination off');
 await click('[data-global-prompt-chip="sh"]');await wait(60);
 await setText('linea uno\nlinea dos');
 await click('[data-global-prompt-enter]');await wait(60);
 ok((await q('[data-global-prompt]')).includes('El Enter solo va a las consolas de Claude y Codex'),'with Enter on, the hint says who gets it');
 await js("smoke.key('Enter',{ctrlKey:true})");await wait(400);
 ok(JSON.stringify(await js('smoke.pasted.a1'))==='["linea uno\\nlinea dos"]','the agent got the text as one paste');
 ok(JSON.stringify(await js('smoke.pasted.sh'))==='["linea uno linea dos"]','the plain console got one line');
 ok(JSON.stringify(await js('smoke.pasted.min'))==='[]','a minimized console got nothing');
 ok(JSON.stringify(await js('smoke.calls.writes'))==='[{"ptyId":"pty-a1","data":"\\r","origin":"auto"}]','Enter only to the agent '+JSON.stringify(await js('smoke.calls.writes')));
 ok(!(await js("!!document.querySelector('[data-global-prompt]')")),'Ctrl+Enter sends and closes');
 // A console waiting on the user (precise permission menu): skipped whole, the toast says so.
 await js("smoke.app.setState(s=>({paneStatus:{...s.paneStatus,a1:{state:'action',precise:true,provider:'claude',pendingCount:1}}}));smoke.calls.writes.length=0;smoke.pasted.a1.length=0;smoke.pasted.sh.length=0");
 await js("smoke.app.setState({globalPromptOpen:true})");await wait(250);
 await setText('1');await click('[data-global-prompt-enter]');await wait(60);
 await js("smoke.key('Enter',{ctrlKey:true})");await wait(400);
 ok(JSON.stringify(await js('smoke.pasted.a1'))==='[]'&&JSON.stringify(await js('smoke.calls.writes'))==='[]','nothing pasted and no Enter into a permission menu');
 ok(JSON.stringify(await js('smoke.pasted.sh'))==='["1"]','the plain console still got it');
 const skipToast=await js("(()=>{const t=smoke.toasts.getState().items.filter(i=>i.dedupeKey==='globalPrompt').at(-1);return t?[t.kind,t.title,t.body||'']:null})()");
 ok(JSON.stringify(skipToast)===JSON.stringify(['warning','Prompt enviado a 1 consola (Enter solo a los agentes)','1 consola salteada: te espera']),'the toast reports the skipped console '+JSON.stringify(skipToast));
 await js("smoke.app.setState(s=>({paneStatus:{...s.paneStatus,a1:{state:'idle',precise:true,provider:'claude'}}}));smoke.calls.writes.length=0");

 // FR-34: race mode with 10 consoles: only a new workspace fits the defaults.
 await js("smoke.app.setState(s=>({workspaces:s.workspaces.map(w=>({...w,panes:[...w.panes,...Array.from({length:7},(_,i)=>({id:'f'+i,type:'shell',title:'F'+i,color:'#888',icon:'terminal'}))]}))}))");
 await js("smoke.app.setState({globalPromptOpen:true})");await wait(250);
 await click('[data-global-prompt-mode="race"]');await wait(250);
 const counts=await js("[...document.querySelectorAll('[data-race-count]')].map(e=>e.textContent).join()");
 ok(counts==='x2,x1','defaults Claude x2, Codex x1 '+counts);
 ok((await q('[data-race-probe]')).includes('Base: HEAD (f6c3fc4)'),'the base comes from the repo probe');
 ok((await js("document.querySelector('[data-race-dest=\"here\"]').disabled&&document.querySelector('[data-race-dest=\"new\"]').checked")),'with 10 consoles and 3 contestants only the new workspace is offered');
 await click('[data-race-dec="claude"]');await wait(60);
 ok((await js("!document.querySelector('[data-race-dest=\"here\"]').disabled")),'2 contestants fit next to 10 consoles');
 await click('[data-race-inc="claude"]');await click('[data-race-inc="codex"]');await wait(60);
 ok((await js("document.querySelector('[data-race-inc=\"claude\"]').disabled&&document.querySelector('[data-race-inc=\"codex\"]').disabled"))&&(await js("[...document.querySelectorAll('[data-race-count]')].map(e=>e.textContent).join()"))==='x2,x2','4 in all caps every counter');
 await click('[data-race-dec="codex"]');await wait(60);
 await setText('Arreglar el login lento\ny sumar un test');await wait(60);
 ok((await js("document.querySelector('[data-race-dest=\"new\"]').parentElement.textContent")).includes('Carrera - Arreglar el login lento y'),'the new workspace is named after the task');
 await shot('race');
 // Start in this workspace (fits once one console is gone).
 await js("smoke.app.setState(s=>({workspaces:s.workspaces.map(w=>({...w,panes:w.panes.filter(p=>!/^f[0-6]$/.test(p.id))}))}))");await wait(80);
 await click('[data-race-dest="here"]');await wait(60);
 await js("smoke.key('Enter',{ctrlKey:true})");await wait(500);
 const adds=await js('smoke.calls.add');const base=await js('smoke.sha');
 ok(adds.length===3&&adds.every(a=>a.base===base),'three worktrees from the same sha');
 ok(!(await js("!!document.querySelector('[data-global-prompt]')")),'the dialog closes once the consoles exist');

 // FR-35: the bar.
 await wait(200);
 const rows=await js("[...document.querySelectorAll('[data-race-row]')].length");
 ok(rows===3,'one row per contestant ('+rows+')');
 ok((await js("[...document.querySelectorAll('[data-race-state]')].every(e=>e.dataset.raceState==='starting')")),'state glyph: starting');
 const stat=await js("document.querySelector('[data-race-stat]').textContent");
 ok(stat==='+10 -3 5 archivos','diffstat against base '+stat);
 ok((await js("smoke.calls.stat[0].base"))===(await js('smoke.sha')),'the stat asks main with the race base');
 ok(!(await js('document.documentElement.scrollWidth>innerWidth')),'the bar does not overflow');
 await shot('race-bar');
 const ids=await js("[...document.querySelectorAll('[data-race-row]')].map(e=>e.dataset.raceRow)");
 await click('[data-race-row="'+ids[0]+'"] [data-race-copy]');await wait(60);
 ok((await js('smoke.calls.clip.at(-1)')).startsWith('git checkout sn/race-claude-1-'),'Copy git checkout');
 await click('[data-race-row="'+ids[0]+'"] [data-race-view]');await wait(400);
 ok(JSON.stringify(await js('smoke.git.getState().panel'))===JSON.stringify({targetKey:'pane:'+ids[0],base:await js('smoke.sha')}),'View changes opens the panel against base');
 ok((await js("document.querySelector('[data-changes-base]')?.dataset.changesBase"))==='on'&&(await q('[data-changes-section="unstaged"] button')).includes('Contra base f6c3fc4'),'the panel lists against the base');
 ok((await js("[...document.querySelectorAll('[data-changes-row]')].length"))===2,'committed files included');
 await click('[data-changes-base]');await wait(400);
 ok((await js("document.querySelector('[data-changes-base]').dataset.changesBase"))==='off'&&(await js("[...document.querySelectorAll('[data-changes-row]')].length"))===1,'the toggle goes back to the uncommitted list');
 await js("smoke.git.getState().closeChanges()");await wait(100);
 // Discard: clean at once; dirty through the FR-30 dialog.
 await click('[data-race-row="'+ids[0]+'"] [data-race-discard]');await wait(300);
 ok((await js("smoke.calls.remove.length"))===1&&(await js("[...document.querySelectorAll('[data-race-row]')].length"))===2,'a clean contestant is discarded without a dialog');
 await js("void (smoke.fake.inspect=(r)=>({exists:true,dirtyFiles:r.path.includes('race-claude')?2:0,commitsAhead:0,mergedIntoHead:false}))");
 await click('[data-race-row="'+ids[1]+'"] [data-race-discard]');await wait(300);
 ok((await js("!!document.querySelector('[data-worktree-close]')")),'a dirty contestant opens the close dialog');
 await click('[data-worktree-keep]');await wait(150);
 ok((await js("smoke.wt.getState().close"))===null,'Keep in that dialog closes the console only');
 await js("smoke.app.getState().reopenClosedPane()");await wait(150);
 // Keep this one: an other with a half-done merge is shown as staying, never deleted.
 await js("void (smoke.fake.prevInspect=smoke.fake.inspect,smoke.fake.inspect=(r)=>({exists:true,dirtyFiles:2,commitsAhead:0,mergedIntoHead:false,inProgress:'merge'}))");
 await click('[data-race-row="'+ids[2]+'"] [data-race-keep]');await wait(300);
 const kb=await js("({rows:[...document.querySelectorAll('[data-race-keep-rows] li')].map(e=>e.getAttribute('data-race-keep-blocked')),text:document.querySelector('[data-race-keep-rows]')?.textContent||'',ack:!!document.querySelector('[data-race-keep-ack]'),dis:document.querySelector('[data-race-keep-confirm]').disabled})");
 ok(kb.rows.length>0&&kb.rows.every(b=>b==='inProgress')&&kb.text.includes('git merge a medias')&&!kb.ack&&kb.dis,'a contestant with a half-done merge stays, nothing to delete '+JSON.stringify(kb));
 await js("document.querySelector('[data-race-keep-dialog] [data-race-keep-confirm]').previousElementSibling.click()");await wait(150);
 ok(!(await js("!!document.querySelector('[data-race-keep-dialog]')"))&&(await js("smoke.calls.remove.length"))===1,'cancelled, nothing was asked of main');
 await js("void (smoke.fake.inspect=smoke.fake.prevInspect)");
 // Keep this one: the dirty other needs the checkbox.
 await click('[data-race-row="'+ids[2]+'"] [data-race-keep]');await wait(300);
 ok((await q('[data-race-keep-rows]')).includes('2 archivos, 0 commits'),'the others with what they lose');
 ok((await js("document.querySelector('[data-race-keep-confirm]').disabled")),'the checkbox is required');
 await shot('race-keep');
 await click('[data-race-keep-ack]');await wait(60);
 await click('[data-race-keep-confirm]');await wait(300);
 ok((await js("smoke.calls.remove.length"))===2&&(await js("[...document.querySelectorAll('[data-race-row]')].map(e=>e.dataset.raceRow).join()"))===ids[2],'the others go, the kept one stays');
 await click('[data-race-end]');await wait(100);
 ok(!(await js("!!document.querySelector('[data-race-bar]')"))&&(await js("smoke.app.getState().workspaces[0].panes.some(p=>p.id==='"+ids[2]+"')")),'closing the bar keeps the console');
 for(const scale of [1.25,1.5]){w.setSize(760,520);w.webContents.setZoomFactor(scale);await js("smoke.app.setState({globalPromptOpen:true})");await wait(200);ok(!(await js('document.documentElement.scrollWidth>innerWidth')),'dialog without overflow at '+scale);await js("smoke.app.setState({globalPromptOpen:false})")}
 if(failures.length)throw new Error(failures.join('\n'));
 console.log('PASS: '+n+' race UI checks (prompt chips + Enter, race counters/destination/base, bar stat/copy/view/discard/keep/close, panel against base, 125/150%); screenshots '+__dirname);w.destroy();app.quit();
}).catch(e=>{console.error(e);app.exit(1)});
`)
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
const res = spawnSync(require('electron'), [path.join(dir, 'main.cjs')], { env, windowsHide: true, encoding: 'utf8', timeout: 90000 })
process.stdout.write(res.stdout ?? ''); if (res.status !== 0) process.stderr.write(res.stderr ?? '')
process.exitCode = res.status ?? 1
