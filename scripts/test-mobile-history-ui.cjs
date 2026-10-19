// History on the phone (E3-FR-36..39): the real HistoryScreen in an isolated,
// hidden browser at phone width. The WS client's requestHistory, sendCtl,
// showPane and requestOpen are stubbed; no socket opens. Checks the two tabs
// and their historyReq fields, the 250ms search debounce, the cards (title,
// folder, "3h ago", open dot), "The PC did not answer [Retry]", the
// confirmation with [Resume in a new console] and its createPane.resume
// payload, [Go to the console] for an open session, the notFound toast, and
// the Spanish labels without horizontal overflow.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path')
const { pathToFileURL } = require('node:url')
const { spawnSync } = require('node:child_process')
const root = path.resolve(__dirname, '..')
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snagentsos-mobile-history-ui-'))
const assets = path.join(root, 'out/mobile/assets')
const mobileCss = fs.existsSync(assets) && fs.readdirSync(assets).find(name => /^index-.*\.css$/.test(name))
if (!mobileCss) throw new Error('Run npm run build:mobile first')
require('esbuild').buildSync({ stdin: { resolveDir: root, loader: 'tsx', contents: `
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { HistoryScreen } from './src/mobile/src/components/HistoryScreen';
import { client } from './src/mobile/src/lib/client';
import { store } from './src/mobile/src/lib/store';
import { openHistory, useHistoryStore } from './src/mobile/src/lib/history';
import { setLang } from './src/mobile/src/lib/i18n';
window.result = (async () => {
 let checks=0; const check=(ok,label)=>{if(!ok)throw new Error(label);checks++};
 const frames = () => new Promise(r => setTimeout(r, 30));
 const wait = ms => new Promise(r => setTimeout(r, ms));
 const reqs=[]; const answers=[];
 client.requestHistory = req => { reqs.push(req); return new Promise(r => answers.push(r)) };
 const ctls=[]; let ack=null;
 client.sendCtl = action => { ctls.push(action); return new Promise(r => { ack = r }) };
 const shown=[]; client.showPane = id => { shown.push(id) };
 const opened=[]; client.requestOpen = id => { opened.push(id); return 'open' };
 const now = Date.now();
 const sessions = [
  { provider:'claude', sessionId:'0b7c2f4e-1a2b-4c3d-8e9f-0123456789ab', cwd:'C:\\\\Users\\\\me\\\\repo', title:'Fix the login bug in the auth flow and add tests for the new token refresh path', updatedAt: now - 3*3600000 },
  { provider:'codex', sessionId:'7c4390bf-8192-43a4-9f60-789abcdef012', cwd:'/srv/app/', title:'codex task', updatedAt: now - 2*86400000 },
  { provider:'claude', sessionId:'2d9e4b6a-3c4d-4e5f-8a1b-23456789abcd', cwd:'C:\\\\Users\\\\me\\\\repo', title:'Open session', updatedAt: now - 60000, paneId:'c1' },
 ];
 const snapshot = {
  language:'en', themeTokens:{}, fontFamily:'mono', fontSize:13, activeWorkspaceId:'w1', keyButtons:[],
  workspaces:[{ id:'w1', name:'Repo', layoutOrder:['c1'], panes:[{ id:'c1', title:'Claude main', type:'claude', color:'', icon:'', running:true }] }],
 };
 setLang('en');
 store.getState().update({ phase:'live', banner:null, connected:true, snapshot, activePaneId:null, subscribedPaneId:null, paneStatus:{} });
 const host=document.getElementById('root'); const reactRoot=createRoot(host);
 flushSync(() => reactRoot.render(<HistoryScreen />)); await frames();
 check(!document.querySelector('[data-push-screen="history"]'),'closed until a workspace opens it');
 openHistory('w1'); await frames(); await wait(350);
 check(!!document.querySelector('[data-push-screen="history"]') && document.body.textContent.includes('History'),'History slides in titled History');
 check(reqs.length===1 && JSON.stringify(reqs[0])==='{"workspaceId":"w1"}','"This workspace" asks with the workspace id and no query: '+JSON.stringify(reqs));
 check(!!document.querySelector('[data-history-loading]'),'a spinner while the PC answers');
 answers.shift()({ ok:true, value:sessions }); await frames();
 const cards=()=>[...document.querySelectorAll('[data-history-card]')];
 check(cards().length===3,'one card per session');
 const first=cards()[0];
 check(first.querySelector('[data-history-folder]').textContent==='repo' && first.querySelector('[data-history-ago]').textContent==='3h ago' && first.dataset.provider==='claude' && !!first.querySelector('svg'),'a card shows the provider icon, the folder basename and "3h ago"');
 check(cards()[1].querySelector('[data-history-folder]').textContent==='app' && cards()[1].querySelector('[data-history-ago]').textContent==='2d ago','POSIX folders and day ages too');
 check(!first.querySelector('[data-history-open-dot]') && !!cards()[2].querySelector('[data-history-open-dot]'),'only the session open in a console has the open dot');
 check(cards().every(c=>c.getBoundingClientRect().height>=48),'cards are at least 48 px tall');
 const tabs=[...document.querySelectorAll('[data-history-tab]')].map(t=>t.textContent+':'+t.getAttribute('aria-selected'));
 check(JSON.stringify(tabs)==='["This workspace:true","All projects:false"]','two tabs, "This workspace" first and selected');

 // Debounced search: one request 250ms after the last keystroke.
 const input=document.querySelector('[data-history-search]');
 const type = v => { const set=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set; set.call(input,v); input.dispatchEvent(new Event('input',{bubbles:true})) };
 type('l'); await wait(80); type('lo'); await wait(80); type('log'); await wait(120);
 check(reqs.length===1,'no request while typing');
 await wait(200);
 check(reqs.length===2 && JSON.stringify(reqs[1])==='{"query":"log","workspaceId":"w1"}','one request 250ms after the last key, with the query and the workspace: '+JSON.stringify(reqs[1]));
 check(cards().length===3,'the previous list stays up while the new one loads');
 answers.shift()({ ok:true, value:[] }); await frames();
 check(document.querySelector('[data-history-empty]')?.textContent==='No session matches "log"','no match says so');

 // "All projects": no workspace id.
 document.querySelector('[data-history-tab="all"]').click(); await frames();
 check(reqs.length===3 && JSON.stringify(reqs[2])==='{"query":"log"}','"All projects" asks without workspaceId');
 // No answer in 10s (the pending map says timeout): "The PC did not answer [Retry]".
 answers.shift()({ ok:false, error:'timeout' }); await frames();
 const noReply=document.querySelector('[data-no-reply]');
 check(!!noReply && noReply.textContent.includes('The PC did not answer'),'a timeout shows "The PC did not answer"');
 noReply.querySelector('button').click(); await frames();
 check(reqs.length===4 && JSON.stringify(reqs[3])==='{"query":"log"}','Retry sends the same request again');
 answers.shift()({ ok:true, value:sessions }); await frames();
 check(!document.querySelector('[data-no-reply]') && cards().length===3,'the answer replaces the error');

 // Resume a closed session.
 cards()[0].click(); await frames(); await wait(350);
 const sheet=()=>document.querySelector('[data-history-sheet]');
 check(sheet()?.querySelector('[data-history-opens]').textContent==='Opens in Repo, folder C:\\\\Users\\\\me\\\\repo','the sheet says where it opens: workspace and folder');
 check(!!document.querySelector('[data-history-resume]') && document.querySelector('[data-history-resume]').textContent.includes('Resume in a new console') && !document.querySelector('[data-history-goto]'),'a closed session offers [Resume in a new console]');
 document.querySelector('[data-history-resume]').click(); document.querySelector('[data-history-resume]').click(); await frames();
 check(ctls.length===1 && JSON.stringify(ctls[0])===JSON.stringify({ kind:'createPane', workspaceId:'w1', paneType:'claude', resume:{ provider:'claude', sessionId:sessions[0].sessionId } }),'Resume sends createPane with resume (no cwd) once: '+JSON.stringify(ctls[0]));
 check(document.querySelector('[data-history-resume]').disabled && !!document.querySelector('[data-history-resume] .animate-spin'),'the button spins until the ack');
 ack({ ok:false, error:'rate' }); await frames();
 check(!!sheet()?.querySelector('[data-no-reply]'),'a rate ack shows "The PC did not answer" in the sheet');
 sheet().querySelector('[data-no-reply] button').click(); await frames();
 check(ctls.length===2,'Retry asks again');
 ack({ ok:true, paneId:'n1' }); await frames(); await wait(400);
 check(JSON.stringify(shown)==='["n1"]' && useHistoryStore.getState().workspaceId===null,'the ack opens the new console on the phone and History closes');

 // An open session: [Go to the console].
 openHistory('w1'); await frames(); await wait(350);
 answers.shift()({ ok:true, value:sessions }); await frames();
 cards()[2].click(); await frames(); await wait(350);
 check(sheet()?.querySelector('[data-history-opens]').textContent==='This session is already open in Claude main' && !!document.querySelector('[data-history-goto]') && !document.querySelector('[data-history-resume]'),'an open session offers [Go to the console]');
 document.querySelector('[data-history-goto]').click(); await frames(); await wait(400);
 check(JSON.stringify(opened)==='["c1"]' && ctls.length===2,'Go to the console opens it without asking the desktop');

 // notFound becomes a toast.
 openHistory('w1'); await frames(); await wait(350);
 answers.shift()({ ok:true, value:sessions }); await frames();
 cards()[1].click(); await frames(); await wait(350);
 document.querySelector('[data-history-resume]').click(); await frames();
 check(ctls.at(-1).paneType==='codex' && ctls.at(-1).resume.provider==='codex','a Codex card resumes with the codex provider');
 ack({ ok:false, error:'notFound' }); await frames();
 const toasts=store.getState().toasts.map(t=>t.text);
 check(toasts.includes('That session no longer exists on the PC'),'notFound shows "That session no longer exists": '+JSON.stringify(toasts));

 // A resume the desktop answers with an existing console goes there, with a toast.
 await wait(400);
 cards()[0].click(); await frames(); await wait(350);
 document.querySelector('[data-history-resume]').click(); await frames();
 ack({ ok:true, paneId:'c1' }); await frames(); await wait(400);
 check(opened.at(-1)==='c1' && store.getState().toasts.some(t=>t.text==='This session is already open in Claude main'),'an ack with an existing console opens it and says it was already open');

 // Spanish, at phone width.
 setLang('es'); flushSync(() => store.getState().update({ snapshot:{ ...snapshot, language:'es' } }));
 openHistory('w1'); await frames(); await wait(350);
 answers.shift()({ ok:true, value:sessions }); await frames();
 const esTabs=[...document.querySelectorAll('[data-history-tab]')].map(t=>t.textContent);
 check(JSON.stringify(esTabs)==='["Este workspace","Todos los proyectos"]' && cards()[0].querySelector('[data-history-ago]').textContent==='hace 3h' && document.querySelector('[data-history-search]').placeholder==='Buscar sesiones','es labels: tabs, "hace 3h", search');
 cards()[0].click(); await frames(); await wait(350);
 check(document.querySelector('[data-history-resume]').textContent.includes('Retomar en consola nueva') && sheet().querySelector('[data-history-opens]').textContent.startsWith('Se abre en Repo, carpeta'),'es sheet: "Se abre en ..., carpeta ..." and [Retomar en consola nueva]');
 { const wide=[...document.querySelectorAll('body *')].filter(e=>e.getBoundingClientRect().right>innerWidth+1).slice(0,5).map(e=>e.tagName+'.'+String(e.className).slice(0,80)); check(document.documentElement.scrollWidth<=innerWidth,'no horizontal overflow at phone width '+JSON.stringify(wide)) }

 // The workspace disappearing on the desktop closes History.
 flushSync(() => store.getState().update({ snapshot:{ ...snapshot, language:'es', workspaces:[] } })); await frames();
 check(useHistoryStore.getState().workspaceId===null,'History closes when its workspace is gone');

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
 console.log('PASS: '+checks+' mobile History UI checks');w.destroy();app.quit();
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
