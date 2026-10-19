// .snagentsos.json UI (E8-FR-23..27) in an isolated hidden Electron window:
// the composer card (summary, unknown preset warning, preselected profile with
// warning border, broken file error without "Use"), the trust dialog (lines,
// profile first, Cancel focused, Cancel creates nothing, "Trust and open"
// creates), the setup hold (waiting, Start now, failed with Retry / Start
// anyway, released on exit 0) and the export dialog (preview, secrets notice,
// Replace, nothing written before the button). A fake window.snApi stands in
// for main. Needs `npm run build` first (CSS). No user config is touched.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path')
const { pathToFileURL } = require('node:url')
const { spawnSync } = require('node:child_process')
const { buildSync } = require('esbuild')
const root = path.resolve(__dirname, '..'), dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snagentsos-repocfg-ui-'))
const assets = path.join(root, 'out/renderer/assets')
const css = fs.existsSync(assets) && fs.readdirSync(assets).find((f) => /^index-.*\.css$/.test(f))
if (!css) throw new Error('Run npm run build first')
buildSync({ stdin: { contents: `
import React from 'react'; import {createRoot} from 'react-dom/client';
import {WorkspaceComposer} from './src/renderer/components/wizard/WorkspaceComposer';
import {TrustDialog} from './src/renderer/components/ui/TrustDialog';
import {ExportRepoConfigDialog} from './src/renderer/components/ui/ExportRepoConfigDialog';
import {RepoSetupPlaceholder} from './src/renderer/components/layout/RepoSetupPlaceholder';
import {I18nProvider} from './src/renderer/i18n';
import {useAppStore} from './src/renderer/lib/store';
import {openRepoExport} from './src/renderer/lib/repoConfigFlow';
import {applyTheme} from './src/renderer/themes/applyTheme';
const sha='a'.repeat(64);
const cfg={version:1,name:'Api',grid:4,connectionProfile:'dedi',setup:{command:'pnpm install',waitForSetup:true},
 consoles:[{title:'Claude',agent:'claude',prompt:'lee el README'},{title:'Dev',command:'npm run dev'},{title:'Gem',agent:'gemini'}],
 quickCommands:[{label:'Tests',action:'send',text:'npm test',enter:true}]};
const calls={read:[],trust:[],preview:[],exp:[],kill:[]};
const fake={read:{status:'ok',config:cfg,sha256:sha,trusted:false,changedSinceTrust:false,needsTrust:true,warnings:[],consoleCwds:[null,null,null]},trust:{ok:true},
 preview:{ok:true,json:'{\\n  "version": 1\\n}\\n',exists:true,path:'C:\\\\repo\\\\.snagentsos.json'},exp:{ok:true,path:'C:\\\\repo\\\\.snagentsos.json',sha256:'b'.repeat(64)}};
window.snApi={platform:'win32',dialog:{openDirectory:async()=>null},fs:{dirExists:async()=>true},
 pty:{killPanes:async(ids)=>{calls.kill.push(...ids);return 0}},
 repoConfig:{read:async(d)=>{calls.read.push(d);return d==='C:\\\\broken'?{status:'invalid',needsTrust:false,warnings:[],errorCode:'cwd_escape',error:'consoles[1].cwd: escapes the repo'}:fake.read},
  trust:async(r)=>{calls.trust.push(r);return fake.trust},previewExport:async(r)=>{calls.preview.push(r);return fake.preview},export:async(r)=>{calls.exp.push(r);return fake.exp}}};
const presets=[{id:'preset-shell',name:'Shell',type:'shell',command:'',args:[],color:'#6366f1',icon:'terminal'},{id:'preset-claude',name:'Claude Code',type:'claude',command:'claude',args:[],color:'#d97757',icon:'claude'}];
useAppStore.setState({hydrated:true,presets,connections:[{id:'conn-1',name:'dedi',steps:[{send:'ssh dedi'}]}],workspaces:[{id:'w1',name:'Viejo',cwd:'C:\\\\repo',panes:[{id:'p1',type:'shell',title:'Shell',color:'#6366f1',icon:'terminal'}],layout:{grid:1,order:['p1']}}],activeWorkspaceId:'w1'});
applyTheme('midnight');
function Held(){const held=useAppStore(s=>s.heldPanes);return <div data-held-host className="flex gap-2 p-2">{Object.entries(held).map(([id,h])=><div key={id} data-held-cell={id} className="h-32 w-64 border border-border"><RepoSetupPlaceholder paneId={id} held={h}/></div>)}</div>}
createRoot(document.getElementById('root')).render(<I18nProvider lang="es"><div style={{height:'100vh'}} className="bg-bg-primary text-text-primary"><Held/><WorkspaceComposer/><ExportRepoConfigDialog/><TrustDialog/></div></I18nProvider>);
window.smoke={app:useAppStore,calls,fake,openExport:(id)=>openRepoExport(id),open:(cwd)=>useAppStore.getState().setWizardOpen(true,{cwd})};
`, resolveDir: root, loader: 'tsx' }, bundle: true, platform: 'browser', format: 'iife', outfile: path.join(dir, 'renderer.js'), alias: { '@shared': path.join(root, 'src/shared'), '@': path.join(root, 'src/renderer') }, jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' } })
fs.writeFileSync(path.join(dir, 'index.html'), `<html><head><meta charset="utf-8"><link rel="stylesheet" href="${pathToFileURL(path.join(assets, css))}"></head><body><div id="root"></div><script src="renderer.js"></script></body></html>`)
fs.writeFileSync(path.join(dir, 'main.cjs'), `
const {app,BrowserWindow}=require('electron');const fs=require('fs'),path=require('path');
app.setPath('userData',path.join(__dirname,'profile'));
app.whenReady().then(async()=>{
 const w=new BrowserWindow({width:1100,height:820,show:false,webPreferences:{sandbox:true,backgroundThrottling:false}});
 let failures=[];w.webContents.on('console-message',(_e,level,message)=>{if(level>=3)failures.push(message)});
 await w.loadFile(path.join(__dirname,'index.html'));await new Promise(r=>setTimeout(r,400));
 const js=(s)=>w.webContents.executeJavaScript(s);
 const wait=(ms)=>new Promise(r=>setTimeout(r,ms));
 const shot=async name=>{await js('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');await wait(120);fs.writeFileSync(path.join(__dirname,name+'.png'),(await w.webContents.capturePage()).toPNG())};
 let n=0;const ok=(c,label)=>{if(!c)throw new Error(label);n++};
 const click=(sel)=>js("document.querySelector('"+sel+"').click()");

 // FR-23: the card under the composer's folder.
 await js("smoke.open('C:\\\\\\\\repo')");await wait(700);
 const card=await js("({kind:document.querySelector('[data-repo-card]')?.getAttribute('data-repo-card'),sum:document.querySelector('[data-repo-card-summary]')?.textContent,warn:document.querySelector('[data-repo-card-warnings]')?.textContent||'',prof:document.querySelector('[data-repo-card-profile]')?.value,border:document.querySelector('[data-repo-card-profile]')?.className||''})");
 ok(card.kind==='ok','the card shows for a folder with a valid file');
 ok(card.sum==='3 consolas (Claude, Dev, Gem), grilla 4, setup: pnpm install','summary with count, titles, grid and setup '+card.sum);
 ok(card.warn.includes('consoles[2].agent: el preset "gemini" no existe'),'an unknown preset is a warning '+card.warn);
 ok(card.prof==='conn-1'&&card.border.includes('amber'),'the file profile is preselected with a warning border');
 await shot('card');

 // FR-24: Cancel creates nothing.
 const before=await js("smoke.app.getState().workspaces.length");
 await click('[data-repo-card-use]');await wait(300);
 const dlg=await js("({lines:[...document.querySelectorAll('[data-repo-trust-line]')].map(e=>e.getAttribute('data-repo-trust-line')),first:document.querySelector('[data-repo-trust-line]')?.textContent,focus:document.activeElement?.hasAttribute('data-repo-trust-cancel'),changed:!!document.querySelector('[data-repo-trust-changed]'),title:document.querySelector('#repo-trust-title')?.textContent})");
 ok(dlg.title==='Confiar en los comandos de este repo'&&dlg.focus,'the trust dialog opens with Cancel focused');
 ok(dlg.lines.join()==='profile,setup,command,agent,agent,quickSend'&&dlg.first==='Inicia sesion con el perfil "dedi" en 4 consolas','every executable line, the profile one first '+dlg.lines.join());
 ok(!dlg.changed,'no "changed" header the first time');
 await shot('trust');
 await js("document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))");await wait(200);
 ok(!(await js("!!document.querySelector('[data-repo-trust]')"))&&(await js("smoke.app.getState().workspaces.length"))===before&&(await js("smoke.calls.trust.length"))===0,'Esc cancels: nothing trusted, nothing created');

 // "Trust and open" creates the workspace.
 await click('[data-repo-card-use]');await wait(300);
 await click('[data-repo-trust-confirm]');await wait(300);
 ok((await js("JSON.stringify(smoke.calls.trust.at(-1))"))===JSON.stringify({dir:'C:\\\\repo',sha256:'a'.repeat(64)}),'main is asked to trust the read hash');
 const ws=await js("JSON.stringify((()=>{const s=smoke.app.getState();const w=s.workspaces.at(-1);return {name:w.name,titles:w.panes.map(p=>p.title),grid:w.layout.grid,setupId:w.setupId,rc:!!w.repoConfig,qc:s.quickCommands.filter(c=>c.workspaceId===w.id).length,held:Object.keys(s.heldPanes).length,open:s.wizardOpen}})())");
 ok(ws==='{"name":"Api","titles":["Setup","Claude","Dev","Gem"],"grid":4,"setupId":"conn-1","rc":true,"qc":1,"held":0,"open":false}','created from the file and the flow closed '+ws);

 // FR-25: the setup hold (with a profile the setup is typed, so nothing is held: try without one).
 await js("smoke.open('C:\\\\\\\\repo')");await wait(700);
 await js("(()=>{const el=document.querySelector('[data-repo-card-profile]');const set=Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set;set.call(el,'');el.dispatchEvent(new Event('change',{bubbles:true}))})()");await wait(150);
 ok((await js("document.querySelector('[data-repo-card-profile]').value"))==='','the profile can be set to None');
 await click('[data-repo-card-use]');await wait(300);
 ok((await js("!document.querySelector('[data-repo-trust-line=\\"profile\\"]')")),'without a profile there is no profile line');
 await click('[data-repo-trust-confirm]');await wait(300);
 const setupId=await js("smoke.app.getState().workspaces.at(-1).panes[0].id");
 ok((await js("document.querySelectorAll('[data-pane-held=\\"waiting\\"]').length"))===3&&(await js("document.querySelector('[data-pane-held]').textContent")).includes('Esperando setup...'),'the other consoles wait for the setup');
 await shot('held');
 await js("document.querySelector('[data-pane-held-start]').click()");await wait(150);
 ok((await js("document.querySelectorAll('[data-pane-held]').length"))===2,'"Iniciar ahora" starts one console');
 await js("smoke.app.getState().takeRepoSetupCommand('"+setupId+"')");
 await js("smoke.app.getState().setPaneExit('"+setupId+"',1)");await wait(150);
 const failed=await js("document.querySelector('[data-pane-held=\\"failed\\"]')?.textContent||''");
 ok(failed.includes('Setup fallo (codigo 1)')&&failed.includes('Reintentar')&&failed.includes('Iniciar igual'),'exit 1: failed with Retry and Start anyway '+failed);
 await js("document.querySelector('[data-pane-held-retry]').click()");await wait(150);
 ok((await js("document.querySelectorAll('[data-pane-held=\\"waiting\\"]').length"))===2&&(await js("smoke.calls.kill.includes('"+setupId+"')")),'Retry restarts the setup console and the rest waits again');
 await js("smoke.app.getState().takeRepoSetupCommand('"+setupId+"')");
 await js("smoke.app.getState().setPaneExit('"+setupId+"',null)");
 await js("smoke.app.getState().setPaneExit('"+setupId+"',0)");await wait(150);
 ok((await js("document.querySelectorAll('[data-pane-held]').length"))===0,'exit 0 releases every console');

 // A broken file: error, no "Use".
 await js("smoke.open('C:\\\\\\\\broken')");await wait(700);
 const bad=await js("({kind:document.querySelector('[data-repo-card]')?.getAttribute('data-repo-card'),err:document.querySelector('[data-repo-card-error]')?.textContent,use:!!document.querySelector('[data-repo-card-use]')})");
 ok(bad.kind==='error'&&bad.err==='consoles[1].cwd: escapes the repo'&&!bad.use,'a broken file shows the first problem and offers no Use');
 await js("smoke.app.getState().setWizardOpen(false)");await wait(150);

 // FR-26: export dialog.
 await js("smoke.openExport('w1')");await wait(300);
 const ex=await js("({json:document.querySelector('[data-repo-export-json]')?.textContent,secrets:document.querySelector('[data-repo-export-secrets]')?.textContent,btn:document.querySelector('[data-repo-export-write]')?.textContent,sent:smoke.calls.preview.length,exp:smoke.calls.exp.length})");
 ok(ex.json==='{\\n  "version": 1\\n}\\n'&&ex.secrets==='Revisa que no haya secretos: este archivo suele commitearse','the preview and the secrets notice');
 ok(ex.btn==='Reemplazar'&&ex.sent===1&&ex.exp===0,'an existing file says Replace and nothing is written yet');
 ok((await js("JSON.stringify(smoke.calls.preview[0].file.consoles)"))==='[{"title":"Shell","color":"#6366f1","icon":"terminal"}]','the preview is built from the workspace');
 await shot('export');
 await click('[data-repo-export-write]');await wait(250);
 ok((await js("smoke.calls.exp.at(-1).overwrite"))===true&&(await js("smoke.app.getState().workspaces[0].repoConfig?.sha256"))==='b'.repeat(64)&&!(await js("!!document.querySelector('[data-repo-export]')")),'Replace writes, records the trace and closes');

 for(const scale of [1.25,1.5]){
  await js("smoke.open('C:\\\\\\\\repo')");w.setSize(760,620);w.webContents.setZoomFactor(scale);await wait(800);
  ok(!(await js('document.documentElement.scrollWidth>innerWidth')),'composer with the card without overflow at '+scale);
  await js("smoke.app.getState().setWizardOpen(false)");await wait(100);
 }
 if(failures.length)throw new Error(failures.join('\\n'));
 console.log('PASS: '+n+' repo config UI checks (card, trust dialog, cancel/confirm, setup hold, broken file, export dialog, 125/150%); screenshots '+__dirname);w.destroy();app.quit();
}).catch(e=>{console.error(e);app.exit(1)});
`)
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
const res = spawnSync(require('electron'), [path.join(dir, 'main.cjs')], { env, windowsHide: true, encoding: 'utf8', timeout: 60000 })
process.stdout.write(res.stdout ?? ''); if (res.status !== 0) process.stderr.write(res.stderr ?? '')
process.exitCode = res.status ?? 1
