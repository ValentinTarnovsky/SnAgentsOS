// Worktree UI (E7-FR-27, 29, 30, 31, 36) in an isolated hidden Electron
// window: the launch dialog (default slug, read-only base, invalid slug,
// node_modules warning, Enter creates, typed error), the close dialog (Keep
// focused, the checkbox gate, Delete, busy with Retry / Open folder, a
// half-done operation or another branch blocking Delete, 'changed' reading
// the worktree again), the pane
// branch chip, the missing card and Settings > Git (root + orphans). App
// 2.7.0 (A9): the chip's and the dialog's "main -N" (the chip's only with the
// git chip on, like its counts), the dialog without Delete
// while another console (any spelling of the path) uses the worktree, Delete
// saving the config at once before asking main, and the
// pane menu's "New console in this worktree" (same agent and worktree,
// disabled on a full workspace), from the production WorkspaceView of a
// workspace that is not active (no console spawns). A fake window.snApi
// stands in for main. Needs `npm run build` first (CSS). No user config, real
// repo or git process is touched.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path')
const { pathToFileURL } = require('node:url')
const { spawnSync } = require('node:child_process')
const { buildSync } = require('esbuild')
const root = path.resolve(__dirname, '..'), dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snagentsos-worktree-ui-'))
const assets = path.join(root, 'out/renderer/assets')
const css = fs.existsSync(assets) && fs.readdirSync(assets).find((f) => /^index-.*\.css$/.test(f))
if (!css) throw new Error('Run npm run build first')
buildSync({ stdin: { contents: `
import React from 'react'; import {createRoot} from 'react-dom/client';
import {SettingsModal} from './src/renderer/components/settings/SettingsModal';
import {WorktreeLaunchDialog} from './src/renderer/components/workspace/WorktreeLaunchDialog';
import {WorktreeCloseDialog} from './src/renderer/components/layout/WorktreeCloseDialog';
import {WorktreeMissingCard} from './src/renderer/components/layout/WorktreeMissingCard';
import {PaneWorktreeChip} from './src/renderer/components/git/PaneWorktreeChip';
import {WorkspaceView} from './src/renderer/components/workspace/WorkspaceView';
import {I18nProvider} from './src/renderer/i18n';
import {useAppStore} from './src/renderer/lib/store';
import {useGitStore} from './src/renderer/lib/gitStore';
import {useWorktreeStore} from './src/renderer/lib/worktreeStore';
import {requestClosePane, templateFromPreset} from './src/renderer/lib/worktrees';
import {applyTheme} from './src/renderer/themes/applyTheme';
const calls={add:[],remove:[],reveal:[],refresh:[],saves:[]};
const sha='f6c3fc4f451077c2689a52f81295236419257c5d';
const wt={repoRoot:'C:\\\\repo',path:'C:\\\\data\\\\worktrees\\\\repo-abc123\\\\claude-1',branch:'sn/claude-1',base:sha};
const fake={addRes:null,removeRes:{ok:true},afterRemove:null,inspect:{exists:true,dirtyFiles:2,commitsAhead:1,mergedIntoHead:false,tip:sha,headBranch:'sn/claude-1'},list:[
 {path:wt.path,branch:wt.branch,repoName:'repo',dirty:false,managed:true,exists:true,repoRoot:'C:\\\\repo',base:sha},
 {path:'C:\\\\data\\\\worktrees\\\\repo-abc123\\\\old-1',branch:'sn/old-1',repoName:'repo',dirty:true,managed:true,exists:true,repoRoot:'C:\\\\repo',base:sha},
 {path:'C:\\\\data\\\\worktrees\\\\repo-abc123\\\\foreign',branch:'feat',repoName:'repo',dirty:null,managed:false,exists:true}]};
// The pane grid (A9 menu) reads more of the bridge than the dialogs: anything not faked is a no-op.
const noop=()=>()=>{};
const fallback=(base)=>new Proxy(base,{get:(t,k)=>k in t?t[k]:(typeof k==='string'?fallback(noop):undefined)});
// config.save: how many removes main had seen when each save went, and the consoles it carried.
window.snApi=fallback({platform:'win32',dialog:{openDirectory:async()=>'D:\\\\wt'},config:fallback({save:(c)=>calls.saves.push({removes:calls.remove.length,panes:c.workspaces.flatMap(w=>w.panes.map(p=>p.id))})}),git:fallback({
 info:async()=>({available:true,version:'2.45.1',path:'C:\\\\Git\\\\git.exe'}),refresh:(r)=>calls.refresh.push(r),setWatch(){},setConfig(){},setPanel(){},onUpdate:()=>()=>{},
 worktreeProbe:async()=>({ok:true,repoName:'repo',head:sha,headShort:sha.slice(0,7)}),
 worktreeAdd:async(r)=>{calls.add.push(r);return fake.addRes??{ok:true,worktree:{repoRoot:'C:\\\\repo',path:'C:\\\\data\\\\worktrees\\\\repo-abc123\\\\'+r.slug,branch:'sn/'+r.slug,base:sha}}},
 worktreeRemove:async(r)=>{calls.remove.push(r);if(fake.afterRemove){fake.inspect=fake.afterRemove;fake.afterRemove=null}return fake.removeRes},
 worktreeInspect:async()=>fake.inspect,worktreeList:async()=>({entries:fake.list}),worktreeReveal:async(p)=>{calls.reveal.push(p);return true}}),
 pty:fallback({killPanes:async()=>0}),status:fallback({hooksStatus:async()=>({installed:false,settingsPath:'x'}),health:async()=>({claude:{installed:false},codex:{enabled:false,available:true,connected:0},discord:{lastSuccessAt:null,error:null,queued:0}})})});
const preset={id:'preset-claude',name:'Claude Code',type:'claude',command:'claude',args:[],color:'#d97757',icon:'claude'};
useAppStore.setState({hydrated:true,activeWorkspaceId:'w1',presets:[preset],workspaces:[{id:'w1',name:'Repo',cwd:'C:\\\\repo',panes:[
 {id:'pw',type:'claude',presetId:'preset-claude',title:'Claude Code · claude-1',color:'#d97757',icon:'claude',cwd:wt.path,worktree:wt},
 {id:'p1',type:'shell',title:'Shell',color:'#fff',icon:'terminal'}]}]});
useGitStore.setState({summaries:{'pane:pw':{repoRoot:wt.path,branch:'sn/claude-1',detached:false,unborn:false,headShort:'abc1234',upstream:null,ahead:0,behind:0,files:3,added:12,removed:3,approx:false,staged:0,unstaged:2,untracked:1,conflicts:0,op:null,truncated:false,updatedAt:0}}});
applyTheme('midnight');
function Header(){const ws=useAppStore(s=>s.workspaces[0]);const pane=ws.panes.find(p=>p.id==='pw');return <div className="flex flex-col gap-2 p-3">
 <header data-header className="flex h-8 w-[420px] items-center gap-1.5 overflow-hidden border border-border bg-card/50 px-2"><span className="min-w-0 flex-1 truncate text-xs">{pane?.title}</span>{pane&&<PaneWorktreeChip pane={pane}/>}</header>
 <div data-missing-host className="h-48 w-[420px] border border-border">{pane&&pane.worktree&&<WorktreeMissingCard workspace={ws} pane={pane} presets={[preset]}/>}</div></div>}
// A9: a second workspace, never active, whose grid has the pane menu (no console spawns there).
const wt2={repoRoot:'C:\\\\repo',path:'C:\\\\data\\\\worktrees\\\\repo-abc123\\\\shared-1',branch:'sn/shared-1',base:sha};
function W2(){const w=useAppStore(s=>s.workspaces.find(x=>x.id==='w2'));return w?<div data-w2 style={{height:300}} className="flex min-h-0 min-w-0 flex-col"><div className="min-h-0 flex-1"><WorkspaceView workspace={w} isActive={false}/></div></div>:null}
createRoot(document.getElementById('root')).render(<I18nProvider lang="es"><div style={{height:'100vh'}} className="bg-bg-primary text-text-primary"><Header/><W2/><SettingsModal/><WorktreeLaunchDialog/><WorktreeCloseDialog/></div></I18nProvider>);
window.smoke={app:useAppStore,git:useGitStore,wt:useWorktreeStore,calls,fake,wtObj:wt,wt2,sha,
 openLaunch:()=>useWorktreeStore.getState().openLaunch({workspaceId:'w1',repoCwd:'C:\\\\repo',template:templateFromPreset(preset)}),
 close:(id)=>requestClosePane('w1',id),settings:()=>useAppStore.getState().openSettings('git'),
 // Two consoles on one worktree, the second with another spelling of its folder.
 addW2:()=>useAppStore.setState(s=>({workspaces:[...s.workspaces,{id:'w2',name:'Dos',cwd:'C:\\\\repo',setupId:'ssh-1',panes:[
  {id:'sa',type:'claude',presetId:'preset-claude',title:'Claude Code · shared-1',color:'#d97757',icon:'claude',cwd:wt2.path,worktree:wt2},
  {id:'sb',type:'shell',title:'Shell',color:'#fff',icon:'terminal',cwd:wt2.path,setupId:'',worktree:{...wt2,path:'c:/DATA/worktrees/repo-abc123/shared-1/'}}]}]})),
 dropW2:()=>useAppStore.setState(s=>({workspaces:s.workspaces.filter(w=>w.id!=='w2')})),
 w2:()=>useAppStore.getState().workspaces.find(w=>w.id==='w2'),
 closeW2:(id)=>requestClosePane('w2',id),
 menu:async(id)=>{const h=document.querySelector('[data-pane-cell='+id+'] header');const r=h.getBoundingClientRect();h.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:r.left+40,clientY:r.top+10}));await new Promise(r=>setTimeout(r,120));return [...document.querySelectorAll('[role=menu] [role=menuitem]')].map(b=>({t:b.textContent,d:b.getAttribute('aria-disabled')==='true',h:b.getAttribute('title')||''}))},
 pick:async(label)=>{const b=[...document.querySelectorAll('[role=menu] [role=menuitem]')].find(e=>e.textContent===label);if(!b)return false;b.click();await new Promise(r=>setTimeout(r,120));return true},
 closeMenu:async()=>{window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}));await new Promise(r=>setTimeout(r,120))}};
`, resolveDir: root, loader: 'tsx' }, bundle: true, platform: 'browser', format: 'iife', outfile: path.join(dir, 'renderer.js'), alias: { '@shared': path.join(root, 'src/shared'), '@': path.join(root, 'src/renderer') }, jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' } })
fs.writeFileSync(path.join(dir, 'index.html'), `<html><head><meta charset="utf-8"><link rel="stylesheet" href="${pathToFileURL(path.join(assets, css))}"></head><body><div id="root"></div><script src="renderer.js"></script></body></html>`)
fs.writeFileSync(path.join(dir, 'main.cjs'), `
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
 const setInput=(sel,v)=>js("(()=>{const el=document.querySelector('"+sel+"');const set=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;set.call(el,"+JSON.stringify(v)+");el.dispatchEvent(new Event('input',{bubbles:true}))})()");

 // FR-29: the branch chip.
 const chip=await js("document.querySelector('[data-pane-worktree-chip]')?.textContent||''");
 ok(chip.includes('sn/claude-1')&&chip.includes('+12')&&chip.includes('-3'),'pane chip: branch and +a -d '+chip);
 await js("document.querySelector('[data-pane-worktree-chip]').click()");await wait(100);
 ok((await js("smoke.git.getState().panel?.targetKey"))==='pane:pw','a chip click opens Changes on the worktree target');
 await js("smoke.git.getState().closeChanges()");
 ok((await js("document.querySelector('[data-header]').scrollWidth<=document.querySelector('[data-header]').clientWidth+1")),'the chip truncates inside the header');
 // A9: "main -N" from main's live mainBehind, only while it is over 0.
 ok(!(await js("!!document.querySelector('[data-worktree-main-behind]')")),'no main -N without mainBehind');
 const setBehind=(v)=>js("smoke.git.setState(s=>({summaries:{...s.summaries,'pane:pw':{...s.summaries['pane:pw'],mainBehind:"+v+"}}}))");
 await setBehind(3);await wait(100);
 ok((await js("document.querySelector('[data-worktree-main-behind]')?.textContent"))==='main -3','the chip shows main -3');
 ok((await js("document.querySelector('[data-header]').scrollWidth<=document.querySelector('[data-header]').clientWidth+1")),'main -N fits in the header (the branch truncates)');
 await shot('chip-main-behind');
 // With the git chip off main stops refreshing pane:<id>: a frozen count is never shown, like the counts beside it.
 const setChip=(on)=>js("smoke.app.setState(s=>({settings:{...s.settings,gitChip:"+on+"}}))");
 await setChip(false);await wait(100);
 ok(!(await js("!!document.querySelector('[data-worktree-main-behind]')")),'git chip off: no main -N (it would be a frozen count)');
 await setChip(true);await wait(100);
 ok((await js("document.querySelector('[data-worktree-main-behind]')?.textContent"))==='main -3','git chip on again: main -3 is back');
 await setBehind(0);await wait(100);
 ok(!(await js("!!document.querySelector('[data-worktree-main-behind]')")),'main -0 shows nothing');

 // FR-27: launch dialog.
 await js('smoke.openLaunch()');await wait(250);
 const d=await js("({slug:document.querySelector('[data-worktree-slug]').value,base:document.querySelector('[data-worktree-base]').textContent,env:document.querySelector('[data-worktree-copy-env]').checked,nm:document.querySelector('[data-worktree-link-nm]').checked,warn:!!document.querySelector('[data-worktree-nm-warn]'),focus:document.activeElement?.hasAttribute('data-worktree-slug'),text:document.querySelector('[data-worktree-launch]').textContent})");
 ok(/^claude-code-[0-9a-f]{4}$/.test(d.slug),'default slug <preset>-<4 hex> '+d.slug);
 ok(d.base==='HEAD (f6c3fc4)','read-only base HEAD (sha) '+d.base);
 ok(d.env===true&&d.nm===false&&!d.warn&&d.focus,'copy .env on, node_modules off, slug focused');
 ok(d.text.includes('Los cambios sin commitear del workspace no se copian'),'uncommitted changes warning');
 await shot('launch');
 await setInput('[data-worktree-slug]','Mal Slug');await wait(80);
 ok((await js("document.querySelector('[data-worktree-create]').disabled")),'an invalid slug disables Create');
 await js("document.querySelector('[data-worktree-link-nm]').click()");await wait(80);
 ok((await js("document.querySelector('[data-worktree-nm-warn]')?.textContent"))==='node_modules se comparte con el repo: npm install afecta a ambos','the node_modules checkbox shows its warning');
 await js("smoke.fake.addRes={ok:false,error:'branch_exists'}");
 await setInput('[data-worktree-slug]','taken');await wait(80);
 await js("document.querySelector('[data-worktree-slug]').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}))");await wait(200);
 ok((await js("document.querySelector('[data-worktree-error]')?.textContent"))==='La rama sn/taken ya existe; elegí otro nombre','typed error, the dialog stays open');
 await js("smoke.fake.addRes=null");
 await setInput('[data-worktree-slug]','claude-9f9f');await wait(80);
 await js("document.querySelector('[data-worktree-slug]').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}))");await wait(250);
 const add=await js("JSON.stringify(smoke.calls.add.at(-1))");
 ok(add==='{"repoCwd":"C:\\\\\\\\repo","slug":"claude-9f9f","copyEnv":true,"linkNodeModules":true}','Enter creates with the dialog values '+add);
 const np=await js("JSON.stringify(smoke.app.getState().workspaces[0].panes.at(-1))");
 ok(np.includes('"title":"Claude Code · claude-9f9f"')&&np.includes('"branch":"sn/claude-9f9f"')&&np.includes('"cwd":"C:\\\\\\\\data\\\\\\\\worktrees\\\\\\\\repo-abc123\\\\\\\\claude-9f9f"'),'the new console runs in the worktree '+np);
 ok(!(await js("!!document.querySelector('[data-worktree-launch]')")),'the dialog closes');

 // FR-30: close dialog.
 await js("smoke.close('pw')");await wait(250);
 const c=await js("({info:document.querySelector('[data-worktree-close-info]')?.textContent,del:document.querySelector('[data-worktree-delete]').disabled,keepFocus:document.activeElement?.hasAttribute('data-worktree-keep'),branch:document.querySelector('[data-worktree-close-branch]').textContent,ack:document.querySelector('[data-worktree-ack]')?.parentElement.textContent})");
 ok(c.info.includes('2 archivos sin commitear')&&c.info.includes('1 commits que no están en la base')&&c.info.includes('No mergeada'),'dirty files, commits over the base, merged state '+c.info);
 ok(c.branch==='sn/claude-1'&&c.keepFocus,'branch shown, Keep focused by default');
 ok(c.del===true&&c.ack==='Entiendo que pierdo 2 archivos y 1 commits','Delete needs the checkbox with dirty work '+c.ack);
 await shot('close-dialog');
 await js("document.querySelector('[data-worktree-keep]').click()");await wait(150);
 ok(!(await js("smoke.app.getState().workspaces[0].panes.some(p=>p.id==='pw')"))&&(await js("smoke.calls.remove.length"))===0,'Keep closes the console without deleting anything');
 await js("smoke.app.getState().reopenClosedPane()");await wait(100);
 ok((await js("!!smoke.app.getState().workspaces[0].panes.find(p=>p.id==='pw')?.worktree")),'a kept console reopens with its worktree');
 await js("smoke.fake.removeRes={ok:false,error:'busy',detail:'EBUSY'}");
 await js("smoke.close('pw')");await wait(250);
 await js("document.querySelector('[data-worktree-ack]').click()");await wait(80);
 ok(!(await js("document.querySelector('[data-worktree-delete]').disabled")),'the checkbox enables Delete');
 await js("document.querySelector('[data-worktree-delete]').click()");await wait(200);
 const err=await js("document.querySelector('[data-worktree-close-error]')?.textContent||''");
 ok(err.includes('Hay archivos en uso')&&err.includes('Reintentar')&&err.includes('Abrir carpeta'),'busy: error with Retry and Open folder '+err);
 ok((await js("smoke.app.getState().workspaces[0].panes.some(p=>p.id==='pw')")),'a failed delete keeps the console');
 await js("[...document.querySelectorAll('[data-worktree-close-error] button')][1].click()");await wait(80);
 ok((await js("smoke.calls.reveal.at(-1)"))==='C:\\\\data\\\\worktrees\\\\repo-abc123\\\\claude-1','Open folder reveals the worktree');
 await js("smoke.fake.removeRes={ok:true}");
 await js("[...document.querySelectorAll('[data-worktree-close-error] button')][0].click()");await wait(200);
 ok((await js("(()=>{const r=smoke.calls.remove.at(-1);return r.path===smoke.wtObj.path&&r.paneId==='pw'&&r.deleteBranch===true&&r.expectTip===smoke.sha&&r.expectDirty===2&&Object.keys(r).length===5})()")),'Retry deletes with path, pane, branch and the inspect it was confirmed on '+(await js("JSON.stringify(smoke.calls.remove.at(-1))")));
 ok(!(await js("smoke.app.getState().workspaces[0].panes.some(p=>p.id==='pw')"))&&!(await js("!!document.querySelector('[data-worktree-close]')")),'after ok the console leaves the store and the dialog closes');
 await js("smoke.close('p1')");await wait(100);
 ok(!(await js("!!document.querySelector('[data-worktree-close]')"))&&!(await js("smoke.app.getState().workspaces[0].panes.some(p=>p.id==='p1')")),'a plain console closes without the dialog');

 // FR-30 delete race: blocked states from the start, and 'changed' reads the worktree again.
 const addPz="smoke.app.setState(s=>({workspaces:s.workspaces.map(w=>({...w,panes:[...w.panes,{id:'pz',type:'claude',presetId:'preset-claude',title:'Claude Code · claude-1',color:'#d97757',icon:'claude',cwd:smoke.wtObj.path,worktree:smoke.wtObj}]}))}))";
 await js(addPz);await wait(100);
 await js("smoke.fake.inspect={exists:true,dirtyFiles:1,commitsAhead:0,mergedIntoHead:true,tip:smoke.sha,headBranch:'sn/claude-1',inProgress:'merge'}");
 await js("smoke.close('pz')");await wait(250);
 const bl=await js("({kind:document.querySelector('[data-worktree-close-blocked]')?.getAttribute('data-worktree-close-blocked'),text:document.querySelector('[data-worktree-close-blocked]')?.textContent||'',del:document.querySelector('[data-worktree-delete]').disabled,ack:!!document.querySelector('[data-worktree-ack]')})");
 ok(bl.kind==='inProgress'&&bl.text.includes('merge')&&bl.text.includes('a medias')&&bl.del&&!bl.ack,'a half-done merge blocks Delete from the start '+JSON.stringify(bl));
 await shot('close-blocked');
 await js("smoke.wt.getState().closeClose()");await wait(100);
 await js("smoke.fake.inspect={exists:true,dirtyFiles:0,commitsAhead:0,mergedIntoHead:true,tip:smoke.sha,headBranch:'main'}");
 await js("smoke.close('pz')");await wait(250);
 const bm=await js("({kind:document.querySelector('[data-worktree-close-blocked]')?.getAttribute('data-worktree-close-blocked'),text:document.querySelector('[data-worktree-close-blocked]')?.textContent||'',del:document.querySelector('[data-worktree-delete]').disabled})");
 ok(bm.kind==='branchMismatch'&&bm.text.includes('main')&&bm.del,'another branch checked out blocks Delete '+JSON.stringify(bm));
 await js("smoke.wt.getState().closeClose()");await wait(100);
 const sha2='0123456789abcdef0123456789abcdef01234567';
 await js("smoke.fake.inspect={exists:true,dirtyFiles:0,commitsAhead:0,mergedIntoHead:true,tip:smoke.sha,headBranch:'sn/claude-1'}");
 await js("smoke.fake.removeRes={ok:false,error:'changed',detail:'tip'}");
 await js("smoke.fake.afterRemove={exists:true,dirtyFiles:0,commitsAhead:1,mergedIntoHead:false,tip:'"+sha2+"',headBranch:'sn/claude-1'}");
 await js("smoke.close('pz')");await wait(250);
 ok(!(await js("document.querySelector('[data-worktree-delete]').disabled"))&&!(await js("!!document.querySelector('[data-worktree-ack]')")),'a clean worktree deletes without the checkbox');
 const before=await js("smoke.calls.remove.length");
 await js("document.querySelector('[data-worktree-delete]').click()");await wait(300);
 ok((await js("(()=>{const r=smoke.calls.remove.at(-1);return r.paneId==='pz'&&r.expectTip===smoke.sha&&r.expectDirty===0})()"))&&(await js("smoke.calls.remove.length"))===before+1,'Delete sends the tip and dirty count the dialog showed');
 const ch=await js("({note:document.querySelector('[data-worktree-close-changed]')?.textContent||'',info:document.querySelector('[data-worktree-close-info]')?.textContent||'',del:document.querySelector('[data-worktree-delete]').disabled,ack:!!document.querySelector('[data-worktree-ack]'),err:!!document.querySelector('[data-worktree-close-error]'),pane:smoke.app.getState().workspaces[0].panes.some(p=>p.id==='pz')})");
 ok(ch.note.includes('El worktree cambió')&&ch.info.includes('1 commits que no están en la base')&&ch.del&&ch.ack&&!ch.err&&ch.pane,'changed: a note, the fresh state, the checkbox is back and the console stays '+JSON.stringify(ch));
 await shot('close-changed');
 await js("smoke.fake.removeRes={ok:true}");
 await js("document.querySelector('[data-worktree-ack]').click()");await wait(80);
 await js("document.querySelector('[data-worktree-delete]').click()");await wait(250);
 ok((await js("smoke.calls.remove.at(-1).expectTip"))===sha2&&!(await js("smoke.app.getState().workspaces[0].panes.some(p=>p.id==='pz')"))&&!(await js("!!document.querySelector('[data-worktree-close]')")),'confirmed again, it deletes against the new tip and closes');
 // A folder gone (by hand, or by a delete whose branch moved): its branch still has commits to lose.
 await js(addPz);await wait(100);
 await js("smoke.fake.inspect={exists:false,dirtyFiles:0,commitsAhead:2,mergedIntoHead:false,tip:'"+sha2+"'}");
 await js("smoke.close('pz')");await wait(250);
 const gn=await js("({info:document.querySelector('[data-worktree-close-info]')?.textContent||'',lost:!!document.querySelector('[data-worktree-close-lost]'),del:document.querySelector('[data-worktree-delete]').disabled,ack:document.querySelector('[data-worktree-ack]')?.parentElement.textContent||''})");
 ok(gn.info.includes('ya no existe')&&gn.info.includes('2 commits que no están en la base')&&gn.lost&&gn.del&&gn.ack==='Entiendo que pierdo 0 archivos y 2 commits','a gone folder whose branch has commits shows them and needs the checkbox '+JSON.stringify(gn));
 await js("smoke.fake.removeRes={ok:true}");
 await js("document.querySelector('[data-worktree-ack]').click()");await wait(80);
 await js("document.querySelector('[data-worktree-delete]').click()");await wait(250);
 ok((await js("smoke.calls.remove.at(-1).expectTip"))===sha2&&!(await js("smoke.app.getState().workspaces[0].panes.some(p=>p.id==='pz')")),'confirmed, it deletes against the tip it showed');
 await js("smoke.fake.inspect={exists:true,dirtyFiles:2,commitsAhead:1,mergedIntoHead:false,tip:smoke.sha,headBranch:'sn/claude-1'}");

 // FR-36: missing card.
 await js("smoke.app.setState(s=>({workspaces:s.workspaces.map(w=>({...w,panes:[...w.panes,{id:'pw',type:'claude',presetId:'preset-claude',title:'Claude Code · claude-1',color:'#d97757',icon:'claude',cwd:smoke.wtObj.path,worktree:smoke.wtObj}]}))}))");await wait(150);
 const mc=await js("document.querySelector('[data-pane-worktree-missing]')?.textContent||''");
 ok(mc.includes('El worktree fue borrado fuera de la app')&&mc.includes('Recrear en una rama nueva')&&mc.includes('Quitar worktree del pane'),'missing card with Recreate and Remove '+mc);
 await js("document.querySelector('[data-worktree-recreate]').click()");await wait(250);
 ok((await js("JSON.stringify({r:smoke.wt.getState().launch?.replacePaneId,c:smoke.wt.getState().launch?.repoCwd})"))==='{"r":"pw","c":"C:\\\\\\\\repo"}','Recreate opens the dialog on the same repo for this console');
 ok((await js("document.querySelector('#worktree-launch-title')?.textContent"))==='Recrear en una rama nueva','titled Recreate');
 await js("document.querySelector('[data-worktree-launch] button').click()");await wait(120);
 await js("document.querySelector('[data-worktree-detach]').click()");await wait(120);
 const det=await js("JSON.stringify(smoke.app.getState().workspaces[0].panes.find(p=>p.id==='pw'))");
 ok(!det.includes('worktree')&&!det.includes('"cwd"'),'Remove from pane drops worktree and cwd '+det);

 // A9: "New console in this worktree" from the pane menu, and the close dialog of a shared worktree.
 await js("smoke.addW2()");await wait(250);
 const adds=await js("smoke.calls.add.length");
 let items=await js("smoke.menu('sa')");
 const here=items.find(i=>i.t==='Nueva consola en este worktree');
 ok(here&&!here.d&&items.findIndex(i=>i.t==='Nueva consola en este worktree')===items.findIndex(i=>i.t==='Duplicar en worktree')+1,'the menu offers it right after Duplicate in worktree '+JSON.stringify(items.map(i=>i.t)));
 ok(await js("smoke.pick('Nueva consola en este worktree')"),'picked');
 const made=await js("(()=>{const ps=smoke.w2().panes;const p=ps.at(-1);return {n:ps.length,type:p.type,preset:p.presetId,title:p.title,cwd:p.cwd===smoke.wt2.path,setup:p.setupId,wt:JSON.stringify(p.worktree)===JSON.stringify(smoke.wt2),copy:p.worktree!==ps[0].worktree,id:p.id}})()");
 ok(made.n===3&&made.type==='claude'&&made.preset==='preset-claude'&&made.title==='Claude Code · shared-1'&&made.cwd&&made.wt&&made.copy,'a new console of the same agent on the same worktree and folder '+JSON.stringify(made));
 ok(made.setup==='','it runs local like the pane, not on the workspace connection profile');
 ok((await js("smoke.calls.add.length"))===adds,'no worktree is created for it');
 items=await js("smoke.menu('sb')");
 ok(items.some(i=>i.t==='Nueva consola en este worktree'),'a shell on a worktree offers it too');
 await js("smoke.closeMenu()");
 // Two other consoles use it (one spelled c:/DATA/.../): no Delete, and why.
 await js("smoke.fake.inspect={exists:true,dirtyFiles:0,commitsAhead:0,mergedIntoHead:true,tip:smoke.sha,headBranch:'sn/shared-1',behindMain:4}");
 const removes=await js("smoke.calls.remove.length");
 await js("smoke.closeW2('sa')");await wait(250);
 const sh=await js("({del:!!document.querySelector('[data-worktree-delete]'),keep:!!document.querySelector('[data-worktree-keep]'),ack:!!document.querySelector('[data-worktree-ack]'),shared:document.querySelector('[data-worktree-close-shared]')?.textContent||'',behind:document.querySelector('[data-worktree-close-behind]')?.textContent||''})");
 ok(!sh.del&&sh.keep&&!sh.ack&&sh.shared==='2 consolas más usan este worktree: cerralas antes de borrar el worktree. Conservar cierra solo esta','another console on the path hides Delete and says why '+JSON.stringify(sh));
 ok(sh.behind==='main -4: el HEAD del workspace tiene 4 commits que esta rama no tiene','the dialog shows main -4 too '+sh.behind);
 await shot('close-shared');
 await js("document.querySelector('[data-worktree-keep]').click()");await wait(150);
 ok(!(await js("smoke.w2().panes.some(p=>p.id==='sa')"))&&(await js("smoke.calls.remove.length"))===removes,'Keep only closes this console');
 const newId=made.id;
 await js("smoke.closeW2('"+newId+"')");await wait(250);
 ok((await js("document.querySelector('[data-worktree-close-shared]')?.textContent"))==='Otra consola usa este worktree: cerrala antes de borrar el worktree. Conservar cierra solo esta'&&!(await js("!!document.querySelector('[data-worktree-delete]')")),'one other console: the singular reason, still no Delete');
 await js("smoke.wt.getState().closeClose()");await wait(100);
 await js("smoke.app.getState().removePane('w2','sb')");await wait(100);
 await js("smoke.closeW2('"+newId+"')");await wait(250);
 ok((await js("!!document.querySelector('[data-worktree-delete]')"))&&!(await js("!!document.querySelector('[data-worktree-close-shared]')")),'the last console on it offers Delete again');
 // Delete sends the config to main first (its 'shared' check reads the saved consoles, which the
 // debounced save keeps up to 400 ms behind): the console closed just before is not in it.
 const saves=await js("smoke.calls.saves.length"),rmBefore=await js("smoke.calls.remove.length");
 await js("document.querySelector('[data-worktree-delete]').click()");await wait(250);
 const sv=await js("smoke.calls.saves.slice("+saves+")");
 ok(sv.length===1&&sv[0].removes===rmBefore&&!sv[0].panes.includes('sb')&&sv[0].panes.includes(newId)&&(await js("smoke.calls.remove.length"))===rmBefore+1,'Delete saves the config at once, before the remove, without the console closed just before '+JSON.stringify(sv));
 ok(!(await js("smoke.w2().panes.some(p=>p.id==='"+newId+"')"))&&!(await js("!!document.querySelector('[data-worktree-close]')")),'the last console leaves with its worktree');
 // A full workspace: the entry stays, disabled, with the reason.
 await js("smoke.app.setState(s=>({workspaces:s.workspaces.map(w=>w.id!=='w2'?w:{...w,panes:[...w.panes,{id:'sc',type:'shell',title:'Shell',color:'#fff',icon:'terminal',cwd:smoke.wt2.path,worktree:smoke.wt2},...Array.from({length:11},(_,i)=>({id:'f'+i,type:'shell',title:'F'+i,color:'#fff',icon:'terminal'}))]})}))");await wait(200);
 items=await js("smoke.menu('sc')");
 const full=items.find(i=>i.t==='Nueva consola en este worktree');
 ok(full&&full.d&&full.h==='El workspace está lleno','disabled on a full workspace, with the reason '+JSON.stringify(full));
 await js("smoke.closeMenu()");
 await js("smoke.dropW2()");await wait(150);

 // FR-31 / FR-28: Settings > Git.
 await js("smoke.app.getState().addPane('w1',{type:'claude',title:'Uses claude-1',cwd:smoke.wtObj.path,worktree:smoke.wtObj})");
 await js('smoke.settings()');await wait(500);
 const rows=await js("[...document.querySelectorAll('[data-worktree-orphan]')].map(e=>e.getAttribute('data-worktree-orphan'))");
 ok(JSON.stringify(rows)==='["sn/old-1","feat"]','orphans: the referenced worktree is not listed '+JSON.stringify(rows));
 const txt=await js("document.querySelector('[data-worktrees-orphans]').textContent");
 ok(txt.includes('con cambios sin commitear')&&txt.includes('no lo creó la app'),'state per row');
 ok((await js("[...document.querySelectorAll('[data-worktree-orphan-delete]')].map(b=>b.disabled).join()"))==='false,true','only managed rows can be deleted');
 await shot('settings-git');
 await setInput('[data-worktrees-root]','E:\\\\worktrees');
 await js("document.querySelector('[data-worktrees-root]').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}))");await wait(80);
 ok((await js("smoke.app.getState().settings.worktreesRoot"))==='E:\\\\worktrees','the root input writes settings.worktreesRoot');
 await js("smoke.fake.inspect={exists:true,dirtyFiles:0,commitsAhead:0,mergedIntoHead:true,incomplete:true}");
 await js("document.querySelector('[data-worktree-orphan-delete]').click()");await wait(250);
 ok((await js("!!document.querySelector('[data-worktree-close-incomplete]')&&document.querySelector('[data-worktree-delete]').disabled&&document.querySelector('[data-worktree-ack]')?.parentElement?.textContent==='Entiendo que puedo perder trabajo de este worktree'")),'a state git could not read shows a warning and still needs the checkbox');
 ok((await js("!!document.querySelector('[data-worktree-close]')&&!document.querySelector('[data-worktree-keep]')&&document.querySelector('#worktree-close-title').textContent==='Borrar worktree'")),'Delete of an orphan uses the same check, without Keep');
 await js("smoke.fake.removeRes={ok:true}");
 await js("document.querySelector('[data-worktree-ack]').click()");await js("document.querySelector('[data-worktree-delete]').click()");await wait(200);
 ok((await js("JSON.stringify(smoke.calls.remove.at(-1))"))==='{"path":"C:\\\\\\\\data\\\\\\\\worktrees\\\\\\\\repo-abc123\\\\\\\\old-1","deleteBranch":true,"ackIncomplete":true}','orphan delete sends no pane, and the ticked "may lose work" of an incomplete inspect as ackIncomplete');
 for(const scale of [1.25,1.5]){w.setSize(860,560);w.webContents.setZoomFactor(scale);await wait(200);ok(!(await js('document.documentElement.scrollWidth>innerWidth')),'Settings > Git without overflow at '+scale)}
 w.webContents.setZoomFactor(1);w.setSize(1100,760);
 await js("smoke.app.getState().setSettingsOpen(false)");await wait(150);
 await js('smoke.openLaunch()');await wait(200);
 for(const scale of [1.25,1.5]){w.setSize(700,520);w.webContents.setZoomFactor(scale);await wait(200);ok(!(await js('document.documentElement.scrollWidth>innerWidth')),'launch dialog without overflow at '+scale)}
 if(failures.length)throw new Error(failures.join('\\n'));
 console.log('PASS: '+n+' worktree UI checks (chip with main -N, launch dialog, close dialog gate/keep/busy/retry/main -N/shared worktree/config saved before the delete, new console in this worktree, missing card, Settings root + orphans, 125/150%); screenshots '+__dirname);w.destroy();app.quit();
}).catch(e=>{console.error(e);app.exit(1)});
`)
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
const res = spawnSync(require('electron'), [path.join(dir, 'main.cjs')], { env, windowsHide: true, encoding: 'utf8', timeout: 60000 })
process.stdout.write(res.stdout ?? ''); if (res.status !== 0) process.stderr.write(res.stderr ?? '')
process.exitCode = res.status ?? 1
