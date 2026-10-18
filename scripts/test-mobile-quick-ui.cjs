// Quick Commands on the phone (E8-FR-07): the real MainScreen with the
// QuickCommandsSheet in an isolated, hidden browser at phone width. The WS
// client's sendCtl and viewPane are stubbed; no socket opens. Checks the
// grouping, the 48 px rows, the strict ctl payloads (paneId of the console open
// here, never the text), the spinner that keeps a double tap to one run, the
// agent opening its console on the phone and the error toasts, in es and en.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path')
const { pathToFileURL } = require('node:url')
const { spawnSync } = require('node:child_process')
const root = path.resolve(__dirname, '..')
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snagentsos-mobile-quick-ui-'))
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
 const sent=[]; client.sendInput = data => { sent.push(data); return true }; client.isOpen = () => true;
 const ctls=[]; let answer=null;
 client.sendCtl = action => { ctls.push(action); return new Promise(r => { answer = r }) };
 const viewed=[]; client.viewPane = id => { viewed.push(id) };
 const qc=(id,o={})=>({ id, name:'Cmd '+id, text:'echo '+id, action:'send', enter:false, ...o });
 const snapshot = {
  language:'en', themeTokens:{}, fontFamily:'mono', fontSize:13, activeWorkspaceId:'w2', keyButtons:[],
  quickCommands:[ qc('g1',{ name:'Compile', text:'npm run build\\nnpm test' }), qc('w1a',{ workspaceId:'w1', name:'Front tests', enter:true }), qc('w2a',{ workspaceId:'w2', name:'Other workspace' }), qc('ag',{ workspaceId:'w1', action:'agent', presetId:'preset-claude', text:'revisa el diff', enter:true, name:'Review' }) ],
  workspaces:[
   { id:'w1', name:'Front', layoutOrder:['c1'], panes:[{ id:'c1', title:'Claude', type:'claude', color:'', icon:'', running:true }] },
   { id:'w2', name:'Back', layoutOrder:['b1'], panes:[{ id:'b1', title:'Shell', type:'shell', color:'', icon:'', running:true }] },
  ],
 };
 setLang('en');
 store.getState().update({ phase:'live', banner:null, connected:true, snapshot, activePaneId:'c1', subscribedPaneId:'c1', paneStatus:{} });
 const host=document.getElementById('root'); const reactRoot=createRoot(host);
 flushSync(() => reactRoot.render(<MainScreen />)); await frames(); await wait(50);
 const key = label => { const b=document.querySelector('button[aria-label="'+label+'"]'); if(!b)throw new Error('missing key '+label); return b };
 const ptr = (el,type) => { const r=el.getBoundingClientRect(); el.dispatchEvent(new PointerEvent(type,{bubbles:true,cancelable:true,pointerId:1,pointerType:'touch',isPrimary:true,clientX:r.left+10,clientY:r.top+10})) };
 const tap = el => { ptr(el,'pointerdown'); ptr(el,'pointerup') };
 const rows = () => [...document.querySelectorAll('[data-qc-row]')];
 const row = id => document.querySelector('[data-qc-row="'+id+'"]');
 const toast = () => [...document.querySelectorAll('div')].find(d => /rounded-full/.test(d.className) && /bg-card/.test(d.className))?.textContent ?? '';

 // The KeyBar slot opens the grouped sheet (the phone's console is in w1).
 const btn = key('Quick Commands');
 check(!!btn.querySelector('svg'),'the KeyBar button has an icon');
 tap(btn); await frames();
 check(document.body.textContent.includes('Quick Commands'),'the sheet is titled Quick Commands');
 const groups=[...document.querySelectorAll('[data-qc-group]')].map(g=>g.dataset.qcGroup+':'+g.querySelector('h3').textContent);
 check(JSON.stringify(groups)==='["workspace:This workspace","global:Global"]','"This workspace" (of the console open here) comes first, then "Global": '+groups);
 check(JSON.stringify(rows().map(r=>r.dataset.qcRow))==='["w1a","ag","g1"]','commands of another workspace are left out');
 check(rows().every(r=>r.getBoundingClientRect().height>=48),'rows are at least 48 px tall');
 check(row('g1').textContent.includes('npm run build') && !row('g1').textContent.includes('npm test'),'a row previews the first line of its text');
 check(row('ag').querySelector('svg') && row('ag').dataset.qcAction==='agent','agent rows carry their own action');

 // send: ctl by id with the console open on the phone; a double tap runs once.
 row('w1a').click(); row('w1a').click(); await frames();
 check(ctls.length===1 && JSON.stringify(ctls[0])===JSON.stringify({ kind:'runQuickCommand', workspaceId:'w1', id:'w1a', paneId:'c1' }),'send asks the desktop by id with the paneId open here, never the text');
 check(rows().every(r=>r.disabled) && row('w1a').getAttribute('aria-busy')==='true' && !!row('w1a').querySelector('.animate-spin'),'every row is disabled with a spinner until the ack');
 answer({ ok:true }); await frames(); await wait(400);
 check(!row('w1a'),'the sheet closes on success');
 check(toast()==='Sent: Front tests' && sent.length===0,'a toast confirms; nothing was typed by the phone');

 // agent: no paneId, the phone views the new console, the desktop is not asked to switch.
 tap(key('Quick Commands')); await frames();
 row('ag').click(); row('ag').click(); await frames();
 check(ctls.length===2 && JSON.stringify(ctls[1])===JSON.stringify({ kind:'runQuickCommand', workspaceId:'w1', id:'ag' }),'agent asks without paneId; a double tap creates one console');
 answer({ ok:true, paneId:'n1' }); await frames(); await wait(400);
 check(JSON.stringify(viewed)==='["n1"]' && !ctls.some(a=>a.kind==='switchWorkspace'),'the phone opens the new console from the ack, no workspace switch');

 // Errors become toasts.
 tap(key('Quick Commands')); await frames();
 row('g1').click(); await frames();
 answer({ ok:false, error:'not_found' }); await frames();
 check(toast()==='That Quick Command no longer exists' && !!row('g1') && !row('g1').disabled,'not_found shows a toast and keeps the sheet usable');
 row('g1').click(); await frames(); answer({ ok:false, error:'not_running' }); await frames();
 check(toast()==='This console is not running','not_running');
 row('g1').click(); await frames(); answer({ ok:false, error:'timeout' }); await frames();
 check(toast()==='Could not run the Quick Command','other errors get a generic toast');

 // Spanish, and the other workspace's own group.
 setLang('es'); flushSync(() => store.getState().update({ activePaneId:'b1', subscribedPaneId:'b1', snapshot:{ ...snapshot, language:'es' } })); await frames();
 const g2=[...document.querySelectorAll('[data-qc-group]')].map(g=>g.querySelector('h3').textContent);
 check(JSON.stringify(g2)==='["Este workspace","Globales"]' && JSON.stringify(rows().map(r=>r.dataset.qcRow))==='["w2a","g1"]','es labels; the group follows the console open on the phone');
 { const wide=[...document.querySelectorAll('body *')].filter(e=>e.getBoundingClientRect().right>innerWidth+1).slice(0,5).map(e=>e.tagName+'.'+String(e.className).slice(0,80)+':'+Math.round(e.getBoundingClientRect().right)); check(document.documentElement.scrollWidth<=innerWidth,'no horizontal overflow at phone width '+document.documentElement.scrollWidth+'/'+innerWidth+' '+JSON.stringify(wide)) }

 // Empty list.
 flushSync(() => store.getState().update({ snapshot:{ ...snapshot, language:'es', quickCommands:[] } })); await frames();
 check(document.querySelector('[data-qc-empty]')?.textContent==='No hay Quick Commands en la PC.','an empty list says so');

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
 console.log('PASS: '+checks+' mobile Quick Commands UI checks');w.destroy();app.quit();
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
