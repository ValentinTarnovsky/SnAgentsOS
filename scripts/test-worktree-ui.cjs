// Worktree UI (E7-FR-27, 29, 30, 31, 36) in an isolated hidden Electron
// window: the launch dialog (default slug, read-only base, invalid slug,
// node_modules warning, Enter creates, typed error), the close dialog (Keep
// focused, the checkbox gate, Delete, busy with Retry / Open folder), the pane
// branch chip, the missing card and Settings > Git (root + orphans). A fake
// window.snApi stands in for main. Needs `npm run build` first (CSS). No user
// config, real repo or git process is touched.
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
import {I18nProvider} from './src/renderer/i18n';
import {useAppStore} from './src/renderer/lib/store';
import {useGitStore} from './src/renderer/lib/gitStore';
import {useWorktreeStore} from './src/renderer/lib/worktreeStore';
import {requestClosePane, templateFromPreset} from './src/renderer/lib/worktrees';
import {applyTheme} from './src/renderer/themes/applyTheme';
const calls={add:[],remove:[],reveal:[],refresh:[]};
const sha='f6c3fc4f451077c2689a52f81295236419257c5d';
const wt={repoRoot:'C:\\\\repo',path:'C:\\\\data\\\\worktrees\\\\repo-abc123\\\\claude-1',branch:'sn/claude-1',base:sha};
const fake={addRes:null,removeRes:{ok:true},inspect:{exists:true,dirtyFiles:2,commitsAhead:1,mergedIntoHead:false},list:[
 {path:wt.path,branch:wt.branch,repoName:'repo',dirty:false,managed:true,exists:true,repoRoot:'C:\\\\repo',base:sha},
 {path:'C:\\\\data\\\\worktrees\\\\repo-abc123\\\\old-1',branch:'sn/old-1',repoName:'repo',dirty:true,managed:true,exists:true,repoRoot:'C:\\\\repo',base:sha},
 {path:'C:\\\\data\\\\worktrees\\\\repo-abc123\\\\foreign',branch:'feat',repoName:'repo',dirty:null,managed:false,exists:true}]};
window.snApi={platform:'win32',dialog:{openDirectory:async()=>'D:\\\\wt'},git:{
 info:async()=>({available:true,version:'2.45.1',path:'C:\\\\Git\\\\git.exe'}),refresh:(r)=>calls.refresh.push(r),setWatch(){},setConfig(){},setPanel(){},onUpdate:()=>()=>{},
 worktreeProbe:async()=>({ok:true,repoName:'repo',head:sha,headShort:sha.slice(0,7)}),
 worktreeAdd:async(r)=>{calls.add.push(r);return fake.addRes??{ok:true,worktree:{repoRoot:'C:\\\\repo',path:'C:\\\\data\\\\worktrees\\\\repo-abc123\\\\'+r.slug,branch:'sn/'+r.slug,base:sha}}},
 worktreeRemove:async(r)=>{calls.remove.push(r);return fake.removeRes},
 worktreeInspect:async()=>fake.inspect,worktreeList:async()=>({entries:fake.list}),worktreeReveal:async(p)=>{calls.reveal.push(p);return true}},
 pty:{killPanes:async()=>0},status:{hooksStatus:async()=>({installed:false,settingsPath:'x'}),health:async()=>({claude:{installed:false},codex:{enabled:false,available:true,connected:0},discord:{lastSuccessAt:null,error:null,queued:0}})}};
const preset={id:'preset-claude',name:'Claude Code',type:'claude',command:'claude',args:[],color:'#d97757',icon:'claude'};
useAppStore.setState({hydrated:true,activeWorkspaceId:'w1',presets:[preset],workspaces:[{id:'w1',name:'Repo',cwd:'C:\\\\repo',panes:[
 {id:'pw',type:'claude',presetId:'preset-claude',title:'Claude Code · claude-1',color:'#d97757',icon:'claude',cwd:wt.path,worktree:wt},
 {id:'p1',type:'shell',title:'Shell',color:'#fff',icon:'terminal'}]}]});
useGitStore.setState({summaries:{'pane:pw':{repoRoot:wt.path,branch:'sn/claude-1',detached:false,unborn:false,headShort:'abc1234',upstream:null,ahead:0,behind:0,files:3,added:12,removed:3,approx:false,staged:0,unstaged:2,untracked:1,conflicts:0,op:null,truncated:false,updatedAt:0}}});
applyTheme('midnight');
function Header(){const ws=useAppStore(s=>s.workspaces[0]);const pane=ws.panes.find(p=>p.id==='pw');return <div className="flex flex-col gap-2 p-3">
 <header data-header className="flex h-8 w-[420px] items-center gap-1.5 overflow-hidden border border-border bg-card/50 px-2"><span className="min-w-0 flex-1 truncate text-xs">{pane?.title}</span>{pane&&<PaneWorktreeChip pane={pane}/>}</header>
 <div data-missing-host className="h-48 w-[420px] border border-border">{pane&&pane.worktree&&<WorktreeMissingCard workspace={ws} pane={pane} presets={[preset]}/>}</div></div>}
createRoot(document.getElementById('root')).render(<I18nProvider lang="es"><div style={{height:'100vh'}} className="bg-bg-primary text-text-primary"><Header/><SettingsModal/><WorktreeLaunchDialog/><WorktreeCloseDialog/></div></I18nProvider>);
window.smoke={app:useAppStore,git:useGitStore,wt:useWorktreeStore,calls,fake,wtObj:wt,
 openLaunch:()=>useWorktreeStore.getState().openLaunch({workspaceId:'w1',repoCwd:'C:\\\\repo',template:templateFromPreset(preset)}),
 close:(id)=>requestClosePane('w1',id),settings:()=>useAppStore.getState().openSettings('git')};
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
 ok((await js("JSON.stringify(smoke.calls.remove.at(-1))"))==='{"path":"C:\\\\\\\\data\\\\\\\\worktrees\\\\\\\\repo-abc123\\\\\\\\claude-1","paneId":"pw","deleteBranch":true}','Retry deletes with path, pane and branch');
 ok(!(await js("smoke.app.getState().workspaces[0].panes.some(p=>p.id==='pw')"))&&!(await js("!!document.querySelector('[data-worktree-close]')")),'after ok the console leaves the store and the dialog closes');
 await js("smoke.close('p1')");await wait(100);
 ok(!(await js("!!document.querySelector('[data-worktree-close]')"))&&!(await js("smoke.app.getState().workspaces[0].panes.some(p=>p.id==='p1')")),'a plain console closes without the dialog');

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
 ok((await js("JSON.stringify(smoke.calls.remove.at(-1))"))==='{"path":"C:\\\\\\\\data\\\\\\\\worktrees\\\\\\\\repo-abc123\\\\\\\\old-1","deleteBranch":true}','orphan delete sends no pane');
 for(const scale of [1.25,1.5]){w.setSize(860,560);w.webContents.setZoomFactor(scale);await wait(200);ok(!(await js('document.documentElement.scrollWidth>innerWidth')),'Settings > Git without overflow at '+scale)}
 w.webContents.setZoomFactor(1);w.setSize(1100,760);
 await js("smoke.app.getState().setSettingsOpen(false)");await wait(150);
 await js('smoke.openLaunch()');await wait(200);
 for(const scale of [1.25,1.5]){w.setSize(700,520);w.webContents.setZoomFactor(scale);await wait(200);ok(!(await js('document.documentElement.scrollWidth>innerWidth')),'launch dialog without overflow at '+scale)}
 if(failures.length)throw new Error(failures.join('\\n'));
 console.log('PASS: '+n+' worktree UI checks (chip, launch dialog, close dialog gate/keep/busy/retry, missing card, Settings root + orphans, 125/150%); screenshots '+__dirname);w.destroy();app.quit();
}).catch(e=>{console.error(e);app.exit(1)});
`)
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
const res = spawnSync(require('electron'), [path.join(dir, 'main.cjs')], { env, windowsHide: true, encoding: 'utf8', timeout: 60000 })
process.stdout.write(res.stdout ?? ''); if (res.status !== 0) process.stderr.write(res.stderr ?? '')
process.exitCode = res.status ?? 1
