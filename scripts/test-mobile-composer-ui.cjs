// Exercise the real phone MainScreen with the docked composer (E1-FR-22..31,
// 38) in an isolated, hidden browser at phone width: the Direct input strip,
// the mode chip and its persistence, the helper textarea going readOnly with
// inputmode=none, KeyBar taps keeping the composer's focus, Send / Insert /
// Stop / slash typing, drafts per pane, offline, the multi-line confirm, the
// Paste one-shot, Quick Commands at the caret, the counter, growth and autocorrect.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path')
const { pathToFileURL } = require('node:url')
const { spawnSync } = require('node:child_process')
const root = path.resolve(__dirname, '..')
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snagentsos-composer-ui-'))
const assets = path.join(root, 'out/mobile/assets')
const mobileCss = fs.existsSync(assets) && fs.readdirSync(assets).find(name => /^index-.*\.css$/.test(name))
if (!mobileCss) throw new Error('Run npm run build:mobile first')
require('esbuild').buildSync({ stdin: { resolveDir: root, loader: 'tsx', contents: `
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { MainScreen } from './src/mobile/src/components/MainScreen';
import { client } from './src/mobile/src/lib/client';
import { store } from './src/mobile/src/lib/store';
import { getActiveTerm } from './src/mobile/src/lib/terminalBus';
import { setLang } from './src/mobile/src/lib/i18n';
window.result = (async () => {
 let checks=0; const check=(ok,label)=>{if(!ok)throw new Error(label);checks++};
 // Hidden windows throttle rAF; React renders on a MessageChannel, so a timer is enough.
 const frames = () => new Promise(r => setTimeout(r, 30));
 const wait = ms => new Promise(r => setTimeout(r, ms));
 const sent=[]; let open=true;
 client.sendInput = data => { if(!open) return false; sent.push(data); return true };
 client.isOpen = () => open;
 const ctls=[]; client.sendCtl = async action => { ctls.push(action); return { ok:true } };
 const snapshot = {
  language:'en', themeTokens:{}, fontFamily:'mono', fontSize:13, activeWorkspaceId:'w1', keyButtons:[],
  quickCommands:[{ id:'s1', name:'Greeting', text:'SNIP', action:'send', enter:false }],
  workspaces:[{ id:'w1', name:'Front', layoutOrder:['c1','s1'], panes:[
   { id:'c1', title:'Claude', type:'claude', color:'', icon:'', running:true },
   { id:'s1', title:'Shell', type:'shell', color:'', icon:'', running:true },
  ] }],
 };
 setLang('en');
 store.getState().update({ phase:'live', banner:null, connected:true, snapshot, activePaneId:'c1', subscribedPaneId:'c1', paneStatus:{} });
 const host=document.getElementById('root'); const reactRoot=createRoot(host);
 flushSync(() => reactRoot.render(<MainScreen />)); await frames(); await wait(50);
 const term=getActiveTerm(); check(!!term,'the terminal mounted');
 const helper=host.querySelector('.xterm-helper-textarea'); check(!!helper,'xterm helper textarea present');
 const q = sel => host.querySelector(sel);
 const key = label => { const b=document.querySelector('button[aria-label="'+label+'"]'); if(!b)throw new Error('missing key '+label); return b };
 const ptr = (el,type,extra={}) => { const r=el.getBoundingClientRect(); const e=new PointerEvent(type,{bubbles:true,cancelable:true,pointerId:1,pointerType:'touch',isPrimary:true,clientX:r.left+10,clientY:r.top+10,...extra}); el.dispatchEvent(e); return e };
 const tap = el => { ptr(el,'pointerdown'); ptr(el,'pointerup') };
 const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set;
 const typeInto = (el,value) => { setter.call(el,value); el.dispatchEvent(new Event('input',{bubbles:true})) };
 const composer = () => q('[data-kb-input="composer"]');
 const sendBtn = () => q('[data-composer-send]');
 const writeTerm = data => new Promise(r => term.write(data, r));

 // Direct mode (default): the strip, a writable helper.
 check(!composer() && !!q('[data-direct-strip]'),'Direct mode shows the strip and no composer');
 check(q('[data-direct-strip]').getBoundingClientRect().height===44,'the strip is 44px tall');
 check(q('[data-direct-strip]').textContent.includes('Direct input - tap to type'),'the strip explains where typing goes');
 check(!helper.readOnly && !helper.hasAttribute('inputmode'),'the helper textarea is writable in Direct mode');
 q('[data-direct-strip]').click();
 check(document.activeElement===helper,'tapping the strip focuses the direct input');
 flushSync(() => store.getState().setKeyboard({ focus:'direct', inset:320 })); await frames();
 check(!q('[data-direct-strip]'),'the strip hides while the keyboard is open');
 helper.blur(); flushSync(() => store.getState().setKeyboard({ focus:null, inset:0 })); await frames();
 check(!!q('[data-direct-strip]'),'the strip returns with the keyboard closed');
 sent.length=0; term.input('d', true); check(sent[0]==='d','Direct mode forwards xterm input');
 const keyEnter = () => helper.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',code:'Enter',keyCode:13,which:13,bubbles:true,cancelable:true}));
 const pasteZz = () => { const dt=new DataTransfer(); dt.setData('text/plain','zz'); helper.dispatchEvent(new ClipboardEvent('paste',{clipboardData:dt,bubbles:true,cancelable:true})) };
 sent.length=0; keyEnter(); check(sent.join('')==='\\r','Direct mode forwards hardware keys typed into the terminal');
 sent.length=0; pasteZz(); check(sent.join('')==='zz','Direct mode forwards a paste into the terminal');

 // Toggle to Composer with the chip.
 tap(key('Input mode')); await frames();
 check(!!composer() && !q('[data-direct-strip]'),'the chip switches to the composer and the strip goes away');
 check(localStorage.getItem('snagentsos.inputMode.c1')==='composer','the mode is saved per pane');
 check(helper.readOnly && helper.getAttribute('inputmode')==='none','Composer mode makes the helper readOnly with inputmode none');
 sent.length=0; keyEnter(); check(sent.length===0,'hardware keys typed into the terminal are dropped in Composer mode');
 sent.length=0; pasteZz(); check(sent.length===0,'a paste into the terminal is dropped in Composer mode');
 sent.length=0; await writeTerm('\\x1b[6n'); await frames();
 check(sent.some(d=>/^\\x1b\\[\\d+;\\d+R$/.test(d)),'replies to terminal queries still reach the pty in Composer mode');
 sent.length=0; term.input('w', true); check(sent[0]==='w','data xterm emits on its own (wheel reports) still flows in Composer mode');
 const ta=composer();
 check(getComputedStyle(ta).fontSize==='16px','composer text is 16px');
 check(ta.placeholder==='Write a prompt...' && ta.maxLength===16384,'placeholder and the 16384 limit');
 check(ta.getAttribute('autocorrect')==='off' && ta.spellcheck===false && ta.getAttribute('autocapitalize')==='off','autocorrect off by default');
 check(sendBtn().getAttribute('aria-description')==='Hold to insert without sending','Send explains the long-press');
 const hostRight=host.getBoundingClientRect().right;
 check(sendBtn().getBoundingClientRect().right<=hostRight+0.5 && q('[data-composer]').scrollWidth<=q('[data-composer]').clientWidth,'the composer fits the phone width');
 check(sendBtn().getBoundingClientRect().width>=44 && sendBtn().getBoundingClientRect().height>=44,'Send is at least 44x44');

 // KeyBar taps keep the composer's focus.
 ta.focus(); sent.length=0;
 const esc=key('Esc'); const down=ptr(esc,'pointerdown'); ptr(esc,'pointerup');
 check(down.defaultPrevented && document.activeElement===ta,'a KeyBar key does not steal the composer focus');
 check(sent[0]==='\\x1b','the key still reaches the pty');
 flushSync(() => store.getState().setKeyboard({ focus:'composer', inset:320 })); await frames();
 check(key('Keyboard').getAttribute('aria-pressed')==='true','the keyboard toggle tracks the composer');
 tap(key('Keyboard')); await frames();
 check(document.activeElement!==ta,'the toggle closes the keyboard');
 flushSync(() => store.getState().setKeyboard({ focus:null, inset:0 })); await frames();
 tap(key('Keyboard')); await frames();
 check(document.activeElement===ta,'the toggle reopens the keyboard in the composer');

 // Send with bracketed paste: one paste, then a separate Enter frame.
 await writeTerm('\\x1b[?2004h');
 sent.length=0; typeInto(ta,'line 1\\nline 2\\nline 3'); await frames();
 check(sendBtn().dataset.composerSend==='send' && sendBtn().getAttribute('aria-disabled')==='false','with text the button is Send');
 const sdown=ptr(sendBtn(),'pointerdown'); ptr(sendBtn(),'pointerup');
 check(sdown.defaultPrevented,'Send keeps the focus in the composer');
 await wait(120); await frames();
 check(sent.length===2 && sent[0].startsWith('\\x1b[200~') && sent[0].includes('line 1\\rline 2\\rline 3') && sent[1]==='\\r','a 3-line prompt goes as one bracketed paste plus a separate \\\\r');
 check(composer().value==='','the field empties after Send');
 await wait(350);
 check(localStorage.getItem('snagentsos.draft.c1')===null,'no draft is left after Send');

 // Drafts follow the pane.
 typeInto(composer(),'draft A'); await wait(380);
 check(JSON.parse(localStorage.getItem('snagentsos.draft.c1')).text==='draft A','the draft is saved after the debounce');
 flushSync(() => store.getState().update({ activePaneId:'s1', subscribedPaneId:'s1' })); await frames();
 check(!composer() && !!q('[data-direct-strip]'),'a shell opens in Direct mode');
 flushSync(() => store.getState().update({ activePaneId:'c1', subscribedPaneId:'c1' })); await frames();
 check(composer() && composer().value==='draft A','coming back restores the draft and the mode');

 // Offline: Send disabled, text kept.
 open=false; flushSync(() => store.getState().update({ connected:false })); await frames();
 sent.length=0;
 check(sendBtn().getAttribute('aria-disabled')==='true' && sendBtn().getAttribute('aria-label')==='No connection - kept in the draft','offline Send is disabled and says the draft is kept');
 tap(sendBtn()); await wait(100);
 check(sent.length===0 && composer().value==='draft A','offline Send sends nothing and keeps the text');
 open=true; flushSync(() => store.getState().update({ connected:true })); await frames();

 // Stop with a working agent and an empty field.
 typeInto(composer(),''); flushSync(() => store.getState().update({ paneStatus:{ c1:{ state:'working', stateSince:Date.now(), provider:'claude' } } })); await frames();
 check(sendBtn().dataset.composerSend==='stop' && sendBtn().getAttribute('aria-label')==='Stop','working + empty turns Send into Stop');
 sent.length=0; tap(sendBtn());
 check(sent.length===1 && sent[0]==='\\x1b','Stop sends ESC');
 typeInto(composer(),'more'); await frames();
 check(sendBtn().dataset.composerSend==='send','typing turns Stop back into Send');
 flushSync(() => store.getState().update({ paneStatus:{} })); await frames();

 // Slash command typed key by key in an agent pane.
 sent.length=0; typeInto(composer(),'/model'); await frames();
 tap(sendBtn()); await wait(40);
 check(sendBtn().dataset.composerSend==='slash' && sendBtn().getAttribute('aria-disabled')==='true','Send shows typing progress and is disabled');
 check(/^\\d\\/6$/.test(sendBtn().textContent),'progress reads n/6 ('+sendBtn().textContent+')');
 await wait(300); await frames();
 check(sent.join('|')==='/|m|o|d|e|l|\\r','/model is typed one key per frame, then Enter');
 check(composer().value==='' && sendBtn().dataset.composerSend==='send','after typing the field empties');

 // Long-press: Insert without Enter.
 sent.length=0; typeInto(composer(),'insert me'); await frames();
 ptr(sendBtn(),'pointerdown'); await wait(520); ptr(sendBtn(),'pointerup'); await wait(100);
 check(sent.length===1 && sent[0].includes('insert me') && !sent.includes('\\r'),'holding Send 450ms inserts without Enter');
 check(composer().value==='','the inserted text leaves the field');
 sent.length=0; typeInto(composer(),'moved'); await frames();
 ptr(sendBtn(),'pointerdown'); ptr(sendBtn(),'pointermove',{clientX:sendBtn().getBoundingClientRect().left+40}); await wait(520); ptr(sendBtn(),'pointerup'); await wait(100);
 check(sent.length===0 && composer().value==='moved','moving the finger cancels the press');

 // Multi-line without bracketed paste asks first.
 await writeTerm('\\x1b[?2004l');
 sent.length=0; typeInto(composer(),'a\\nb'); await frames();
 tap(sendBtn()); await frames();
 check(!!q('[data-composer-confirm]') && sent.length===0,'multi-line text without bracketed paste asks to confirm');
 check(q('[data-composer-confirm]').textContent.includes('Several lines'),'the confirm explains each line runs');
 [...q('[data-composer-confirm]').querySelectorAll('button')].find(b=>b.textContent==='Confirm').click();
 await wait(120);
 check(sent.length===2 && sent[1]==='\\r','confirming sends it');
 check(sent[0]==='a\\rb','without bracketed paste the text goes bare, with \\\\r line breaks');

 // E3-FR-05: a claude status pastes bracketed even when the xterm saw the mode
 // off, so no confirm; an embedded closing marker loses its ESC.
 flushSync(() => store.getState().update({ paneStatus:{ c1:{ state:'idle', stateSince:Date.now(), provider:'claude' } } })); await frames();
 sent.length=0; typeInto(composer(),'one\\ntwo\\x1b[201~three'); await frames();
 tap(sendBtn()); await wait(120); await frames();
 check(!q('[data-composer-confirm]'),'a claude pane never asks the multi-line confirm');
 check(sent.length===2 && sent[0]==='\\x1b[200~one\\rtwo[201~three\\x1b[201~' && sent[1]==='\\r','safePaste: one bracketed frame, the injected marker without ESC, then Enter');
 flushSync(() => store.getState().update({ paneStatus:{} })); await frames();

 // Counter and growth.
 typeInto(composer(),'x'.repeat(13999)); await frames();
 check(!q('[data-composer-counter]'),'no counter under 14000');
 typeInto(composer(),'x'.repeat(14001)); await frames();
 check(q('[data-composer-counter]')?.textContent==='14001/16384','the counter shows from 14000');
 typeInto(composer(),''); await frames();
 const h1=composer().getBoundingClientRect().height;
 typeInto(composer(),'1\\n2\\n3'); await frames();
 const h3=composer().getBoundingClientRect().height;
 typeInto(composer(),'1\\n2\\n3\\n4\\n5\\n6\\n7\\n8\\n9\\n10'); await frames();
 const h10=composer().getBoundingClientRect().height;
 check(Math.abs((h3-h1)-44)<=2,'the field grows a line at a time ('+h1+' -> '+h3+')');
 check(Math.abs((h10-h1)-110)<=2 && getComputedStyle(composer()).overflowY==='auto','it stops at 6 lines and scrolls ('+h10+')');
 typeInto(composer(),''); await frames();

 // Autocorrect preference.
 flushSync(() => store.getState().setComposerPref('composerAutocorrect', true)); await frames();
 check(composer().getAttribute('autocorrect')==='on' && composer().spellcheck===true && composer().getAttribute('autocapitalize')==='sentences','autocorrect on: on / spellcheck / sentences');
 check(localStorage.getItem('snagentsos.composer.autocorrect')==='1','the preference persists');
 flushSync(() => store.getState().setComposerPref('composerAutocorrect', false)); await frames();

 // Quick Commands without Enter insert at the caret in Composer mode (E1-FR-31).
 sent.length=0; typeInto(composer(),'ab'); composer().setSelectionRange(1,1);
 tap(key('Quick Commands')); await frames();
 const snip=[...document.querySelectorAll('button')].find(b=>b.textContent.includes('Greeting'));
 check(!!snip,'the Quick Commands sheet lists the command');
 snip.click(); await frames();
 check(composer().value==='aSNIPb' && sent.length===0 && ctls.length===0,'a send without Enter lands in the composer at the caret, not in the pty');
 typeInto(composer(),'x'.repeat(16384)); await frames(); composer().setSelectionRange(2,2);
 tap(key('Quick Commands')); await frames();
 [...document.querySelectorAll('button')].find(b=>b.textContent.includes('Greeting')).click(); await frames();
 check(composer().value.length===16384 && !composer().value.includes('SNIP'),'a full field takes no snippet');
 typeInto(composer(),'abc'); await frames();
 check(composer().selectionStart===3,'a command that did not fit leaves no stale caret behind');
 typeInto(composer(),''); await frames();

 // Paste key: a one-shot composer on a Direct pane.
 flushSync(() => store.getState().update({ activePaneId:'s1', subscribedPaneId:'s1' })); await frames();
 check(!composer(),'the shell is in Direct mode');
 tap(key('Paste')); await frames();
 check(!!composer() && document.activeElement===composer(),'Paste opens the composer focused');
 check(localStorage.getItem('snagentsos.inputMode.s1')===null,'the one-shot does not change the saved mode');
 await writeTerm('\\x1b[?2004h');
 sent.length=0; typeInto(composer(),'ls'); await frames(); tap(sendBtn()); await wait(150); await frames();
 check(sent.length===2 && sent[1]==='\\r' && !composer() && !!q('[data-direct-strip]'),'after Send the one-shot returns to Direct');
 check(!helper.readOnly && !helper.hasAttribute('inputmode'),'Direct mode restores the helper attributes');
 sent.length=0; tap(key('Quick Commands')); await frames();
 [...document.querySelectorAll('button')].find(b=>b.textContent.includes('Greeting')).click(); await frames();
 await frames();
 check(sent.length===0 && JSON.stringify(ctls.at(-1))===JSON.stringify({ kind:'runQuickCommand', workspaceId:'w1', id:'s1', paneId:'s1' }),'in Direct mode it runs on the desktop by id, for the console open here');

 // Agents default: an unsaved claude pane opens in Composer.
 flushSync(() => store.getState().setComposerPref('composerDefaultForAgents', true)); await frames();
 const snap2 = { ...snapshot, workspaces:[{ ...snapshot.workspaces[0], layoutOrder:['c1','s1','c2'], panes:[...snapshot.workspaces[0].panes, { id:'c2', title:'New', type:'custom', color:'', icon:'', running:true }] }] };
 flushSync(() => store.getState().update({ snapshot:snap2, activePaneId:'c2', subscribedPaneId:'c2' })); await frames();
 check(!!composer(),'with the agents default a new custom console opens in Composer');
 flushSync(() => store.getState().update({ activePaneId:'s1', subscribedPaneId:'s1' })); await frames();
 check(!composer(),'a shell still opens in Direct');

 reactRoot.unmount(); return checks;
})();
` }, bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"', __APP_VERSION__: '"test"' }, alias: { '@shared': path.join(root, 'src/shared') }, loader: { '.css': 'empty' }, outfile: path.join(dir, 'renderer.js') })
fs.writeFileSync(path.join(dir, 'index.html'), `<html><head><meta charset="utf-8"><link rel="stylesheet" href="${pathToFileURL(path.join(assets, mobileCss))}"></head><body style="margin:0;width:430px"><div id="root"></div><script src="renderer.js"></script></body></html>`)
fs.writeFileSync(path.join(dir, 'main.cjs'), `
const {app,BrowserWindow}=require('electron');const path=require('path');
app.setPath('userData',path.join(__dirname,'profile'));
app.whenReady().then(async()=>{
 const w=new BrowserWindow({show:false,width:430,height:800,webPreferences:{sandbox:true,backgroundThrottling:false}});
 await w.loadFile(path.join(__dirname,'index.html'));
 const checks=await w.webContents.executeJavaScript('window.result');
 console.log('PASS: '+checks+' mobile composer UI checks');w.destroy();app.quit();
}).catch(e=>{console.error(e);app.exit(1)});
`)
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
// Hosted Linux CI cannot use Electron's unpacked SUID helper. This flag applies
// only to the isolated, trusted fixture; the shipped application is unchanged.
const flags = process.platform === 'linux' && process.env.CI ? ['--no-sandbox'] : []
const result = spawnSync(require('electron'), [...flags, path.join(dir, 'main.cjs')], { env, windowsHide: true, encoding: 'utf8', timeout: 60000 })
process.stdout.write(result.stdout ?? '')
if (result.status !== 0) process.stderr.write((result.stderr || '') + (result.error ? result.error.message : '') + (result.signal ? ' signal ' + result.signal : ''))
fs.rmSync(dir, { recursive: true, force: true })
process.exitCode = result.status ?? 1
