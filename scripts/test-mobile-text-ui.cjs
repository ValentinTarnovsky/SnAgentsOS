// Usable text on the real phone MainScreen (E2-FR-26..34) in an isolated
// offscreen window at 360 px with real xterm: a long-press selects the word
// without the keyboard, the pill fits the screen, Copy / All / Cancel, the
// fallback sheet when the browser refuses, a dragged handle extends and
// auto-scrolls at the edge; taps on URLs and paths open LinkSheet with the
// right rows and labels and send openUrl / openPath (errors become toasts);
// the "New lines" pill, the scroll thumb, the pinch and the text size presets.
// The WS client is stubbed: frames go straight to the terminal's listener.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path')
const { pathToFileURL } = require('node:url')
const { spawnSync } = require('node:child_process')
const root = path.resolve(__dirname, '..')
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snagentsos-text-ui-'))
const assets = path.join(root, 'out/mobile/assets')
const mobileCss = fs.existsSync(assets) && fs.readdirSync(assets).find(name => /^index-.*\.css$/.test(name))
if (!mobileCss) throw new Error('Run npm run build:mobile first')
require('esbuild').buildSync({ stdin: { resolveDir: root, loader: 'tsx', contents: `
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { MainScreen } from './src/mobile/src/components/MainScreen';
import { SettingsScreen } from './src/mobile/src/components/SettingsScreen';
import { BackStackHost } from './src/mobile/src/lib/useBackClaim';
import { client } from './src/mobile/src/lib/client';
import { store } from './src/mobile/src/lib/store';
import { getActiveTerm } from './src/mobile/src/lib/terminalBus';
import { setLang } from './src/mobile/src/lib/i18n';
window.result = (async () => {
 let checks=0; const check=(ok,label)=>{if(!ok)throw new Error(label);checks++};
 const wait = ms => new Promise(r => setTimeout(r, ms));
 const frames = () => wait(40);
 const ctls=[]; let ctlAnswer={ ok:true };
 client.sendCtl = async action => { ctls.push(action); return ctlAnswer };
 client.sendInput = () => true; client.isOpen = () => true;
 const snapshot = { language:'en', themeTokens:{}, fontFamily:'mono', fontSize:13, activeWorkspaceId:'w1', keyButtons:[],
  workspaces:[{ id:'w1', name:'Front', layoutOrder:['c1'], panes:[{ id:'c1', title:'Claude', type:'shell', color:'', icon:'', running:true }] }] };
 setLang('en');
 store.getState().update({ phase:'live', banner:null, connected:true, snapshot, activePaneId:'c1', subscribedPaneId:'c1', paneStatus:{}, hostPlatform:'win32' });
 const host=document.getElementById('root'); const reactRoot=createRoot(host);
 flushSync(() => reactRoot.render(<MainScreen />)); await frames();
 const term=getActiveTerm(); check(!!term,'the terminal mounted');
 const feed = f => client.termListener(f);
 const history = Array.from({length:60},(_,i)=>'old line '+i).join('\\r\\n');
 const body = ['hello wonderful world', 'dev: http://localhost:5173/ ready', 'docs https://example.com/guide', 'error in src/App.tsx:12 fix', 'see notes.md too'].join('\\r\\n');
 feed({ type:'replay', running:true, cols:40, rows:12, data: history + '\\r\\n' + body });
 await wait(120);
 const screen = host.querySelector('.xterm-screen');
 const helper = host.querySelector('.xterm-helper-textarea');
 const find = needle => { const b=term.buffer.active; for (let r=b.length-1;r>=0;r--){ const s=b.getLine(r).translateToString(true); const c=s.indexOf(needle); if(c>=0) return { col:c, row:r } } throw new Error('not in buffer: '+needle) };
 const pointOf = (cell, dc=0) => { const r=screen.getBoundingClientRect(); const w=r.width/term.cols, h=r.height/term.rows; return { x:r.left+(cell.col+dc+0.5)*w, y:r.top+(cell.row-term.buffer.active.viewportY+0.5)*h } };
 const touch = (type, p, count=1, spread=0) => {
  const pts=Array.from({length:count},(_,i)=>new Touch({identifier:i,target:screen,clientX:p.x+i*spread,clientY:p.y,pageX:p.x+i*spread,pageY:p.y}));
  const e=new TouchEvent(type,{bubbles:true,cancelable:true,touches:type==='touchend'?[]:pts,changedTouches:pts}); screen.dispatchEvent(e); return e };
 const tapAt = p => { touch('touchstart',p); return touch('touchend',p) };
 const longPressAt = async p => { touch('touchstart',p); await wait(560); const e=touch('touchend',p); await frames(); return e };
 const sheetRows = () => [...document.querySelectorAll('[data-link-sheet] [data-action]')].map(b=>({ id:b.getAttribute('data-action'), text:b.textContent }));
 const closeSheets = async () => { const b=[...document.querySelectorAll('.fixed .absolute.inset-0')].pop(); if (b) b.click(); await wait(400) };
 const toast = () => store.getState().toast;

 // --- Long-press selection (E2-FR-26/27) ---
 helper.focus();
 const word = find('wonderful');
 const lp = await longPressAt(pointOf(word, 2));
 const overlay = () => host.querySelector('[data-selection-overlay]');
 check(lp.defaultPrevented && !!overlay(), 'a 500 ms hold enters selection mode and cancels the lift');
 check(term.getSelection()==='wonderful', 'the word under the finger is selected');
 check(document.activeElement!==helper, 'the terminal input lost the focus (no keyboard)');
 const pill = host.querySelector('[data-selection-pill]');
 const pr = pill.getBoundingClientRect(), box = overlay().getBoundingClientRect();
 check(pr.left>=box.left+8 && pr.right<=box.right-8 && pr.top>=box.top+8 && pr.bottom<=box.bottom-8, 'the pill stays 8 px inside the terminal');
 check(pill.textContent.includes('Copy') && pill.textContent.includes('All') && pill.textContent.includes('Cancel'), 'Copy | All | Cancel');
 const handles = host.querySelectorAll('[data-selection-handle]');
 check(handles.length===2 && [...handles].every(h=>{const r=h.getBoundingClientRect();return r.width===44&&r.height===44}), 'two handles with a 44 px touch area');
 const cellH = screen.getBoundingClientRect().height/term.rows;
 check(pr.bottom <= pointOf(word).y - cellH/2 - 7, 'the pill sits above the selection');
 // Drag the end handle three cells right.
 const endH = host.querySelector('[data-selection-handle="end"]');
 const er = endH.getBoundingClientRect(); const cw = screen.getBoundingClientRect().width/term.cols;
 const pe = (type,x,y) => endH.dispatchEvent(new PointerEvent(type,{bubbles:true,cancelable:true,pointerId:7,pointerType:'touch',isPrimary:true,clientX:x,clientY:y}));
 pe('pointerdown', er.left+22, er.top+10); pe('pointermove', er.left+22+cw*6, er.top+10); pe('pointerup', er.left+22+cw*6, er.top+10); await frames();
 check(term.getSelection()==='wonderful world', 'dragging the end handle extends the selection');
 // Auto-scroll: hold the start handle at the top edge.
 const startH = host.querySelector('[data-selection-handle="start"]');
 const sr = startH.getBoundingClientRect(); const top = screen.getBoundingClientRect().top;
 const before = term.buffer.active.viewportY;
 const ps = (type,x,y) => startH.dispatchEvent(new PointerEvent(type,{bubbles:true,cancelable:true,pointerId:8,pointerType:'touch',isPrimary:true,clientX:x,clientY:y}));
 ps('pointerdown', sr.left+22, sr.top+10); ps('pointermove', sr.left+22, top+5); await wait(400); ps('pointerup', sr.left+22, top+5); await frames();
 check(term.buffer.active.viewportY < before && term.getSelection().includes('old line'), 'a handle held at the top edge scrolls and keeps extending');
 // Copy through execCommand (no Clipboard API on plain http).
 Object.defineProperty(navigator,'clipboard',{value:undefined,configurable:true});
 const realExec=document.execCommand; let copiedText=null, inClick=false;
 document.execCommand = cmd => { const ta=document.querySelector('textarea[data-copy-buffer]'); copiedText=ta&&ta.value; inClick=window.event&&window.event.type==='click'; return true };
 const expected = term.getSelection().replace(/\\r\\n/g,'\\n');
 host.querySelector('[data-sel-action="copy"]').click(); await frames();
 check(copiedText===expected && inClick, 'Copy runs execCommand inside the tap with the selected text '+JSON.stringify([copiedText,expected,inClick]));
 check(toast()==='Copied ('+Array.from(expected).length+' characters)' && !overlay() && !term.hasSelection(), 'toast with the count, then selection mode ends');
 // All, then Cancel.
 term.scrollToBottom(); await frames();
 await longPressAt(pointOf(find('hello')));
 host.querySelector('[data-sel-action="all"]').click(); await frames();
 check(term.getSelection().includes('old line 0') && term.getSelection().includes('notes.md'), 'All selects the whole buffer');
 host.querySelector('[data-sel-action="cancel"]').click(); await frames();
 check(!overlay() && !term.hasSelection(), 'Cancel leaves the mode');
 // A tap outside leaves too.
 await longPressAt(pointOf(find('hello')));
 host.querySelector('[data-selection-backdrop]').click(); await frames();
 check(!overlay(), 'a tap outside the pill and handles leaves the mode');
 // execCommand refused: the fallback sheet with the text.
 document.execCommand = () => false;
 await longPressAt(pointOf(find('hello')));
 host.querySelector('[data-sel-action="copy"]').click(); await wait(350);
 const fb = document.querySelector('[data-copy-fallback]');
 check(fb && fb.value==='hello' && fb.readOnly && document.body.textContent.includes('Press and hold to copy'), 'a refused copy opens the text in a selectable sheet');
 await closeSheets();
 document.execCommand = realExec;

 // --- Links (E2-FR-28/29) ---
 ctls.length=0;
 let up = tapAt(pointOf(find('localhost'), 3)); await wait(350);
 let rows = sheetRows();
 check(up.defaultPrevented && document.querySelector('[data-link-sheet="url"]'), 'a tap on a URL opens LinkSheet and cancels the click');
 check(!rows.some(r=>r.id==='openPhone') && rows.some(r=>r.id==='openPc') && rows.some(r=>r.id==='copy'), 'localhost hides "Open on the phone"');
 document.querySelector('[data-link-sheet] [data-action="openPc"]').click(); await wait(350);
 check(ctls.at(-1).kind==='openUrl' && ctls.at(-1).url==='http://localhost:5173/' && toast()==='Sent to the PC', '"Open on the PC" sends ctl openUrl');
 tapAt(pointOf(find('example.com'))); await wait(350);
 rows = sheetRows();
 check(rows.some(r=>r.id==='openPhone' && r.text.includes('Open on the phone')), 'a public URL can open on the phone');
 document.execCommand = () => false;
 document.querySelector('[data-link-sheet] [data-action="copy"]').click(); await wait(400);
 const fbLink = document.querySelector('[data-copy-fallback]');
 check(fbLink && fbLink.value==='https://example.com/guide' && toast()!=="Couldn't open it on the PC", 'a refused link copy opens the fallback sheet, not a PC error');
 await closeSheets();
 document.execCommand = realExec;
 tapAt(pointOf(find('App.tsx'))); await wait(350);
 rows = sheetRows();
 check(document.querySelector('[data-link-sheet="path"]') && rows.map(r=>r.id).join()==='copyPath,insert,revealPc', 'a path offers Copy path, Insert and the PC action');
 check(rows[2].text.includes('Show in Explorer'), 'a .tsx path says "Show in Explorer", not "Open on the PC"');
 ctlAnswer = { ok:false, error:'denied_path' };
 document.querySelector('[data-link-sheet] [data-action="revealPc"]').click(); await wait(350);
 check(ctls.at(-1).kind==='openPath' && ctls.at(-1).workspaceId==='w1' && ctls.at(-1).paneId==='c1' && ctls.at(-1).path==='src/App.tsx:12', 'the PC action sends ctl openPath for the viewed pane');
 check(toast()==='Path outside the workspace', 'denied_path becomes its toast');
 ctlAnswer = { ok:false, error:'rate' };
 tapAt(pointOf(find('notes.md'))); await wait(350);
 rows = sheetRows();
 check(rows[2].id==='openPc' && rows[2].text.includes('Open on the PC'), 'an inert .md says "Open on the PC"');
 document.querySelector('[data-link-sheet] [data-action="openPc"]').click(); await wait(350);
 check(toast()==='Wait a second', 'rate becomes "Wait a second"');
 ctlAnswer = { ok:false, error:'not_found' };
 tapAt(pointOf(find('notes.md'))); await wait(350);
 document.querySelector('[data-link-sheet] [data-action="openPc"]').click(); await wait(350);
 check(toast()==='The file does not exist', 'not_found becomes its toast');
 ctlAnswer = { ok:true };
 tapAt(pointOf(find('App.tsx'))); await wait(350);
 document.querySelector('[data-link-sheet] [data-action="insert"]').click(); await wait(350);
 const comp = host.querySelector('[data-kb-input="composer"]');
 check(comp && comp.value.includes('src/App.tsx:12'), '"Insert in the composer" opens it one-shot with the path');
 store.getState().update({ composerOneShot:null }); await frames();
 up = tapAt(pointOf(find('wonderful'))); await wait(200);
 check(!up.defaultPrevented && !document.querySelector('[data-link-sheet]'), 'a tap on plain text opens nothing and keeps its click');

 // --- New lines pill and scroll thumb (E2-FR-32/33) ---
 term.scrollLines(-10); await wait(80);
 const thumb = () => host.querySelector('[data-scroll-thumb]');
 check(thumb() && thumb().getAttribute('data-visible')==='true' && thumb().getBoundingClientRect().width===3, 'scrolling shows the 3 px thumb');
 check(!host.querySelector('[data-new-lines]'), 'no pill without new output');
 feed({ type:'out', data:'\\r\\nfresh output' }); await wait(120);
 const pillBtn = host.querySelector('[data-new-lines]');
 check(pillBtn && pillBtn.textContent.includes('New lines'), 'output while scrolled up shows "New lines"');
 pillBtn.click(); await wait(120);
 check(term.buffer.active.viewportY===term.buffer.active.baseY && !host.querySelector('[data-new-lines]'), 'tapping it jumps to the end and hides it');
 await wait(1200);
 check(thumb().getAttribute('data-visible')==='false', 'the thumb fades a second after the scroll');
 feed({ type:'out', data:'\\r\\nmore at the bottom' }); await wait(120);
 check(thumb().getAttribute('data-visible')==='false' && !host.querySelector('[data-new-lines]'), 'output that follows the bottom neither shows the thumb nor the pill');

 // --- Pinch and text size presets (E2-FR-34) ---
 const size1 = term.options.fontSize;
 const c = pointOf({ col:5, row:term.buffer.active.viewportY+3 });
 touch('touchstart', c, 2, 40); touch('touchmove', c, 2, 60); await frames();
 check(/scale\\(1\\.5\\)/.test(term.element.style.transform), 'a live pinch scales the terminal with CSS');
 touch('touchend', c); await frames();
 check(store.getState().fontScale===1.5 && localStorage.getItem('snagentsos.fontScale')==='1.5' && term.element.style.transform==='', 'releasing at 1.5x snaps to 150% and saves it');
 check(term.options.fontSize > size1, 'the font grows with the scale');
 const sRoot = createRoot(document.getElementById('settings'));
 flushSync(() => sRoot.render(<BackStackHost><SettingsScreen open onClose={() => {}} /></BackStackHost>)); await wait(400);
 check(document.body.textContent.includes('Text size: 150%'), 'Settings shows the same preset as a percentage');
 document.querySelector('[data-font-scale] [data-scale="1"]').click(); await frames();
 check(store.getState().fontScale===1 && term.options.fontSize===size1 && document.body.textContent.includes('Text size: 100%'), 'a preset in Settings sets the scale back');
 setLang('es'); flushSync(() => store.getState().update({ snapshot:{ ...snapshot, language:'es' } })); await frames();
 sRoot.unmount();
 const sRoot2 = createRoot(document.getElementById('settings'));
 flushSync(() => sRoot2.render(<BackStackHost><SettingsScreen open onClose={() => {}} /></BackStackHost>)); await wait(400);
 check(document.body.textContent.includes('Tamaño de texto: 100%'), 'the text size row is translated');
 sRoot2.unmount();
 reactRoot.unmount(); return checks;
})();
` }, bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"', __APP_VERSION__: '"test"' }, alias: { '@shared': path.join(root, 'src/shared') }, loader: { '.css': 'empty' }, outfile: path.join(dir, 'renderer.js') })
fs.writeFileSync(path.join(dir, 'index.html'), `<html><head><meta charset="utf-8"><link rel="stylesheet" href="${pathToFileURL(path.join(assets, mobileCss))}"></head><body style="margin:0;width:360px"><div id="root"></div><div id="settings"></div><script src="renderer.js"></script></body></html>`)
fs.writeFileSync(path.join(dir, 'main.cjs'), `
const {app,BrowserWindow}=require('electron');const path=require('path');
app.setPath('userData',path.join(__dirname,'profile'));
app.whenReady().then(async()=>{
 const w=new BrowserWindow({show:false,width:360,height:640,useContentSize:true,webPreferences:{sandbox:true,backgroundThrottling:false,offscreen:true}});
 await w.loadFile(path.join(__dirname,'index.html'));
 const checks=await w.webContents.executeJavaScript('window.result');
 console.log('PASS: '+checks+' mobile usable text UI checks');w.destroy();app.quit();
}).catch(e=>{console.error(e);app.exit(1)});
`)
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
// Hosted Linux CI cannot use Electron's unpacked SUID helper. This flag applies
// only to the isolated, trusted fixture; the shipped application is unchanged.
const flags = process.platform === 'linux' && process.env.CI ? ['--no-sandbox'] : []
const result = spawnSync(require('electron'), [...flags, path.join(dir, 'main.cjs')], { env, windowsHide: true, encoding: 'utf8', timeout: 90000 })
process.stdout.write(result.stdout ?? '')
if (result.status !== 0) process.stderr.write((result.stderr || '') + (result.error ? result.error.message : '') + (result.signal ? ' signal ' + result.signal : ''))
fs.rmSync(dir, { recursive: true, force: true })
process.exitCode = result.status ?? 1
