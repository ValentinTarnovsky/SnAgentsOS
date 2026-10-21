// "Shared with me", the guest UI of desktop sharing (app 2.4.0, item 8, S3),
// rendered from the production Sidebar, WorkspaceHost (one local console),
// SharedWorkspaceHost, JoinShareDialog, ConfirmLinkDialog, useGlobalKeys and
// shareGuestStore in an isolated hidden Electron window with a fake
// window.snApi (share.guest included). Checks: the join flow (preview, name,
// approval wait with password, connected opens the view), a 120x40 host
// replay fits the cell at 6 px or more or scrolls, the host pty is never
// resized, view mode (readOnly textarea, nothing sent), type mode (Enter, a
// multi-line paste and Ctrl+C refused locally with the strip message, Esc
// sent), OSC 52 never touches the clipboard and titles never reach status,
// an OSC 8 link and a plain URL open the confirm dialog (Open goes out only
// on a click), the host-typing strip, backpressure to share:flow, end
// reasons, the overlay focus case (Ctrl+1 sends nothing to a local pty and
// keeps the view; a local switch or reveal leaves it), the config never
// holds a shared pane, es/en and light/dark. Stage S5 (full control of a
// workspace): New console from the host presets (the ack's pane shows at
// once, a refusal toasts why), Close console asks first, the read-only Chat
// drawer (folded tools, Load earlier, append, working row, links as buttons
// through the confirm dialog, no composer, a reconnect reads it again, a
// notice, unsub on close), Notes (list, read, links confirmed, notesChanged
// reloads, no editor), Changes (status sections, diff pages joined, no
// review buttons) and a live downgrade that takes every extra away. No pty,
// user config or socket is touched. Requires npm run build (for the CSS).
const fs = require('node:fs'), os = require('node:os'), path = require('node:path')
const { pathToFileURL } = require('node:url')
const { spawnSync } = require('node:child_process')
const { buildSync } = require('esbuild')
const root = path.resolve(__dirname, '..'), dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snagentsos-share-ui-'))
const assets = path.join(root, 'out/renderer/assets')
const css = fs.existsSync(assets) ? fs.readdirSync(assets).find(f => /^index-.*\.css$/.test(f)) : null
if (!css && !process.env.SHARE_UI_BUNDLE_ONLY) throw new Error('Run npm run build first')
buildSync({ stdin: { contents: `
import React from 'react'; import {createRoot} from 'react-dom/client';
import {I18nProvider} from './src/renderer/i18n';
import {useAppStore} from './src/renderer/lib/store';
import {snapshotConfig} from './src/renderer/lib/persist';
import {revealPane} from './src/renderer/lib/revealPane';
import {useGlobalKeys} from './src/renderer/lib/useGlobalKeys';
import {initShareGuest, useShareGuestStore} from './src/renderer/lib/shareGuestStore';
import {Sidebar} from './src/renderer/components/sidebar/Sidebar';
import {WorkspaceHost} from './src/renderer/components/layout/WorkspaceHost';
import {SharedWorkspaceHost} from './src/renderer/components/share/SharedWorkspaceHost';
import {JoinShareDialog} from './src/renderer/components/share/JoinShareDialog';
import {ConfirmLinkDialog} from './src/renderer/components/share/ConfirmLinkDialog';
import {applyTheme} from './src/renderer/themes/applyTheme';
import {useToastStore} from './src/renderer/lib/toast';
import {useShareExtrasStore} from './src/renderer/lib/shareGuestExtras';
const calls={spawn:[],writes:[],resize:[],setActive:[],save:[],clip:[],titles:[],open:[],
 sub:[],unsub:[],input:[],flow:[],preview:[],join:[],connect:[],disconnect:[],password:[],ctl:[],git:[],notes:[],chat:[]};
const subs={data:new Set(),link:new Set(),stream:new Set(),chat:new Set()};
const fakes={ctl:null,git:null,notes:null};
const noop=()=>()=>{};
const fallback=(base)=>new Proxy(base,{get:(t,k)=>k in t?t[k]:(typeof k==='string'?fallback(noop):undefined)});
let clipText='';
const LINK='AbCdEfGhIjKlMnOpQrStUv';
const FP='AB12-CD34-EF56-7890';
const link=(status,extra)=>({id:LINK,hostLabel:'Host PC',hostFingerprint:FP,scope:{kind:'pane',label:'Build'},permHint:'type',addedAt:1,persisted:true,rememberedPassword:false,status,...(extra||{})});
const INVITE='snaos-share:1:eyJ2IjoxfQ';
window.snApi=fallback({platform:'win32',filePath:()=>'',
 pty:fallback({reattach:async()=>null,spawn:async r=>{calls.spawn.push(r.paneId);return{ptyId:'pty-'+r.paneId,shellKind:'powershell'}},
  write:r=>calls.writes.push(r),resize:r=>calls.resize.push(r),setActive:ids=>calls.setActive.push(ids),flow(){},kill:async()=>{},killPanes:async()=>0,
  onData:cb=>{subs.data.add(cb);return()=>subs.data.delete(cb)},onExit:noop}),
 config:fallback({save:cfg=>{calls.save.push(JSON.parse(JSON.stringify(cfg)));return Promise.resolve()}}),
 system:fallback({openExternal:u=>calls.open.push(u),onDisplayRecovered:noop}),
 status:fallback({reportTitle:(id,t)=>calls.titles.push([id,t])}),
 clipboard:fallback({writeText:t=>calls.clip.push(t),readText:async()=>clipText}),
 agents:fallback({list:async()=>[],startup:async()=>({trigger:null,interrupted:[]})}),
 share:{host:fallback({}),guest:{
  preview:async inv=>{calls.preview.push(inv);return inv.startsWith('snaos-share:1:')?{ok:true,preview:{hostLabel:'Host PC',hostFingerprint:FP,scope:{kind:'pane',label:'Build'},perm:'type',expired:false,endpoints:[{address:'100.64.0.7',port:4527,kind:'ts'},{address:'192.168.1.5',port:4527,kind:'lan'}]}}:{ok:false,error:'format'}},
  join:async inv=>{calls.join.push(inv);return{ok:true,link:link('connecting')}},
  links:async()=>({persisted:true,guestFingerprint:null,links:[],states:{}}),
  connect:async id=>{calls.connect.push(id);return true},disconnect:async id=>{calls.disconnect.push(id);return true},forget:async()=>true,
  password:async r=>{calls.password.push(r);return{ok:true}},
  ctl:async r=>{calls.ctl.push(r);return fakes.ctl?fakes.ctl(r):{ok:false,error:'denied'}},git:async r=>{calls.git.push(r);return fakes.git?fakes.git(r):{ok:false,error:'denied'}},notes:async r=>{calls.notes.push(r);return fakes.notes?fakes.notes(r):{ok:false,error:'denied'}},
  sub:(l,p)=>calls.sub.push(l+':'+p),unsub:(l,p)=>calls.unsub.push(l+':'+p),input:r=>calls.input.push(r),flow:r=>calls.flow.push(r),chat:r=>calls.chat.push(r),
  onLinkEvent:cb=>{subs.link.add(cb);return()=>subs.link.delete(cb)},onStream:cb=>{subs.stream.add(cb);return()=>subs.stream.delete(cb)},onChatEvent:cb=>{subs.chat.add(cb);return()=>subs.chat.delete(cb)}}},
});
const local={id:'local1',type:'shell',title:'Local',icon:'terminal',color:'#888'};
useAppStore.setState(s=>({hydrated:true,activeWorkspaceId:'w1',workspaces:[{id:'w1',name:'Mine',cwd:'C:/repo',panes:[local],layout:{grid:1,order:['local1']}},{id:'w2',name:'Other',cwd:'C:/other',panes:[{...local,id:'local2',title:'Other'}],layout:{grid:1,order:['local2']}}],settings:{...s.settings,language:'es'}}));
applyTheme('midnight');
initShareGuest();
function Keys(){useGlobalKeys();return null}
function Root(){const [lang,setLang]=React.useState('es');window.smoke.setLang=setLang;
 return <I18nProvider lang={lang}><Keys/><div style={{height:'100vh'}} className="flex w-full overflow-hidden bg-bg-primary text-text-primary">
  <Sidebar/>
  <main className="relative min-w-0 flex-1"><WorkspaceHost/><SharedWorkspaceHost/></main>
  <JoinShareDialog/><ConfirmLinkDialog/>
 </div></I18nProvider>}
const state=(perm,panes)=>({scope:{kind:'pane',label:'Build'},perm,title:'Build',layoutOrder:panes.map(p=>p.id),panes,terminalUnicode11:true,hostPlatform:'win32',caps:{createPane:false,closePane:false,chat:false,notes:false,git:false}});
const sp=(id,extra)=>({id,title:'Remote '+id,type:'shell',color:'#6366f1',icon:'terminal',running:true,...(extra||{})});
const setVal=(el,v)=>{const proto=el.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(proto,'value').set.call(el,v);el.dispatchEvent(new Event('input',{bubbles:true}))};
const ta=id=>document.querySelector('[data-remote-term="'+id+'"] .xterm-helper-textarea');
const FULL_CAPS={createPane:true,closePane:true,chat:true,notes:true,git:true};
const PRESETS=[{id:'pre1',name:'Claude',type:'claude',icon:'bot',color:'#d97706'},{id:'pre2',name:'Shell',type:'shell',icon:'terminal',color:'#888888'}];
const stateFull=(panes,extra)=>({scope:{kind:'workspace',label:'Team'},perm:'full',title:'Team',layoutOrder:panes.map(p=>p.id),panes,terminalUnicode11:true,hostPlatform:'win32',caps:FULL_CAPS,presets:PRESETS,...(extra||{})});
const msg=(id,role,blocks)=>({id,role,ts:null,blocks});
window.smoke={calls,LINK,INVITE,theme:applyTheme,snapshotConfig,revealPane,fakes,sp,msg,
 toasts:()=>useToastStore.getState().items,extras:()=>useShareExtrasStore.getState(),
 stateFull:(panes,extra)=>subs.link.forEach(cb=>cb({t:'state',linkId:LINK,state:stateFull(panes,extra)})),
 linkEvt:e=>subs.link.forEach(cb=>cb({...e,linkId:LINK})),
 chatEvt:m=>subs.chat.forEach(cb=>cb({linkId:LINK,msg:m})),
 visible:sel=>{const el=document.querySelector(sel);return !!el&&!el.hidden&&el.offsetParent!==null},
 count:sel=>document.querySelectorAll(sel).length,
 store:()=>useShareGuestStore.getState(),app:()=>useAppStore.getState(),
 setClip:t=>{clipText=t},
 link:(status,extra)=>subs.link.forEach(cb=>cb({t:'link',link:link(status,extra)})),
 state:(perm,panes)=>subs.link.forEach(cb=>cb({t:'state',linkId:LINK,state:state(perm,panes||[sp('sp1')])})),
 stream:items=>subs.stream.forEach(cb=>cb({linkId:LINK,items})),
 has:sel=>!!document.querySelector(sel),text:sel=>document.querySelector(sel)?.textContent||'',
 click:sel=>{const el=document.querySelector(sel);if(!el)throw new Error('missing '+sel);el.click()},
 setVal:(sel,v)=>setVal(document.querySelector(sel),v),
 ta,
 key:(id,key,keyCode,mods)=>{const t=ta(id);t.focus();const o={key,keyCode,which:keyCode,bubbles:true,cancelable:true,...(mods||{})};t.dispatchEvent(new KeyboardEvent('keydown',o))},
 winKey:(key,keyCode,mods)=>{const o={key,keyCode,which:keyCode,code:'Digit'+key,bubbles:true,cancelable:true,...(mods||{})};(document.activeElement||document.body).dispatchEvent(new KeyboardEvent('keydown',o))},
 activeInShared:()=>!!document.activeElement?.closest?.('[data-shared-workspace]'),
 activeInLocal:()=>!!document.activeElement?.closest?.('[data-pane-cell]'),
 geom:id=>{const c=document.querySelector('[data-remote-term="'+id+'"]');const s=c?.querySelector('.xterm-screen');if(!c||!s)return null;const cr=c.getBoundingClientRect(),sr=s.getBoundingClientRect();return{cw:cr.width,ch:cr.height,sw:sr.width,sh:sr.height,font:Number(c.dataset.fitFont||0),host:c.dataset.hostSize,overflow:getComputedStyle(c).overflow}},
 cellPoint:(id,col,row)=>{const c=document.querySelector('[data-remote-term="'+id+'"]');const s=c.querySelector('.xterm-screen');const r=s.getBoundingClientRect();const cols=120,rows=40;return{x:r.left+(col+0.5)*r.width/cols,y:r.top+(row+0.5)*r.height/rows,el:s}},
 hover:(id,col,row)=>{const p=window.smoke.cellPoint(id,col,row);p.el.dispatchEvent(new MouseEvent('mousemove',{bubbles:true,clientX:p.x,clientY:p.y}))},
 press:(id,col,row)=>{const p=window.smoke.cellPoint(id,col,row);for(const t of ['mousedown','mouseup','click'])p.el.dispatchEvent(new MouseEvent(t,{bubbles:true,cancelable:true,button:0,buttons:t==='mousedown'?1:0,clientX:p.x,clientY:p.y,detail:1}))},
 overflow:()=>document.documentElement.scrollWidth>innerWidth,
 pasteInvite:()=>setVal(document.querySelector('[data-join-invite]'),INVITE.slice(0,14)+'\\n  '+INVITE.slice(14)),
 replayHello:()=>window.smoke.stream([{t:'replay',paneId:'sp1',running:true,cols:120,rows:40,data:'\\x1b[2J\\x1b[Hhello from the host\\r\\n',first:true,last:true}]),
 clipMultiline:()=>{clipText='echo one\\nrm -rf /'},
 outOsc:()=>window.smoke.stream([{t:'out',paneId:'sp1',data:'\\x1b]52;c;aGVsbG8=\\x07\\x1b]0;evil title\\x07\\x1b]7;file:///C:/Windows\\x07after\\r\\n'}]),
 replayLinks:()=>window.smoke.stream([{t:'replay',paneId:'sp1',running:true,cols:120,rows:40,data:'\\x1b[H\\x1b[2J\\x1b]8;;https://evil.example/steal?x=1\\x07click here\\x1b]8;;\\x07\\r\\nsee https://docs.example.com/page now\\r\\n',first:true,last:true}]),
 linkRow:()=>document.querySelector('[data-shared-link="'+LINK+'"]'),
 openLinkRow:()=>document.querySelector('[data-shared-link-open="'+LINK+'"]').click(),
};
createRoot(document.getElementById('root')).render(<Root/>);
`, resolveDir: root, loader: 'tsx' }, bundle: true, platform: 'browser', format: 'iife', outfile: path.join(dir, 'renderer.js'), alias: { '@shared': path.join(root, 'src/shared'), '@': path.join(root, 'src/renderer') }, jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' }, loader: { '.ttf': 'empty', '.woff': 'empty', '.woff2': 'empty' }, logLevel: 'error' })
fs.writeFileSync(path.join(dir, 'index.html'), `<html><head><meta charset="utf-8">${css ? `<link rel="stylesheet" href="${pathToFileURL(path.join(assets, css))}">` : ''}<link rel="stylesheet" href="renderer.css"></head><body><div id="root"></div><script src="renderer.js"></script></body></html>`)
fs.writeFileSync(path.join(dir, 'main.cjs'), `
const {app,BrowserWindow}=require('electron');const fs=require('fs'),path=require('path');
app.setPath('userData',path.join(__dirname,'profile'));
const wait=ms=>new Promise(r=>setTimeout(r,ms));
app.whenReady().then(async()=>{
 const w=new BrowserWindow({width:1280,height:820,show:false,webPreferences:{sandbox:true,backgroundThrottling:false}});
 let failures=[];w.webContents.on('console-message',(_e,level,message)=>{if(level>=3)failures.push(message)});
 await w.loadFile(path.join(__dirname,'index.html'));
 const js=c=>w.webContents.executeJavaScript(c);
 const frame=()=>js('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
 const settle=async(ms=120)=>{await frame();await wait(ms)};
 const shot=async name=>{await settle(150);fs.writeFileSync(path.join(__dirname,name+'.png'),(await w.webContents.capturePage()).toPNG())};
 const LINK='AbCdEfGhIjKlMnOpQrStUv';
 let n=0;const ok=(c,label,v)=>{if(!c)throw new Error(label+(v!==undefined?' '+JSON.stringify(v):'')+(failures.length?' console: '+failures.join(' | '):''));n++};
 for(let i=0;i<60&&!(await js("smoke.calls.spawn.length>0&&!!document.querySelector('[data-pane-cell] .xterm')"));i++)await wait(100);
 ok(await js("smoke.calls.spawn.includes('local1')"),'the local console mounted and spawned');
 ok(await js("smoke.has('[data-shared-with-me]')&&smoke.text('[data-shared-with-me]').includes('Compartido conmigo')"),'the sidebar shows "Shared with me" (es)');

 // Join: preview from main, the name the host sees, then the approval wait.
 await js("smoke.click('[data-share-join]')");await settle();
 ok(await js("smoke.has('[data-join-share]')"),'Join a share... opens the dialog');
 await js("smoke.setVal('[data-join-invite]','not an invite')");await wait(350);
 ok(await js("smoke.has('[data-join-preview-error]')&&!smoke.has('[data-join-preview]')&&document.querySelector('[data-join-submit]').disabled"),'a bad invite shows an error and Join stays disabled');
 await js("smoke.pasteInvite()");await wait(350);
 let v=await js("({prev:smoke.calls.preview.at(-1),text:smoke.text('[data-join-preview]'),dis:document.querySelector('[data-join-submit]').disabled})");
 ok(v.prev===await js('smoke.INVITE')&&v.text.includes('Host PC')&&v.text.includes('AB12-CD34-EF56-7890')&&v.text.includes('100.64.0.7:4527')&&v.text.includes('Solo escribir')&&!v.dis,'the preview (whitespace stripped) shows host, key, endpoints and permission',v);
 await js("smoke.setVal('[data-join-name]','Ana')");
 await js("smoke.click('[data-join-submit]')");await settle(200);
 v=await js("({join:smoke.calls.join,save:smoke.calls.save.at(-1)?.settings?.share?.guestName,panel:document.querySelector('[data-link-panel]')?.dataset.linkPanel})");
 ok(v.join.length===1&&v.save==='Ana'&&v.panel==='connecting','Join saves the name first, then joins and shows the wait',v);
 await js("smoke.link('waiting_approval',{pending:{expiresAt:Date.now()+60000,password:true}})");await settle();
 ok(await js("smoke.text('[data-link-panel]').includes('Esperando que Host PC apruebe')&&smoke.has('[data-link-password]')"),'waiting for approval with the password field');
 await js("smoke.setVal('[data-link-password]','hunter2hunter2')");await js("smoke.click('[data-link-pw-send]')");await settle();
 v=await js("smoke.calls.password");ok(v.length===1&&v[0].password==='hunter2hunter2'&&v[0].remember===true&&v[0].linkId===LINK,'the password goes to main with remember',v);
 await js("smoke.link('password_required',{pending:{expiresAt:Date.now()+50000,password:true,passwordFailed:true}})");await settle();
 ok(await js("smoke.has('[data-link-pw-wrong]')"),'a wrong password says so and the wait goes on');
 await shot('share-join-wait');
 await js("smoke.state('type');smoke.link('connected',{perm:'type',host:{label:'Host PC',platform:'win32',app:'2.4.0'}})");await settle(250);
 v=await js("({dialog:smoke.has('[data-join-share]'),view:smoke.has('[data-shared-workspace]'),active:smoke.store().activeLinkId,sub:smoke.calls.sub,setActive:smoke.calls.setActive.at(-1)})");
 ok(!v.dialog&&v.view&&v.active===await js('smoke.LINK'),'connected: the dialog closes and the shared view opens',v);
 ok(v.sub.includes(await js("smoke.LINK+':sp1'")),'the mounted pane subscribes',v);
 ok(Array.isArray(v.setActive)&&v.setActive.length===0,'the local grid reports no visible pane while the view covers it',v);
 v=await js("(()=>{const m=document.querySelector('main').getBoundingClientRect();return [[m.right-40,m.top+20],[m.left+m.width/2,m.top+m.height/2]].map(([x,y])=>!!document.elementFromPoint(x,y)?.closest('[data-shared-workspace]'))})()");
 ok(v.every(Boolean),'the view covers the local header menus and grid',v);
 v=await js("({row:!!smoke.linkRow(),perm:document.querySelector('[data-shared-link-perm]')?.dataset.sharedLinkPerm,pane:smoke.has('[data-shared-pane-row=sp1]'),hdr:smoke.text('[data-shared-view]')})");
 ok(v.row&&v.perm==='type'&&v.pane&&v.hdr.includes('Host PC')&&v.hdr.includes('Solo escribir')&&v.hdr.includes('Conectado'),'sidebar link row, perm chip, pane row and header',v);

 // A 120x40 host replay: the font fits the cell (6 px or more) or the area scrolls; no pty resize.
 const resize0=await js('smoke.calls.resize.length');
 await js("smoke.replayHello()");await settle(300);
 v=await js("smoke.geom('sp1')");
 ok(v&&v.host==='120x40'&&v.font>=6,'the replay sets the host grid and a font of 6 px or more',v);
 ok((v.sw<=v.cw+1&&v.sh<=v.ch+1)||v.overflow==='auto','the 120x40 grid fits the cell or the area scrolls',v);
 ok((await js('smoke.calls.resize.length'))===resize0,'the guest never resizes a pty');
 await shot('share-view-dark');

 // Type: Enter, a multi-line paste and Ctrl+C refused locally with the strip; text and Esc go out.
 await js("smoke.calls.input.length=0;smoke.key('sp1','a',65)");await settle();
 v=await js("smoke.calls.input");ok(v.length===1&&v[0].data==='a'&&v[0].paneId==='sp1'&&!v[0].paste,'a letter is sent',v);
 await js("smoke.key('sp1','Enter',13)");await settle();
 v=await js("({n:smoke.calls.input.length,b:document.querySelector('[data-guest-banner]')?.dataset.guestBanner,t:smoke.text('[data-guest-banner]')})");
 ok(v.n===1&&v.b==='notice'&&v.t.includes('Enter deshabilitado'),'Enter is refused locally with the strip message',v);
 await js("smoke.clipMultiline();smoke.key('sp1','v',86,{ctrlKey:true})");await settle(200);
 v=await js("({n:smoke.calls.input.length,t:smoke.text('[data-guest-banner]')})");
 ok(v.n===1&&v.t.includes('Enter deshabilitado'),'a multi-line paste is refused whole',v);
 await js("smoke.setClip('ls');smoke.key('sp1','v',86,{ctrlKey:true})");await settle(200);
 v=await js("smoke.calls.input.at(-1)");ok(v&&v.paste===true&&v.data.includes('ls')&&!/[\\r\\n]/.test(v.data),'a one-line paste goes as one paste unit',v);
 const nBefore=await js('smoke.calls.input.length');
 await js("smoke.key('sp1','c',67,{ctrlKey:true})");await settle();
 v=await js("({n:smoke.calls.input.length,t:smoke.text('[data-guest-banner]')})");
 ok(v.n===nBefore&&v.t.includes('Ctrl+C'),'Ctrl+C is refused locally with the strip message',v);
 await shot('share-type-notice');
 await js("smoke.key('sp1','Escape',27)");await settle();
 v=await js("smoke.calls.input.at(-1)");ok(v.data==='\\x1b','Esc is sent',v);
 await wait(1100);
 // The strip goes back to its line after 3 s.
 await wait(2100);
 v=await js("({b:document.querySelector('[data-guest-banner]').dataset.guestBanner,t:smoke.text('[data-guest-banner]')})");
 ok(v.b==='base'&&v.t.includes('Compartido por Host PC')&&v.t.includes('Enter deshabilitado'),'after 3 s the strip says who shares and that Enter is off',v);

 // Host typing lock.
 await js("smoke.stream([{t:'inputLock',paneId:'sp1',holder:'host'}])");await settle();
 v=await js("({b:document.querySelector('[data-guest-banner]').dataset.guestBanner,t:smoke.text('[data-guest-banner]')})");
 ok(v.b==='host'&&v.t.includes('El dueño está escribiendo'),'the host-typing strip',v);
 const nLock=await js('smoke.calls.input.length');
 await js("smoke.key('sp1','q',81)");await settle();
 ok((await js('smoke.calls.input.length'))===nLock,'keys are held while the host types');
 await js("smoke.stream([{t:'inputLock',paneId:'sp1',holder:null}])");await settle(3200);

 // Untrusted output: OSC 52 never reaches the clipboard, a title never reaches status.
 await js("smoke.calls.clip.length=0;smoke.calls.titles.length=0");
 await js("smoke.outOsc()");await settle(200);
 v=await js("({clip:smoke.calls.clip,titles:smoke.calls.titles})");
 ok(v.clip.length===0&&v.titles.length===0,'OSC 52 and the title are swallowed',v);

 // Links: OSC 8 and a plain URL open the confirm dialog with the full URL.
 await js("smoke.replayLinks()");await settle(300);
 await js("smoke.hover('sp1',3,0)");await wait(250);await js("smoke.press('sp1',3,0)");await settle(200);
 v=await js("({open:smoke.has('[data-share-link-dialog]'),url:smoke.text('[data-share-link-url]'),ext:smoke.calls.open.length})");
 ok(v.open&&v.url==='https://evil.example/steal?x=1'&&v.ext===0,'an OSC 8 link opens the confirm dialog with its real target',v);
 await shot('share-link-confirm');
 await js("smoke.click('[data-share-link-cancel]')");await settle();
 ok(!(await js("smoke.has('[data-share-link-dialog]')"))&&(await js('smoke.calls.open.length'))===0,'Cancel opens nothing');
 await js("smoke.hover('sp1',8,1)");await wait(250);await js("smoke.press('sp1',8,1)");await settle(200);
 v=await js("({url:smoke.text('[data-share-link-url]'),ext:smoke.calls.open.length})");
 ok(v.url==='https://docs.example.com/page'&&v.ext===0,'a plain URL opens the confirm dialog too',v);
 await js("smoke.click('[data-share-link-open]')");await settle();
 v=await js("smoke.calls.open");ok(v.length===1&&v[0]==='https://docs.example.com/page','Open in browser opens exactly that URL',v);
 await js("smoke.store().confirmLink('file:///C:/Windows/System32/calc.exe','Host PC')");await settle();
 ok((await js("smoke.has('[data-share-link-blocked]')&&!smoke.has('[data-share-link-open]')")),'a non-http link cannot be opened');
 await js("smoke.click('[data-share-link-cancel]')");await settle();

 // Backpressure: more than 1 MB pending pauses the pane in main, the drain resumes it.
 await js("smoke.calls.flow.length=0;smoke.stream([{t:'out',paneId:'sp1',data:'x'.repeat(1100000)}])");
 for(let i=0;i<50&&(await js("!smoke.calls.flow.some(f=>f.pause===false)"));i++)await wait(100);
 v=await js("smoke.calls.flow");ok(v.length>=2&&v[0].pause===true&&v.at(-1).pause===false&&v.every(f=>f.paneId==='sp1'),'HIGH_WATER pauses and LOW_WATER resumes the pane',v);

 // View: the helper textarea is read-only and nothing is sent.
 await js("smoke.link('connected',{perm:'view',host:{label:'Host PC',platform:'win32',app:'2.4.0'}})");await settle();
 const nView=await js('smoke.calls.input.length');
 await js("smoke.key('sp1','z',90);smoke.key('sp1','Enter',13);smoke.setClip('x');smoke.key('sp1','v',86,{ctrlKey:true})");await settle(200);
 v=await js("({ro:smoke.ta('sp1').readOnly,n:smoke.calls.input.length,perm:document.querySelector('[data-remote-term=sp1]').dataset.sharePerm,banner:smoke.text('[data-guest-banner]')})");
 ok(v.ro&&v.n===nView&&v.perm==='view'&&v.banner.includes('Solo ver'),'view: read-only textarea, nothing sent',v);
 await js("smoke.link('connected',{perm:'type',host:{label:'Host PC',platform:'win32',app:'2.4.0'}})");await settle();
 ok(!(await js("smoke.ta('sp1').readOnly")),'back to type: the textarea takes keys again');

 // Overlay focus: Ctrl+1 never reaches the hidden local console.
 await js("smoke.ta('sp1').focus();smoke.calls.writes.length=0");
 await js("smoke.winKey('1',49,{ctrlKey:true})");await settle(200);
 v=await js("({w:smoke.calls.writes,active:smoke.store().activeLinkId,local:smoke.activeInLocal(),shared:smoke.activeInShared()})");
 ok(v.w.length===0&&v.active===LINK&&!v.local&&v.shared,'Ctrl+1 sends nothing to a local pty and keeps the shared view focused',v);
 await js("smoke.winKey('1',49,{altKey:true})");await settle(250);
 v=await js("({active:smoke.store().activeLinkId,set:smoke.calls.setActive.at(-1)})");
 ok(v.active===null&&JSON.stringify(v.set)==='["local1"]','Alt+1 on the active local workspace leaves the view and the grid is visible again',v);
 await js("smoke.openLinkRow()");await settle(250);
 await js("document.querySelector('[data-sidebar-ws=w1] button').click()");await settle(250);
 ok((await js("smoke.store().activeLinkId"))===null,'a click on the local workspace row leaves the view');
 ok(await js("smoke.calls.unsub.includes(smoke.LINK+':sp1')"),'leaving the view unsubscribes the pane');
 await js("smoke.click('[data-shared-pane-row=sp1]')");await settle(250);
 ok((await js("smoke.store().activeLinkId"))===await js('smoke.LINK'),'a pane row reopens the view');
 await js("smoke.revealPane('local1')");await settle(250);
 ok((await js("smoke.store().activeLinkId"))===null,'revealing a local console leaves the view');
 await js("smoke.openLinkRow()");await settle(250);
 await js("smoke.app().setActive('w2')");await settle(150);
 ok((await js("smoke.store().activeLinkId"))===null,'a programmatic switch (phone, CLI) leaves the view (one guard)');
 await js("smoke.app().setActive('w1')");await settle(150);

 // The config never holds a shared pane.
 await js("smoke.openLinkRow()");await settle(250);
 v=await js("({snap:JSON.stringify(smoke.snapshotConfig()),saves:JSON.stringify(smoke.calls.save),ws:smoke.app().workspaces.map(w=>w.panes.map(p=>p.id))})");
 ok(!v.snap.includes('sp1')&&!v.snap.includes(await js('smoke.LINK'))&&!v.saves.includes('sp1')&&JSON.stringify(v.ws)==='[["local1"],["local2"]]','config and the store hold no shared pane or link',v);

 // es/en, light/dark, end reasons.
 await js("smoke.setLang('en')");await settle();
 v=await js("({b:smoke.text('[data-guest-banner]'),s:smoke.text('[data-shared-with-me]'),over:smoke.overflow()})");
 ok(v.b.includes('Shared by Host PC - Type only (Enter disabled)')&&v.s.includes('Shared with me')&&!v.over,'en strings, no horizontal overflow',v);
 await js("smoke.theme('light')");await shot('share-view-light');await js("smoke.theme('midnight')");
 await js("smoke.link('ended',{reason:'revoked'})");await settle();
 v=await js("({panel:document.querySelector('[data-link-panel]')?.dataset.linkPanel,t:smoke.text('[data-link-panel]'),row:document.querySelector('[data-shared-link]')?.dataset.sharedLinkStatus})");
 ok(v.panel==='ended'&&v.t.includes('The host revoked your access')&&v.row==='ended','an ended link says why, in the view and the row',v);
 await js("smoke.click('[data-link-connect]')");await settle();
 ok((await js('smoke.calls.connect.length'))>=1,'Try again connects');
 await js("smoke.setLang('es');smoke.link('connected',{perm:'full',host:{label:'Host PC',platform:'win32',app:'2.4.0'}})");await settle(250);
 await js("smoke.click('[data-shared-disconnect]')");await settle();
 ok(JSON.stringify(await js('smoke.calls.disconnect'))===JSON.stringify([await js('smoke.LINK')]),'Disconnect disconnects that link');

 // --- S5: whole-workspace full control (New / Close console, Chat, Notes, Changes) ---
 await js("smoke.stateFull([smoke.sp('sp1'),smoke.sp('sp2',{type:'claude',title:'Agent',icon:'bot'})]);smoke.link('connected',{perm:'full',scope:{kind:'workspace',label:'Team'},lastConnectedAt:1,host:{label:'Host PC',platform:'win32',app:'2.4.0'}})");await settle(250);
 v=await js("({nc:smoke.visible('[data-shared-extra=newConsole]'),chat:smoke.visible('[data-shared-extra=chat]'),notes:smoke.visible('[data-shared-extra=notes]'),ch:smoke.visible('[data-shared-extra=changes]'),hiddenLeft:smoke.count('[data-shared-extra][hidden]'),pc2:smoke.has('[data-shared-pane-chat=sp2]'),pc1:smoke.has('[data-shared-pane-chat=sp1]'),close:smoke.has('[data-shared-pane-close=sp1]')&&smoke.has('[data-shared-pane-close=sp2]')})");
 ok(v.nc&&v.chat&&v.notes&&v.ch&&v.hiddenLeft===0,'full on a workspace: New console, Chat, Notes and Changes show in the header',v);
 ok(v.pc2&&!v.pc1&&v.close,'cells: Chat only on the agent console, Close on every console',v);

 // New console: the host presets only; the ack's pane shows before any state lists it.
 await js("smoke.fakes.ctl=r=>r.op==='createPane'?{ok:true,paneId:'sp9'}:{ok:true};smoke.calls.ctl.length=0");
 await js("smoke.click('[data-shared-extra=newConsole]')");await settle();
 v=await js("({items:[...document.querySelectorAll('[data-shared-preset]')].map(e=>e.dataset.sharedPreset),text:smoke.text('[data-shared-new-menu]')})");
 ok(JSON.stringify(v.items)==='[\"pre1\",\"pre2\"]'&&v.text.includes('Claude')&&v.text.includes('Shell'),'the New console menu lists the host presets',v);
 await js("smoke.click('[data-shared-preset=pre1]')");await settle(250);
 v=await js("({ctl:smoke.calls.ctl,cell:smoke.has('[data-shared-pane=sp9]'),title:smoke.text('[data-shared-pane=sp9]'),sub:smoke.calls.sub.includes(smoke.LINK+':sp9'),menu:smoke.has('[data-shared-new-menu]')})");
 ok(v.ctl.length===1&&JSON.stringify(v.ctl[0])===JSON.stringify({linkId:LINK,op:'createPane',presetId:'pre1'}),'createPane goes to main with the preset id only (no prompt, cwd nor resume)',v);
 ok(v.cell&&v.title.includes('Claude')&&v.sub&&!v.menu,'the acked console shows at once (named after its preset) and subscribes',v);
 await js("smoke.stateFull([smoke.sp('sp1'),smoke.sp('sp2',{type:'claude',title:'Agent',icon:'bot'}),smoke.sp('sp9',{type:'claude',title:'Claude 2',icon:'bot'})])");await settle();
 v=await js("({n:smoke.count('[data-shared-pane=sp9]'),title:smoke.text('[data-shared-pane=sp9]'),pending:(smoke.extras().pendingPanes[smoke.LINK]||[]).length})");
 ok(v.n===1&&v.title.includes('Claude 2')&&v.pending===0,'once the state lists it, the pending cell gives way to the host one',v);
 await js("smoke.fakes.ctl=()=>({ok:false,error:'rate'})");
 await js("smoke.click('[data-shared-extra=newConsole]')");await settle();await js("smoke.click('[data-shared-preset=pre2]')");await settle(250);
 v=await js("smoke.toasts().map(t=>({k:t.kind,title:t.title,body:t.body}))");
 ok(v.some(t=>t.k==='error'&&t.title.includes('No se creó')&&t.body.includes('Demasiados')),'a refused createPane says why in a toast',v);

 // Close console: asks first (Esc cancels), then relays closePane.
 await js("smoke.fakes.ctl=()=>({ok:true});smoke.calls.ctl.length=0");
 await js("smoke.click('[data-shared-pane-close=sp1]')");await settle();
 v=await js("({dlg:smoke.has('[data-confirm]'),text:document.body.innerText.includes('Host PC')})");
 ok(v.dlg&&v.text,'Close console asks first, naming the host',v);
 await js("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}))");await settle();
 ok(!(await js("smoke.has('[data-confirm]')"))&&(await js('smoke.calls.ctl.length'))===0,'Esc cancels: nothing is relayed');
 await js("smoke.click('[data-shared-pane-close=sp1]')");await settle();await js("smoke.click('[data-confirm]')");await settle(200);
 v=await js("smoke.calls.ctl");ok(v.length===1&&JSON.stringify(v[0])===JSON.stringify({linkId:LINK,op:'closePane',paneId:'sp1'}),'confirming relays closePane for that console',v);

 // Chat: read only, links confirmed, Load earlier, append, no composer, unsub on close.
 await js("smoke.calls.chat.length=0;smoke.click('[data-shared-pane-chat=sp2]')");await settle(250);
 v=await js("({drawer:smoke.has('[data-drawer=share-chat]'),chat:smoke.calls.chat,inShared:!!document.querySelector('[data-drawer=share-chat]')?.closest('[data-shared-workspace]')})");
 ok(v.drawer&&v.inShared&&v.chat.length===1&&JSON.stringify(v.chat[0])===JSON.stringify({linkId:LINK,op:'sub',paneId:'sp2'}),'the Chat drawer opens inside the shared view and reads the chat',v);
 await js("smoke.chatEvt({t:'chatPage',paneId:'sp2',items:[smoke.msg('200','user',[{t:'text',text:'fix the build'}]),smoke.msg('210','assistant',[{t:'text',text:'See [the docs](https://docs.example.com/x) and [run](javascript:alert(1)).'}]),smoke.msg('220','assistant',[{t:'toolUse',id:'u1',name:'Read',summary:'a.ts'},{t:'toolUse',id:'u2',name:'Read',summary:'b.ts'}]),smoke.msg('230','tool',[{t:'toolResult',toolUseId:'u1',isError:false,text:'ok'},{t:'toolResult',toolUseId:'u2',isError:false,text:'ok'}])],cursor:'200',done:false})");await settle(250);
 v=await js("({rows:smoke.count('[data-drawer=share-chat] [data-chat-row]'),user:smoke.text('[data-chat-user]'),tool:smoke.text('[data-tool-label]'),link:document.querySelector('[data-drawer=share-chat] [data-md-link]')?.tagName,anchors:smoke.count('[data-drawer] a'),inert:smoke.text('[data-md-inert-link]'),inputs:smoke.count('[data-drawer=share-chat] textarea, [data-drawer=share-chat] input, [data-drawer=share-chat] [contenteditable]')})");
 ok(v.rows===2&&v.user.includes('fix the build')&&v.tool.includes('Read 2 archivos'),'the page renders: the prompt, the reply and the tool calls folded into one row',v);
 ok(v.link==='BUTTON'&&v.anchors===0&&v.inert==='run','an http link is a button (never an anchor); a javascript: link is inert text',v);
 ok(v.inputs===0,'no composer: the guest writes only in the terminal',v);
 await js("smoke.calls.open.length=0;smoke.click('[data-drawer=share-chat] [data-md-link]')");await settle();
 v=await js("({dlg:smoke.has('[data-share-link-dialog]'),url:smoke.text('[data-share-link-url]'),open:smoke.calls.open.length})");
 ok(v.dlg&&v.url==='https://docs.example.com/x'&&v.open===0,'a chat link opens the confirm dialog with its full target, nothing opens yet',v);
 await js("smoke.click('[data-share-link-cancel]')");await settle();
 ok(await js("smoke.has('[data-drawer=share-chat]')"),'cancelling the link keeps the chat open');
 await js("smoke.click('[data-chat-load-earlier]')");await settle();
 v=await js("smoke.calls.chat.at(-1)");ok(v&&v.op==='more'&&v.before==='200'&&v.paneId==='sp2','Load earlier asks for the page before the oldest message',v);
 await js("smoke.chatEvt({t:'chatPage',paneId:'sp2',items:[smoke.msg('100','user',[{t:'text',text:'older prompt'}])],cursor:null,done:true})");await settle(200);
 v=await js("({first:document.querySelector('[data-drawer=share-chat] [data-chat-row]')?.dataset.chatId,earlier:smoke.has('[data-chat-load-earlier]')})");
 ok(v.first==='100'&&!v.earlier,'the older page goes in front and the button goes away at the start',v);
 await js("smoke.chatEvt({t:'chatAppend',paneId:'sp2',items:[smoke.msg('300','assistant',[{t:'text',text:'all green now'}])]})");await settle(200);
 ok((await js("smoke.text('[data-drawer=share-chat] [data-chat-scroll]')")).includes('all green now'),'chatAppend adds the new message');
 await js("smoke.stream([{t:'paneStatus',paneId:'sp2',status:{state:'working',stateSince:1,provider:'claude'}}])");await settle();
 ok((await js("smoke.text('[data-chat-working]')")).includes('Claude está trabajando'),'the working row follows the shared status');
 // A new session (reconnect) reads the chat again: the host forgot the old reader.
 await js("smoke.calls.chat.length=0;smoke.link('reconnecting',{perm:'full',scope:{kind:'workspace',label:'Team'},lastConnectedAt:1})");await settle();
 await js("smoke.link('connected',{perm:'full',scope:{kind:'workspace',label:'Team'},lastConnectedAt:2,host:{label:'Host PC',platform:'win32',app:'2.4.0'}})");await settle(250);
 v=await js("smoke.calls.chat");ok(v.some(c=>c.op==='unsub')&&v.at(-1).op==='sub'&&v.at(-1).paneId==='sp2','a reconnect subscribes the chat again',v);
 await shot('share-s5-chat');
 await js("smoke.chatEvt({t:'chatPage',paneId:'sp2',items:[{id:'notice',role:'system',ts:null,blocks:[{t:'notice',code:'noTranscript'}]}],cursor:null,done:true})");await settle();
 ok((await js("smoke.text('[data-chat-notice]')")).includes('Chat no disponible'),'a notice page says the console has no chat');
 await js("smoke.calls.chat.length=0;smoke.click('[data-drawer=share-chat] [data-drawer-close]')");await settle(200);
 v=await js("({open:smoke.has('[data-drawer=share-chat]'),chat:smoke.calls.chat})");
 ok(!v.open&&v.chat.length===1&&v.chat[0].op==='unsub'&&v.chat[0].paneId==='sp2','closing the drawer stops reading the chat',v);

 // Notes: list and read only; links confirmed; notesChanged reloads.
 await js("smoke.fakes.notes=r=>r.op==='list'?{ok:true,reply:{ok:true,notes:[{id:'n1',title:'Plan',updatedAt:Date.now()-60000,size:10,rev:'a'},{id:'n2',title:'',updatedAt:Date.now()-120000,size:0,rev:'b'}]}}:{ok:true,reply:{ok:true,note:{id:r.noteId,title:'Plan',updatedAt:1,size:10,rev:'a',text:'# Plan\\\\n\\\\nRead [spec](https://spec.example.com/a).'}}};smoke.calls.notes.length=0");
 await js("smoke.click('[data-shared-extra=notes]')");await settle(250);
 v=await js("({drawer:smoke.has('[data-drawer=share-notes]'),calls:smoke.calls.notes,rows:smoke.count('[data-shared-note]'),text:smoke.text('[data-shared-notes-list]')})");
 ok(v.drawer&&v.calls.length===1&&v.calls[0].op==='list'&&v.rows===2&&v.text.includes('Plan')&&v.text.includes('Sin título'),'Notes lists the host notes (untitled named so)',v);
 await js("smoke.click('[data-shared-note=n1]')");await settle(250);
 v=await js("({call:smoke.calls.notes.at(-1),view:smoke.text('[data-shared-note-view]'),btn:document.querySelector('[data-drawer=share-notes] [data-md-link]')?.tagName,edit:smoke.count('[data-drawer=share-notes] textarea, [data-drawer=share-notes] [contenteditable], [data-drawer=share-notes] .cm-editor'),anchors:smoke.count('[data-drawer] a')})");
 ok(v.call.op==='read'&&v.call.noteId==='n1'&&v.view.includes('Plan')&&v.btn==='BUTTON'&&v.anchors===0&&v.edit===0,'a note opens read only, its links are buttons, no editor',v);
 await js("smoke.click('[data-drawer=share-notes] [data-md-link]')");await settle();
 ok((await js("smoke.text('[data-share-link-url]')"))==='https://spec.example.com/a','a note link goes through the confirm dialog');
 await js("smoke.click('[data-share-link-cancel]')");await settle();
 const nNotes=await js('smoke.calls.notes.length');
 await js("smoke.linkEvt({t:'notesChanged',noteId:'n1'})");await settle(250);
 v=await js("smoke.calls.notes.slice("+nNotes+").map(c=>c.op+':'+(c.noteId||''))");
 ok(v.includes('list:')&&v.includes('read:n1'),'notesChanged reloads the list and the open note',v);
 await shot('share-s5-notes');

 // Changes: status sections, a file's diff in pages, read only.
 await js("smoke.calls.git.length=0;smoke.fakes.git=r=>r.op==='status'?{ok:true,reply:{ok:true,data:{summary:{branch:'feat/x',ahead:0,behind:0,added:5,removed:2,files:2,approx:false,conflicts:0,op:null},files:[{path:'src/a.ts',area:'unstaged',status:'M',added:3,removed:1,binary:false},{path:'new.md',area:'untracked',status:'?',added:2,removed:0,binary:false}],total:2,truncated:false},page:0,done:true}}:{ok:true,reply:{ok:true,data:{path:r.path,area:'unstaged',diffRev:'r1',binary:false,hunks:[{header:'@@ -1,2 +1,3 @@',oldStart:1,newStart:1,lines:r.page?[{kind:'add',newNo:3,text:'page two'}]:[{kind:'ctx',oldNo:1,newNo:1,text:'one'},{kind:'add',newNo:2,text:'two'}],...(r.page?{continued:true}:{})}]},page:r.page||0,done:!!r.page}}}");
 await js("smoke.click('[data-shared-extra=changes]')");await settle(300);
 v=await js("({drawer:smoke.has('[data-drawer=share-changes]'),notes:smoke.has('[data-drawer=share-notes]'),call:smoke.calls.git[0],sum:smoke.text('[data-shared-changes-summary]'),secs:[...document.querySelectorAll('[data-shared-changes-section]')].map(e=>e.dataset.sharedChangesSection)})");
 ok(v.drawer&&!v.notes&&v.call.op==='status'&&v.call.page===0&&v.call.linkId===LINK&&v.sum.includes('feat/x')&&JSON.stringify(v.secs)==='[\"unstaged\",\"untracked\"]','Changes replaces Notes (one drawer) and shows the host status in sections',v);
 await js("[...document.querySelectorAll('[data-shared-change]')].find(e=>e.dataset.sharedChange==='unstaged:src/a.ts').click()");await settle(300);
 v=await js("({call:smoke.calls.git.at(-1),lines:smoke.count('[data-drawer=share-changes] [data-line]'),more:smoke.has('[data-shared-diff-more]')})");
 ok(v.call.op==='diff'&&v.call.path==='src/a.ts'&&v.call.staged===false&&v.call.page===0&&v.lines===2&&v.more,'a file shows its first diff page and offers the rest',v);
 await js("smoke.click('[data-shared-diff-more]')");await settle(300);
 v=await js("({call:smoke.calls.git.at(-1),lines:smoke.count('[data-drawer=share-changes] [data-line]'),hunks:smoke.count('[data-drawer=share-changes] [data-hunk]'),more:smoke.has('[data-shared-diff-more]'),edit:smoke.count('[data-drawer=share-changes] [data-new-line] button')})");
 ok(v.call.page===1&&v.lines===3&&v.hunks===1&&!v.more&&v.edit===0,'the next page joins the continued hunk; no review-note buttons (read only)',v);
 await shot('share-s5-changes');

 // A live downgrade takes every extra away and closes the drawer.
 await js("smoke.link('connected',{perm:'type',scope:{kind:'workspace',label:'Team'},lastConnectedAt:2,host:{label:'Host PC',platform:'win32',app:'2.4.0'}});smoke.stateFull([smoke.sp('sp2',{type:'claude',title:'Agent',icon:'bot'}),smoke.sp('sp9',{type:'claude',title:'Claude 2',icon:'bot'})],{perm:'type',caps:{createPane:false,closePane:false,chat:false,notes:false,git:false},presets:undefined})");await settle(250);
 v=await js("({extras:smoke.count('[data-shared-extra]'),drawer:smoke.has('[data-drawer]'),close:smoke.count('[data-shared-pane-close]'),chat:smoke.count('[data-shared-pane-chat]'),panel:smoke.extras().panel[smoke.LINK]})");
 ok(v.extras===0&&!v.drawer&&v.close===0&&v.chat===0&&!v.panel,'type: no extras, no drawer, no Close nor Chat on the cells',v);
 v=await js("({snap:JSON.stringify(smoke.snapshotConfig()),saves:JSON.stringify(smoke.calls.save),ws:smoke.app().workspaces.map(w=>w.panes.map(p=>p.id))})");
 ok(!v.snap.includes('sp9')&&!v.saves.includes('sp9')&&JSON.stringify(v.ws)==='[[\"local1\"],[\"local2\"]]','a console created on the host never enters the local config or store',v);
 await shot('share-final');
 const real=failures.filter(f=>!/Download the React DevTools/.test(f));
 if(real.length)throw new Error(real.join('\\n'));
 console.log('PASS: '+n+' share guest UI checks (join with preview, name and password wait, host-size fit at 6px+ or scroll, no pty resize, view read-only, type refusals with Esc allowed, OSC 52 and titles swallowed, OSC 8 and URL confirm, host-typing strip, backpressure, overlay focus and Ctrl+1, config clean, end reasons, es/en, light/dark; S5 New and Close console, read-only Chat, Notes and Changes, downgrade); screenshots '+__dirname);w.destroy();app.quit();
}).catch(e=>{console.error(e);app.exit(1)});
`)
if (process.env.SHARE_UI_BUNDLE_ONLY) {
  console.log('bundled: ' + dir)
  return
}
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
const res = spawnSync(require('electron'), [path.join(dir, 'main.cjs')], { env, windowsHide: true, encoding: 'utf8', timeout: 120000 })
process.stdout.write(res.stdout ?? ''); if (res.status !== 0) process.stderr.write(res.stderr ?? '')
process.exitCode = res.status ?? 1
