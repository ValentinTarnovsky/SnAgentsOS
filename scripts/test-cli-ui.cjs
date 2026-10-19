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
const noop=()=>()=>{};
const fallback=(base)=>new Proxy(base,{get:(t,k)=>k in t?t[k]:(typeof k==='string'?fallback(noop):undefined)});
const calls={clipboard:[],userPath:[],skill:[],enabled:[],reveal:0};
const env={portable:false,skill:{claude:{state:'missing',target:'claude',path:'C:/fake/.claude/skills/snagentsos'},codex:{state:'missing',target:'codex',path:'C:/fake/.codex/skills/snagentsos'}}};
window.snApi=fallback({platform:'win32',
 clipboard:{writeText:(t)=>calls.clipboard.push(t),readText:async()=>''},
 window:fallback({reveal:()=>{calls.reveal++}}),
 cli:{setEnabled:(v)=>calls.enabled.push(v),
  state:async()=>({enabled:true,running:true,endpoint:'\\\\\\\\.\\\\pipe\\\\snagentsos-ctl-0123456789abcdef',startedAt:Date.UTC(2026,9,18,12,0),shimPath:'C:/data/bin/snaos.cmd',binDir:'C:/data/bin',portable:env.portable,inUserPath:false}),
  skill:async(op,target)=>{const tg=target??'claude';calls.skill.push(op+':'+tg);const cur=env.skill[tg];if(op==='install'||op==='repair')env.skill[tg]={state:'installed',target:tg,version:'2.0.0',path:cur.path};if(op==='remove')env.skill[tg]={state:'missing',target:tg,path:cur.path};return env.skill[tg]},
  userPath:async(v)=>{calls.userPath.push(v);return true}},
 pty:fallback({write(){}}),config:fallback({save(){}}),
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

 if(failures.length)throw new Error(failures.join('\\n'));
 console.log('PASS: '+n+' cli UI checks (Settings > Automation, search, list, spawn, read, status line, attention, note, open); screenshots '+__dirname);w.destroy();app.quit();
}).catch(e=>{console.error(e);app.exit(1)});
`)
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
const res = spawnSync(require('electron'), [path.join(dir, 'main.cjs')], { env, windowsHide: true, encoding: 'utf8', timeout: 180000 })
process.stdout.write(res.stdout ?? ''); if (res.status !== 0) process.stderr.write(res.stderr ?? '')
process.exitCode = res.status ?? 1
