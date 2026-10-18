// Git chip UI (E7-FR-07, 08, 10) in an isolated hidden Electron window: the
// workspace header label, the sidebar second line and Settings > Git, with a
// seeded gitStore and a fake window.snApi. Needs `npm run build` first (CSS).
// No user config, real repo or git process is touched.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path')
const { pathToFileURL } = require('node:url')
const { spawnSync } = require('node:child_process')
const { buildSync } = require('esbuild')
const root = path.resolve(__dirname, '..'), dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snagentsos-git-ui-'))
const assets = path.join(root, 'out/renderer/assets')
const css = fs.readdirSync(assets).find((f) => /^index-.*\.css$/.test(f))
if (!css) throw new Error('Run npm run build first')
buildSync({ stdin: { contents: `
import React from 'react'; import {createRoot} from 'react-dom/client';
import {Sidebar} from './src/renderer/components/sidebar/Sidebar';
import {SettingsModal} from './src/renderer/components/settings/SettingsModal';
import {WorkspaceGitLabel} from './src/renderer/components/git/WorkspaceGitLabel';
import {I18nProvider} from './src/renderer/i18n';
import {useAppStore} from './src/renderer/lib/store';
import {useGitStore} from './src/renderer/lib/gitStore';
import {applyTheme} from './src/renderer/themes/applyTheme';
const refreshes=[];
window.snApi={git:{info:async()=>({available:true,version:'2.45.1',path:'C:\\\\Program Files\\\\Git\\\\cmd\\\\git.exe'}),refresh:(r)=>refreshes.push(r),setWatch(){},setConfig(){},onUpdate:()=>()=>{}},status:{hooksStatus:async()=>({installed:false,settingsPath:'x'}),health:async()=>({claude:{installed:false},codex:{enabled:false,available:true,connected:0},discord:{lastSuccessAt:null,error:null,queued:0}})}};
const base={repoRoot:'C:\\\\fixture\\\\repo',branch:'main',detached:false,unborn:false,headShort:'abc1234',upstream:null,ahead:0,behind:0,files:0,added:0,removed:0,approx:false,staged:0,unstaged:0,untracked:0,conflicts:0,op:null,truncated:false,updatedAt:Date.UTC(2026,9,18,13,5)};
const S=(o)=>({...base,...o});
const rows=[
 ['clean',S({})],
 ['dirty',S({files:5,added:142,removed:37,upstream:'origin/main',ahead:2,behind:1})],
 ['approx',S({files:300,added:9000,removed:0,approx:true,untracked:300})],
 ['conflict',S({files:2,added:3,removed:1,conflicts:2,op:'rebase',branch:null,detached:true})],
 ['long',S({branch:'feature/una-rama-con-un-nombre-larguisimo-para-probar-el-truncado-del-chip',files:12,added:12345,removed:6789,upstream:'origin/x',ahead:12,behind:3})],
 ['norepo',null],
];
const workspaces=rows.map(([name],i)=>({id:'w'+i,name:'Workspace '+name,cwd:'C:\\\\Users\\\\tarno\\\\Desktop\\\\'+name,panes:[{id:'p'+i,type:'shell',title:'Console',icon:'terminal'},{id:'q'+i,type:'shell',title:'Console 2',icon:'terminal'}]}));
useAppStore.setState({hydrated:true,activeWorkspaceId:'w1',workspaces});
useGitStore.setState({summaries:Object.fromEntries(rows.filter(r=>r[1]).map(([,s],i)=>['ws:w'+rows.findIndex(r=>r[1]===s),s]))});
applyTheme('midnight');
function Headers(){return <div id="headers" className="flex min-w-0 flex-1 flex-col">{workspaces.map(ws=><div key={ws.id} data-header={ws.id} className="flex h-11 shrink-0 items-center justify-between gap-3 border-b border-border px-4"><div className="flex min-w-0 items-baseline gap-2"><span className="shrink-0 text-sm font-medium text-text-primary">{ws.name}</span><WorkspaceGitLabel workspace={ws}/></div><div className="flex shrink-0 gap-2"><button className="rounded-btn border border-border px-2.5 py-1.5 text-xs">Prompt global</button><button className="rounded-btn border border-border px-2.5 py-1.5 text-xs">Nueva consola</button></div></div>)}</div>}
createRoot(document.getElementById('root')).render(<I18nProvider lang="es"><div style={{height:'100vh'}} className="flex bg-bg-primary text-text-primary"><Sidebar/><Headers/><SettingsModal/></div></I18nProvider>);
window.smoke={set:useAppStore.setState,get:useAppStore.getState,theme:applyTheme,refreshes,open:()=>useAppStore.getState().openSettings('git')};
`, resolveDir: root, loader: 'tsx' }, bundle: true, platform: 'browser', format: 'iife', outfile: path.join(dir, 'renderer.js'), alias: { '@shared': path.join(root, 'src/shared'), '@': path.join(root, 'src/renderer') }, jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' } })
fs.writeFileSync(path.join(dir, 'index.html'), `<html><head><meta charset="utf-8"><link rel="stylesheet" href="${pathToFileURL(path.join(assets, css))}"></head><body><div id="root"></div><script src="renderer.js"></script></body></html>`)
fs.writeFileSync(path.join(dir, 'main.cjs'), `
const {app,BrowserWindow}=require('electron');const fs=require('fs'),path=require('path');
app.setPath('userData',path.join(__dirname,'profile'));
app.whenReady().then(async()=>{
 const w=new BrowserWindow({width:1280,height:820,show:false,webPreferences:{sandbox:true,backgroundThrottling:false}});
 let failures=[];w.webContents.on('console-message',(_e,level,message)=>{if(level>=3)failures.push(message)});
 await w.loadFile(path.join(__dirname,'index.html'));await new Promise(r=>setTimeout(r,400));
 const js=(s)=>w.webContents.executeJavaScript(s);
 const wait=(ms)=>new Promise(r=>setTimeout(r,ms));
 const shot=async name=>{await js('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');await wait(150);fs.writeFileSync(path.join(__dirname,name+'.png'),(await w.webContents.capturePage()).toPNG())};
 let n=0;const ok=(c,label)=>{if(!c)throw new Error(label);n++};
 await shot('chips-midnight');
 const head=await js("(()=>{const h=(id)=>document.querySelector('[data-header='+id+']');return{chips:document.querySelectorAll('[data-header] [data-git-chip]').length,clean:h('w0').querySelector('[data-git-chip]')?.textContent,dirty:h('w1').querySelector('[data-git-chip]')?.textContent,aria:h('w1').querySelector('[data-git-chip]')?.getAttribute('aria-label'),approx:h('w2').textContent,conflict:h('w3').textContent,norepo:h('w5').textContent,green:getComputedStyle(h('w1').querySelector('.text-ansi-green')).color,red:getComputedStyle(h('w1').querySelector('.text-ansi-red')).color,cleanColor:getComputedStyle(h('w0').querySelector('[data-git-chip] span')).color,longFits:h('w4').scrollWidth<=h('w4').clientWidth+1}})()");
 ok(head.chips===5,'five repos show a chip, the folder without repo none '+JSON.stringify(head));
 ok(head.clean.trim()==='main','clean repo: only the branch '+JSON.stringify(head.clean));
 ok(/main/.test(head.dirty)&&/\\+142/.test(head.dirty)&&/-37/.test(head.dirty)&&/5 archivos/.test(head.dirty)&&/2/.test(head.dirty)&&/1/.test(head.dirty),'dirty chip: branch, +N -N, files, arrows '+head.dirty);
 ok(head.aria.startsWith('Rama main, 5 archivos cambiados, 142 líneas agregadas, 37 eliminadas, 2 commits adelante, 1 commits atrás'),'full aria label '+head.aria);
 ok(head.approx.includes('+9000+'),'approx count reads +N+');
 ok(head.conflict.includes('2 conflictos')&&head.conflict.includes('REBASE')&&head.conflict.includes('abc1234'),'conflicts badge, REBASE tag, detached sha');
 ok(head.norepo.includes('C:\\\\Users\\\\tarno\\\\Desktop\\\\norepo'),'no repo: the header keeps the cwd');
 ok(head.green==='rgb(34, 197, 94)'&&head.red==='rgb(239, 68, 68)','counts use the midnight ansi green/red '+head.green+' '+head.red);
 ok(head.longFits,'a long branch truncates inside the header');
 await js("document.querySelector('[data-header=w1] [data-git-chip]').dispatchEvent(new MouseEvent('mouseover',{bubbles:true}))");await wait(500);
 const tip=await js("document.querySelector('[role=tooltip]')?.textContent||''");
 ok(tip.includes('C:\\\\Users\\\\tarno\\\\Desktop\\\\dirty')&&tip.includes('Upstream: origin/main')&&tip.includes('según el último fetch')&&/Último cambio \\d\\d:\\d\\d/.test(tip),'tooltip: cwd, upstream, fetch note, last change hh:mm '+JSON.stringify(tip));
 await shot('chip-tooltip');
 await js("document.querySelector('[data-header=w1] [data-git-chip]').dispatchEvent(new MouseEvent('mouseout',{bubbles:true}))");
 await js("document.querySelector('[data-header=w1] [data-git-chip]').click()");
 ok((await js('JSON.stringify(smoke.refreshes)'))==='[{"keys":["ws:w1"],"reason":"manual"}]','a click asks main for a fresh summary');
 const side=await js("[...document.querySelectorAll('aside nav [data-sidebar-git]')].map(e=>e.parentElement.textContent)");
 ok(side.length===5&&side.includes('2 consolas· main +142 -37')&&side.includes('2 consolas· main'),'sidebar second line "2 consolas · main +142 -37" '+JSON.stringify(side));
 for(const scale of [1,1.25,1.5]){w.setSize(900,600);w.webContents.setZoomFactor(scale);await wait(200);const r=await js("({who:[...document.querySelectorAll('body *')].filter(e=>e.getBoundingClientRect().right>innerWidth+1).slice(0,4).map(e=>e.tagName+'.'+String(e.className).slice(0,60)+' '+Math.round(e.getBoundingClientRect().right)),overflow:document.documentElement.scrollWidth>innerWidth,rows:[...document.querySelectorAll('aside nav [data-sidebar-git]')].every(e=>{const p=e.parentElement;return p.scrollWidth<=p.clientWidth+1}),count:[...document.querySelectorAll('aside nav [data-sidebar-git]')].every(e=>{const c=e.previousElementSibling;return c.scrollWidth<=c.clientWidth&&c.textContent==='2 consolas'})})");ok(!r.overflow&&r.rows&&r.count,'no overflow, chip truncates before the count at '+scale+' '+JSON.stringify(r));if(scale===1.5)await shot('chips-150')}
 w.webContents.setZoomFactor(1);w.setSize(1280,820);
 await js("smoke.set({sidebarCollapsed:true})");await wait(300);
 await js("document.querySelectorAll('aside nav button')[1].dispatchEvent(new MouseEvent('mouseover',{bubbles:true}))");await wait(500);
 const ctip=await js("document.querySelector('[role=tooltip]')?.textContent||''");
 ok(ctip.includes('Workspace dirty')&&ctip.includes('main +142 -37'),'collapsed sidebar: the tooltip carries the chip '+JSON.stringify(ctip));
 ok((await js("document.querySelectorAll('aside nav [data-sidebar-git]').length"))===5,'collapsed rows keep the hidden line (opacity 0)');
 await js("document.querySelectorAll('aside nav button')[1].dispatchEvent(new MouseEvent('mouseout',{bubbles:true}))");
 await js("smoke.set({sidebarCollapsed:false});smoke.theme('light')");await wait(300);await shot('chips-light');
 const light=await js("getComputedStyle(document.querySelector('[data-header=w1] .text-ansi-green')).color");
 ok(light==='rgb(22, 163, 74)','light theme switches the counts to its ansi green '+light);
 await js("smoke.set({settings:{...smoke.get().settings,gitChip:false}})");await wait(200);
 const off=await js("({chips:document.querySelectorAll('[data-git-chip]').length,side:document.querySelectorAll('[data-sidebar-git]').length,cwd:document.querySelector('[data-header=w1]').textContent})");
 ok(off.chips===0&&off.side===0&&off.cwd.includes('C:\\\\Users\\\\tarno\\\\Desktop\\\\dirty'),'gitChip off hides header and sidebar chips, the header shows the cwd '+JSON.stringify(off));
 await js("smoke.theme('midnight');smoke.open()");await wait(400);
 const sec=await js("({diag:document.querySelector('[data-git-diag]')?.textContent,sw:document.querySelector('[role=switch]')?.getAttribute('aria-checked')})");
 ok(sec.diag==='git 2.45.1 detectado en C:\\\\Program Files\\\\Git\\\\cmd\\\\git.exe'&&sec.sw==='false','Settings > Git: diagnostic and the switch state '+JSON.stringify(sec));
 await js("document.querySelector('[role=switch]').click()");await wait(150);
 ok((await js('smoke.get().settings.gitChip'))===true,'the switch writes settings.gitChip');
 ok((await js("document.querySelector('[role=switch]').getAttribute('aria-checked')"))==='true','the switch follows the setting');
 await shot('settings-git');
 for(const scale of [1.25,1.5]){w.setSize(860,560);w.webContents.setZoomFactor(scale);await wait(200);ok(!(await js('document.documentElement.scrollWidth>innerWidth')),'Settings > Git without overflow at '+scale)}
 if(failures.length)throw new Error(failures.join('\\n'));
 console.log('PASS: '+n+' git chip UI checks (header chip states, tooltip, aria, sidebar line and truncation, collapsed tooltip, midnight/light colors, gitChip off, Settings > Git, 100/125/150%); screenshots '+__dirname);w.destroy();app.quit();
}).catch(e=>{console.error(e);app.exit(1)});
`)
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
const res = spawnSync(require('electron'), [path.join(dir, 'main.cjs')], { env, windowsHide: true, encoding: 'utf8', timeout: 45000 })
process.stdout.write(res.stdout ?? ''); if (res.status !== 0) process.stderr.write(res.stderr ?? '')
process.exitCode = res.status ?? 1
