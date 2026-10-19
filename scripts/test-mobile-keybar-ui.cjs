// Exercise the real KeyBar component (E1-FR-16..21) with synthetic pointer
// events in an isolated, hidden browser: tap on pointerup, swipe voids, hold
// repeat, latch release, offline no-op, pane switch, keyboard toggle, layout,
// and the Key bar screen (E2-FR-45, 46): hide, reorder, reset, custom keys.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path')
const { pathToFileURL } = require('node:url')
const { spawnSync } = require('node:child_process')
const root = path.resolve(__dirname, '..')
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snagentsos-keybar-'))
const assets = path.join(root, 'out/mobile/assets')
const mobileCss = fs.existsSync(assets) && fs.readdirSync(assets).find(name => /^index-.*\.css$/.test(name))
if (!mobileCss) throw new Error('Run npm run build:mobile first')
require('esbuild').buildSync({ stdin: { resolveDir: root, loader: 'tsx', contents: `
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { KeyBar } from './src/mobile/src/components/KeyBar';
import { KeyLayoutScreen } from './src/mobile/src/components/KeyLayoutScreen';
import { client } from './src/mobile/src/lib/client';
import { store } from './src/mobile/src/lib/store';
import { setActiveTerm } from './src/mobile/src/lib/terminalBus';
window.result = (async () => {
 let checks=0; const check=(ok,label)=>{if(!ok)throw new Error(label);checks++};
 const frames = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
 const wait = ms => new Promise(r => setTimeout(r, ms));
 const sent=[]; client.sendInput = data => { sent.push(data); return true };
 store.getState().update({ phase:'live', banner:null, activePaneId:'p1', subscribedPaneId:'p1',
   snapshot:{ keyButtons:[{id:'u1',label:'F5',seq:'\\x1b[15~'}] } });
 const helper=document.createElement('textarea'); helper.className='xterm-helper-textarea'; document.body.appendChild(helper);
 setActiveTerm({ textarea: helper, modes: { applicationCursorKeysMode:false } });
 const host=document.getElementById('root'); const reactRoot=createRoot(host);
 let pastes=0, modeToggles=0;
 const render = props => flushSync(() => reactRoot.render(<KeyBar onPaste={() => pastes++} onQuickCommands={() => {}} {...props} />));
 render({}); await frames();
 const key = label => { const b=host.querySelector('button[aria-label="'+label+'"]'); if(!b)throw new Error('missing key '+label); return b };
 const ptr = (el,type,x=0,y=0,extra={}) => { const r=el.getBoundingClientRect(); const e=new PointerEvent(type,{bubbles:true,cancelable:true,pointerId:1,pointerType:'touch',isPrimary:true,clientX:r.left+10+x,clientY:r.top+10+y,...extra}); el.dispatchEvent(e); return e };
 const tap = el => { ptr(el,'pointerdown'); ptr(el,'pointerup') };

 const bksp=key('Backspace');
 const down=ptr(bksp,'pointerdown');
 check(down.defaultPrevented,'pointerdown is prevented so the input keeps the focus');
 check(sent.length===0,'nothing is sent on pointerdown');
 ptr(bksp,'pointerup');
 check(sent.length===1&&sent[0]==='\\x7f','Bksp taps DEL on pointerup');
 sent.length=0; tap(key('Delete'));
 check(sent[0]==='\\x1b[3~','Del sends CSI 3 ~');

 sent.length=0; const ctrlD=key('Ctrl+D: end of input');
 ptr(ctrlD,'pointerdown'); ptr(ctrlD,'pointermove',30); ptr(ctrlD,'pointermove',60); ptr(ctrlD,'pointercancel',60);
 ptr(ctrlD,'pointerup',60);
 check(sent.length===0,'a 60px swipe that starts on ^D sends nothing');
 ptr(ctrlD,'pointerdown'); ptr(ctrlD,'pointermove',60); ptr(ctrlD,'pointerup',60);
 check(sent.length===0,'a swipe voids the key even without pointercancel');

 sent.length=0; const left=key('Left arrow');
 ptr(left,'pointerdown'); await wait(1000); ptr(left,'pointerup');
 const held=sent.length; await wait(150);
 check(held>=12&&held<=15&&sent.every(s=>s==='\\x1b[D'),'holding an arrow 1s repeats about 14 times ('+held+')');
 check(sent.length===held,'releasing stops the repeat with no extra send');

 sent.length=0; ptr(left,'pointerdown'); await wait(600);
 store.getState().update({ subscribedPaneId:'p2' });
 const atSwitch=sent.length; await wait(300); ptr(left,'pointerup');
 check(atSwitch>0&&sent.length===atSwitch,'a pane switch stops a running repeat synchronously, before any render');

 sent.length=0; const ctrl=key('Ctrl');
 tap(ctrl); await frames();
 check(ctrl.getAttribute('aria-pressed')==='true'&&store.getState().ctrlLatch,'Ctrl latches on tap');
 tap(key('Ctrl+C: interrupt')); await frames();
 check(sent[0]==='\\x03'&&!store.getState().ctrlLatch&&ctrl.getAttribute('aria-pressed')==='false','^C sends ETX and releases the latch');

 sent.length=0; const nl=key('Alt+Enter: newline');
 check(nl.textContent==='Newline','the ctrlEnter key reads Newline');
 tap(nl); check(sent[0]==='\\x1b\\r','Newline still sends ESC CR');
 tap(key('Paste')); check(pastes===1&&sent.length===1,'Paste opens the sheet without writing to the pty');

 const scroller=host.querySelector('[data-scrollable]');
 const labels=[...scroller.querySelectorAll('button')].map(b=>b.getAttribute('aria-label'));
 const order=['Esc','Ctrl+C: interrupt','Tab','Ctrl','Left arrow','Up arrow','Down arrow','Right arrow','Backspace','Delete','Enter','\\u21e7Tab','Alt+Enter: newline','Ctrl+L: clear screen','Ctrl+R: search history','F5','Paste','Quick Commands','Ctrl+D: end of input','Ctrl+Z: suspend'];
 check(JSON.stringify(labels)===JSON.stringify(order),'scroll zone order: '+labels.join(' | '));
 check(getComputedStyle(scroller).touchAction==='pan-x','the scroller only pans horizontally');
 const kb=key('Keyboard');
 check(!scroller.contains(kb)&&host.contains(kb),'the keyboard toggle is pinned outside the scroll zone');
 check([...host.querySelectorAll('button')].every(b=>{const r=b.getBoundingClientRect();return r.width>=44&&r.height>=44}),'every key is at least 44x44');

 tap(kb); await frames();
 check(document.activeElement===helper,'with the keyboard closed the toggle focuses the direct input');
 check(kb.getAttribute('aria-pressed')==='false','focus without a keyboard inset is not shown as open');
 flushSync(() => store.getState().setKeyboard({ focus:'direct', inset:320 })); await frames();
 check(kb.getAttribute('aria-pressed')==='true','focus plus a keyboard inset lights the toggle');
 flushSync(() => store.getState().setKeyboard({ inset:0 })); await frames();
 check(kb.getAttribute('aria-pressed')==='false','the OS hiding the keyboard without a blur turns the toggle off');
 flushSync(() => store.getState().setKeyboard({ inset:320 })); await frames();
 tap(kb); await frames();
 check(document.activeElement!==helper,'with the keyboard open the toggle drops the focus');

 sent.length=0; flushSync(() => store.getState().update({ banner:{ kind:'reconnecting', attempt:1 } })); await frames();
 const esc=key('Esc');
 tap(esc); ptr(left,'pointerdown'); await wait(600); ptr(left,'pointerup');
 check(sent.length===0,'offline keys do nothing');
 check(esc.className.includes('opacity-40'),'offline keys are dimmed');
 flushSync(() => store.getState().update({ banner:null })); await frames();

 sent.length=0; ptr(esc,'pointerdown',0,0,{pointerType:'mouse',button:0}); ptr(esc,'pointerout',0,0,{pointerType:'mouse',relatedTarget:document.body}); ptr(esc,'pointerup',0,0,{pointerType:'mouse'});
 check(sent.length===0,'a mouse leaving the key ends the press');
 esc.dispatchEvent(new MouseEvent('click',{bubbles:true,detail:0}));
 check(sent[0]==='\\x1b','keyboard or assistive activation fires the key once');

 render({ inputMode:'composer', onToggleMode:() => modeToggles++ }); await frames();
 const mode=key('Input mode');
 check(!scroller.contains(mode)&&host.querySelector('button')===mode,'the mode chip is pinned first, outside the scroll zone');
 check(mode.textContent==='>>'&&mode.getAttribute('aria-pressed')==='true','the mode chip shows >> and the composer mode');
 tap(mode); check(modeToggles===1,'the mode chip toggles the input mode');
 const latch=key('Ctrl'); tap(latch); await frames();
 check(!store.getState().ctrlLatch&&latch.className.includes('opacity-40'),'in composer mode the latch is disabled');
 check(store.getState().toast==='Ctrl+letter: use Direct mode','and explains Direct mode in a toast');

 // --- KeyBar part 2 (E2-FR-45, 46): the Key bar screen drives the live bar ---
 // rAF can stall in a hidden window after many re-renders, so this part settles on timers.
 const settle = () => wait(30);
 render({}); await settle();
 const layoutHost=document.createElement('div'); document.body.appendChild(layoutHost);
 const layoutRoot=createRoot(layoutHost);
 flushSync(() => layoutRoot.render(<KeyLayoutScreen open={true} onClose={() => {}} />)); await wait(400);
 const barLabels = () => [...host.querySelector('[data-scrollable]').querySelectorAll('button')].map(b=>b.getAttribute('aria-label'));
 const rowIds = () => [...layoutHost.querySelectorAll('[data-key-row]')].map(r=>r.getAttribute('data-key-row'));
 const row = id => { const r=layoutHost.querySelector('[data-key-row="'+id+'"]'); if(!r)throw new Error('missing row '+id); return r };
 const stored = () => JSON.parse(localStorage.getItem('snagentsos.keybar'));
 check(layoutHost.querySelector('[data-push-screen="keybar"]')!=null,'the Key bar screen opens as a pushed screen');
 check(rowIds().length===20&&rowIds()[0]==='esc'&&rowIds().includes('desk:u1')&&!rowIds().includes('keyboard'),'it lists every scroll key (desktop keys included), not the keyboard toggle');
 const tabRow=row('tab');
 check([...tabRow.querySelectorAll('[data-key-up],[data-key-down]')].every(b=>{const r=b.getBoundingClientRect();return r.width>=44&&r.height>=44}),'move up / move down buttons are 44px');
 check(row('esc').querySelector('[data-key-up]').disabled&&row('chip:^Z').querySelector('[data-key-down]').disabled,'the first row cannot move up and the last cannot move down');
 tabRow.querySelector('[data-key-toggle]').click(); await settle();
 check(row('tab').getAttribute('data-visible')==='false'&&row('tab').querySelector('[role=switch]').getAttribute('aria-checked')==='false','hiding Tab flips its switch');
 check(!barLabels().includes('Tab'),'a hidden key leaves the live KeyBar');
 flushSync(() => store.getState().setCtrlLatch(true)); await settle();
 row('ctrl').querySelector('[data-key-toggle]').click(); await settle();
 check(!store.getState().ctrlLatch&&!barLabels().includes('Ctrl'),'hiding the Ctrl key releases a held latch');
 row('ctrl').querySelector('[data-key-toggle]').click(); await settle();
 check(barLabels().includes('Ctrl'),'showing Ctrl again brings the latch key back');
 for(let i=0;i<25;i++){ const b=row('esc').querySelector('[data-key-down]'); if(b.disabled)break; b.click(); await settle(); }
 check(rowIds().at(-1)==='esc'&&barLabels().at(-1)==='Esc','moving Esc down to the end reorders the live KeyBar');
 check(stored().version===1&&!stored().visibleIds.includes('tab')&&stored().orderedIds.at(-1)==='esc','the layout persists to snagentsos.keybar');
 row('tab').querySelector('[data-key-toggle]').click(); await settle();
 check(barLabels().includes('Tab'),'showing Tab again brings it back');
 layoutHost.querySelector('[data-keybar-reset]').click(); await settle();
 check(JSON.stringify(barLabels())===JSON.stringify(order),'Reset restores the default order');
 check(store.getState().toast==='Key bar reset','and confirms with a toast');

 const setVal=(el,v)=>{ const proto=el.tagName==='SELECT'?HTMLSelectElement.prototype:HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto,'value').set.call(el,v); el.dispatchEvent(new Event(el.tagName==='SELECT'?'change':'input',{bubbles:true})) };
 const q = sel => { const el=document.querySelector(sel); if(!el)throw new Error('missing '+sel); return el };
 const saveBtn = () => [...document.querySelectorAll('button')].find(b=>b.textContent==='Save');
 layoutHost.querySelector('[data-keybar-add]').click(); await wait(400);
 check(q('[data-custom-mode="key"]').getAttribute('aria-pressed')==='true','a new key starts in Key mode');
 setVal(q('[data-custom-key]'),'right'); q('[data-custom-mod="ctrl"]').click(); await settle();
 check(q('[data-custom-preview]').textContent==='\\\\x1b[1;5C','the builder previews Ctrl+Right as \\\\x1b[1;5C');
 check(q('[data-custom-label]').placeholder==='C-\\u2192','a blank label suggests C-\\u2192');
 setVal(q('[data-custom-key]'),'enter'); await settle();
 check(saveBtn().disabled&&q('[data-custom-preview]').textContent==='Ctrl+Enter has no key of its own: use Text mode','Ctrl+Enter disables Save and points to Text mode');
 setVal(q('[data-custom-key]'),'right'); setVal(q('[data-custom-label]'),'Word>'); await settle();
 check(!saveBtn().disabled,'a valid key can be saved');
 saveBtn().click(); await wait(400);
 check(rowIds().at(-1)?.startsWith('cust:')&&barLabels().at(-1)==='Word>','the custom key is appended to the list and the live KeyBar');
 check(stored().custom.length===1&&stored().custom[0].mode==='key'&&stored().custom[0].ctrl===true,'the custom key persists in custom[]');
 sent.length=0; tap(key('Word>'));
 check(sent[0]==='\\x1b[1;5C','tapping the custom key sends ESC [ 1 ; 5 C');

 const custId=rowIds().at(-1);
 row(custId).querySelector('[data-key-edit]').click(); await wait(400);
 check(q('[data-custom-label]').value==='Word>'&&q('[data-custom-mod="ctrl"]').getAttribute('aria-pressed')==='true','editing loads the saved key');
 q('[data-custom-mode="text"]').click(); await settle();
 setVal(q('[data-custom-text]'),'git status'); q('[data-custom-enter]').click(); setVal(q('[data-custom-label]'),'gst'); await settle();
 check(q('[data-custom-preview]').textContent==='git status\\\\r','Text mode previews the literal and the Enter');
 saveBtn().click(); await wait(400);
 check(rowIds().at(-1)===custId&&barLabels().at(-1)==='gst','an edit keeps the key in place');
 sent.length=0; tap(key('gst'));
 check(sent[0]==='git status\\r','the Text key sends its literal and Enter');
 row(custId).querySelector('[data-key-up]').click(); await settle();
 check(rowIds().at(-2)===custId,'custom keys reorder like any other');

 flushSync(() => store.getState().update({ snapshot:{ keyButtons:[] } })); await settle();
 check(!rowIds().includes('desk:u1')&&!barLabels().includes('F5'),'a desktop key that disappears from the snapshot is dropped silently');
 flushSync(() => store.getState().update({ snapshot:{ keyButtons:[{id:'u1',label:'F5',seq:'\\x1b[15~'}] } })); await settle();
 check(rowIds().indexOf('desk:u1')===rowIds().indexOf('chip:^R')+1,'and comes back next to its canonical neighbour');

 row(custId).querySelector('[data-key-edit]').click(); await wait(400);
 q('[data-custom-delete]').click(); await wait(400);
 check(!rowIds().includes(custId)&&!barLabels().includes('gst')&&stored().custom.length===0,'deleting a custom key removes it from the list, the bar and storage');
 layoutRoot.unmount();

 reactRoot.unmount(); return checks;
})();
` }, bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' }, alias: { '@shared': path.join(root, 'src/shared') }, outfile: path.join(dir, 'renderer.js') })
fs.writeFileSync(path.join(dir, 'index.html'), `<html><head><meta charset="utf-8"><link rel="stylesheet" href="${pathToFileURL(path.join(assets, mobileCss))}"></head><body style="margin:0;width:430px"><div id="root"></div><script src="renderer.js"></script></body></html>`)
fs.writeFileSync(path.join(dir, 'main.cjs'), `
const {app,BrowserWindow}=require('electron');const path=require('path');
app.setPath('userData',path.join(__dirname,'profile'));
app.whenReady().then(async()=>{
 const w=new BrowserWindow({show:false,width:430,height:800,webPreferences:{sandbox:true,backgroundThrottling:false}});
 await w.loadFile(path.join(__dirname,'index.html'));
 const checks=await w.webContents.executeJavaScript('window.result');
 console.log('PASS: '+checks+' mobile KeyBar UI checks');w.destroy();app.quit();
}).catch(e=>{console.error(e);app.exit(1)});
`)
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
// Hosted Linux CI cannot use Electron's unpacked SUID helper. This flag applies
// only to the isolated, trusted fixture; the shipped application is unchanged.
const flags = process.platform === 'linux' && process.env.CI ? ['--no-sandbox'] : []
const result = spawnSync(require('electron'), [...flags, path.join(dir, 'main.cjs')], { env, windowsHide: true, encoding: 'utf8', timeout: 30000 })
process.stdout.write(result.stdout ?? '')
if (result.status !== 0) process.stderr.write(result.stderr ?? result.error?.message ?? '')
fs.rmSync(dir, { recursive: true, force: true })
process.exitCode = result.status ?? 1
