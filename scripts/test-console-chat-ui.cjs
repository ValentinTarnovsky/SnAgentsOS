// Desktop console chat (app 2.7.0, A7; Labs consoleChat) rendered from the
// production PaneCell + xterm + ConsoleChatView in an isolated hidden Electron
// window. main is a fake: window.snApi.chat answers sub / more from a table and
// hands the frame callback to the test, pty.submit records its requests, so no
// pty, ChatHub, transcript, user config or real agent is touched. Checks: the
// Terminal | Chat switch is gone with the lab off and shows with it on, only on
// agent consoles; Chat hides the xterm without unmounting it (same element, no
// new spawn, no kill) and reads the chat (chat:sub); rows render from the stubbed
// page with a phase row; Load earlier pages older rows (chat:more); frames
// append and reset; the composer's Enter is a new line, Insert types the text
// with no Enter and only Send adds one (both gated while the agent waits on the
// user); an enter_held send empties the composer (the text is typed already) and
// its note outlives the menu and a trip to the terminal (not a restart), and a later empty Send
// only presses Enter; a late first page and a notice explain themselves; the choice persists
// per pane across a re-render and leaving the chat unsubscribes; a focus request
// for a console on its Chat reaches its composer and the draft outlives a switch
// to the terminal; the remappable toggleConsoleChat (no default: Settings > Keys
// says "Sin asignar", the palette shows no chip) toggles the focused agent
// console with a recorded chord and does nothing with the lab off, on a shell or
// under a modal (the plan modal, a pane's schedule dialog), letting the key
// through, but swallowed while the shared view is on top; the
// palette command does the same; ChatHub's paused
// notice keeps the list under "Este chat se pausó..." and only [Reanudar]
// subscribes again; a `disabled` refusal sends the config at once and asks once
// more, and the lab turning on asks again; an `unknown_pane` refusal sends the
// config and asks once more, then offers [Reintentar], and one with no pty asks
// once more when its pty registers (never a loop); no console errors, no
// horizontal overflow. Requires npm run build (CSS).
const fs = require('node:fs'), os = require('node:os'), path = require('node:path')
const { pathToFileURL } = require('node:url')
const { spawnSync } = require('node:child_process')
const { buildSync } = require('esbuild')
const root = path.resolve(__dirname, '..'), dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snagentsos-console-chat-ui-'))
const assets = path.join(root, 'out/renderer/assets')
const css = fs.existsSync(assets) && fs.readdirSync(assets).find(f => /^index-.*\.css$/.test(f))
if (!css) throw new Error('Run npm run build first')
buildSync({ stdin: { contents: `
import React from 'react'; import {createRoot} from 'react-dom/client';
import {PaneCell} from './src/renderer/components/layout/PaneCell';
import {I18nProvider} from './src/renderer/i18n';
import {useAppStore} from './src/renderer/lib/store';
import {useConsoleChatStore,openConsoleChat} from './src/renderer/lib/consoleChatStore';
import {isBracketedPaste} from './src/renderer/lib/pasteRegistry';
import {focusPane,getFocusedPane} from './src/renderer/lib/focus';
import {useGlobalKeys} from './src/renderer/lib/useGlobalKeys';
import {KEY_ACTIONS} from './src/renderer/lib/keymap';
import {CommandPalette} from './src/renderer/components/ui/CommandPalette';
import {KeymapSection} from './src/renderer/components/settings/sections/KeymapSection';
import {registerPty,unregisterPty} from './src/renderer/lib/ptyRegistry';
import {useShareGuestStore,sharedOverlayActive} from './src/renderer/lib/shareGuestStore';
import {applyTheme} from './src/renderer/themes/applyTheme';
import {PlanModal} from './src/renderer/components/status/PlanModal';
import {usePlanModal,closePlan} from './src/renderer/lib/planModal';
const writes=[],subs=[],calls={sub:[],unsub:[],more:[],submit:[],spawn:[],kill:[],open:[],save:[]};
let frameCb=null;
const msg=(id,role,blocks)=>({id,role,ts:null,blocks});
const PAGE={type:'chatPage',paneId:'pa',cursor:'200',done:false,items:[
 msg('200','user',[{t:'text',text:'arreglá el build'}]),
 msg('210','assistant',[{t:'text',text:'Busco primero. Ver [la guía](https://docs.example.com/x).'}]),
 msg('220','assistant',[{t:'toolUse',id:'u1',name:'Grep',summary:'TODO'}]),
 msg('230','tool',[{t:'toolResult',toolUseId:'u1',isError:false,text:'a.ts:1'}]),
 msg('240','assistant',[{t:'toolUse',id:'u2',name:'Glob',summary:'src/**/*.ts'}]),
 msg('250','tool',[{t:'toolResult',toolUseId:'u2',isError:false,text:'a.ts'}]),
 msg('260','assistant',[{t:'text',text:'Listo, el build pasa.'}]),
]};
const OLDER={type:'chatPage',paneId:'pa',cursor:null,done:true,items:[msg('100','user',[{t:'text',text:'prompt viejo'}])]};
const fakes={
 sub:(r)=>r.paneId==='pa'?{ok:true,page:PAGE}:{ok:false,error:'timeout'},
 more:()=>({ok:true,page:OLDER}),
 submit:()=>({ok:true}),
};
const noop=()=>()=>{};
const fallback=(base)=>new Proxy(base,{get:(t,k)=>k in t?t[k]:(typeof k==='string'?fallback(noop):undefined)});
window.snApi=fallback({platform:'win32',
 pty:fallback({reattach:async()=>null,spawn:async r=>{calls.spawn.push(r.paneId);return {ptyId:'pty-'+r.paneId}},onData:cb=>{subs.push(cb);return()=>{}},onExit:noop,
  write:w=>writes.push(w),resize(){},flow(){},kill:async id=>{calls.kill.push(id)},killPanes:async ids=>{calls.kill.push(...ids);return 0},
  submit:async r=>{calls.submit.push(r);return fakes.submit(r)}}),
 chat:{sub:async r=>{calls.sub.push(r);return fakes.sub(r)},unsub:r=>{calls.unsub.push(r)},more:async r=>{calls.more.push(r);return fakes.more(r)},
  onFrame:cb=>{frameCb=cb;return()=>{if(frameCb===cb)frameCb=null}}},
 system:fallback({onDisplayRecovered:noop,openExternal:u=>{calls.open.push(u)}}),
 status:fallback({reportTitle(){}}),clipboard:fallback({readText:async()=>'',writeText(){}}),config:fallback({save:c=>{calls.save.push(c?.settings?.labs?.consoleChat===true)}})});
const ws={id:'w1',name:'Chat',cwd:'',panes:[{id:'pa',type:'claude',title:'Claude',icon:'claude'},{id:'pb',type:'claude',title:'Backend',icon:'claude'},{id:'ps',type:'shell',title:'Shell',icon:'terminal'}]};
const s0=useAppStore.getState();
useAppStore.setState({hydrated:true,activeWorkspaceId:'w1',workspaces:[ws],settings:{...s0.settings,language:'es',labs:{consoleChat:false,teams:false}}});
applyTheme('midnight');
const noopFn=()=>{};
function Keys(){useGlobalKeys();return null}
function Grid(){const w=useAppStore(s=>s.workspaces[0]);return <div style={{height:'100vh',display:'grid',gridTemplateColumns:'1fr 1fr 1fr',gap:6,padding:6}} className="bg-bg-primary text-text-primary">
 {w.panes.map((p,i)=><PaneCell key={p.id} workspace={w} pane={p} presets={[]} workspaceActive maximizedId={null} minimizedIds={[]} index={i} isDragging={false} draggable onToggleMax={noopFn} onToggleMin={noopFn} onClose={noopFn} onDragStartCell={noopFn} onDragEndCell={noopFn}/>)}
 <Keys/><CommandPalette/><PlanModal/><div data-test-keymap style={{display:'none'}}><KeymapSection/></div>
</div>}
let reactRoot=createRoot(document.getElementById('root'));
const render=()=>reactRoot.render(<I18nProvider lang="es"><Grid/></I18nProvider>);
render();
const cell=id=>document.querySelector('[data-pane-cell="'+id+'"]');
const marks={};
let heldMore=null;
window.smoke={calls,writes,fakes,PAGE,msg,
 ready:()=>['pa','pb','ps'].every(id=>isBracketedPaste(id)!==null),
 lab:on=>{const s=useAppStore.getState();useAppStore.setState({settings:{...s.settings,labs:{...s.settings.labs,consoleChat:on}}})},
 toggle:id=>{const g=cell(id)?.querySelector('[data-pane-view-toggle]');return g?{view:g.getAttribute('data-pane-view-toggle'),checked:[...g.querySelectorAll('[role=radio]')].map(b=>b.getAttribute('data-view-option')+':'+b.getAttribute('aria-checked'))}:null},
 pick:(id,view)=>{const b=cell(id)?.querySelector('[data-view-option="'+view+'"]');if(b)b.click();return !!b},
 mark:id=>{const c=cell(id);marks[id]={x:c.querySelector('.xterm'),ta:c.querySelector('.xterm-helper-textarea')};return !!marks[id].x&&!!marks[id].ta},
 sameXterm:id=>{const m=marks[id],c=cell(id);return !!m&&m.x.isConnected&&c.querySelector('.xterm')===m.x&&c.querySelector('.xterm-helper-textarea')===m.ta},
 termShown:id=>{const w=cell(id)?.querySelector('[data-pane-terminal]');return !!w&&getComputedStyle(w).display!=='none'&&w.offsetHeight>0},
 chat:id=>!!cell(id)?.querySelector('[data-console-chat]'),
 signalsShown:id=>{const e=cell(id)?.querySelector('[data-console-chat-signals]');return !!e&&getComputedStyle(e).display!=='none'},
 text:sel=>document.querySelector(sel)?.textContent||'',
 count:sel=>document.querySelectorAll(sel).length,
 has:sel=>!!document.querySelector(sel),
 click:sel=>{const e=document.querySelector(sel);if(e)e.click();return !!e},
 frame:(paneId,frame)=>{if(!frameCb)return false;frameCb({paneId,frame});return true},
 emit:(ptyId,data)=>subs.forEach(cb=>cb({ptyId,data})),
 draft:(id,v)=>{const ta=cell(id).querySelector('[data-chat-composer]');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(ta,v);ta.dispatchEvent(new Event('input',{bubbles:true}));return true},
 composer:id=>{const c=cell(id),ta=c?.querySelector('[data-chat-composer]');if(!ta)return null;const n=c.querySelector('[data-chat-composer-note]');return {value:ta.value,insert:c.querySelector('[data-chat-insert]').disabled,send:c.querySelector('[data-chat-send]').disabled,note:n.getAttribute('data-chat-composer-note'),noteText:n.textContent}},
 focusComposer:id=>{cell(id).querySelector('[data-chat-composer]').focus();return !!document.activeElement?.hasAttribute('data-chat-composer')},
 status:(paneId,extra)=>useAppStore.getState().setPaneStatus({paneId,state:'working',precise:true,notify:false,provider:'claude',...extra}),
 stored:id=>{try{return localStorage.getItem('snagentsos.paneView.'+id)}catch{return 'error'}},
 remount:()=>{reactRoot.unmount();useConsoleChatStore.setState({views:{}});reactRoot=createRoot(document.getElementById('root'));render();return true},
 chats:()=>Object.keys(useConsoleChatStore.getState().chats),
 holdMore:()=>{fakes.more=()=>new Promise(r=>{heldMore=()=>r({ok:true,page:OLDER})});return true},
 releaseMore:()=>{const go=heldMore;heldMore=null;fakes.more=()=>({ok:true,page:OLDER});if(go)go();return !!go},
 rowIds:paneId=>[...document.querySelectorAll('[data-console-chat="'+paneId+'"] [data-chat-row]')].map(e=>e.getAttribute('data-chat-id')),
 overflow:()=>{if(document.documentElement.scrollWidth>innerWidth)return 'page';for(const el of document.querySelectorAll('[data-chat-scroll]'))if(el.scrollWidth>el.clientWidth+1)return 'chat';return ''},
 active:()=>{const a=document.activeElement;return {cell:a?.closest('[data-pane-cell]')?.getAttribute('data-pane-cell')||'',xterm:!!a?.classList.contains('xterm-helper-textarea'),composer:!!a?.hasAttribute('data-chat-composer'),focused:getFocusedPane()}},
 focusXterm:id=>{cell(id).querySelector('.xterm-helper-textarea').focus();return true},
 focusPane:id=>{focusPane(id);return true},
 keyDefault:()=>KEY_ACTIONS.find(a=>a.id==='toggleConsoleChat')?.defaultAccel,
 bind:accel=>{const s=useAppStore.getState();const keymap={...s.settings.keymap};if(accel)keymap.toggleConsoleChat=accel;else delete keymap.toggleConsoleChat;useAppStore.setState({settings:{...s.settings,keymap}});return true},
 keyRow:()=>{const r=document.querySelector('[data-test-keymap] [data-setting-id="keys.toggleConsoleChat"]');return r?{text:r.textContent,unset:!!r.querySelector('[data-keys-unset]')}:null},
 conflicts:()=>[...document.querySelectorAll('[data-test-keymap] [data-setting-id]')].filter(r=>/conflicto/.test(r.textContent)).length,
 // A key event no other handler sees: was it consumed by the global keymap?
 synthKey:()=>{const ev=new KeyboardEvent('keydown',{key:'Y',code:'KeyY',ctrlKey:true,shiftKey:true,bubbles:true,cancelable:true});document.body.dispatchEvent(ev);return ev.defaultPrevented},
 dropStatus:id=>{useAppStore.setState(s=>{const ps={...s.paneStatus};delete ps[id];return {paneStatus:ps}});return true},
 palette:on=>{useAppStore.getState().setPaletteOpen(on);return true},
 paletteCmd:()=>{const b=document.querySelector('[data-palette-cmd="toggle-console-chat"]');return b?{text:b.textContent,kbd:b.querySelector('kbd')?.textContent??null}:null},
 openChat:id=>{smoke['close_'+id]=openConsoleChat(id);return true},
 closeChat:id=>{smoke['close_'+id]?.();return true},
 chatState:id=>{const c=useConsoleChatStore.getState().chats[id];return c?{refused:c.refused,paused:c.paused,rows:c.list.items.length,loading:c.loading}:null},
 reg:(id,ptyId)=>{registerPty(id,ptyId);return true},
 unreg:id=>{unregisterPty(id);return true},
 // The shared view of a joined share on top of the grid (no guard runs here: only the keymap reads it).
 // A6's plan modal (its own store) and a dialog a pane holds in its own state (the pane menu's "Programar prompt").
 plan:on=>{if(on)usePlanModal.setState({view:{paneId:'pb',place:'Chat / Backend',summary:'Plan',plan:{requestId:'r1',text:'# Plan\\n\\nPaso uno',at:0,truncated:false}}});else closePlan(false);return true},
 planOpen:()=>!!document.querySelector('[data-plan-modal]'),
 menuPick:async(id,label)=>{const h=cell(id).querySelector('header');const r=h.getBoundingClientRect();h.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:r.left+40,clientY:r.top+10}));await new Promise(r=>setTimeout(r,120));const b=[...document.querySelectorAll('[role=menu] [role=menuitem]')].find(e=>e.textContent===label);if(b)b.click();await new Promise(r=>setTimeout(r,120));return !!b},
 escape:()=>{window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));return true},
 overlay:on=>{useShareGuestStore.setState(on?{links:{l1:{id:'l1',hostLabel:'Host',hostFingerprint:'AB12-CD34-EF56-7890',scope:{kind:'workspace',label:'W'},permHint:'view',addedAt:0,persisted:false}},activeLinkId:'l1'}:{links:{},activeLinkId:null});return sharedOverlayActive()},
};
const smoke=window.smoke;
`, resolveDir: root, loader: 'tsx' }, bundle: true, platform: 'browser', format: 'iife', outfile: path.join(dir, 'renderer.js'), alias: { '@shared': path.join(root, 'src/shared'), '@': path.join(root, 'src/renderer') }, jsx: 'automatic', loader: { '.css': 'empty' }, define: { 'process.env.NODE_ENV': '"production"' } })
fs.writeFileSync(path.join(dir, 'index.html'), `<html><head><meta charset="utf-8"><link rel="stylesheet" href="${pathToFileURL(path.join(assets, css))}"></head><body><div id="root"></div><script src="renderer.js"></script></body></html>`)
fs.writeFileSync(path.join(dir, 'main.cjs'), `
const {app,BrowserWindow}=require('electron');const fs=require('fs'),path=require('path');
app.setPath('userData',path.join(__dirname,'profile'));
app.whenReady().then(async()=>{
 const w=new BrowserWindow({width:1300,height:720,show:false,webPreferences:{sandbox:true,backgroundThrottling:false}});
 const failures=[];w.webContents.on('console-message',(_e,level,message)=>{if(process.env.SN_UI_DEBUG)console.log('[renderer]',level,message);if(level>=3)failures.push(message)});
 await w.loadFile(path.join(__dirname,'index.html'));
 const js=c=>w.webContents.executeJavaScript(c);const wait=ms=>new Promise(r=>setTimeout(r,ms));
 const frame=()=>js('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
 const settle=async(ms=150)=>{await frame();await wait(ms)};
 const shot=async name=>{await frame();await wait(150);fs.writeFileSync(path.join(__dirname,name+'.png'),(await w.webContents.capturePage()).toPNG())};
 let n=0;const ok=(c,label,extra)=>{if(!c)throw new Error(label+(extra!==undefined?' '+JSON.stringify(extra):''));n++};
 const eq=(a,b,label)=>ok(JSON.stringify(a)===JSON.stringify(b),label,{got:a,want:b});
 const press=async keyCode=>{w.webContents.sendInputEvent({type:'keyDown',keyCode});w.webContents.sendInputEvent({type:'char',keyCode:keyCode==='Return'?String.fromCharCode(13):keyCode});w.webContents.sendInputEvent({type:'keyUp',keyCode});await frame()};
 // The chord the user records for toggleConsoleChat (it has no default).
 const chord=async()=>{const modifiers=['control','shift'];w.webContents.sendInputEvent({type:'keyDown',keyCode:'Y',modifiers});w.webContents.sendInputEvent({type:'keyUp',keyCode:'Y',modifiers});await frame()};
 const waitReady=async()=>{for(let i=0;i<60&&!(await js('smoke.ready()'));i++)await wait(100);ok(await js('smoke.ready()'),'the three terminals mounted and registered their paster')};
 w.webContents.focus();
 await waitReady();
 eq(await js('smoke.calls.spawn.slice().sort()'),['pa','pb','ps'],'one spawn per console');

 // --- Lab off: no switch, the terminal ---------------------------------------
 eq(await js("smoke.count('[data-pane-view-toggle]')"),0,'with the lab off no console has the Terminal | Chat switch');
 ok((await js("smoke.termShown('pa')"))&&!(await js("smoke.chat('pa')")),'with the lab off the agent console shows its terminal');

 // --- Lab on: the switch, only on agent consoles -----------------------------
 await js('smoke.lab(true)');await settle();
 eq(await js("smoke.toggle('pa')"),{view:'terminal',checked:['terminal:true','chat:false']},'with the lab on an agent console has the switch, on Terminal');
 ok(!!(await js("smoke.toggle('pb')")),'every agent console has it');
 eq(await js("smoke.toggle('ps')"),null,'a shell console with no agent has no switch');
 await js("smoke.status('ps',{})");await settle();
 ok(!!(await js("smoke.toggle('ps')")),'a shell whose status names its agent gets the switch');
 eq(await js('smoke.calls.sub'),[],'nothing is read before a chat shows');
 await shot('lab-on-terminal');

 // --- Chat: the xterm only hides, the chat is read ----------------------------
 await js("smoke.emit('pty-pa','hola terminal')");await settle();
 ok(await js("smoke.mark('pa')"),'the agent console has its xterm');
 const writes0=await js('smoke.writes.length');
 ok(await js("smoke.pick('pa','chat')"),'the Chat option is clickable');await settle(250);
 ok(await js("smoke.chat('pa')"),'Chat shows the console chat');
 ok(!(await js("smoke.termShown('pa')"))&&(await js("smoke.sameXterm('pa')")),'the xterm stays mounted (the same element), only hidden');
 eq(await js("smoke.toggle('pa').checked"),['terminal:false','chat:true'],'the switch reads Chat');
 eq(await js('smoke.calls.sub'),[{paneId:'pa'}],'showing the chat subscribes it (chat:sub)');
 eq(await js('smoke.calls.spawn.length'),3,'no console spawned again');
 eq(await js('smoke.calls.kill'),[],'no pty was killed');
 eq(await js("smoke.stored('pa')"),'chat','the choice is saved for this pane');
 eq(await js("smoke.stored('pb')"),null,'the other console keeps no choice');
 ok((await js('smoke.active()')).composer,'the keyboard goes to the composer',await js('smoke.active()'));

 // --- Rows from the stubbed page, a phase row included -------------------------
 let v=await js("({rows:smoke.count('[data-console-chat=pa] [data-chat-row]'),user:smoke.text('[data-console-chat=pa] [data-chat-user]'),phases:smoke.count('[data-console-chat=pa] [data-tool-phase]'),phase:smoke.text('[data-console-chat=pa] [data-tool-phase=search] [data-phase-label]'),link:document.querySelector('[data-console-chat=pa] [data-md-link]')?.tagName,anchors:smoke.count('[data-console-chat] a'),earlier:smoke.has('[data-console-chat=pa] [data-chat-load-earlier]')})");
 ok(v.rows===3&&v.user.includes('arreglá el build'),'the first page renders its messages',v);
 ok(v.phases===1&&v.phase==='Búsqueda 2','the Grep and the Glob fold into one search phase',v);
 ok(v.link==='BUTTON'&&v.anchors===0,'links are buttons, never anchors',v);
 ok(v.earlier,'a page with more before it offers Load earlier',v);
 ok(!(await js("smoke.signalsShown('pa')")),'with no status chip the bar on top takes no room');
 eq(await js('smoke.overflow()'),'','the chat has no horizontal overflow');
 await js("smoke.click('[data-console-chat=pa] [data-tool-phase] button')");await settle();
 eq(await js("smoke.count('[data-console-chat=pa] [data-phase-items] [data-tool-run]')"),2,'a click on the phase shows its tool rows');
 await js("smoke.click('[data-console-chat=pa] [data-md-link]')");await settle();
 eq(await js('smoke.calls.open'),['https://docs.example.com/x'],'a link opens like the terminal links (openExternal), with its full target');

 // --- Load earlier: chat:more, the older page in front --------------------------
 await js("smoke.click('[data-console-chat=pa] [data-chat-load-earlier]')");await settle(200);
 eq(await js('smoke.calls.more'),[{paneId:'pa',before:'200'}],'Load earlier asks main for the page before the oldest message (chat:more)');
 v=await js("({first:document.querySelector('[data-console-chat=pa] [data-chat-row]')?.dataset.chatId,earlier:smoke.has('[data-console-chat=pa] [data-chat-load-earlier]')})");
 ok(v.first==='100'&&!v.earlier,'the older page goes in front and the button goes away at the start',v);

 // --- Frames: appends, a pane nobody reads, a reset ------------------------------
 ok(await js("smoke.frame('pa',{type:'chatAppend',paneId:'pa',items:[smoke.msg('300','assistant',[{t:'text',text:'todo verde'}])]})"),'the store listens to chat:frame');await settle(200);
 ok((await js("smoke.text('[data-console-chat=pa] [data-chat-scroll]')")).includes('todo verde'),'an append adds the new message');
 await js("smoke.frame('pb',{type:'chatAppend',paneId:'pb',items:[smoke.msg('1','assistant',[{t:'text',text:'ajeno'}])]})");await settle();
 eq(await js('smoke.chats()'),['pa'],'a frame for a console nobody reads is dropped');
 await shot('console-chat-rows');
 await js("smoke.frame('pa',{type:'chatPage',paneId:'pa',items:[smoke.msg('500','user',[{t:'text',text:'otra conversación'}])],cursor:null,done:true})");await settle(200);
 v=await js("({rows:smoke.count('[data-console-chat=pa] [data-chat-row]'),text:smoke.text('[data-console-chat=pa] [data-chat-scroll]')})");
 ok(v.rows===1&&v.text.includes('otra conversación')&&!v.text.includes('todo verde'),'a chatPage frame is a reset: it replaces the list',v);

 // --- Composer: Enter is a new line, Insert has no Enter, only Send adds one ------
 ok(await js("smoke.focusComposer('pa')"),'the composer takes the focus');
 for(const k of ['h','i'])await press(k);
 await press('Return');
 await press('x');await settle();
 v=await js("smoke.composer('pa')");
 eq(v.value,'hi'+String.fromCharCode(10)+'x','a real Enter in the composer is a new line in it');
 eq(await js('smoke.calls.submit.length'),0,'typing and Enter write nothing to the console');
 eq(await js('smoke.writes.slice('+writes0+').map(w=>w.data).filter(d=>d.includes(String.fromCharCode(13))||d.includes(String.fromCharCode(10))||d.includes("hi"))'),[],'nothing reaches the hidden xterm either');
 await js("smoke.click('[data-console-chat=pa] [data-chat-insert]')");await settle();
 eq(await js('smoke.calls.submit'),[{ptyId:'pty-pa',paneId:'pa',text:'hi'+String.fromCharCode(10)+'x',enter:false,userGate:true}],'Insert types the text through pty.submit, with no Enter and the user gate');
 v=await js("smoke.composer('pa')");
 ok(v.value===''&&v.note==='consoleChat.inserted'&&v.noteText.includes('sin enviar'),'the composer empties and says the text is typed, not sent',v);
 await js("smoke.draft('pa','abc'+String.fromCharCode(10,10))");await settle(60);
 await js("smoke.click('[data-console-chat=pa] [data-chat-insert]')");await settle();
 eq(await js('smoke.calls.submit.at(-1)'),{ptyId:'pty-pa',paneId:'pa',text:'abc',enter:false,userGate:true},'trailing line breaks never go (they would be typed Enters)');
 ok((await js("smoke.composer('pa')")).insert,'Insert needs some text');
 await js("smoke.click('[data-console-chat=pa] [data-chat-send]')");await settle();
 eq(await js('smoke.calls.submit.at(-1)'),{ptyId:'pty-pa',paneId:'pa',text:'',enter:true,userGate:true},'Send with an empty composer presses Enter on what was inserted');
 await js("smoke.draft('pa','listo')");await settle(60);
 await js("smoke.click('[data-console-chat=pa] [data-chat-send]')");await settle();
 eq(await js('smoke.calls.submit.at(-1)'),{ptyId:'pty-pa',paneId:'pa',text:'listo',enter:true,userGate:true},'Send types the text and then its Enter');
 eq(await js('smoke.calls.submit.filter(r=>r.enter).length'),2,'only the two Send clicks carried an Enter');
 ok(!(await js("smoke.calls.submit.some(r=>'origin' in r)")),'what the composer writes is the user typing (never an auto origin)');
 await js("smoke.fakes.submit=()=>({ok:false,error:'awaiting_user'});smoke.draft('pa','uno');0");await settle(60);
 await js("smoke.click('[data-console-chat=pa] [data-chat-insert]')");await settle();
 v=await js("smoke.composer('pa')");
 ok(v.value==='uno'&&v.note==='consoleChat.blocked','a refusal from main keeps the text and says why',v);
 await js("smoke.fakes.submit=()=>({ok:true});0");

 // --- enter_held: main typed the text, then a menu opened before its Enter ---------------
 await js("smoke.fakes.submit=()=>({ok:false,error:'enter_held'});smoke.draft('pa','fix the tests');0");await settle(60);
 await js("smoke.click('[data-console-chat=pa] [data-chat-send]')");await settle();
 eq(await js('smoke.calls.submit.at(-1)'),{ptyId:'pty-pa',paneId:'pa',text:'fix the tests',enter:true,userGate:true},'Send asks main for the text and its Enter');
 await js("smoke.fakes.submit=()=>({ok:true});0");
 v=await js("smoke.composer('pa')");
 ok(v.value===''&&v.note==='consoleChat.error.held'&&v.noteText.includes('quedó escrito en la consola sin Enter'),'enter_held is no refusal that keeps the text: it is typed already, so the composer empties and says so',v);
 await js("smoke.status('pa',{state:'action',reason:'permission',pendingCount:1,attention:true})");await settle();
 v=await js("smoke.composer('pa')");
 ok(v.send&&v.note==='consoleChat.error.held','the agent waiting: Send is off and the held note stays (it says the agent waits)',v);
 // The blocked composer offers the terminal: the user answers the menu there and comes back.
 await js("smoke.click('[data-console-chat=pa] [data-chat-composer-box] [data-console-chat-terminal]')");await settle(250);
 ok((await js("smoke.termShown('pa')"))&&!(await js("smoke.chat('pa')")),'the user goes to the terminal to answer the menu');
 await js("smoke.status('pa',{state:'working'})");await settle();
 ok(await js("smoke.pick('pa','chat')"),'and back to the chat');await settle(250);
 v=await js("smoke.composer('pa')");
 ok(v.value===''&&!v.send&&v.note==='consoleChat.error.held','the menu answered, the held note outlives the trip and wins over the hint',v);
 const typed0=await js("smoke.calls.submit.filter(r=>r.text==='fix the tests').length");
 await js("smoke.click('[data-console-chat=pa] [data-chat-send]')");await settle();
 eq(await js('smoke.calls.submit.at(-1)'),{ptyId:'pty-pa',paneId:'pa',text:'',enter:true,userGate:true},'a second Send on the empty composer only presses Enter on the typed text');
 eq(await js("smoke.calls.submit.filter(r=>r.text==='fix the tests').length"),typed0,'and never types it again');
 eq((await js("smoke.composer('pa')")).note,'consoleChat.hint','that Send clears the held note');
 // The held note lives on the pty that typed it: the menu opening and closing on screen keeps it, a restart drops it.
 await js("smoke.fakes.submit=()=>({ok:false,error:'enter_held'});smoke.draft('pa','otra vez');0");await settle(60);
 await js("smoke.click('[data-console-chat=pa] [data-chat-send]')");await settle();
 await js("smoke.fakes.submit=()=>({ok:true});0");
 await js("smoke.status('pa',{state:'action',reason:'permission',pendingCount:1,attention:true})");await settle();
 await js("smoke.status('pa',{state:'working'})");await settle();
 v=await js("smoke.composer('pa')");
 ok(v.value===''&&!v.send&&v.note==='consoleChat.error.held','blocked then unblocked with the chat on screen, the held note stays and wins over the hint',v);
 await js("smoke.reg('pa','pty-pa-restarted')");await settle();
 eq((await js("smoke.composer('pa')")).note,'consoleChat.hint','another pty taking the console (a restart) drops the held note: the text went with the old one');
 await js("smoke.reg('pa','pty-pa')");await settle();
 eq((await js("smoke.composer('pa')")).note,'consoleChat.hint','and it stays dropped (the run goes on with the first pty id)');
 // A draft for the gate checks below (Insert needs text).
 await js("smoke.draft('pa','uno')");await settle(60);

 // --- typingBlocked: nothing goes while the agent waits on the user ---------------
 const n0=await js('smoke.calls.submit.length');
 await js("smoke.status('pa',{state:'action',reason:'permission',pendingCount:1,attention:true})");await settle();
 v=await js("smoke.composer('pa')");
 ok(v.insert&&v.send&&v.note==='consoleChat.blocked','while the agent waits on the user Insert and Send are off',v);
 ok(await js("smoke.has('[data-console-chat=pa] [data-chat-composer-box] [data-console-chat-terminal]')"),'and the composer offers the terminal');
 await js("smoke.click('[data-console-chat=pa] [data-chat-send]')");await settle();
 eq(await js('smoke.calls.submit.length'),n0,'a disabled Send writes nothing');
 await js("smoke.status('pa',{state:'working',needs:{text:'Revisá el diff',at:Date.now()}})");await settle();
 v=await js("({working:smoke.text('[data-console-chat=pa] [data-chat-working]'),chip:smoke.text('[data-console-chat=pa] [data-console-chat-signals] [data-needs-chip]'),shown:smoke.signalsShown('pa'),insert:smoke.composer('pa').insert,note:smoke.composer('pa').note})");
 ok(v.working.includes('Claude está trabajando')&&v.chip.includes('Revisá el diff')&&v.shown,'the working row, and the needs chip on top',v);
 ok(!v.insert&&v.note==='consoleChat.hint','the composer works again and no longer says the agent waits',v);
 await shot('console-chat-composer');

 // --- A late first page and a notice ------------------------------------------------
 ok(await js("smoke.pick('pb','chat')"),'the other console switches too');await settle(250);
 v=await js("({noreply:smoke.text('[data-console-chat=pb] [data-chat-noreply]'),retry:smoke.has('[data-console-chat=pb] [data-chat-retry]')})");
 ok(v.noreply.includes('El chat no cargó')&&v.retry,'a first page main did not get in time shows the console words and [Retry]',v);
 await js("smoke.fakes.sub=r=>({ok:true,page:{type:'chatPage',paneId:r.paneId,items:[{id:'notice',role:'system',ts:null,blocks:[{t:'notice',code:'ambiguous'}]}],cursor:null,done:true}});0");
 await js("smoke.click('[data-console-chat=pb] [data-chat-retry]')");await settle(200);
 v=await js("({subs:smoke.calls.sub.filter(r=>r.paneId==='pb').length,notice:document.querySelector('[data-console-chat=pb] [data-chat-notice]')?.getAttribute('data-chat-notice'),text:smoke.text('[data-console-chat=pb] [data-chat-notice]')})");
 ok(v.subs===2&&v.notice==='ambiguous'&&v.text.includes('Chat no disponible')&&v.text.includes('en esta carpeta'),'[Retry] subscribes again; a notice page says why there is no chat',v);
 await shot('console-chat-notice');
 await js("smoke.click('[data-console-chat=pb] [data-chat-notice] [data-console-chat-terminal]')");await settle(200);
 ok((await js("smoke.termShown('pb')"))&&!(await js("smoke.chat('pb')")),'[Ver la terminal] goes back to the terminal');
 eq(await js("smoke.calls.unsub.filter(r=>r.paneId==='pb')"),[{paneId:'pb'}],'leaving the chat unsubscribes it once (chat:unsub)');
 eq(await js("smoke.stored('pb')"),null,'the terminal is the default: nothing stays saved');

 // --- The choice persists per pane across a re-render ---------------------------------
 await js('smoke.calls.sub.length=0;smoke.fakes.sub=r=>r.paneId===\\'pa\\'?{ok:true,page:smoke.PAGE}:{ok:false,error:\\'timeout\\'};smoke.remount()');
 await waitReady();await settle(250);
 ok((await js("smoke.chat('pa')"))&&!(await js("smoke.termShown('pa')")),'after a re-render the console opens in the Chat it was left on');
 ok((await js("smoke.termShown('pb')"))&&!(await js("smoke.chat('pb')")),'and the other console in its terminal');
 eq(await js('smoke.calls.sub'),[{paneId:'pa'}],'only the chat on screen subscribes');
 eq(await js("smoke.count('[data-console-chat=pa] [data-chat-row]')"),3,'its first page shows again');

 // --- A focus request for a console on its Chat (Ctrl+digit, a sidebar row) ----------------
 await js("smoke.focusXterm('pb')");await settle(60);
 v=await js('smoke.active()');ok(v.xterm&&v.cell==='pb'&&v.focused==='pb','the other console has the keyboard',v);
 await js("smoke.focusPane('pa')");await settle();
 v=await js('smoke.active()');ok(v.composer&&v.cell==='pa'&&v.focused==='pa','a focus request for a console on its Chat lands in its composer, never left in another console',v);

 // --- A late older page never lands on a list a reset replaced ----------------------------
 await js('smoke.holdMore()');
 await js("smoke.click('[data-console-chat=pa] [data-chat-load-earlier]')");await settle();
 ok(await js("smoke.has('[data-console-chat=pa] [data-chat-skeleton]')"),'Load earlier waits on main');
 await js("smoke.frame('pa',{type:'chatPage',paneId:'pa',items:[smoke.msg('700','user',[{t:'text',text:'reiniciado'}])],cursor:null,done:true})");await settle(200);
 ok(await js('smoke.releaseMore()'),'the held older page comes back late');await settle(200);
 eq(await js("({rows:smoke.rowIds('pa'),skeleton:smoke.has('[data-console-chat=pa] [data-chat-skeleton]')})"),{rows:['700'],skeleton:false},'the reset wins: the late older page is dropped');

 // --- Back to the terminal: the same xterm, the chat stops -----------------------------
 ok(await js("smoke.mark('pa')"),'the remounted console has its xterm (hidden)');
 let u0=await js('smoke.calls.unsub.length');
 await js("smoke.draft('pa','borrador')");await settle(60);
 await js("smoke.pick('pa','terminal')");await settle(250);
 ok((await js("smoke.termShown('pa')"))&&!(await js("smoke.chat('pa')"))&&(await js("smoke.sameXterm('pa')")),'Terminal brings back the same xterm, never remounted');
 eq(await js('smoke.calls.unsub.slice('+u0+')'),[{paneId:'pa'}],'and stops reading the chat');
 eq(await js("smoke.stored('pa')"),null,'the terminal choice clears the saved one');
 v=await js('smoke.active()');ok(v.xterm&&v.cell==='pa','the keyboard goes back to the terminal',v);

 // --- Lab off while a chat shows ---------------------------------------------------------
 await js("smoke.pick('pa','chat')");await settle(250);
 ok(await js("smoke.chat('pa')"),'the chat shows again');
 eq((await js("smoke.composer('pa')")).value,'borrador','the unsent draft outlives the trip to the terminal');
 u0=await js('smoke.calls.unsub.length');
 await js('smoke.lab(false)');await settle(250);
 eq(await js("smoke.count('[data-pane-view-toggle]')"),0,'turning the lab off removes every switch');
 ok(!(await js("smoke.chat('pa')"))&&(await js("smoke.termShown('pa')"))&&(await js("smoke.sameXterm('pa')")),'and shows the same terminal');
 eq(await js('smoke.calls.unsub.slice('+u0+')'),[{paneId:'pa'}],'and stops reading the chat');
 eq(await js("smoke.stored('pa')"),'chat','the choice waits for the lab to come back');

 // --- toggleConsoleChat: remappable, with no default ----------------------------------------
 eq(await js('smoke.keyDefault()'),'','toggleConsoleChat has no default chord');
 v=await js('smoke.keyRow()');
 ok(v&&v.unset&&v.text.includes('Alternar chat de la consola')&&v.text.includes('Sin asignar'),'Settings > Keys lists it as "Sin asignar"',v);
 eq(await js('smoke.conflicts()'),0,'an action with no key is never a conflict');
 ok(await js("smoke.mark('pb')"),'the other console has its xterm');
 await js("smoke.focusXterm('pb')");await settle(60);
 await chord();await settle(200);
 ok(!(await js("smoke.chat('pb')"))&&(await js("smoke.termShown('pb')")),'unbound, the chord does nothing');
 eq(await js('smoke.synthKey()'),false,'and the key is not consumed');
 await js("smoke.bind('Ctrl+Shift+Y')");await settle();
 v=await js('smoke.keyRow()');ok(v&&!v.unset&&v.text.includes('Ctrl + Shift + Y'),'the user records Ctrl+Shift+Y for it',v);
 // Lab off: nothing, and the key goes on to the console.
 await js("smoke.focusXterm('pb')");await settle(60);
 await chord();await settle(200);
 ok(!(await js("smoke.chat('pb')"))&&(await js("smoke.termShown('pb')"))&&(await js("smoke.stored('pb')"))===null,'with the lab off the recorded chord does nothing');
 eq(await js('smoke.synthKey()'),false,'and lets the key through to the console');
 // Lab on: the chord toggles the focused agent console, both ways.
 await js('smoke.lab(true)');await settle(250);
 ok(await js("smoke.chat('pa')"),'the lab back on: the console left on Chat shows it again');
 await js("smoke.focusXterm('pb')");await settle(60);
 await chord();await settle(250);
 ok((await js("smoke.chat('pb')"))&&!(await js("smoke.termShown('pb')"))&&(await js("smoke.sameXterm('pb')"))&&(await js("smoke.stored('pb')"))==='chat','the chord switches the focused console to its chat (the xterm only hides)');
 ok(await js("smoke.chat('pa')"),'the other console keeps its own view');
 v=await js('smoke.active()');ok(v.composer&&v.cell==='pb','the keyboard follows to its composer',v);
 await chord();await settle(250);
 ok((await js("smoke.termShown('pb')"))&&!(await js("smoke.chat('pb')"))&&(await js("smoke.sameXterm('pb')"))&&(await js("smoke.stored('pb')"))===null,'pressed again from the composer, the same terminal comes back');
 v=await js('smoke.active()');ok(v.xterm&&v.cell==='pb','and the keyboard with it',v);
 // A shell with no agent: nothing, the key let through.
 await js("smoke.dropStatus('ps')");await settle();
 eq(await js("smoke.toggle('ps')"),null,'a shell whose status went away has no switch');
 await js("smoke.focusXterm('ps')");await settle(60);
 await chord();await settle(200);
 ok(!(await js("smoke.chat('ps')"))&&(await js("smoke.stored('ps')"))===null,'on a console with no agent the chord does nothing');
 eq(await js('smoke.synthKey()'),false,'and the key is not consumed there either');
 // The shared view on top: swallowed like every pane action, whatever local console is focused (never left to the shared terminal).
 await js("smoke.focusXterm('pb')");await settle(60);
 ok(await js('smoke.overlay(true)'),'the shared view covers the grid');
 eq(await js('smoke.synthKey()'),true,'over the shared view the chord is swallowed with an agent console focused');
 await settle(200);
 ok(!(await js("smoke.chat('pb')"))&&(await js("smoke.termShown('pb')"))&&(await js("smoke.stored('pb')"))===null,'and switches nothing on the hidden local console');
 await js('smoke.overlay(false)');
 await js("smoke.focusXterm('ps')");await settle(60);
 ok(await js('smoke.overlay(true)'),'the shared view on top again');
 eq(await js('smoke.synthKey()'),true,'with a shell focused (no target) the chord is swallowed too');
 ok(!(await js('smoke.overlay(false)')),'the shared view goes away');
 eq(await js('smoke.synthKey()'),false,'and with the grid back the chord on a shell is let through again');
 // A modal on top that the store flags do not cover: the plan modal (A6), then a dialog a pane holds in
 // its own state (Programar prompt). The chord does nothing, is not consumed and the modal stays.
 // Plain waits here (a React commit, not a frame), so the block stays short.
 await js("smoke.focusXterm('pb')");await wait(80);
 await js('smoke.plan(true)');await wait(250);
 ok(await js('smoke.planOpen()'),'the plan modal is open over the grid');
 eq(await js('smoke.synthKey()'),false,'with the plan modal open the chord is not consumed');
 await chord();await wait(250);
 ok(!(await js("smoke.chat('pb')"))&&(await js("smoke.termShown('pb')"))&&(await js("smoke.stored('pb')"))===null&&(await js('smoke.planOpen()')),'and switches nothing behind it: the console keeps its terminal and the plan stays open');
 await js('smoke.plan(false)');await wait(200);
 ok(!(await js('smoke.planOpen()')),'the plan modal closes');
 ok(await js("smoke.menuPick('pb','Programar prompt')"),'the pane menu opens Programar prompt');await wait(250);
 ok(await js("smoke.has('[data-schedule-dialog=pb]')"),'the schedule dialog is open');
 eq(await js('smoke.synthKey()'),false,'with a dialog held in the pane state open the chord is not consumed either');
 await wait(200);
 ok(!(await js("smoke.chat('pb')"))&&(await js("smoke.stored('pb')"))===null&&(await js("smoke.has('[data-schedule-dialog=pb]')")),'and switches nothing: the dialog stays');
 await js('smoke.escape()');await wait(250);
 ok(!(await js("smoke.has('[data-schedule-dialog=pb]')")),'Esc closes the schedule dialog');
 await js("smoke.focusXterm('pb')");await wait(80);
 eq(await js('smoke.synthKey()'),true,'with nothing on top the chord works again');
 await wait(250);
 ok((await js("smoke.chat('pb')"))&&(await js("smoke.stored('pb')"))==='chat','and switches the focused console to its chat');
 eq(await js('smoke.synthKey()'),true,'pressed again');
 // One frame: the view switch hands the keyboard over in a requestAnimationFrame.
 await settle(250);
 ok((await js("smoke.termShown('pb')"))&&(await js("smoke.stored('pb')"))===null,'back to the terminal');
 await js("smoke.focusXterm('ps')");await wait(80);

 // --- The palette command -------------------------------------------------------------------
 await js('smoke.palette(true)');await settle();
 eq(await js('smoke.paletteCmd()'),null,'with a shell focused the palette has no "Alternar chat de la consola"');
 await js('smoke.palette(false)');await settle();
 await js("smoke.focusXterm('pb')");await settle(60);
 await js('smoke.palette(true)');await settle();
 v=await js('smoke.paletteCmd()');ok(v&&v.text.includes('Alternar chat de la consola')&&v.kbd==='Ctrl + Shift + Y','with an agent console focused it lists the command with the recorded chord',v);
 await js("smoke.click('[data-palette-cmd=toggle-console-chat]')");await settle(250);
 ok((await js("smoke.chat('pb')"))&&(await js("smoke.stored('pb')"))==='chat'&&!(await js("smoke.has('[data-palette-cmd]')")),'running it closes the palette and switches that console to its chat');
 await js('smoke.bind(null)');await settle();
 await js('smoke.palette(true)');await settle();
 v=await js('smoke.paletteCmd()');ok(v&&v.kbd===null,'with no chord bound the command shows no key chip',v);
 await js("smoke.click('[data-palette-cmd=toggle-console-chat]')");await settle(250);
 ok((await js("smoke.termShown('pb')"))&&(await js("smoke.stored('pb')"))===null,'and it still toggles: back to the terminal');
 await js('smoke.lab(false)');await settle(250);
 await js("smoke.focusXterm('pb')");await settle(60);
 await js('smoke.palette(true)');await settle();
 eq(await js('smoke.paletteCmd()'),null,'with the lab off the palette has no such command');
 await js('smoke.palette(false)');await settle();
 await js('smoke.lab(true)');await settle(250);

 // --- ChatHub paused this chat (LRU): the list stays, only [Reanudar] reads it again ----------
 ok(await js("smoke.chat('pa')"),'the console left on Chat shows it');
 let s0=await js('smoke.calls.sub.length');
 const rows0=await js("smoke.count('[data-console-chat=pa] [data-chat-row]')");
 ok(await js("smoke.frame('pa',{type:'chatAppend',paneId:'pa',items:[],notice:'paused'})"),'main says the chat is paused');await settle(200);
 v=await js("({bar:smoke.text('[data-console-chat=pa] [data-chat-paused]'),rows:smoke.count('[data-console-chat=pa] [data-chat-row]'),resume:smoke.has('[data-console-chat=pa] [data-chat-resume]')})");
 ok(v.bar.includes('Este chat se pausó para no abrir demasiados a la vez')&&v.bar.includes('Reanudar')&&v.resume&&rows0>0&&v.rows===rows0,'the paused bar shows over the list it had, with [Reanudar]',v);
 await shot('console-chat-paused');
 await wait(600);
 eq(await js('smoke.calls.sub.length'),s0,'it is never resumed by itself');
 await js("smoke.click('[data-console-chat=pa] [data-chat-resume]')");await settle(250);
 eq(await js('smoke.calls.sub.slice('+s0+')'),[{paneId:'pa'}],'[Reanudar] subscribes again (chat:sub)');
 ok(!(await js("smoke.has('[data-console-chat=pa] [data-chat-paused]')")),'its fresh first page clears the bar');
 await js("smoke.frame('pa',{...smoke.PAGE,notice:'paused'})");await settle(200);
 v=await js("({bar:smoke.has('[data-console-chat=pa] [data-chat-paused]'),rows:smoke.count('[data-console-chat=pa] [data-chat-row]')})");
 ok(v.bar&&v.rows===rows0,'a first page read while main closed the watcher comes marked paused, rows and bar',v);
 await js("smoke.click('[data-console-chat=pa] [data-chat-resume]')");await settle(250);
 ok(!(await js("smoke.has('[data-console-chat=pa] [data-chat-paused]')")),'and [Reanudar] reads it live again');

 // --- disabled: the config goes to main at once and the chat asks once more; the lab turning on asks again ---
 await js("smoke.fakes.sub=r=>r.paneId==='pz'?{ok:false,error:'disabled'}:(r.paneId==='pa'?{ok:true,page:smoke.PAGE}:{ok:false,error:'timeout'});smoke.calls.save.length=0;0");
 s0=await js('smoke.calls.sub.length');
 await js("smoke.openChat('pz')");await settle(250);
 v=await js("({subs:smoke.calls.sub.slice("+s0+").filter(r=>r.paneId==='pz').length,save:smoke.calls.save.slice(),chat:smoke.chatState('pz')})");
 ok(v.subs===2&&v.save.length===1&&v.save[0]===true&&v.chat.refused==='disabled','main says disabled while the lab is on here: the config goes at once and the chat asks once more, then says it is off',v);
 await js("smoke.fakes.sub=r=>r.paneId==='pa'||r.paneId==='pz'?{ok:true,page:smoke.PAGE}:{ok:false,error:'timeout'};0");
 await js('smoke.lab(false)');await settle(150);
 await js('smoke.lab(true)');await settle(300);
 v=await js("({subs:smoke.calls.sub.slice("+s0+").filter(r=>r.paneId==='pz').length,save:smoke.calls.save.length,chat:smoke.chatState('pz')})");
 ok(v.subs===3&&v.save===2&&v.chat.refused===null&&v.chat.rows===7,'the lab turning on sends the config and asks again by itself: the chat reads',v);
 await js("smoke.closeChat('pz')");

 // --- unknown_pane: a console main has not saved nor spawned yet (one just reopened) -------
 await js("smoke.fakes.sub=r=>r.paneId==='pb'||r.paneId==='pz'?{ok:false,error:'unknown_pane'}:(r.paneId==='pa'?{ok:true,page:smoke.PAGE}:{ok:false,error:'timeout'});smoke.calls.save.length=0;0");
 s0=await js('smoke.calls.sub.length');
 const pbSubs=()=>js("smoke.calls.sub.slice("+s0+").filter(r=>r.paneId==='pb').length");
 ok(await js("smoke.pick('pb','chat')"),'a console of this window switches to its chat');await settle(250);
 v=await js("({save:smoke.calls.save.slice(),notice:document.querySelector('[data-console-chat=pb] [data-chat-notice]')?.getAttribute('data-chat-notice'),text:smoke.text('[data-console-chat=pb] [data-chat-notice]'),retry:smoke.has('[data-console-chat=pb] [data-chat-notice] [data-chat-retry]')})");
 ok((await pbSubs())===2&&v.save.length===1&&v.save[0]===true,'main does not know it yet: the config goes at once and the chat asks once more',v);
 ok(v.notice==='unknown_pane'&&v.text.includes('Chat no disponible')&&v.text.includes('todavía se está abriendo')&&v.retry,'still unknown: the notice says why and offers [Reintentar]',v);
 await shot('console-chat-unknown');
 // Its pty is live here: another console pty coming and going asks nothing (never a loop).
 await js("smoke.reg('py','pty-py');smoke.unreg('py');0");await wait(300);
 eq(await pbSubs(),2,'nothing asks main again by itself');
 await js("smoke.fakes.sub=r=>r.paneId==='pz'?{ok:false,error:'unknown_pane'}:{ok:true,page:smoke.PAGE};0");
 await js("smoke.click('[data-console-chat=pb] [data-chat-retry]')");await settle(250);
 v=await js("({rows:smoke.count('[data-console-chat=pb] [data-chat-row]'),notice:smoke.has('[data-console-chat=pb] [data-chat-notice]')})");
 ok((await pbSubs())===3&&v.rows===3&&!v.notice,'[Reintentar] asks main again and the chat reads',v);
 await js("smoke.pick('pb','terminal')");await settle(250);
 // No pty yet and no pane here (so no config to send): the pty registering asks once more.
 s0=await js('smoke.calls.sub.length');await js('smoke.calls.save.length=0');
 const pzSubs=()=>js("smoke.calls.sub.slice("+s0+").filter(r=>r.paneId==='pz').length");
 await js("smoke.openChat('pz')");await settle(200);
 v=await js("({save:smoke.calls.save.length,chat:smoke.chatState('pz')})");
 ok((await pzSubs())===1&&v.save===0&&v.chat.refused==='unknown_pane','a console with no pane in this window sends no config and stays refused, waiting for its pty',v);
 await js("smoke.reg('py','pty-py')");await settle(150);
 eq(await pzSubs(),1,'another console pty registering asks nothing');
 await js("smoke.fakes.sub=r=>r.paneId==='pa'||r.paneId==='pz'?{ok:true,page:smoke.PAGE}:{ok:false,error:'timeout'};0");
 await js("smoke.reg('pz','pty-pz')");await settle(200);
 v=await js("smoke.chatState('pz')");
 ok((await pzSubs())===2&&v.refused===null&&v.rows===7,'its own pty registering asks main once more: the chat reads',v);
 await js("smoke.unreg('pz');smoke.reg('pz','pty-pz2');smoke.unreg('pz');smoke.unreg('py');0");await settle(150);
 eq(await pzSubs(),2,'and only that once: later pty changes ask nothing');
 await js("smoke.closeChat('pz')");
 eq(await js('smoke.calls.kill'),[],'no pty was killed in the whole run');

 eq(await js('smoke.overflow()'),'','no horizontal overflow');
 if(failures.length)throw new Error(failures.join('\\n'));
 console.log('PASS: '+n+' console chat UI checks (lab gate, agent-only switch, hidden xterm, rows and phases, Load earlier, frames, composer Insert/Send and gate, enter_held, late page, notice, persistence, focus request, draft, unsub, toggleConsoleChat shortcut, modals, shared overlay and palette, paused and Reanudar, disabled re-sub, unknown_pane retry); screenshots '+__dirname);w.destroy();app.quit();
}).catch(e=>{console.error(e);app.exit(1)});
`)
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
// The run takes about 210 s on a loaded machine (each frame wait in the hidden window costs about 2 s): room to spare.
const res = spawnSync(require('electron'), [path.join(dir, 'main.cjs')], { env, windowsHide: true, encoding: 'utf8', timeout: 360000 })
process.stdout.write(res.stdout ?? ''); if (res.status !== 0) process.stderr.write((res.stderr ?? '') + (res.error ? String(res.error) : ''))
process.exitCode = res.status ?? 1
