// snaos CLI desktop UI (E8-FR-15..22, R30-11): Settings > Automation (switch,
// SSH protection, user PATH incl. the portable lock, server state, Copy
// example, skill install/repair/remove for Claude and Codex), the settings search, and the renderer side
// of the CLI bus (list in sidebar order, spawn without focus, --no-profile,
// read from a real xterm buffer, status line in the pane header and the agent
// row, attention, note). Isolated hidden Electron window; main is a fake.
// Requires npm run build (CSS).
const fs = require('node:fs'), os = require('node:os'), path = require('node:path')
const { pathToFileURL } = require('node:url')
const { spawnSync } = require('node:child_process')
const { buildSync } = require('esbuild')
const root = path.resolve(__dirname, '..'), dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snagentsos-cli-ui-'))
const assets = path.join(root, 'out/renderer/assets')
const css = fs.existsSync(assets) && fs.readdirSync(assets).find(f => /^index-.*\.css$/.test(f))
if (!css) throw new Error('Run npm run build first')
buildSync({ stdin: { contents: `
import React from 'react'; import {createRoot} from 'react-dom/client';
import {Terminal} from '@xterm/xterm';
import {Sidebar} from './src/renderer/components/sidebar/Sidebar';
import {SettingsModal} from './src/renderer/components/settings/SettingsModal';
import {PaneStatusLine} from './src/renderer/components/layout/PaneStatusLine';
import {I18nProvider} from './src/renderer/i18n';
import {useAppStore} from './src/renderer/lib/store';
import {runCtlOp} from './src/renderer/lib/ctlCommands';
import {registerTermReader, readBufferLines} from './src/renderer/lib/termReaders';
import {applyTheme} from './src/renderer/themes/applyTheme';
import {useSidePanels} from './src/renderer/lib/sidePanels';
import {useAgentStore} from './src/renderer/lib/agentStore';
import {useToastStore} from './src/renderer/lib/toast';
import {isStopped} from './src/renderer/lib/stoppedPanes';
const noop=()=>()=>{};
const fallback=(base)=>new Proxy(base,{get:(t,k)=>k in t?t[k]:(typeof k==='string'?fallback(noop):undefined)});
const calls={clipboard:[],userPath:[],skill:[],enabled:[],reveal:0,kill:[],forget:[]};
const env={portable:false,skill:{claude:{state:'missing',target:'claude',path:'C:/fake/.claude/skills/snagentsos'},codex:{state:'missing',target:'codex',path:'C:/fake/.codex/skills/snagentsos'}}};
window.snApi=fallback({platform:'win32',
 clipboard:{writeText:(t)=>calls.clipboard.push(t),readText:async()=>''},
 window:fallback({reveal:()=>{calls.reveal++}}),
 cli:{setEnabled:(v)=>calls.enabled.push(v),
  state:async()=>({enabled:true,running:true,endpoint:'\\\\\\\\.\\\\pipe\\\\snagentsos-ctl-0123456789abcdef',startedAt:Date.UTC(2026,9,18,12,0),shimPath:'C:/data/bin/snaos.cmd',binDir:'C:/data/bin',portable:env.portable,inUserPath:false}),
  skill:async(op,target)=>{const tg=target??'claude';calls.skill.push(op+':'+tg);const cur=env.skill[tg];if(op==='install'||op==='repair')env.skill[tg]={state:'installed',target:tg,version:'2.0.0',path:cur.path};if(op==='remove')env.skill[tg]={state:'missing',target:tg,path:cur.path};return env.skill[tg]},
  userPath:async(v)=>{calls.userPath.push(v);return true}},
 pty:fallback({write(){},killPanes:async(ids)=>{calls.kill.push(...ids);return ids.length}}),config:fallback({save(){}}),
 agents:fallback({forget:(id)=>calls.forget.push(id)}),
 updates:fallback({check:async()=>({available:false,currentVersion:'2.0.0'}),onProgress:noop}),
 system:fallback({getMetrics:async()=>null,getLoginItem:async()=>false}),
 app:fallback({info:async()=>({version:'2.0.0',portable:env.portable,platform:'win32'})}),
 remote:fallback({onStatus:noop,onDevices:noop,getStatus:async()=>({state:'stopped',connectedCount:0}),listDevices:async()=>[]})});
const presets=[
 {id:'sh',name:'Shell',type:'shell',command:'',args:[],color:'#6366f1',icon:'terminal'},
 {id:'cx',name:'Codex',type:'codex',command:'codex',args:[],color:'#10a37f',icon:'codex'},
 {id:'cl',name:'Claude Code',type:'claude',command:'claude',args:[],color:'#d97757',icon:'claude'}];
const pane=(id,t='shell',extra={})=>({id,type:t,title:t==='claude'?'Claude '+id:'Console '+id,color:'#6366f1',icon:t==='claude'?'claude':'terminal',...(t==='claude'?{presetId:'cl'}:{}),...extra});
const workspaces=[
 {id:'ws-api',name:'api',cwd:'C:/repos/api',panes:[pane('p1','claude'),pane('p2'),pane('p3')],layout:{grid:'3',order:['p2','p1','p3']}},
 {id:'ws-srv',name:'srv',cwd:'C:/repos/srv',setupId:'conn1',panes:[pane('p4')]},
 {id:'ws-fav',name:'fav',cwd:'C:/repos/fav',favorite:true,panes:[pane('p5')]}];
useAppStore.setState({hydrated:true,activeWorkspaceId:'ws-api',workspaces,presets,connections:[{id:'conn1',name:'Dedi',steps:[]}],mountedWorkspaces:{'ws-api':'full'},paneStatus:{p1:{paneId:'p1',provider:'claude',state:'working',precise:true,notify:false,updatedAt:Date.now(),stateSince:Date.now()}}});
useAppStore.getState().updateSettings({language:'es'});
applyTheme('midnight');
const term=new Terminal({cols:40,rows:6,scrollback:100});
function Root(){const lang=useAppStore(s=>s.settings.language);
 return <I18nProvider lang={lang}><div style={{height:'100vh'}} className="flex bg-bg-primary text-text-primary"><Sidebar/>
 <main className="flex-1 p-6"><div id="hdr" className="flex w-[260px] items-baseline overflow-hidden text-xs"><span className="min-w-0 truncate">Claude p1</span><PaneStatusLine paneId="p1"/></div><div id="xt" style={{width:400,height:140}}/></main>
 <SettingsModal/></div></I18nProvider>}
createRoot(document.getElementById('root')).render(<Root/>);
const mountTerm=()=>{term.open(document.getElementById('xt'));registerTermReader('p2',(n)=>readBufferLines(term.buffer.active,n))};
const q=s=>document.querySelector(s);
window.smoke={calls,env,mountTerm,
 st:()=>{const s=useAppStore.getState();return {active:s.activeWorkspaceId,flow:s.wizardOpen,prefill:s.wizardPrefill,mounted:s.mountedWorkspaces,pending:s.pendingPrompts,attention:s.paneAttention,settings:{cli:s.settings.cliEnabled,auto:s.settings.automation}}},
 ws:id=>useAppStore.getState().workspaces.find(w=>w.id===id),
 op:o=>JSON.parse(JSON.stringify(runCtlOp(o))),
 write:t=>new Promise(r=>term.write(t,r)),
 open:c=>useAppStore.getState().openSettings(c),
 close:()=>useAppStore.getState().setSettingsOpen(false),
 query:v=>useAppStore.getState().setSettingsQuery(v),
 has:sel=>!!q(sel),
 attr:(sel,a)=>q(sel)?.getAttribute(a),
 text:sel=>q(sel)?.textContent??null,
 click:sel=>q(sel).click(),
 switchOf:id=>q('[data-setting-id="'+id+'"] [role=switch]'),
 sw:id=>{const s=q('[data-setting-id="'+id+'"] [role=switch]');return s?{checked:s.getAttribute('aria-checked'),disabled:s.disabled}:null},
 toggle:id=>q('[data-setting-id="'+id+'"] [role=switch]').click(),
 groups:()=>[...document.querySelectorAll('[data-search-group]')].map(g=>g.getAttribute('data-search-group')),
 overflow:sel=>{const e=q(sel);return e.scrollWidth>e.clientWidth},
 side:()=>{const s=useSidePanels.getState();return {open:s.open,req:s.noteRequest?{workspaceId:s.noteRequest.workspaceId,noteId:s.noteRequest.noteId}:null}},
 agent:()=>({view:useAgentStore.getState().view,intent:useAgentStore.getState().launchIntent}),
 setView:v=>useAgentStore.getState().setView(v),
 toasts:()=>useToastStore.getState().items.map(t=>t.title),
 closeWizard:()=>useAppStore.getState().setWizardOpen(false),
 lang:l=>useAppStore.getState().updateSettings({language:l}),
 epoch:id=>useAppStore.getState().paneEpoch[id]??0,
 stopped:id=>isStopped(id),
 lastSession:id=>useAppStore.getState().workspaces.flatMap(w=>w.panes).find(p=>p.id===id)?.lastSession??null,
 setLastSession:(id,v)=>useAppStore.setState(s=>({workspaces:s.workspaces.map(w=>({...w,panes:w.panes.map(p=>p.id===id?{...p,lastSession:v}:p)}))})),
 lastToast:()=>{const i=useToastStore.getState().items;const t=i[i.length-1];return t?{id:t.id,title:t.title}:null},
 sidebarText:()=>q('aside')?.textContent??document.body.textContent,
};
`, resolveDir: root, loader: 'tsx' }, bundle: true, platform: 'browser', format: 'iife', outfile: path.join(dir, 'renderer.js'), alias: { '@shared': path.join(root, 'src/shared'), '@': path.join(root, 'src/renderer') }, jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' }, loader: { '.css': 'empty' } })
fs.writeFileSync(path.join(dir, 'index.html'), `<html><head><meta charset="utf-8"><link rel="stylesheet" href="${pathToFileURL(path.join(assets, css))}"></head><body><div id="root"></div><script src="renderer.js"></script></body></html>`)
fs.writeFileSync(path.join(dir, 'main.cjs'), `
const {app,BrowserWindow}=require('electron');const fs=require('fs'),path=require('path');
app.setPath('userData',path.join(__dirname,'profile'));
app.whenReady().then(async()=>{
 const w=new BrowserWindow({width:1200,height:800,show:false,webPreferences:{sandbox:true,backgroundThrottling:false}});
 const failures=[];w.webContents.on('console-message',(_e,level,message)=>{if(process.env.SN_UI_DEBUG)console.log('[renderer]',level,message);if(level>=3)failures.push(message)});
 await w.loadFile(path.join(__dirname,'index.html'));await new Promise(r=>setTimeout(r,500));
 const js=c=>w.webContents.executeJavaScript(c);const wait=ms=>new Promise(r=>setTimeout(r,ms));const frame=()=>wait(80);
 const shot=async name=>{await js('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');await wait(150);fs.writeFileSync(path.join(__dirname,name+'.png'),(await w.webContents.capturePage()).toPNG())};
 let n=0;const ok=(c,label,extra)=>{if(!c)throw new Error(label+(extra!==undefined?' '+JSON.stringify(extra):''));n++};
 const eq=(a,b,label)=>ok(JSON.stringify(a)===JSON.stringify(b),label,{got:a,want:b});

 // --- E8-FR-22: Settings > Automation ------------------------------------------
 await js("smoke.open('automation')");await wait(700);
 ok(await js("smoke.has('[data-cli-settings]')"),'Settings > Automation shows the CLI block');
 eq(await js("['automation.cli','automation.protectSsh','automation.userPath','automation.server','automation.skill'].map(id=>!!document.querySelector('[data-setting-id=\\"'+id+'\\"]'))"),[true,true,true,true,true],'every CLI row is a deep-linkable setting');
 eq([await js("smoke.sw('automation.cli')"),await js("smoke.sw('automation.protectSsh')"),await js("smoke.sw('automation.userPath')")],[{checked:'true',disabled:false},{checked:'true',disabled:false},{checked:'false',disabled:false}],'defaults: CLI on, SSH protected, PATH off (enabled outside the portable)');
 ok((await js("smoke.text('[data-cli-server]')")).startsWith('Activo en \\\\\\\\.\\\\pipe\\\\snagentsos-ctl-'),'the server row shows the endpoint',await js("smoke.text('[data-cli-server]')"));
 ok((await js("smoke.text('[data-cli-restart-note]')")).includes('Windows Terminal'),'the restart note mentions Windows Terminal');
 await js("smoke.click('[data-cli-copy]')");await frame();
 eq(await js('smoke.calls.clipboard'),['snaos ls'],'Copy example puts "snaos ls" on the clipboard');
 await js("smoke.toggle('automation.cli')");await frame();
 eq((await js('smoke.st()')).settings.cli,false,'the switch turns settings.cliEnabled off');
 await js("smoke.toggle('automation.cli')");await frame();
 await js("smoke.toggle('automation.protectSsh')");await frame();
 eq((await js('smoke.st()')).settings.auto.cliProtectSsh,false,'SSH protection toggles settings.automation.cliProtectSsh');
 await js("smoke.toggle('automation.protectSsh')");await frame();
 await js("smoke.toggle('automation.userPath')");await wait(200);
 eq([await js('smoke.calls.userPath'),(await js('smoke.st()')).settings.auto.cliUserPath],[[true],true],'the PATH switch asks main first, then saves settings.automation.cliUserPath');
 eq(await js("smoke.attr('[data-cli-skill]','data-cli-skill')"),'missing','the skill starts as not installed');
 eq(await js("[...document.querySelectorAll('[data-cli-skill-target]')].map(b=>[b.getAttribute('data-cli-skill-target'),b.getAttribute('aria-checked')])"),[['claude','true'],['codex','false']],'the Claude | Codex selector defaults to Claude');
 eq(await js('smoke.calls.skill'),['status:claude','status:codex'],'both statuses are read on open, nothing is written');
 await js("smoke.click('[data-cli-skill-install]')");await wait(150);
 eq([await js("smoke.attr('[data-cli-skill]','data-cli-skill')"),await js("smoke.text('[data-cli-skill]')"),await js("smoke.has('[data-cli-skill-remove]')"),await js("smoke.has('[data-cli-skill-repair]')")],['installed','Instalada v2.0.0',true,true],'Install writes it (only on the click); Remove and Repair appear');
 await shot('automation-cli');
 await js("smoke.click('[data-cli-skill-target=codex]')");await frame();
 eq([await js("smoke.attr('[data-cli-skill-target=codex]','aria-checked')"),await js("smoke.attr('[data-cli-skill]','data-cli-skill')"),await js("smoke.has('[data-cli-skill-install]')"),await js("smoke.has('[data-cli-skill-remove]')")],['true','missing',true,false],'selecting Codex shows its own status (not installed) with Install; Claude stays installed');
 eq(await js('smoke.calls.skill.length'),3,'switching the selector writes nothing and asks nothing more');
 await js("smoke.click('[data-cli-skill-install]')");await wait(150);
 eq([await js("smoke.attr('[data-cli-skill]','data-cli-skill')"),await js("smoke.attr('[data-cli-skill]','title')"),await js("smoke.text('[data-cli-skill]')")],['installed','C:/fake/.codex/skills/snagentsos','Instalada v2.0.0'],'Install on Codex acts on the Codex folder');
 await js("document.querySelector('[data-cli-skill-target]').scrollIntoView({block:'center'})");
 await shot('automation-cli-codex');
 await js("smoke.click('[data-cli-skill-repair]')");await wait(150);
 await js("smoke.click('[data-cli-skill-remove]')");await wait(150);
 eq(await js("smoke.attr('[data-cli-skill]','data-cli-skill')"),'missing','Remove on Codex leaves it not installed');
 await js("smoke.click('[data-cli-skill-target=claude]')");await frame();
 eq([await js("smoke.attr('[data-cli-skill]','data-cli-skill')"),await js("smoke.has('[data-cli-skill-remove]')")],['installed',true],'back on Claude: still installed, untouched by the Codex ops');
 await js("smoke.click('[data-cli-skill-remove]')");await wait(150);
 eq(await js('smoke.calls.skill'),['status:claude','status:codex','install:claude','install:codex','repair:codex','remove:codex','remove:claude'],'skill ops go to main with the selected target: both statuses first, then install, repair and remove');
 await js('smoke.close()');await frame();
 await js("smoke.env.portable=true");
 await js("smoke.open('automation')");await wait(700);
 eq(await js("smoke.sw('automation.userPath')"),{checked:'false',disabled:true},'portable: the PATH switch is off and disabled');
 ok((await js("smoke.attr('[data-cli-user-path]','title')"))==='No disponible en la versión portable','with the "not available in the portable" tooltip');
 await js('smoke.close()');await frame();
 // Search
 await js("smoke.open()");await wait(400);await js("smoke.query('snaos')");await wait(300);
 ok((await js('smoke.groups()')).includes('automation'),'searching "snaos" finds the Automation rows',await js('smoke.groups()'));
 await js("smoke.query('')");await js('smoke.close()');await frame();

 // --- The renderer side of the CLI bus --------------------------------------------
 const list=await js("smoke.op({kind:'list'})");
 eq(list.data.workspaces.map(w=>w.id),['ws-fav','ws-api','ws-srv'],'list follows the sidebar order: favorites first (Alt+1..9 numbers)');
 eq(list.data.workspaces[1].panes.map(p=>p.id),['p2','p1','p3'],'consoles in grid order (layout order)');
 eq([list.data.activeWorkspaceId,list.data.workspaces[2].setupId,list.data.presets.length],['ws-api','conn1',3],'active workspace, profile and presets in the list');
 const sp=await js("smoke.op({kind:'spawn',workspaceId:'ws-srv',presetId:'cl',prompt:'revisa el diff',focus:false,noProfile:true})");
 const st=await js('smoke.st()');
 const made=(await js("smoke.ws('ws-srv')")).panes.find(p=>p.id===sp.data.paneId);
 ok(sp.ok&&sp.data.index===2&&['argv','gate'].includes(sp.data.promptDelivery),'spawn answers the new console id, its grid index and the delivery',sp);
 eq([st.active,st.mounted['ws-srv']],['ws-api',[sp.data.paneId]],'without --focus the workspace is not activated and only the new console mounts');
 eq([made.presetId,made.setupId],['cl',''],'--no-profile: the console is local in a workspace with a profile');
 eq([st.pending[sp.data.paneId].text,st.pending[sp.data.paneId].enter,st.pending[sp.data.paneId].source],['revisa el diff',true,'cli'],'the prompt waits for the spawn through the shared path (source cli)');
 const sp2=await js("smoke.op({kind:'spawn',workspaceId:'ws-api',paneType:'shell',title:'Logs',focus:true,noProfile:false})");
 eq([(await js('smoke.st()')).active,(await js("smoke.ws('ws-api')")).panes.find(p=>p.id===sp2.data.paneId).title,sp2.data.promptDelivery],['ws-api','Logs','none'],'--focus reveals it; --title names it; no prompt is none');
 eq((await js("smoke.op({kind:'spawn',workspaceId:'nope',focus:false,noProfile:false})")).error,'not_found','an unknown workspace is not_found');

 // read from a real xterm: scrollback + screen, wrapped rows joined.
 await js('smoke.mountTerm()');await frame();
 await js("smoke.write('linea 1\\\\r\\\\nlinea 2\\\\r\\\\n'+'x'.repeat(50)+'\\\\r\\\\n\\\\x1b[31mrojo\\\\x1b[0m\\\\r\\\\n')");
 const rd=await js("smoke.op({kind:'read',paneId:'p2',lines:3})");
 eq(rd.data.lines,['linea 2','x'.repeat(50),'rojo'],'read returns the last lines without ANSI, a 50-char line wrapped at 40 joined back');
 eq((await js("smoke.op({kind:'read',paneId:'p3',lines:5})")).error,'not_running','a pane without a mounted xterm answers not_running (main falls back to its ring)');

 // status line in the header and the agent row, attention, note.
 eq((await js("smoke.op({kind:'setStatusLine',paneId:'p1',text:'corriendo tests'})")).ok,true,'setStatusLine');
 await frame();
 eq([await js("smoke.text('#hdr [data-pane-status-line]')"),await js("smoke.attr('#hdr [data-pane-status-line]','title')")],[' · corriendo tests','corriendo tests'],'the pane header shows the status line with the full text in the tooltip');
 ok(await js("[...document.querySelectorAll('[data-agent-status-line]')].some(e=>e.textContent==='corriendo tests')"),'the sidebar agent row shows it too');
 await js("smoke.op({kind:'setStatusLine',paneId:'p1',text:'una linea de estado muy larga que no entra en el header del pane y se recorta'})");await frame();
 ok(await js("smoke.overflow('#hdr [data-pane-status-line]')")&&!(await js("smoke.overflow('#hdr')")),'a long line truncates inside the header');
 await shot('status-line');
 await js("smoke.op({kind:'setStatusLine',paneId:'p1',text:null})");await frame();
 ok(!(await js("smoke.has('#hdr [data-pane-status-line]')"))&&!(await js("smoke.has('[data-agent-status-line]')")),'clearing removes it from both places');
 eq((await js("smoke.op({kind:'setStatusLine',paneId:'ghost',text:'x'})")).error,'not_found','an unknown pane is not_found');
 await js("smoke.op({kind:'attention',paneId:'p4'})");
 eq((await js('smoke.st()')).attention.p4,true,'attention marks the console badge');
 await js("smoke.op({kind:'setNote',workspaceId:'ws-api',note:'esperando CI',taskState:'review'})");await frame();
 eq([(await js("smoke.ws('ws-api')")).note,(await js("smoke.ws('ws-api')")).taskState],['esperando CI','review'],'setNote updates the sidebar note and state');
 await js("smoke.op({kind:'setNote',workspaceId:'ws-api',note:null,taskState:null})");
 eq(['note' in (await js("smoke.ws('ws-api')")),'taskState' in (await js("smoke.ws('ws-api')"))],[false,false],'null clears both');
 await js("smoke.op({kind:'open',workspaceId:'ws-srv'})");await frame();
 eq([(await js('smoke.st()')).active,await js('smoke.calls.reveal')>0],['ws-srv',true],'open activates the workspace and brings the window up');
 await js("smoke.op({kind:'composer',cwd:'C:/repos/nuevo'})");await frame();
 eq([(await js('smoke.st()')).flow,(await js('smoke.st()')).prefill],[true,{cwd:'C:/repos/nuevo'}],'composer op opens the new workspace card with the folder');

 // --- app 2.3.0: the new CLI ops ------------------------------------------------
 await js("smoke.op({kind:'composer',cwd:'C:/repos/x',name:'Equis'})");await frame();
 eq((await js('smoke.st()')).prefill,{cwd:'C:/repos/x',name:'Equis'},'composer carries the name of ws new --composer');
 await js('smoke.closeWizard()');await frame();
 const cw=await js("smoke.op({kind:'createWorkspace',name:'nuevo',cwd:'C:/repos/nuevo',focus:false})");
 const lst=await js("smoke.op({kind:'list'})");
 eq([(await js('smoke.st()')).active,lst.data.workspaces[cw.data.index-1].id,!!(await js('smoke.st()')).mounted[cw.data.workspaceId]],['ws-srv',cw.data.workspaceId,true],'createWorkspace without focus keeps the active workspace; its index is its sidebar number; its shell mounts');
 const rv=await js('smoke.calls.reveal');
 const cw2=await js("smoke.op({kind:'createWorkspace',name:'otro',cwd:'C:/repos/otro',focus:true})");
 eq([(await js('smoke.st()')).active,(await js('smoke.calls.reveal'))>rv],[cw2.data.workspaceId,true],'with focus it activates and brings the window up');
 await js("smoke.op({kind:'setFavorite',workspaceId:'ws-api',favorite:true})");
 await js("smoke.op({kind:'setFavorite',workspaceId:'ws-api',favorite:true})");
 const favs=(await js("smoke.op({kind:'list'})")).data.workspaces.filter(w=>w.favorite).map(w=>w.id).sort();
 eq([(await js("smoke.ws('ws-api')")).favorite,favs],[true,['ws-api','ws-fav']],'setFavorite is idempotent and the list marks favorites');
 await js("smoke.op({kind:'setFavorite',workspaceId:'ws-api',favorite:false})");
 eq((await js("smoke.ws('ws-api')")).favorite,false,'setFavorite false unmarks it');
 await js("smoke.op({kind:'renamePane',workspaceId:'ws-api',paneId:'p2',title:'Logs del build'})");
 await js("smoke.op({kind:'renameWorkspace',workspaceId:'ws-api',name:'Api renombrada'})");await frame();
 eq([(await js("smoke.ws('ws-api')")).panes.find(p=>p.id==='p2').title,(await js("smoke.ws('ws-api')")).name],['Logs del build','Api renombrada'],'renamePane and renameWorkspace');
 ok((await js('document.body.textContent')).includes('Api renombrada'),'the sidebar shows the new workspace name');
 eq((await js("smoke.op({kind:'renamePane',workspaceId:'ws-srv',paneId:'p2',title:'x'})")).error,'not_found','a pane of another workspace is not_found');
 await js("smoke.op({kind:'kill',workspaceId:'ws-api',paneId:'p3',close:false})");await wait(50);
 eq([(await js('smoke.calls.kill')).includes('p3'),(await js("smoke.ws('ws-api')")).panes.some(p=>p.id==='p3')],[true,true],'kill stops the pty by paneId (killPanes) and keeps the console');
 eq(await js("smoke.stopped('p3')"),true,'kill without --close keeps the console stopped (a later mount shows the exit card, never a new spawn)');
 ok((await js('smoke.toasts()')).includes('snaos detuvo la consola "Console p3"'),'kill shows an info toast (es)',await js('smoke.toasts()'));
 await js("smoke.op({kind:'kill',workspaceId:'ws-api',paneId:'p3',close:true})");await frame();
 eq((await js("smoke.ws('ws-api')")).panes.some(p=>p.id==='p3'),false,'kill --close removes the console (reopenable from the desktop)');
 eq(await js("smoke.stopped('p3')"),false,'a closed console leaves no stop behind (reopening it starts it again)');
 ok((await js('smoke.toasts()')).includes('snaos cerró la consola "Console p3"'),'the close toast (es)',await js('smoke.toasts()'));
 const e4=await js("smoke.epoch('p4')");const k4=(await js('smoke.calls.kill')).length;
 eq((await js("smoke.op({kind:'restart',workspaceId:'ws-srv',paneId:'p4'})")).ok,true,'restart without a flag');await frame();
 ok((await js("smoke.epoch('p4')"))>e4&&(await js('smoke.calls.kill')).length>k4,'the header button path: the pty is killed and the console remounts');
 await js("smoke.op({kind:'restart',workspaceId:'ws-api',paneId:'p1',resume:true})");
 eq((await js('smoke.agent()')).intent.p1,'resume','restart --resume goes through the resume launch intent (nothing typed, no Enter)');
 ok((await js('smoke.toasts()')).includes('snaos reinició la consola "Claude p1"'),'the restart toast (es)',await js('smoke.toasts()'));
 await js("smoke.setLastSession('p1',{provider:'claude',sessionId:'s-old',cwd:'C:/repos/api',at:1})");
 const beforeFresh=await js('smoke.lastToast()');
 eq((await js("smoke.op({kind:'restart',workspaceId:'ws-api',paneId:'p1',resume:false})")).ok,true,'restart --fresh');
 eq([(await js('smoke.agent()')).intent.p1,await js("smoke.lastSession('p1')"),(await js('smoke.calls.forget')).includes('p1')],['fresh',null,true],'restart --fresh goes through restartFresh: fresh intent, last session cleared, session forgotten in main');
 const afterFresh=await js('smoke.lastToast()');
 ok(afterFresh.id!==beforeFresh.id&&afterFresh.title==='snaos reinició la consola "Claude p1"','the restart toast for --fresh',afterFresh);
 eq((await js("smoke.op({kind:'restart',workspaceId:'ws-api',paneId:'ghost'})")).error,'not_found','restart of an unknown console is not_found');
 await js("smoke.op({kind:'deleteWorkspace',workspaceId:'"+cw.data.workspaceId+"'})");
 ok(!(await js("smoke.ws('"+cw.data.workspaceId+"')"))&&(await js('smoke.toasts()')).includes('snaos cerró el workspace "nuevo"'),'deleteWorkspace removes it with a toast (es)',await js('smoke.toasts()'));
 await js("smoke.lang('en')");await frame();
 await js("smoke.op({kind:'deleteWorkspace',workspaceId:'"+cw2.data.workspaceId+"'})");
 ok((await js('smoke.toasts()')).includes('snaos closed workspace "otro"'),'and in English',await js('smoke.toasts()'));
 await js("smoke.op({kind:'kill',workspaceId:'ws-srv',paneId:'p4',close:false})");
 ok((await js('smoke.toasts()')).includes('snaos stopped console "Console p4"'),'the kill toast in English',await js('smoke.toasts()'));
 eq(await js("smoke.stopped('p4')"),true,'the killed console is marked stopped');
 const before4=await js('smoke.lastToast()');
 eq((await js("smoke.op({kind:'kill',workspaceId:'ws-srv',paneId:'p4',close:false,running:false})")).ok,true,'kill of a console main reports as not running is ok');
 eq(await js('smoke.lastToast()'),before4,'no "stopped console" toast when nothing was running');
 await js("smoke.op({kind:'restart',workspaceId:'ws-srv',paneId:'p4'})");await frame();
 eq(await js("smoke.stopped('p4')"),false,'an explicit restart clears the stop');
 await js("smoke.lang('es')");await frame();
 await js("smoke.setView('board')");
 const rv2=await js('smoke.calls.reveal');
 eq((await js("smoke.op({kind:'openNote',workspaceId:'ws-fav',noteId:'n-0123abcd'})")).ok,true,'openNote');
 eq([(await js('smoke.st()')).active,await js('smoke.side()'),(await js('smoke.agent()')).view,(await js('smoke.calls.reveal'))>rv2],['ws-fav',{open:{kind:'notes',workspaceId:'ws-fav'},req:{workspaceId:'ws-fav',noteId:'n-0123abcd'}},'grid',true],'openNote activates the workspace, leaves the board and asks the Notes drawer for that note');
 eq((await js("smoke.op({kind:'openNote',workspaceId:'ws-fav',noteId:'../x'})")).error,'bad_request','an invalid note id is bad_request');
 eq((await js("smoke.op({kind:'openNote',workspaceId:'nope',noteId:'n-1'})")).error,'not_found','an unknown workspace is not_found');

 if(failures.length)throw new Error(failures.join('\\n'));
 console.log('PASS: '+n+' cli UI checks (Settings > Automation, search, list, spawn, read, status line, attention, note, open, composer name, workspaces, favorites, rename, kill, restart, openNote, toasts es/en); screenshots '+__dirname);w.destroy();app.quit();
}).catch(e=>{console.error(e);app.exit(1)});
`)
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
const res = spawnSync(require('electron'), [path.join(dir, 'main.cjs')], { env, windowsHide: true, encoding: 'utf8', timeout: 180000 })
process.stdout.write(res.stdout ?? ''); if (res.status !== 0) process.stderr.write(res.stderr ?? '')
process.exitCode = res.status ?? 1
