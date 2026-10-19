// Settings search, deep links, shortcut chips and wizard focus (E4-FR-26..31):
// the production SettingsModal, Sidebar, wizard and dialogs in an isolated
// hidden Electron window. main is a fake: no update check, metrics, hooks or
// user config is touched. Requires npm run build (CSS).
const fs = require('node:fs'), os = require('node:os'), path = require('node:path')
const { pathToFileURL } = require('node:url')
const { spawnSync } = require('node:child_process')
const { buildSync } = require('esbuild')
const root = path.resolve(__dirname, '..'), dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snagentsos-settings-'))
const assets = path.join(root, 'out/renderer/assets')
const css = fs.readdirSync(assets).find(f => /^index-.*\.css$/.test(f))
if (!css) throw new Error('Run npm run build first')
buildSync({ stdin: { contents: `
import React, {useState} from 'react'; import {createRoot} from 'react-dom/client';
import {Sidebar} from './src/renderer/components/sidebar/Sidebar';
import {SettingsModal} from './src/renderer/components/settings/SettingsModal';
import {NewWorkspaceWizard} from './src/renderer/components/wizard/NewWorkspaceWizard';
import {WorkspaceComposer} from './src/renderer/components/wizard/WorkspaceComposer';
import {GlobalPromptDialog} from './src/renderer/components/workspace/GlobalPromptDialog';
import {ConfirmDialog} from './src/renderer/components/ui/ConfirmDialog';
import {I18nProvider} from './src/renderer/i18n';
import {useAppStore} from './src/renderer/lib/store';
import {applyTheme} from './src/renderer/themes/applyTheme';
import {dispatchOpenRequest} from './src/renderer/lib/openRequest';
const explorerArgs=[];const calls={};const spy=(name,ret)=>(...a)=>{calls[name]=(calls[name]||0)+1;return ret}
const noop=()=>()=>{};
const fallback=(base)=>new Proxy(base,{get:(t,k)=>k in t?t[k]:(typeof k==='string'?fallback(noop):undefined)});
window.snApi=fallback({platform:'win32',
 updates:fallback({check:spy('updates.check',Promise.resolve({available:false,currentVersion:'2.0.0'})),onProgress:noop}),
 system:fallback({getMetrics:spy('system.getMetrics',Promise.resolve(null)),getLoginItem:spy('system.getLoginItem',Promise.resolve(false)),openExternal(){},
  getExplorerMenu:spy('system.getExplorerMenu',Promise.resolve({ok:true,registered:true,exe:'D:/Portable/SnAgentsOS-portable.exe',currentExe:'C:/App/SnAgentsOS.exe',mismatch:true})),
  setExplorerMenu:(req)=>{explorerArgs.push(req);return Promise.resolve({ok:true,registered:!!req.enabled,exe:req.enabled?'C:/App/SnAgentsOS.exe':undefined,currentExe:'C:/App/SnAgentsOS.exe',mismatch:false})}}),
 status:fallback({health:spy('status.health',Promise.resolve({claude:{installed:false},codex:{enabled:false,available:true,connected:0},discord:{lastSuccessAt:null,error:null,queued:0}})),hooksStatus:spy('status.hooksStatus',Promise.resolve({installed:false,settingsPath:'x'})),testNtfy:spy('status.testNtfy',Promise.resolve({ok:true}))}),
 app:fallback({info:async()=>({version:'2.0.0',portable:false,platform:'win32'})}),
 remote:fallback({onStatus:noop,onDevices:noop,getStatus:async()=>({state:'stopped',connectedCount:0}),listDevices:async()=>[]}),
 pty:fallback({write(){}}),config:fallback({save(){}})});
const created=[];
useAppStore.setState({hydrated:true,activeWorkspaceId:'ws-0',workspaces:[{id:'ws-0',name:'Workspace 0',cwd:'C:/w',panes:[{id:'p0',type:'shell',title:'Console',icon:'terminal'}]}],connections:[{id:'c1',name:'Dedi',setup:[]}],createWorkspaceFull:(d)=>{created.push(d)}});
useAppStore.getState().updateSettings({language:'es'});
applyTheme('midnight');
let setConfirm=()=>{};let setAbove=()=>{};
function Root(){const lang=useAppStore(s=>s.settings.language);const [confirm,sc]=useState(false);setConfirm=sc;const [above,sa]=useState(false);setAbove=sa;
 return <I18nProvider lang={lang}><div style={{height:'100vh'}} className="flex bg-bg-primary text-text-primary"><Sidebar/>
 <main className="flex-1 p-6"><div className="xterm"><textarea id="term" className="xterm-helper-textarea" aria-label="term"/></div></main>
 {above&&<input id="above" aria-label="above" className="fixed left-2 top-2 z-[90] w-24"/>}
 <SettingsModal/><WorkspaceComposer/><NewWorkspaceWizard/><GlobalPromptDialog/>
 <ConfirmDialog open={confirm} title="Borrar" message="Seguro?" confirmLabel="Borrar" cancelLabel="Cancelar" onConfirm={()=>sc(false)} onCancel={()=>sc(false)}/></div></I18nProvider>}
createRoot(document.getElementById('root')).render(<Root/>);
// The console behind: a keydown that reaches its textarea counts as typed into the pty.
const termKeys=[];document.addEventListener('keydown',e=>{if(e.target&&e.target.id==='term')termKeys.push(e.key)});
// Every ring on/off with a timestamp: hidden windows throttle rAF, so the
// checks read this log instead of racing the 1200 ms timer.
const flashLog=[];new MutationObserver(ms=>ms.forEach(m=>flashLog.push({id:m.target.id,on:m.target.hasAttribute('data-setting-flash'),t:performance.now()}))).observe(document.body,{attributes:true,subtree:true,attributeFilter:['data-setting-flash']});
const setInput=(el,v)=>{const set=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;set.call(el,v);el.dispatchEvent(new Event('input',{bubbles:true}))};
window.smoke={calls,created,termKeys,explorerArgs,theme:applyTheme,
 open:(p,id)=>dispatchOpenRequest({id,path:p,source:'second-instance'}),
 explorerMenu:()=>useAppStore.getState().settings.explorerMenu,
 activeWs:()=>useAppStore.getState().activeWorkspaceId,
 flashed:id=>flashLog.some(f=>f.id===id&&f.on),
 flashMs:id=>{const on=flashLog.find(f=>f.id===id&&f.on),off=on&&flashLog.find(f=>f.id===id&&!f.on&&f.t>=on.t);return on&&off?Math.round(off.t-on.t):null},
 clearFlash:()=>{flashLog.length=0},
 state:()=>{const s=useAppStore.getState();return {open:s.settingsOpen,query:s.settingsQuery,anchor:s.settingsAnchor,wizard:s.wizardOpen,sound:s.settings.notifications.sound}},
 set:p=>useAppStore.setState(p),
 ntfy:()=>useAppStore.getState().settings.notifications.ntfy,
 settings:p=>useAppStore.getState().updateSettings(p),
 openSettings:t=>useAppStore.getState().openSettings(t),
 // The 3-step wizard is the composer's Advanced... (E8-FR-08).
 openWizard:p=>useAppStore.getState().openAdvancedWizard(p?{name:'',grid:1,presetId:'',setupId:'',...p}:null),
 confirm:v=>setConfirm(v),
 above:v=>setAbove(v),
 search:q=>setInput(document.querySelector('[data-settings-search]'),q),
 setInput:(sel,v)=>setInput(document.querySelector(sel),v),
 key:(key,opts={})=>document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key,bubbles:true,cancelable:true,...opts})),
 active:()=>{const a=document.activeElement;return {tag:a?.tagName,id:a?.id,inDialog:!!a?.closest('[role=dialog]'),search:a?.hasAttribute('data-settings-search'),cwd:a?.hasAttribute('data-wizard-cwd'),primary:a?.getAttribute('data-wizard-primary')}},
 step:()=>[...document.querySelectorAll('[data-wizard] .rounded-full')].findIndex(e=>/bg-accent-violet/.test(e.className)&&!e.querySelector('svg')),
 inView:sel=>{const el=document.querySelector(sel);if(!el)return false;const r=el.getBoundingClientRect(),box=el.closest('.overflow-y-auto').getBoundingClientRect();return r.top>=box.top-1&&r.bottom<=box.bottom+1},
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
const js=c=>w.webContents.executeJavaScript(c);const wait=ms=>new Promise(r=>setTimeout(r,ms));
 // A hidden window throttles rAF: React commits on a MessageChannel, so a short timer is enough.
 const frame=()=>wait(60);
 const shot=async name=>{await js('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');await wait(150);fs.writeFileSync(path.join(__dirname,name+'.png'),(await w.webContents.capturePage()).toPNG())};
 let n=0;const ok=(c,label,extra)=>{if(!c)throw new Error(label+(extra!==undefined?' '+JSON.stringify(extra):''));n++};
 const eq=(a,b,label)=>ok(JSON.stringify(a)===JSON.stringify(b),label,{got:a,want:b});
 const calls=async()=>js('({...smoke.calls})');
 // Trusted key events (keyDown, char, keyUp) so buttons get their native Enter activation.
 const press=async(keyCode,modifiers=[])=>{w.webContents.sendInputEvent({type:'keyDown',keyCode,modifiers});if(keyCode==='Return'||keyCode.length===1)w.webContents.sendInputEvent({type:'char',keyCode:keyCode==='Return'?String.fromCharCode(13):keyCode,modifiers});w.webContents.sendInputEvent({type:'keyUp',keyCode,modifiers});await frame()};
 w.webContents.focus();

 // --- FR-28: focus lands in the search on open ------------------------------
 await js('smoke.openSettings()');await frame();
 ok((await js('smoke.active()')).search,'opening settings focuses the search');
 const before=await calls();

 // --- FR-26: per-row results, <mark>, counts, empty state, no live section ---
 await js("smoke.search('sonido')");await frame();
 ok(await js("!!document.querySelector('[data-search-result=\\"notifications.sound\\"] mark')"),'"sonido" lists the row with the match in <mark>',await js("({state:smoke.state(),rows:[...document.querySelectorAll('[data-search-result]')].map(e=>e.outerHTML.slice(0,300))})"));
 eq(await js("[...document.querySelectorAll('[data-settings-nav]')].map(b=>[b.dataset.settingsNav,b.querySelector('[data-search-count]')?.textContent])"),[['notifications','2']],'the nav keeps only matching categories, with their count');
 await shot('search-sonido');
 for(const q of ['actualizar','rendimiento','notificaciones','inicio','modelos','discord']){await js('smoke.search('+JSON.stringify(q)+')');await frame()}
 await wait(300);
 const during=await calls();
 for(const k of ['updates.check','system.getMetrics','status.health','status.hooksStatus','system.getLoginItem'])eq(during[k]||0,before[k]||0,'searching never mounts a live section: '+k);
 await js("smoke.search('paleta')");await frame();
 ok(await js("!!document.querySelector('[data-search-result=\\"keys.palette\\"]')"),'"paleta" finds the Keys row');
 await js("smoke.search('despierta')");await frame();
 ok(await js("document.querySelector('[data-search-result=\\"agents.awake\\"]').textContent.includes('Comportamiento')"),'a Behavior row shows its block as a breadcrumb');
 await js("smoke.search('xyzzy')");await frame();
 eq(await js("document.querySelector('[data-search-empty]')?.textContent"),'Ning\\u00fan ajuste coincide con "xyzzy"','"xyzzy" shows the empty state');
 eq(await js("document.querySelectorAll('[data-settings-nav]').length"),0,'no category is listed without results');

 // Inline switch: toggles the setting and stays in search mode.
 await js("smoke.search('sonido')");await frame();
 const sound0=(await js('smoke.state()')).sound;
 await js("document.querySelector('[data-search-result=\\"notifications.sound\\"] [role=switch]').click()");await frame();
 ok((await js('smoke.state()')).sound===!sound0&&(await js('smoke.state()')).query==='sonido','the inline switch writes the setting without leaving the search');

 // --- FR-28: Esc clears, second Esc closes -----------------------------------
 await js("document.querySelector('[data-settings-search]').focus()");await press('Escape');
 eq([(await js('smoke.state()')).open,(await js('smoke.state()')).query],[true,''],'Esc with text clears the query and keeps settings open');
 await press('Escape');
 ok(!(await js('smoke.state()')).open,'Esc on an empty search closes settings');

 // --- FR-28 + FR-27: Enter jumps to the first result with the ring ------------
 await js('smoke.openSettings()');await frame();
 await js("smoke.search('volumen')");await frame();
 await press('Return');await frame();
 ok(await js("smoke.flashed('setting-notifications-sound')"),'Enter opens the first result and rings it',await js("({state:smoke.state(),active:smoke.active(),el:!!document.getElementById('setting-notifications-sound'),flash:[...document.querySelectorAll('[data-setting-flash]')].map(e=>e.id),results:[...document.querySelectorAll('[data-search-result]')].map(e=>e.dataset.searchResult)})"));
 ok(await js("smoke.inView('#setting-notifications-sound')"),'the row is scrolled into view');
 eq((await js('smoke.state()')).query,'','the jump clears the query');
 await js("smoke.set({settingsOpen:false})");await frame();

 // --- FR-27: deep link API ---------------------------------------------------
 await js("smoke.clearFlash();smoke.openSettings('updates#autoCheck')");await frame();await frame();
 ok(await js("smoke.inView('#setting-updates-autoCheck')&&smoke.flashed('setting-updates-autoCheck')"),"openSettings('updates#autoCheck') shows and rings the row",await js("({inView:smoke.inView('#setting-updates-autoCheck'),flashed:smoke.flashed('setting-updates-autoCheck'),state:smoke.state(),el:!!document.getElementById('setting-updates-autoCheck'),nav:document.querySelector('[data-settings-nav=updates]')?.className})"));
 await js("smoke.clearFlash();smoke.openSettings('notifications#sound')");await frame();await frame();
 ok(await js("smoke.inView('#setting-notifications-sound')&&smoke.flashed('setting-notifications-sound')"),"openSettings('notifications#sound') leaves the row visible with the ring");
 ok(await js("document.querySelectorAll('[data-setting-flash]').length<=1"),'only the target row carries the ring');
 eq(await js("(()=>{const el=document.querySelector('[data-setting-flash]');if(!el)return null;const cs=getComputedStyle(el);return [el.id,cs.outlineStyle,cs.outlineWidth]})()"),['setting-notifications-sound','solid','2px'],'the ring is a 2px accent outline');
 await shot('deeplink-sound');
 await wait(1400);
 const ms=await js("smoke.flashMs('setting-notifications-sound')");
 ok(ms!==null&&ms>=1100&&ms<=1500&&!(await js("document.querySelector('[data-setting-flash]')")),'the ring lasts about 1.2 s',ms);
 await js("smoke.openSettings('notifications#nope')");await frame();await frame();
 eq([(await js('smoke.state()')).anchor,await js("document.querySelector('[data-settings-nav=notifications]').className.includes('bg-card text')")],[null,true],'an unknown row just opens the category');
 // --- E2-FR-40/41 (R22-18): the ntfy block and the away toggle ----------------
 await js("smoke.openSettings('notifications#ntfy')");await frame();await frame();
 ok(await js("smoke.inView('#setting-notifications-ntfy')"),'the ntfy row is a deep-link target');
 await js("document.querySelector('[data-ntfy-generate]').click()");await frame();
 const ntfyTopic=(await js('smoke.ntfy()')).topic;
 ok(/^snaos-[0-9a-f]{16}$/.test(ntfyTopic)&&await js("document.getElementById('ntfy-topic').value")===ntfyTopic,'Generate proposes snaos-<16 hex> and fills the field',ntfyTopic);
 await js("document.querySelector('[data-ntfy-test]').click()");await frame();await frame();
 ok((await js('smoke.calls'))['status.testNtfy']===1&&await js("document.querySelector('[data-ntfy-result]')?.textContent")==='Aceptado por el servidor de ntfy.','Send test calls status:ntfyTest and reports Aceptado');
 ok(await js("!!document.getElementById('setting-notifications-onlyWhenAway')&&document.getElementById('setting-notifications-onlyWhenAway').textContent.includes('Solo cuando no estoy en la PC')"),'the global away toggle is in Notifications');
 await js("smoke.search('ausente')");await frame();
 ok(await js("!!document.querySelector('[data-search-result=\\"notifications.onlyWhenAway\\"]')"),'search "ausente" finds the away toggle');
 await js("smoke.search('ntfy')");await frame();
 ok(await js("!!document.querySelector('[data-search-result=\\"notifications.ntfy\\"]')"),'search "ntfy" finds the ntfy row');
 await js("smoke.search('')");await frame();
 await js("smoke.openSettings('keys#palette')");await frame();await frame();
 ok(await js("smoke.inView('#setting-keys-palette')"),'Keys rows are deep-link targets');
 await js("smoke.set({settingsOpen:false})");await frame();

 // --- FR-30: chips follow the keymap -----------------------------------------
 eq(await js("[document.querySelector('[data-sidebar-new] [data-key-hint]')?.dataset.keyHint,document.querySelector('[data-sidebar-new]').getAttribute('aria-keyshortcuts')]"),['Ctrl+Shift+N','Control+Shift+N'],'new workspace chip and aria-keyshortcuts');
 await js("smoke.settings({keymap:{newWorkspace:'Ctrl+Alt+N'}})");await frame();
 eq(await js("[document.querySelector('[data-sidebar-new] [data-key-hint]')?.dataset.keyHint,document.querySelector('[data-sidebar-new]').getAttribute('aria-keyshortcuts')]"),['Ctrl+Alt+N','Control+Alt+N'],'rebinding updates the chip without a restart');
 ok(await js("document.querySelector('[data-sidebar-settings] [data-key-hint]')?.dataset.keyHint==='Ctrl+,'"),'settings button chip');
 await js("smoke.set({sidebarCollapsed:true})");await wait(300);
 await js("document.querySelector('[data-sidebar-new]').dispatchEvent(new MouseEvent('mouseover',{bubbles:true}))");await wait(500);
 eq(await js("document.querySelector('[role=tooltip] [data-action-tip=newWorkspace] [data-key-hint]')?.dataset.keyHint"),'Ctrl+Alt+N','collapsed tooltip carries the chip');
 await shot('collapsed-tooltip');
 await js("document.querySelector('[data-sidebar-new]').dispatchEvent(new MouseEvent('mouseout',{bubbles:true}))");await js("smoke.set({sidebarCollapsed:false})");await wait(300);
 await js("smoke.settings({keymap:{}})");

 // --- FR-31 + FR-29: wizard focus, keys and chips -----------------------------
 await js("document.getElementById('term').focus()");
 await js('smoke.openWizard()');await frame();
 const a0=await js('smoke.active()');ok(a0.inDialog&&a0.cwd,'opening the wizard moves focus into the folder input',a0);
 ok(await js("document.querySelector('[data-wizard]').getAttribute('role')==='dialog'&&document.querySelector('[data-wizard]').getAttribute('aria-modal')==='true'"),'the wizard is an aria-modal dialog');
 ok(await js("!!document.querySelector('[data-wizard-primary=next] [data-key-hint=Enter]')&&document.querySelector('[data-wizard-primary=next]').getAttribute('aria-keyshortcuts')==='Enter'"),'Next carries the Enter chip');
 ok(await js("[...document.querySelectorAll('[data-wizard] button')].filter(b=>/Cancelar/.test(b.textContent)).every(b=>!b.querySelector('[data-key-hint]')&&!b.hasAttribute('aria-keyshortcuts'))"),'Cancel has no chip');
 ok(await js("!!document.querySelector('[data-wizard-ctrl-enter]')"),'step 0 shows the Ctrl+Enter text');
 await press('Return');await press('A');
 eq([await js('smoke.step()'),await js('smoke.termKeys.length')],[0,0],'Enter without a folder neither advances nor reaches the console');
 await js("document.getElementById('term').focus()");await press('B');
 const back=await js('smoke.active()');
 eq([await js('smoke.termKeys.length'),back.inDialog],[0,true],'a key aimed at the console behind is swallowed and focus returns inside');
 // An overlay opened above the wizard (phone pairing prompt, update modal) keeps its keyboard.
 await js('smoke.above(true)');await frame();await js("document.getElementById('above').focus()");await press('C');
 eq([await js("document.getElementById('above').value"),await js("document.activeElement.id")],['C','above'],'a key aimed at an overlay above the wizard is not swallowed');
 await js('smoke.above(false)');await frame();await js("document.querySelector('[data-wizard-cwd]').focus()");
 for(let i=0;i<14;i++)await press('Tab');
 ok((await js('smoke.active()')).inDialog,'Tab never leaves the dialog');
 for(let i=0;i<5;i++)await press('Tab',['shift']);
 ok((await js('smoke.active()')).inDialog,'Shift+Tab never leaves the dialog');
 await js("document.querySelector('[data-wizard-cwd]').focus()");await js("smoke.setInput('[data-wizard-cwd]','C:/repo')");await frame();
 await press('Return');eq(await js('smoke.step()'),1,'Enter with a folder advances');
 ok(await js("!!document.querySelector('[data-wizard-ctrl-enter]')"),'step 1 shows the Ctrl+Enter text');
 eq((await js('smoke.active()')).primary,'next','focus stays inside on the primary after the step change');
 await press('Return');eq(await js('smoke.step()'),2,'Enter on Next advances to the last step');
 ok(await js("!!document.querySelector('[data-wizard-primary=create] [data-key-hint=Enter]')&&!document.querySelector('[data-wizard-ctrl-enter]')"),'Create carries the chip and the last step drops the Ctrl+Enter text');
 await js("document.querySelector('[data-wizard] select').focus()");
 await js("smoke.key('Enter')");await frame();
 eq([(await js('smoke.state()')).wizard,await js('smoke.created.length'),await js('smoke.step()')],[true,0,2],'Enter in the StepAgents select neither advances nor creates');
 await js("document.querySelector('[data-wizard-primary]').focus()");await press('Return');
 eq([await js('smoke.created.length'),(await js('smoke.state()')).wizard,await js('smoke.termKeys.length')],[1,false,0],'Enter, Enter, Enter creates the workspace, nothing typed into the console');
 await js('smoke.openWizard()');await frame();
 await js("smoke.setInput('[data-wizard-cwd]','C:/other')");await press('Return',['control']);
 eq([await js('smoke.created.length'),await js('smoke.created[1].cwd'),await js('smoke.created[1].grid')],[2,'C:/other',1],'Ctrl+Enter from step 0 creates with the defaults');
 await js("smoke.openWizard({cwd:'C:/pre'})");await frame();
 eq((await js('smoke.active()')).primary,'next','a prefilled wizard focuses the primary');
 await press('Return');await press('Return');
 eq(await js('smoke.step()'),2,'with a prefill, two Enter reach step 2');
 await shot('wizard-last');
 await js("document.getElementById('term').focus()");await js("smoke.set({wizardOpen:false})");await frame();
 await js("document.querySelector('[data-sidebar-settings]').focus()");await js('smoke.openWizard()');await frame();await press('Escape');
 ok((await js('smoke.active()')).tag==='BUTTON'&&await js("document.activeElement.hasAttribute('data-sidebar-settings')"),'closing the wizard returns focus to the previous element');

 // --- FR-29: global prompt and confirm chips ----------------------------------
 await js("smoke.set({globalPromptOpen:true})");await frame();
 ok(await js("document.querySelector('[data-global-prompt-send]').getAttribute('aria-keyshortcuts')==='Control+Enter'&&document.querySelector('[data-global-prompt-send] [data-key-hint]').dataset.keyHint==='Ctrl+Enter'"),'"Enviar" shows Ctrl+Enter');
 await js("smoke.set({globalPromptOpen:false})");await frame();
 await js('smoke.confirm(true)');await frame();
 ok(await js("document.querySelector('[data-confirm] [data-key-hint]')?.dataset.keyHint==='Enter'&&document.querySelector('[data-confirm]').getAttribute('aria-keyshortcuts')==='Enter'"),'ConfirmDialog confirm shows Enter');
 ok(await js("[...document.querySelectorAll('button')].filter(b=>b.textContent==='Cancelar').every(b=>!b.querySelector('[data-key-hint]'))"),'ConfirmDialog cancel has no chip');
 await shot('confirm');
 await js('smoke.confirm(false)');await frame();

 // --- E4-FR-34: Explorer menu row (path, mismatch, toggle) ---------------------
 await js("smoke.clearFlash();smoke.openSettings('startup#explorerMenu')");await frame();await frame();
 ok(await js("smoke.inView('#setting-startup-explorerMenu')&&smoke.flashed('setting-startup-explorerMenu')"),"openSettings('startup#explorerMenu') shows and rings the row");
 ok(await js("(document.querySelector('[data-explorer-mismatch]')?.textContent||'').includes('D:/Portable/SnAgentsOS-portable.exe')&&!document.querySelector('[data-explorer-path]')"),'a key for another exe shows the amber mismatch, not the path');
 await js("document.querySelector('#setting-startup-explorerMenu [role=switch]').click()");await frame();await frame();
 eq([await js('smoke.explorerArgs'),await js('smoke.explorerMenu()')],[[{enabled:true,language:'es'}],true],'the toggle sends enabled + the UI language and persists the setting');
 ok(await js("(document.querySelector('[data-explorer-path]')?.textContent||'').includes('C:/App/SnAgentsOS.exe')&&!document.querySelector('[data-explorer-mismatch]')&&!document.querySelector('[data-explorer-error]')"),'after enabling, the registered path shows and the mismatch is gone');

 // --- E4-FR-33: "Open in" over Settings ---------------------------------------
 await js("smoke.open('D:/New/proj','open-1')");await frame();await frame();
 eq([(await js('smoke.state()')).open,(await js('smoke.state()')).wizard,await js("document.querySelector('[data-composer-cwd]')?.value"),await js("document.activeElement.hasAttribute('data-composer-primary')")],[false,true,'D:/New/proj',true],'a new folder closes Settings and opens the composer prefilled, focus on Create');
 ok(await js("document.querySelector('[data-composer-name]')?.value==='proj'"),'the name is the folder basename');
 await js("smoke.open('E:/Other','open-2')");await frame();
 eq(await js("document.querySelector('[data-composer-cwd]')?.value"),'D:/New/proj','another folder never overwrites the composer in progress');
 await js("smoke.set({wizardOpen:false})");await frame();
 await js("smoke.openSettings();smoke.set({activeWorkspaceId:null})");await frame();
 await js("smoke.open('c:/W/','open-3')");await frame();
 eq([await js('smoke.activeWs()'),(await js('smoke.state()')).open,(await js('smoke.state()')).wizard],['ws-0',false,false],'a folder that is a workspace (other case, trailing slash) activates it');

 // Light theme and zoom: the results list fits.
 await js("smoke.theme('light');smoke.openSettings()");await frame();await js("smoke.search('notif')");
 for(const scale of [1,1.25,1.5]){w.setSize(900,600);w.webContents.setZoomFactor(scale);await wait(200);ok(!(await js('document.documentElement.scrollWidth>innerWidth')),'no overflow at '+scale);if(scale===1.5)await shot('search-light-150')}
 if(failures.length)throw new Error(failures.join('\\n'));
 console.log('PASS: '+n+' settings search / deep link / key chip / wizard focus checks; screenshots '+__dirname);w.destroy();app.quit();
}).catch(e=>{console.error(e);app.exit(1)});
`)
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
const res = spawnSync(require('electron'), [path.join(dir, 'main.cjs')], { env, windowsHide: true, encoding: 'utf8', timeout: 180000 })
process.stdout.write(res.stdout ?? ''); if (res.status !== 0) process.stderr.write(res.stderr ?? '')
process.exitCode = res.status ?? 1
