// Quick Commands on the desktop (E8-FR-03..06): the production popover,
// Settings > Quick Commands, the palette rows and the global keys in an
// isolated hidden Electron window. main is a fake: pty.submit only records.
// Requires npm run build (CSS).
const fs = require('node:fs'), os = require('node:os'), path = require('node:path')
const { pathToFileURL } = require('node:url')
const { spawnSync } = require('node:child_process')
const { buildSync } = require('esbuild')
const root = path.resolve(__dirname, '..'), dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snagentsos-quick-ui-'))
const assets = path.join(root, 'out/renderer/assets')
const css = fs.existsSync(assets) && fs.readdirSync(assets).find(f => /^index-.*\.css$/.test(f))
if (!css) throw new Error('Run npm run build first')
buildSync({ stdin: { contents: `
import React from 'react'; import {createRoot} from 'react-dom/client';
import {SettingsModal} from './src/renderer/components/settings/SettingsModal';
import {CommandPalette} from './src/renderer/components/ui/CommandPalette';
import {QuickCommandPopover} from './src/renderer/components/workspace/QuickCommandPopover';
import {NotificationStack} from './src/renderer/components/ui/NotificationStack';
import {I18nProvider} from './src/renderer/i18n';
import {useAppStore} from './src/renderer/lib/store';
import {useGlobalKeys} from './src/renderer/lib/useGlobalKeys';
import {registerPty} from './src/renderer/lib/ptyRegistry';
import {registerFocuser, setFocusedPane} from './src/renderer/lib/focus';
import {applyTheme} from './src/renderer/themes/applyTheme';
const noop=()=>()=>{};
const fallback=(base)=>new Proxy(base,{get:(t,k)=>k in t?t[k]:(typeof k==='string'?fallback(noop):undefined)});
const submits=[];const focused=[];
window.snApi=fallback({platform:'win32',
 pty:fallback({write(){},submit:async(req)=>{submits.push(req);return {ok:true}}}),config:fallback({save(){}}),
 updates:fallback({check:async()=>({available:false,currentVersion:'2.0.0'}),onProgress:noop}),
 system:fallback({getMetrics:async()=>null,getLoginItem:async()=>false,getExplorerMenu:async()=>({ok:true,registered:false})}),
 status:fallback({health:async()=>({claude:{installed:false},codex:{enabled:false,available:true,connected:0},discord:{lastSuccessAt:null,error:null,queued:0}}),hooksStatus:async()=>({installed:false,settingsPath:'x'})}),
 app:fallback({info:async()=>({version:'2.0.0',portable:false,platform:'win32'})}),
 remote:fallback({onStatus:noop,onDevices:noop,getStatus:async()=>({state:'stopped',connectedCount:0}),listDevices:async()=>[]})});
const qc=(i,o={})=>({id:'qc-'+i,name:'Cmd '+i,text:'echo '+i,action:'send',enter:false,...o});
const commands=[qc('g1',{name:'Compilar'}),qc('w1',{workspaceId:'ws-0',name:'Tests del front'}),qc('g2',{name:'Deploy'}),qc('o1',{workspaceId:'ws-1',name:'Otro ws'}),qc('a1',{action:'agent',presetId:'preset-claude',text:'revisa el diff',enter:true,name:'Revisar'}),
 ...Array.from({length:8},(_,i)=>qc('x'+i,{name:'Extra '+i}))];
useAppStore.setState({hydrated:true,activeWorkspaceId:'ws-0',quickCommands:commands,
 workspaces:[{id:'ws-0',name:'Front',cwd:'C:/w',panes:[{id:'p1',type:'shell',title:'Console',color:'#fff',icon:'terminal'},{id:'p2',type:'shell',title:'Two',color:'#fff',icon:'terminal'}],layout:{grid:2,order:['p1','p2']}},
  {id:'ws-1',name:'Back',cwd:'C:/b',panes:[{id:'q1',type:'shell',title:'Back',color:'#fff',icon:'terminal'}]}]});
useAppStore.getState().updateSettings({language:'es'});
applyTheme('midnight');
registerPty('p1','pty-1');registerPty('p2','pty-2');
for(const id of ['p1','p2'])registerFocuser(id,()=>{focused.push(id);document.getElementById('term-'+id).focus()});
function Keys(){useGlobalKeys();return null}
function Root(){const lang=useAppStore(s=>s.settings.language);
 return <I18nProvider lang={lang}><Keys/><div style={{height:'100vh'}} className="flex gap-2 bg-bg-primary p-2 text-text-primary">
  <div data-pane-cell="p1" style={{width:300,height:400,marginLeft:500}} className="border border-border"><textarea id="term-p1" className="xterm-helper-textarea" aria-label="p1"/></div>
  <div data-pane-cell="p2" style={{width:200,height:400}} className="border border-border"><textarea id="term-p2" className="xterm-helper-textarea" aria-label="p2"/></div>
 </div><QuickCommandPopover/><CommandPalette/><SettingsModal/><NotificationStack/></I18nProvider>}
createRoot(document.getElementById('root')).render(<Root/>);
setFocusedPane('p1','ws-0');document.getElementById('term-p1')?.focus();
const setInput=(el,v)=>{const set=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;set.call(el,v);el.dispatchEvent(new Event('input',{bubbles:true}))};
const setArea=(el,v)=>{const set=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set;set.call(el,v);el.dispatchEvent(new Event('input',{bubbles:true}))};
window.smoke={submits,focused,
 focus:id=>{setFocusedPane(id,'ws-0');document.getElementById('term-'+id).focus()},
 state:()=>{const s=useAppStore.getState();return {popover:s.quickPopoverOpen,settings:s.settingsOpen,palette:s.paletteOpen,order:s.quickCommands.map(c=>c.id),panes:s.workspaces[0].panes.length,pending:Object.keys(s.pendingPrompts).length}},
 set:p=>useAppStore.setState(p),
 openSettings:t=>useAppStore.getState().openSettings(t),
 setInput:(sel,v)=>setInput(document.querySelector(sel),v),
 setArea:(sel,v)=>setArea(document.querySelector(sel),v),
 items:()=>[...document.querySelectorAll('[data-quick-item]')].map(b=>({id:b.dataset.quickItem,digit:b.querySelector('[data-quick-digit]')?.dataset.quickDigit??null})),
 groups:()=>[...document.querySelectorAll('[data-quick-group]')].map(g=>g.dataset.quickGroup+':'+g.querySelector('p').textContent),
 box:()=>{const d=document.querySelector('[data-quick-popover] [role=dialog]');if(!d)return null;const r=d.getBoundingClientRect();return {left:r.left,width:r.width,cx:r.left+r.width/2,top:r.top,maxH:Math.abs(parseFloat(getComputedStyle(d).maxHeight)-innerHeight*0.6)<=1}},
 cell:id=>{const r=document.querySelector('[data-pane-cell="'+id+'"]').getBoundingClientRect();return {cx:r.left+r.width/2,top:r.top}},
 active:()=>document.activeElement?.id||document.activeElement?.tagName,
 toasts:()=>[...document.querySelectorAll('[data-toast-id]')].map(t=>t.textContent),
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
 const press=async(keyCode,modifiers=[])=>{w.webContents.sendInputEvent({type:'keyDown',keyCode,modifiers});if(keyCode.length===1&&!modifiers.includes('control'))w.webContents.sendInputEvent({type:'char',keyCode,modifiers});w.webContents.sendInputEvent({type:'keyUp',keyCode,modifiers});await frame()};
 const type=async s=>{for(const ch of s)await press(ch)};
 const openQ=async()=>{await press('Q',['control','shift']);await frame()};
 w.webContents.focus();await js("smoke.focus('p1')");await frame();

 // --- FR-04: Ctrl+Shift+Q opens over the focused console -----------------------
 await openQ();
 ok((await js('smoke.state()')).popover,'Ctrl+Shift+Q opens the popover');
 const box=await js('smoke.box()'),cell=await js("smoke.cell('p1')");
 ok(box&&Math.abs(box.cx-cell.cx)<=1&&box.width===360&&box.maxH===true,'centered over the focused pane, 360 px wide, at most 60vh',{box,cell});
 eq(await js('smoke.groups()'),['workspace:Este workspace','global:Globales'],'"This workspace" comes before "Global"');
 const items=await js('smoke.items()');
 eq(items.map(i=>i.id).slice(0,4),['qc-w1','qc-g1','qc-g2','qc-a1'],'workspace commands first, then globals in Settings order; other workspaces left out');
 ok(!items.some(i=>i.id==='qc-o1')&&items.filter(i=>i.digit).length===9&&items[8].digit==='9'&&items[9].digit===null,'only the first 9 carry 1-9',items);
 await shot('quick-popover');
 await press('3');
 eq((await js('smoke.state()')).popover,false,'with the filter empty, 3 runs the third item and closes');
 await wait(100);
 const sub=(await js('smoke.submits')).at(-1);
 eq([sub.text,sub.ptyId,sub.enter],['echo g2','pty-1',false],'it went to the focused console through submit');
 ok((await js('smoke.focused')).includes('p1'),'the console gets the focus back after a send');

 // Filter: letters filter, then a digit is part of the filter.
 await openQ();await type('comp');
 eq((await js('smoke.items()')).map(i=>i.id),['qc-g1'],'"comp" filters by subsequence');
 const before=(await js('smoke.submits')).length;
 await press('1');
 eq([await js("document.querySelector('[data-quick-filter]').value"),(await js('smoke.submits')).length,(await js('smoke.state()')).popover],['comp1',before,true],'a later 1 becomes part of the filter, nothing runs');
 // Esc returns the focus to the pane.
 await js("smoke.focused.length=0");await press('Escape');await wait(80);
 eq([(await js('smoke.state()')).popover,await js('smoke.focused'),await js('smoke.active()')],[false,['p1'],'term-p1'],'Esc closes and gives the focus back to the console');
 // Arrows + Enter, agent: a new focused console with its prompt pending.
 await openQ();await press('Down');await press('Down');await press('Down');await press('Return');await wait(120);
 const st=await js('smoke.state()');
 eq([st.popover,st.panes,st.pending],[false,3,1],'arrows + Enter run the agent: a new console with its prompt pending');
 ok((await js('smoke.toasts()')).some(t=>t.includes('Abriendo Claude Code: Revisar')),'agent feedback toast',await js('smoke.toasts()'));

 // The shortcut toggles it closed and the console gets its focus back.
 await js("smoke.focus('p1')");await frame();await openQ();
 ok((await js('smoke.state()')).popover,'Ctrl+Shift+Q opens it again');
 await js("smoke.focused.length=0");await openQ();await wait(80);
 eq([(await js('smoke.state()')).popover,await js('smoke.focused'),await js('smoke.active()')],[false,['p1'],'term-p1'],'Ctrl+Shift+Q closes it and gives the focus back to the console');

 // Never over a modal.
 await js("smoke.openSettings('quick')");await frame();
 await openQ();
 eq((await js('smoke.state()')).popover,false,'with Settings open Ctrl+Shift+Q does nothing');

 // --- FR-03: Settings > Quick Commands -----------------------------------------
 ok(await js("[...document.querySelectorAll('[data-settings-nav]')].some(b=>b.dataset.settingsNav==='quick'&&b.textContent.includes('Quick Commands'))"),'the category is called Quick Commands');
 eq(await js("[...document.querySelectorAll('[data-quick-row]')].map(r=>r.querySelector('[data-quick-scope]').textContent).slice(0,4)"),['Global','Front','Global','Back'],'each row shows its scope badge');
 await js("document.querySelector('[data-quick-row=\\"qc-g2\\"] [aria-label=Subir]').click()");await frame();
 eq((await js('smoke.state()')).order.slice(0,3),['qc-g1','qc-g2','qc-w1'],'move up reorders the list');
 await js("document.querySelector('[data-quick-new]').click()");await frame();
 ok(await js("document.querySelector('[data-quick-save]').disabled"),'Save is disabled with the label and text empty');
 await js("smoke.setInput('[data-quick-name]','Hola')");await frame();
 ok(await js("document.querySelector('[data-quick-save]').disabled"),'still disabled without text');
 await js("smoke.setArea('[data-quick-text]','echo hola')");await frame();
 ok(!(await js("document.querySelector('[data-quick-save]').disabled")),'enabled with label and text');
 await js("document.querySelector('[data-quick-action=\\"agent\\"]').click()");await frame();
 eq(await js("document.querySelector('[data-quick-preset]')?.value"),'preset-claude','agent defaults to the first claude preset');
 ok(!(await js("!!document.querySelector('[data-quick-enter]')")),'an agent has no Enter checkbox');
 await shot('quick-editor');
 await js("document.querySelector('[data-quick-save]').click()");await frame();
 ok((await js('smoke.state()')).order.length===14,'saved');
 // Search "snippet" finds the category.
 await js("smoke.setInput('[data-settings-search]','snippet')");await frame();
 ok(await js("!!document.querySelector('[data-search-result=\\"quick.list\\"]')"),'searching "snippet" finds Quick Commands');
 await js("smoke.set({settingsOpen:false})");await frame();
 // The reorder shows in the popover numbering.
 await js("smoke.focus('p1')");await openQ();
 eq((await js('smoke.items()')).slice(0,3).map(i=>i.id+':'+i.digit),['qc-w1:1','qc-g1:2','qc-g2:3'],'the Settings order drives the popover numbers');
 await press('Escape');

 // --- FR-06: palette rows ---------------------------------------------------
 await press('K',['control']);await frame();
 const rows=await js("[...document.querySelectorAll('[data-palette-cmd^=qc-]')].map(b=>b.textContent)");
 ok(rows.some(r=>r.includes('Ejecutar: Tests del front'))&&rows.some(r=>r.includes('Ejecutar: Compilar'))&&!rows.some(r=>r.includes('Otro ws'))&&rows.every(r=>r.includes('Quick Command')),'Ctrl+K lists "Run: <label>" for globals and this workspace only',rows);
 await js("document.querySelector('[data-palette-cmd=\\"qc-qc-g1\\"]').click()");await wait(100);
 eq((await js('smoke.submits')).at(-1).text,'echo g1','a palette row runs like the popover');

 // --- Empty state -------------------------------------------------------------
 await js("smoke.set({quickCommands:[],paletteOpen:false})");await js("smoke.focus('p1')");await openQ();
 ok(await js("document.querySelector('[data-quick-empty]').textContent.includes('No hay Quick Commands')"),'empty popover says so');
 await js("document.querySelector('[data-quick-create]').click()");await frame();await frame();
 eq([(await js('smoke.state()')).settings,await js("document.querySelector('[data-quick-scope-select]')?.value")],[true,'ws-0'],'"Create" opens the editor scoped to the active workspace');
 await js("smoke.set({settingsOpen:false})");
 // Light theme, zoom.
 await js("smoke.set({quickCommands:["+JSON.stringify({id:'qc-z',name:'Uno largo largo largo largo largo largo largo largo largo',text:'x'.repeat(400),action:'send',enter:false})+"]})");
 await js("smoke.focus('p2')");await openQ();
 for(const scale of [1,1.5]){w.webContents.setZoomFactor(scale);await js('smoke.set({quickPopoverOpen:false})');await frame();await openQ();const b=await js('({...smoke.box(),vw:innerWidth})');ok(b&&b.left>=8&&b.left+b.width<=b.vw-8,'the popover stays inside the window at '+scale,b);ok(await js("(()=>{const d=document.querySelector('[data-quick-item]');return d.scrollWidth<=d.clientWidth+1})()"),'a long label truncates inside its row at '+scale)}
 await shot('quick-popover-150');
 if(failures.length)throw new Error(failures.join('\\n'));
 console.log('PASS: '+n+' Quick Commands UI checks (popover, Settings, palette); screenshots '+__dirname);w.destroy();app.quit();
}).catch(e=>{console.error(e);app.exit(1)});
`)
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
const res = spawnSync(require('electron'), [path.join(dir, 'main.cjs')], { env, windowsHide: true, encoding: 'utf8', timeout: 120000 })
process.stdout.write(res.stdout ?? ''); if (res.status !== 0) process.stderr.write(res.stderr ?? '')
process.exitCode = res.status ?? 1
