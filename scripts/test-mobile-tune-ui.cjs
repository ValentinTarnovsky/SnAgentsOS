// Model, effort and Ultracode from the phone (app 2.3.0, ctl agentTune): the
// real MainScreen with the AgentTuneSheet in an isolated, hidden browser at
// phone width. The WS client's sendCtl and sendInput are stubbed; no socket
// opens. Checks the header chip and the kebab row (only for Claude / Codex
// consoles of a desktop >= 2.3.0), the Claude controls vs the Codex picker,
// "Apply with Enter" off (Composer inserts at the caret, Direct types without
// Enter) and on (enter:true, `busy` offers Insert), the in-flight lock, the
// error toast, es / en and no horizontal overflow at 360 px.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path')
const { pathToFileURL } = require('node:url')
const { spawnSync } = require('node:child_process')
const root = path.resolve(__dirname, '..')
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snagentsos-mobile-tune-ui-'))
const assets = path.join(root, 'out/mobile/assets')
const mobileCss = fs.existsSync(assets) && fs.readdirSync(assets).find(name => /^index-.*\.css$/.test(name))
if (!mobileCss) throw new Error('Run npm run build:mobile first')
require('esbuild').buildSync({ stdin: { resolveDir: root, loader: 'tsx', contents: `
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { MainScreen } from './src/mobile/src/components/MainScreen';
import { client } from './src/mobile/src/lib/client';
import { store } from './src/mobile/src/lib/store';
import { setLang } from './src/mobile/src/lib/i18n';
window.result = (async () => {
 let checks=0; const check=(ok,label)=>{if(!ok)throw new Error(label);checks++};
 const frames = () => new Promise(r => setTimeout(r, 30));
 const wait = ms => new Promise(r => setTimeout(r, ms));
 try { localStorage.clear() } catch {}
 const sent=[]; client.sendInput = data => { sent.push(data); return true }; client.isOpen = () => true;
 const ctls=[]; let answer=null;
 client.sendCtl = action => { ctls.push(action); return new Promise(r => { answer = r }) };
 const snapshot = {
  language:'en', themeTokens:{}, fontFamily:'mono', fontSize:13, activeWorkspaceId:'w1', keyButtons:[], quickCommands:[],
  workspaces:[
   { id:'w1', name:'Front', layoutOrder:['c1','x1','s1'], panes:[
     { id:'c1', title:'Claude', type:'claude', color:'', icon:'', running:true },
     { id:'x1', title:'Codex', type:'codex', color:'', icon:'', running:true },
     { id:'s1', title:'Shell', type:'shell', color:'', icon:'', running:true },
   ] },
  ],
 };
 const claude = { state:'idle', stateSince:1, precise:true, provider:'claude', model:'claude-opus-4-5', effort:'high', ultracode:true, attention:false };
 setLang('en');
 store.getState().update({ phase:'live', banner:null, connected:true, snapshot, appVersion:'2.2.1', activePaneId:'c1', subscribedPaneId:'c1', paneStatus:{ c1:claude, x1:{ state:'idle', stateSince:1, precise:true, provider:'codex' } } });
 const host=document.getElementById('root'); const reactRoot=createRoot(host);
 flushSync(() => reactRoot.render(<MainScreen />)); await frames(); await wait(50);
 const $ = sel => document.querySelector(sel);
 const toast = () => [...document.querySelectorAll('[data-toast]')].map(d => d.textContent)[0] ?? '';
 const openKebab = async () => { $('[data-terminal-kebab]').click(); await frames() };
 const closeSheets = async () => { document.querySelectorAll('[aria-label="Close"],[aria-label="Cerrar"]').forEach(b => b.click()); await wait(400) };

 // 1. An older desktop: no chip and no kebab row (it would strike the unknown ctl).
 check(!$('[data-tune-chip]'),'no chip for a desktop older than 2.3.0');
 await openKebab();
 check(!!$('[data-action="history"]') && !$('[data-action="tune"]'),'no kebab row for an older desktop');
 await closeSheets();

 // 2. A 2.3.0 desktop: the chip shows what the console runs.
 flushSync(() => store.getState().update({ appVersion:'2.3.0' })); await frames();
 const chip = $('[data-tune-chip]');
 check(chip && chip.dataset.tuneChip==='claude' && chip.textContent==='claude-opus-4-5 \\u00b7 high \\u00b7 UC','the chip reads model, effort and UC: '+(chip&&chip.textContent));
 check(chip.getBoundingClientRect().width<=97,'the chip stays narrow (truncated)');
 { check(document.documentElement.scrollWidth<=innerWidth,'no horizontal overflow at phone width with the chip') }

 // 3. The sheet (from the chip): Claude controls with the current values.
 chip.click(); await frames();
 const sheet = $('[data-tune-sheet]');
 check(sheet && sheet.dataset.tuneSheet==='claude' && document.body.textContent.includes('Model and effort'),'the chip opens the Claude sheet');
 check(document.querySelectorAll('[data-tune-model]').length===8 && document.querySelectorAll('[data-tune-effort]').length===6,'8 model chips, 5 effort stops plus Auto');
 check($('[data-tune-effort="high"]').getAttribute('aria-checked')==='true' && $('[data-tune-effort="low"]').getAttribute('aria-checked')==='false','the current effort is checked');
 check($('[data-tune-ultracode]').getAttribute('aria-checked')==='true','Ultracode shows on');
 check($('[data-tune-model-note]').textContent==='The model is also saved as the default for new sessions.','the sheet warns that /model saves the global default');
 check($('[data-tune-now]').textContent==='Now: claude-opus-4-5 \\u00b7 high \\u00b7 Ultracode on','the current values are spelled out');
 check($('[data-tune-enter]').getAttribute('aria-checked')==='false','"Apply with Enter" is off by default');
 check([...document.querySelectorAll('[data-tune-effort],[data-tune-model],[data-tune-ultracode],[data-tune-enter]')].every(b=>b.getBoundingClientRect().height>=40),'touch targets are at least 40 px');

 // 4. Enter off in Direct mode: typed without Enter; one ctl per tap, locked in flight.
 $('[data-tune-effort="max"]').click(); $('[data-tune-effort="max"]').click(); await frames();
 check(ctls.length===1 && JSON.stringify(ctls[0])===JSON.stringify({ kind:'agentTune', workspaceId:'w1', paneId:'c1', set:{ kind:'effort', value:'max' }, enter:false }),'Direct mode sends enter:false, once: '+JSON.stringify(ctls));
 check([...document.querySelectorAll('[data-tune-model],[data-tune-effort]')].every(b=>b.disabled) && !!$('[data-tune-effort="max"] .animate-spin'),'every control is locked with a spinner until the ack');
 answer({ ok:true }); await frames(); await wait(400);
 check(!$('[data-tune-sheet]') && toast()==='Typed /effort max: press Enter to apply it' && sent.length===0,'the sheet closes and a toast says to press Enter');

 // 5. Composer mode (from the kebab row): inserted at the caret, nothing over the socket.
 flushSync(() => store.getState().setInputMode('c1','composer')); await frames();
 await openKebab();
 check(!!$('[data-action="tune"]'),'the kebab lists "Model and effort"');
 $('[data-action="tune"]').click(); await frames(); await wait(50);
 $('[data-tune-model="sonnet"]').click(); await frames(); await wait(400);
 const ta = document.querySelector('textarea[data-kb-input="composer"]');
 check(ctls.length===1 && ta && ta.value.includes('/model sonnet'),'Composer mode inserts /model sonnet in the composer: '+(ta&&ta.value));
 check(toast()==='Inserted /model sonnet: review it and send it','a toast says it waits in the composer');

 // 6. Enter on (Direct): enter:true; busy offers Insert, which types it without Enter.
 flushSync(() => { store.getState().setInputMode('c1','direct'); }); await frames();
 $('[data-tune-chip]').click(); await frames();
 $('[data-tune-enter]').click(); await frames();
 check($('[data-tune-enter]').getAttribute('aria-checked')==='true' && localStorage.getItem('snagentsos.tune.enter')==='1','the switch turns on and is saved per phone');
 $('[data-tune-ultracode]').click(); await frames();
 check(JSON.stringify(ctls[1])===JSON.stringify({ kind:'agentTune', workspaceId:'w1', paneId:'c1', set:{ kind:'ultracode', on:false }, enter:true }),'Enter on sends enter:true (Ultracode toggles off)');
 answer({ ok:false, error:'busy' }); await frames();
 check(!!$('[data-tune-busy]') && $('[data-tune-busy]').textContent.includes('Not applied: the agent is busy or has unsent text.') && !!$('[data-tune-sheet]'),'busy keeps the sheet and explains why');
 $('[data-tune-insert]').click(); await frames();
 check(JSON.stringify(ctls[2])===JSON.stringify({ kind:'agentTune', workspaceId:'w1', paneId:'c1', set:{ kind:'ultracode', on:false }, enter:false }),'Insert sends the same command without Enter');
 answer({ ok:true }); await frames(); await wait(400);
 check(!$('[data-tune-sheet]') && toast()==='Typed /effort ultracode off: press Enter to apply it','Insert closes with the typed toast');
 $('[data-tune-chip]').click(); await frames();
 check($('[data-tune-enter]').getAttribute('aria-checked')==='true','the switch is remembered');
 $('[data-tune-effort="auto"]').click(); await frames();
 check(ctls[3].set.value==='auto' && ctls[3].enter===true,'Auto with Enter');
 answer({ ok:true }); await frames(); await wait(400);
 check(toast()==='Applied /effort auto','an applied tune says so');
 $('[data-tune-chip]').click(); await frames();
 $('[data-tune-effort="low"]').click(); await frames();
 answer({ ok:false, error:'not_running' }); await frames();
 check(toast()==='This console is not running' && !!$('[data-tune-sheet]') && !$('[data-tune-effort="low"]').disabled,'an error toasts and keeps the sheet usable');
 await closeSheets();

 // 7. Codex: only the picker; the chip says "Model" while nothing is known.
 flushSync(() => store.getState().update({ activePaneId:'x1', subscribedPaneId:'x1' })); await frames();
 const cx = $('[data-tune-chip]');
 check(cx && cx.dataset.tuneChip==='codex' && cx.textContent==='Model','the Codex chip says Model while unknown');
 cx.click(); await frames();
 check($('[data-tune-sheet]').dataset.tuneSheet==='codex' && !$('[data-tune-model]') && !$('[data-tune-effort]') && !$('[data-tune-ultracode]') && !!$('[data-tune-picker]'),'Codex shows only the picker');
 check($('[data-tune-now]').textContent==='Now: Unknown','Codex values are read-only (unknown here)');
 $('[data-tune-picker]').click(); await frames();
 check(JSON.stringify(ctls[5])===JSON.stringify({ kind:'agentTune', workspaceId:'w1', paneId:'x1', set:{ kind:'picker' }, enter:true }),'the picker goes as one ctl');
 answer({ ok:true }); await frames(); await wait(400);
 check(toast()==='Applied /model','the picker toast');

 // 8. A shell: no chip, no row.
 flushSync(() => store.getState().update({ activePaneId:'s1', subscribedPaneId:'s1' })); await frames();
 check(!$('[data-tune-chip]'),'no chip on a shell');
 await openKebab();
 check(!$('[data-action="tune"]'),'no kebab row on a shell');
 await closeSheets();

 // 9. Spanish.
 setLang('es'); flushSync(() => store.getState().update({ activePaneId:'c1', subscribedPaneId:'c1', snapshot:{ ...snapshot, language:'es' } })); await frames();
 $('[data-tune-chip]').click(); await frames();
 check(document.body.textContent.includes('Modelo y esfuerzo') && $('[data-tune-model-note]').textContent==='El modelo también se guarda como default para sesiones nuevas.','es copy');
 check($('[data-tune-enter]').textContent.includes('Aplicar con Enter') && $('[data-tune-ultracode]').textContent.includes('solo en esta sesión'),'es switches');
 { const wide=[...document.querySelectorAll('body *')].filter(e=>e.getBoundingClientRect().right>innerWidth+1).slice(0,5).map(e=>e.tagName+'.'+String(e.className).slice(0,80)); check(document.documentElement.scrollWidth<=innerWidth,'no horizontal overflow with the sheet open '+JSON.stringify(wide)) }

 reactRoot.unmount(); return checks;
})();
` }, bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"', __APP_VERSION__: '"test"' }, alias: { '@shared': path.join(root, 'src/shared') }, loader: { '.css': 'empty' }, outfile: path.join(dir, 'renderer.js') })
fs.writeFileSync(path.join(dir, 'index.html'), `<html><head><meta charset="utf-8"><link rel="stylesheet" href="${pathToFileURL(path.join(assets, mobileCss))}"></head><body style="margin:0"><div id="root"></div><script src="renderer.js"></script></body></html>`)
fs.writeFileSync(path.join(dir, 'main.cjs'), `
const {app,BrowserWindow}=require('electron');const path=require('path');
app.setPath('userData',path.join(__dirname,'profile'));
app.whenReady().then(async()=>{
 const w=new BrowserWindow({show:false,width:360,height:640,webPreferences:{sandbox:true,backgroundThrottling:false}});
 await w.loadFile(path.join(__dirname,'index.html'));
 const checks=await w.webContents.executeJavaScript('window.result');
 console.log('PASS: '+checks+' mobile agent tune UI checks');w.destroy();app.quit();
}).catch(e=>{console.error(e);app.exit(1)});
`)
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
// Hosted Linux CI cannot use Electron's unpacked SUID helper. This flag applies
// only to the isolated, trusted fixture; the shipped application is unchanged.
const flags = process.platform === 'linux' && process.env.CI ? ['--no-sandbox'] : []
const result = spawnSync(require('electron'), [...flags, path.join(dir, 'main.cjs')], { env, windowsHide: true, encoding: 'utf8', timeout: 60000 })
process.stdout.write(result.stdout ?? '')
if (result.status !== 0) process.stderr.write((result.stderr || '') + (result.error ? result.error.message : '') + (result.signal ? ' signal ' + result.signal : ''))
process.exitCode = result.status ?? 1
