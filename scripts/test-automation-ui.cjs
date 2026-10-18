// Workspace composer, note and task state (E8-FR-08..10): the production
// composer, 3-step wizard, Sidebar and global keys in an isolated hidden
// Electron window. main is a fake: fs.dirExists and the folder picker are
// stubs, no config is written. Requires npm run build (CSS).
const fs = require('node:fs'), os = require('node:os'), path = require('node:path')
const { pathToFileURL } = require('node:url')
const { spawnSync } = require('node:child_process')
const { buildSync } = require('esbuild')
const root = path.resolve(__dirname, '..'), dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snagentsos-automation-ui-'))
const assets = path.join(root, 'out/renderer/assets')
const css = fs.existsSync(assets) && fs.readdirSync(assets).find(f => /^index-.*\.css$/.test(f))
if (!css) throw new Error('Run npm run build first')
buildSync({ stdin: { contents: `
import React from 'react'; import {createRoot} from 'react-dom/client';
import {Sidebar} from './src/renderer/components/sidebar/Sidebar';
import {WorkspaceComposer} from './src/renderer/components/wizard/WorkspaceComposer';
import {NewWorkspaceWizard} from './src/renderer/components/wizard/NewWorkspaceWizard';
import {I18nProvider} from './src/renderer/i18n';
import {useAppStore} from './src/renderer/lib/store';
import {useGlobalKeys} from './src/renderer/lib/useGlobalKeys';
import {registerFocuser} from './src/renderer/lib/focus';
import {applyTheme} from './src/renderer/themes/applyTheme';
const noop=()=>()=>{};
const fallback=(base)=>new Proxy(base,{get:(t,k)=>k in t?t[k]:(typeof k==='string'?fallback(noop):undefined)});
const probes=[];
window.snApi=fallback({platform:'win32',
 fs:{dirExists:async(p)=>{probes.push(p);return !/missing/i.test(p)}},
 dialog:{openDirectory:async()=>'D:/picked/proj'},
 pty:fallback({write(){}}),config:fallback({save(){}}),
 updates:fallback({check:async()=>({available:false,currentVersion:'2.0.0'}),onProgress:noop}),
 system:fallback({getMetrics:async()=>null,getLoginItem:async()=>false}),
 app:fallback({info:async()=>({version:'2.0.0',portable:false,platform:'win32'})}),
 remote:fallback({onStatus:noop,onDevices:noop,getStatus:async()=>({state:'stopped',connectedCount:0}),listDevices:async()=>[]})});
const presets=[
 {id:'sh',name:'Shell',type:'shell',command:'',args:[],color:'#6366f1',icon:'terminal'},
 {id:'cx',name:'Codex',type:'codex',command:'codex',args:[],color:'#10a37f',icon:'codex'},
 {id:'cl',name:'Claude Code',type:'claude',command:'claude',args:[],color:'#d97757',icon:'claude'}];
const pane=(id,t='shell')=>({id,type:t,title:'Console '+id,color:'#6366f1',icon:'terminal'});
const LONG='Revisar el flujo de login con SSO y los tokens que vencen; despues seguir con el refactor del modulo de pagos y avisar al equipo xx';
const workspaces=[
 {id:'ws-note',name:'Front con un nombre bastante largo',cwd:'C:/repos/front',panes:[pane('p1'),pane('p2')],note:LONG.slice(0,140),taskState:'review'},
 {id:'ws-doing',name:'Back',cwd:'C:/repos/back',panes:[pane('p3')],taskState:'doing'},
 ...Array.from({length:9},(_,i)=>({id:'ws-'+i,name:'Repo '+i,cwd:'C:/repos/r'+i,panes:[pane('q'+i)]}))];
useAppStore.setState({hydrated:true,activeWorkspaceId:'ws-note',workspaces,presets,connections:[]});
useAppStore.getState().updateSettings({language:'es'});
applyTheme('midnight');
registerFocuser('p1',()=>document.getElementById('term').focus());
function Keys(){useGlobalKeys();return null}
function Root(){const lang=useAppStore(s=>s.settings.language);
 return <I18nProvider lang={lang}><Keys/><div style={{height:'100vh'}} className="flex bg-bg-primary text-text-primary"><Sidebar/>
 <main className="flex-1 p-6"><div className="xterm"><textarea id="term" className="xterm-helper-textarea" aria-label="term"/></div></main>
 <WorkspaceComposer/><NewWorkspaceWizard/></div></I18nProvider>}
createRoot(document.getElementById('root')).render(<Root/>);
const termKeys=[];document.addEventListener('keydown',e=>{if(e.target&&e.target.id==='term')termKeys.push(e.key)});
const setInput=(el,v)=>{const proto=el instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(proto,'value').set.call(el,v);el.dispatchEvent(new Event('input',{bubbles:true}))};
const q=s=>document.querySelector(s);
window.smoke={probes,termKeys,LONG,
 st:()=>{const s=useAppStore.getState();return {flow:s.wizardOpen,composer:s.composerOpen,active:s.activeWorkspaceId,count:s.workspaces.length,auto:s.settings.automation,pending:s.pendingPrompts}},
 last:()=>{const s=useAppStore.getState();const w=s.workspaces[s.workspaces.length-1];return {id:w.id,name:w.name,cwd:w.cwd,grid:w.layout&&w.layout.grid,presets:w.panes.map(p=>p.presetId||p.type),setupId:w.setupId||null,ids:w.panes.map(p=>p.id)}},
 ws:id=>useAppStore.getState().workspaces.find(w=>w.id===id),
 set:p=>useAppStore.setState(p),
 settings:p=>useAppStore.getState().updateSettings(p),
 setInput:(sel,v)=>setInput(q(sel),v),
 val:sel=>q(sel)?.value,
 has:sel=>!!q(sel),
 attr:(sel,a)=>q(sel)?.getAttribute(a),
 text:sel=>q(sel)?.textContent??null,
 click:sel=>q(sel).click(),
 focus:sel=>q(sel).focus(),
 active:()=>{const a=document.activeElement;return a?.id||a?.getAttribute('data-composer-agent')||(a?.hasAttribute('data-composer-primary')?'primary':a?.tagName)},
 rect:sel=>{const r=q(sel).getBoundingClientRect();return {x:r.left,y:r.top,w:r.width,h:r.height}},
 suggestions:()=>[...document.querySelectorAll('[data-composer-suggestion]')].map(e=>e.dataset.composerSuggestion),
 overflow:sel=>{const e=q(sel);return e.scrollWidth>e.clientWidth},
 ctx:id=>{const row=q('[data-sidebar-ws="'+id+'"] > div');const r=row.getBoundingClientRect();row.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:r.left+40,clientY:r.top+10}))},
 menuItem:label=>[...document.querySelectorAll('[role=menuitem]')].find(b=>b.textContent.includes(label))?.click(),
 hover:sel=>q(sel).dispatchEvent(new MouseEvent('mouseover',{bubbles:true})),
 unhover:sel=>q(sel).dispatchEvent(new MouseEvent('mouseout',{bubbles:true})),
 tip:()=>q('[role=tooltip]')?.textContent??null,
};
`, resolveDir: root, loader: 'tsx' }, bundle: true, platform: 'browser', format: 'iife', outfile: path.join(dir, 'renderer.js'), alias: { '@shared': path.join(root, 'src/shared'), '@': path.join(root, 'src/renderer') }, jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' } })
fs.writeFileSync(path.join(dir, 'index.html'), `<html><head><meta charset="utf-8"><link rel="stylesheet" href="${pathToFileURL(path.join(assets, css))}"></head><body><div id="root"></div><script src="renderer.js"></script></body></html>`)
fs.writeFileSync(path.join(dir, 'main.cjs'), `
const {app,BrowserWindow}=require('electron');const fs=require('fs'),path=require('path');
app.setPath('userData',path.join(__dirname,'profile'));
app.whenReady().then(async()=>{
 const w=new BrowserWindow({width:1200,height:780,show:false,webPreferences:{sandbox:true,backgroundThrottling:false}});
 const failures=[];w.webContents.on('console-message',(_e,level,message)=>{if(process.env.SN_UI_DEBUG)console.log('[renderer]',level,message);if(level>=3)failures.push(message)});
 await w.loadFile(path.join(__dirname,'index.html'));await new Promise(r=>setTimeout(r,400));
 const js=c=>w.webContents.executeJavaScript(c);const wait=ms=>new Promise(r=>setTimeout(r,ms));const frame=()=>wait(60);
 const shot=async name=>{await js('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');await wait(150);fs.writeFileSync(path.join(__dirname,name+'.png'),(await w.webContents.capturePage()).toPNG())};
 let n=0;const ok=(c,label,extra)=>{if(!c)throw new Error(label+(extra!==undefined?' '+JSON.stringify(extra):''));n++};
 const eq=(a,b,label)=>ok(JSON.stringify(a)===JSON.stringify(b),label,{got:a,want:b});
 const press=async(keyCode,modifiers=[])=>{w.webContents.sendInputEvent({type:'keyDown',keyCode,modifiers});if((keyCode==='Return'||keyCode.length===1)&&!modifiers.includes('control'))w.webContents.sendInputEvent({type:'char',keyCode:keyCode==='Return'?String.fromCharCode(13):keyCode,modifiers});w.webContents.sendInputEvent({type:'keyUp',keyCode,modifiers});await frame()};
 const st=()=>js('smoke.st()');
 const click=async(x,y,clickCount=1)=>{for(const type of ['mouseDown','mouseUp'])w.webContents.sendInputEvent({type,x:Math.round(x),y:Math.round(y),button:'left',clickCount});await frame()};
 w.webContents.focus();

 // --- E8-FR-08: Ctrl+Shift+N opens the single card ---------------------------
 await js("smoke.focus('#term')");
 await press('N',['control','shift']);await frame();
 let s=await st();
 ok(s.flow&&s.composer&&await js("smoke.has('[data-composer]')")&&!(await js("smoke.has('[data-wizard]')")),'Ctrl+Shift+N opens the composer, not the wizard',s);
 eq((await js("smoke.rect('[data-composer]')")).w,560,'the card is 560 px wide');
 eq(await js('smoke.active()'),'composer-cwd','focus lands in the folder input');
 ok(!(await js("smoke.has('[data-composer-suggestions]')")),'focus alone does not open the folder list');
 await press('Down');
 eq(await js('smoke.suggestions()'),['C:/repos/r8','C:/repos/r7','C:/repos/r6','C:/repos/r5','C:/repos/r4','C:/repos/r3','C:/repos/r2','C:/repos/r1'],'the folder input suggests workspace folders, most recent first, up to 8');
 ok(await js("smoke.attr('[data-composer-primary]','disabled')!==null"),'Create is disabled without a folder');
 eq(await js("[...document.querySelectorAll('[data-composer-primary] [data-key-hint] kbd')].map(k=>k.textContent||'enter')"),['Ctrl','enter'],'the primary carries the Ctrl+Enter chip');
 eq(await js("smoke.attr('[data-composer-primary]','aria-keyshortcuts')"),'Control+Enter','and announces it');
 await press('Return',['control']);
 eq([(await st()).count,(await st()).composer],[11,true],'Ctrl+Enter without a folder creates nothing');
 // A key aimed at the console behind is swallowed.
 await js("smoke.focus('#term')");await press('B');
 eq([await js('smoke.termKeys.length'),await js('smoke.active()')],[0,'composer-cwd'],'keys never reach the console behind the card');
 eq(await js("smoke.attr('[data-composer-agent=cl]','aria-checked')"),'true','the first claude preset is preselected');
 ok(!(await js("smoke.has('[data-composer-profile]')")),'no Connection Profile field without profiles');

 // Folder typed: name follows, missing folder hint, suggestions filter.
 await js("smoke.setInput('[data-composer-cwd]','C:/missing/app')");await wait(450);
 eq(await js("smoke.val('[data-composer-name]')"),'app','the name follows the folder basename');
 eq(await js("smoke.text('[data-composer-missing]')"),'La carpeta no existe','a folder that does not exist shows the hint');
 ok(await js("smoke.attr('[data-composer-primary]','disabled')===null"),'the hint never blocks Create');
 await js("smoke.setInput('[data-composer-cwd]','C:/repos/back')");await wait(450);
 ok(!(await js("smoke.has('[data-composer-missing]')"))&&(await js('smoke.probes')).includes('C:/repos/back'),'an existing folder clears the hint (asked over fs.dirExists)');
 await js("smoke.setInput('[data-composer-name]','Mi nombre')");
 await js("smoke.setInput('[data-composer-cwd]','C:/repos/r')");await frame();
 eq(await js("smoke.val('[data-composer-name]')"),'Mi nombre','a typed name is kept when the folder changes');
 await js("smoke.focus('[data-composer-cwd]')");await frame();
 await press('Down');await press('Down');await press('Return');
 eq([await js("smoke.val('[data-composer-cwd]')"),(await st()).count],['C:/repos/r7',11],'arrows + Enter pick a suggestion without creating');
 await js("smoke.setInput('[data-composer-cwd]','C:/repos/')");await frame();
 ok(await js("smoke.has('[data-composer-suggestions]')"),'typing reopens the list');
 await press('Escape');
 ok((await st()).composer===true&&!(await js("smoke.has('[data-composer-suggestions]')")),'Esc with the list open closes only the list');
 await press('Escape');
 s=await st();
 ok(!s.flow&&!s.composer&&!(await js("smoke.has('[data-composer]')")),'a second Esc closes the composer',s);

 // --- Browse fills the folder; star persists the default agent ---------------
 await press('N',['control','shift']);await frame();
 await js("smoke.click('[data-composer-browse]')");await wait(100);
 eq([await js("smoke.val('[data-composer-cwd]')"),await js("smoke.val('[data-composer-name]')")],['D:/picked/proj','proj'],'Browse fills the folder and the name');
 await js("smoke.click('[data-composer-star=cx]')");await frame();
 eq([(await st()).auto.defaultAgentPresetId,await js("smoke.attr('[data-composer-star=cx]','aria-pressed')"),await js("smoke.attr('[data-composer-agent=cx]','aria-checked')")],['cx','true','true'],'the star saves settings.automation.defaultAgentPresetId and selects the agent');
 await press('Escape');await press('Escape');
 await press('N',['control','shift']);await frame();
 eq(await js("smoke.attr('[data-composer-agent=cx]','aria-checked')"),'true','the default agent is preselected next time');

 // --- E8-FR-09: Ctrl+Enter from the textarea; first prompt to the first agent -
 await js("smoke.setInput('[data-composer-cwd]','C:/repos/nuevo')");
 await js("smoke.click('[data-composer-grid=\\"2\\"]')");
 await js("smoke.setInput('[data-composer-prompt]','arregla el login')");
 await js("smoke.focus('[data-composer-prompt]')");
 await press('Return',['control']);await frame();
 s=await st();
 const made=await js('smoke.last()');
 eq([s.count,s.composer,s.flow,made.cwd,made.name,made.grid,made.presets],[12,false,false,'C:/repos/nuevo','nuevo',2,['cx','cx']],'Ctrl+Enter from the textarea creates the workspace with the grid and agent');
 eq(s.active,made.id,'the created workspace is active');
 eq(Object.keys(s.pending),[made.ids[0]],'the first prompt waits for the first agent console only');
 eq([s.pending[made.ids[0]].text,s.pending[made.ids[0]].enter,s.pending[made.ids[0]].source],['arregla el login',true,'composer'],'delivered with Enter through the composer source');

 // --- "Create another": the card stays, agent/grid/profile kept ---------------
 await js("smoke.set({connections:[{id:'c1',name:'Dedi',setup:[]}]})");
 await press('N',['control','shift']);await frame();
 ok(await js("smoke.has('[data-composer-profile]')"),'with profiles the Connection Profile select shows');
 await js("smoke.click('[data-composer-another] [role=switch]')");await frame();
 eq((await st()).auto.composerCreateAnother,true,'the switch persists settings.automation.composerCreateAnother');
 await js("smoke.click('[data-composer-agent=cl]')");await js("smoke.click('[data-composer-grid=\\"4\\"]')");
 await js("(()=>{const el=document.querySelector('[data-composer-profile]');el.value='c1';el.dispatchEvent(new Event('change',{bubbles:true}))})()");
 await js("smoke.setInput('[data-composer-cwd]','C:/repos/otro')");await js("smoke.setInput('[data-composer-prompt]','hola')");
 await js("smoke.click('[data-composer-primary]')");await frame();
 s=await st();
 const made2=await js('smoke.last()');
 eq([s.count,s.composer,made2.cwd,made2.grid,made2.presets,made2.setupId],[13,true,'C:/repos/otro',4,['cl','cl','cl','cl'],'c1'],'with Create another the workspace is created and the card stays open');
 eq([await js("smoke.val('[data-composer-cwd]')"),await js("smoke.val('[data-composer-name]')"),await js("smoke.val('[data-composer-prompt]')")],['','',''],'folder, name and first prompt are cleared');
 eq([await js("smoke.attr('[data-composer-agent=cl]','aria-checked')"),await js("smoke.attr('[data-composer-grid=\\"4\\"]','aria-checked')"),await js("smoke.val('[data-composer-profile]')"),await js('smoke.active()')],['true','true','c1','composer-cwd'],'agent, grid and profile are kept, focus back on the folder');
 eq(s.active,made2.id,'the created workspace is activated anyway');
 await press('Return',['control']);
 eq((await st()).count,13,'a quick second Ctrl+Enter (folder cleared) creates nothing');
 // Enter on the agent selector creates too.
 await js("smoke.setInput('[data-composer-cwd]','C:/repos/tres')");await js("smoke.focus('[data-composer-agent=cl]')");
 await press('Right');eq(await js('smoke.active()'),'sh','arrows move along the agent selector');
 ok(await js("smoke.attr('[data-composer-prompt]','disabled')!==null"),'a shell agent disables the first prompt');
 await press('Return');
 eq([(await st()).count,(await js('smoke.last()')).presets],[13+1,['sh','sh','sh','sh']],'Enter on the agent selector creates');
 await shot('composer-another');
 await js("smoke.click('[data-composer-another] [role=switch]')");await frame();

 // --- "Advanced..." hands the draft to the 3-step wizard ---------------------
 await js("smoke.setInput('[data-composer-cwd]','C:/repos/avanzado')");
 await js("smoke.click('[data-composer-agent=cx]')");await js("smoke.click('[data-composer-grid=\\"2\\"]')");
 await js("smoke.click('[data-composer-advanced]')");await frame();await frame();
 s=await st();
 ok(s.flow&&!s.composer&&await js("smoke.has('[data-wizard]')")&&!(await js("smoke.has('[data-composer]')")),'Advanced... swaps the card for the wizard',s);
 eq([await js("smoke.val('[data-wizard-cwd]')"),await js("[...document.querySelectorAll('[data-wizard] input')].map(i=>i.value)[1]")],['C:/repos/avanzado','avanzado'],'the wizard has the folder and name');
 await press('Return');await press('Return');
 eq(await js("[...document.querySelectorAll('[data-wizard] .flex.flex-wrap.items-center.gap-3')].length"),2,'the wizard grid is the composer grid (2 cells)');
 eq(await js("[...document.querySelectorAll('[data-wizard] .flex.flex-wrap.items-center.gap-3')].map(r=>r.querySelector('.border-accent-violet')?.textContent)"),['Codex','Codex'],'every cell carries the composer agent');
 await press('Escape');
 ok(!(await st()).flow,'Esc closes the wizard');
 await js("smoke.settings({automation:{defaultAgentPresetId:'',composerCreateAnother:false}})");

 // --- E8-FR-10: note and task state in the sidebar ---------------------------
 await js("smoke.set({activeWorkspaceId:'ws-note'})");await frame();
 eq(await js("smoke.text('[data-sidebar-ws=ws-note] [data-ws-note]')"),await js('smoke.LONG.slice(0,140)'),'the note replaces the console count on the second line');
 ok(!(await js("smoke.text('[data-sidebar-ws=ws-note] [data-ws-second-line]')")).includes('consolas'),'no console count with a note');
 ok((await js("smoke.text('[data-sidebar-ws=ws-doing] [data-ws-second-line]')")).includes('1 consola'),'without a note the count stays');
 ok(await js("smoke.overflow('[data-sidebar-ws=ws-note] [data-ws-note]')")&&!(await js("smoke.overflow('[data-sidebar]')")),'a 140-char note truncates inside the row, the sidebar never overflows');
 eq([await js("smoke.text('[data-sidebar-ws=ws-note] [data-task-chip]')"),await js("smoke.text('[data-sidebar-ws=ws-doing] [data-task-chip]')")],['En revisión','En curso'],'the state chip sits next to the name');
 ok(await js("smoke.attr('[data-sidebar-ws=ws-note] [data-task-chip]','class').includes('amber')")&&!(await js("smoke.attr('[data-sidebar-ws=ws-doing] [data-task-chip]','class').includes('amber')")),'review is amber, the others neutral');
 const chip=await js("smoke.rect('[data-sidebar-ws=ws-note] [data-task-chip]')"),side=await js("smoke.rect('[data-sidebar]')");
 ok(chip.x+chip.w<=side.x+side.w,'the chip stays inside the sidebar next to a long name',{chip,side});
 await shot('sidebar-notes');

 // Context menu -> popover.
 await js("smoke.ctx('ws-doing')");await frame();
 await js("smoke.menuItem('Nota y estado')");await frame();
 ok(await js("smoke.has('[data-note-popover=ws-doing]')")&&await js('smoke.active()')==='INPUT','"Nota y estado..." opens the popover with the note input focused');
 eq(await js("smoke.attr('[data-note-state=doing]','aria-checked')"),'true','it opens on the current state');
 w.webContents.insertText('x'.repeat(141));await frame();
 eq(await js("smoke.val('[data-note-input]').length"),140,'141 characters are not accepted');
 eq(await js("smoke.text('[data-note-count]')"),'140/140','the counter shows the limit');
 await js("smoke.setInput('[data-note-input]','esperando review del PR')");
 await js("smoke.click('[data-note-state=review]')");
 await js("smoke.click('[data-note-save]')");await frame();
 eq([await js("smoke.ws('ws-doing').note"),await js("smoke.ws('ws-doing').taskState"),await js("smoke.has('[data-note-popover]')")],['esperando review del PR','review',false],'Save stores note and state and closes');
 await js("smoke.ctx('ws-doing')");await frame();await js("smoke.menuItem('Nota y estado')");await frame();
 await press('Escape');
 ok(!(await js("smoke.has('[data-note-popover]')"))&&await js("smoke.ws('ws-doing').note")==='esperando review del PR','Esc cancels without changes');
 await js("smoke.ctx('ws-doing')");await frame();await js("smoke.menuItem('Nota y estado')");await frame();
 await js("smoke.setInput('[data-note-input]','linea uno')");await press('Return');
 eq(await js("smoke.ws('ws-doing').note"),'linea uno','Enter in the note saves');
 await js("smoke.ctx('ws-doing')");await frame();await js("smoke.menuItem('Nota y estado')");await frame();
 await js("smoke.click('[data-note-clear]')");await frame();
 eq([await js("'note' in smoke.ws('ws-doing')"),await js("'taskState' in smoke.ws('ws-doing')")],[false,false],'Remove clears note and state');

 // Double click on the second line edits inline (real clicks: the row click's console focus must not steal it).
 const line=await js("smoke.rect('[data-sidebar-ws=ws-note] [data-ws-second-line]')");
 await click(line.x+20,line.y+line.h/2,1);await click(line.x+20,line.y+line.h/2,2);await wait(120);
 ok(await js("smoke.has('[data-note-inline]')")&&await js("document.activeElement.hasAttribute('data-note-inline')"),'double click opens the inline editor and keeps the focus',await js('smoke.active()'));
 await js("smoke.setInput('[data-note-inline]','  nota   nueva ')");await press('Return');
 eq([await js("smoke.ws('ws-note').note"),await js("smoke.has('[data-note-inline]')")],['nota nueva',false],'Enter saves the inline note (normalized)');
 await click(line.x+20,line.y+line.h/2,1);await click(line.x+20,line.y+line.h/2,2);await wait(120);
 await js("smoke.setInput('[data-note-inline]','descartada')");await press('Escape');
 eq([await js("smoke.ws('ws-note').note"),await js("smoke.has('[data-note-inline]')")],['nota nueva',false],'Esc cancels the inline edit');

 // Collapsed: the tooltip carries state and note.
 await js("smoke.set({sidebarCollapsed:true})");await wait(300);
 ok(!(await js("smoke.has('[data-sidebar-ws=ws-note] [data-task-chip]')")),'no chip in the collapsed sidebar');
 await js("smoke.hover('[data-sidebar-ws=ws-note] button')");await wait(600);
 const tip=await js('smoke.tip()');
 ok(tip&&tip.includes('Front con un nombre')&&tip.includes('En revisión')&&tip.includes('nota nueva'),'the collapsed tooltip includes the note and the state',tip);
 await shot('collapsed-note-tip');
 await js("smoke.unhover('[data-sidebar-ws=ws-note] button')");

 if(failures.length)throw new Error(failures.join('\\n'));
 console.log('PASS: '+n+' composer / note / task state checks; screenshots '+__dirname);w.destroy();app.quit();
}).catch(e=>{console.error(e);app.exit(1)});
`)
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
const res = spawnSync(require('electron'), [path.join(dir, 'main.cjs')], { env, windowsHide: true, encoding: 'utf8', timeout: 180000 })
process.stdout.write(res.stdout ?? ''); if (res.status !== 0) process.stderr.write(res.stderr ?? '')
process.exitCode = res.status ?? 1
