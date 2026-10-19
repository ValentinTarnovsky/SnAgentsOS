// The phone's Chat view (E3-FR-24..33) in the real MainScreen, in an isolated
// hidden browser at 390x844. The WS client's frame sender is captured (no
// socket opens) and chat frames are fed to its own handlers, decoded from
// scripts/fixtures/chat by the real main decoder. Checks the [Terminal | Chat]
// control (hidden for a shell), unsub + chatSub, the skeleton, the rows
// ("Read 3 files", "Edit App.tsx +2 -1", the red Bash error, the folded
// prompt, the numbered diff, "Output cut"), raw HTML and javascript: links as
// inert text, no horizontal overflow, the "Go to the end (2)" pill, "Load
// earlier" with its chatMore cursor, the composer sending a bracketed paste
// as `input` (never term.paste), "Claude is working...", "The PC did not
// answer", the notice falling back to Terminal with its toast, Spanish
// labels, and 500 messages with the time it took reported.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path')
const { pathToFileURL } = require('node:url')
const { spawnSync } = require('node:child_process')
const root = path.resolve(__dirname, '..')
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snagentsos-mobile-chat-'))
const assets = path.join(root, 'out/mobile/assets')
const mobileCss = fs.existsSync(assets) && fs.readdirSync(assets).find(name => /^index-.*\.css$/.test(name))
if (!mobileCss) throw new Error('Run npm run build:mobile first')
const fixture = fs.readFileSync(path.join(__dirname, 'fixtures/chat/claude-session.jsonl'), 'utf8')
require('esbuild').buildSync({ stdin: { resolveDir: root, loader: 'tsx', contents: `
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { MainScreen } from './src/mobile/src/components/MainScreen';
import { client } from './src/mobile/src/lib/client';
import { store } from './src/mobile/src/lib/store';
import { chatStore } from './src/mobile/src/lib/chatStore';
import { getActiveTerm } from './src/mobile/src/lib/terminalBus';
import { setLang } from './src/mobile/src/lib/i18n';
import { decodeClaude } from './src/main/chat/decodeClaude';
const FIXTURE = ${JSON.stringify(fixture)};
function decodeAll(text) {
  const out = []; let offset = 0;
  for (const line of text.split('\\n')) {
    const bytes = new TextEncoder().encode(line).length + 1;
    if (line.trim()) { let rec; try { rec = JSON.parse(line) } catch { rec = undefined } if (rec !== undefined) out.push(...decodeClaude(rec, offset)) }
    offset += bytes;
  }
  return out;
}
window.result = (async () => {
 let checks=0; const check=(ok,label)=>{if(!ok)throw new Error(label);checks++};
 const frames = () => new Promise(r => setTimeout(r, 30));
 const wait = ms => new Promise(r => setTimeout(r, ms));
 const sent=[];
 client.send = msg => { sent.push(msg); return true };
 client.isOpen = () => true;
 const ofType = type => sent.filter(m => m.type === type);
 const feed = msg => client.handleChatPage({ v:1, type:'chatPage', ...msg });
 const append = (paneId, items) => client.handleChatAppend({ v:1, type:'chatAppend', paneId, items });
 const snapshot = {
  language:'en', themeTokens:{}, fontFamily:'mono', fontSize:13, activeWorkspaceId:'w1', keyButtons:[],
  workspaces:[{ id:'w1', name:'Front', layoutOrder:['c1','s1'], panes:[
   { id:'c1', title:'Claude', type:'claude', color:'', icon:'', running:true },
   { id:'s1', title:'Shell', type:'shell', color:'', icon:'', running:true },
  ] }],
 };
 setLang('en');
 store.getState().update({ phase:'live', banner:null, connected:true, snapshot, activePaneId:'s1', subscribedPaneId:'s1', chatPaneId:null, paneStatus:{ c1:{ state:'idle', provider:'claude', stateSince:1 } } });
 const host=document.getElementById('root'); const reactRoot=createRoot(host);
 flushSync(() => reactRoot.render(<MainScreen />)); await frames(); await wait(50);
 const q = sel => host.querySelector(sel);
 const qa = sel => [...host.querySelectorAll(sel)];
 check(!q('[data-view-toggle]'),'a shell console shows no [Terminal | Chat] control');
 client.viewPane('c1'); await frames();
 check(!!q('[data-view-toggle="terminal"]') && qa('[data-view-option]').length===2,'a Claude console shows [Terminal | Chat], Terminal selected');
 check(qa('[data-view-option]').every(b => b.getBoundingClientRect().width >= 44 && b.getAttribute('aria-label')),'each option is 44px wide with an aria-label');
 const term = getActiveTerm(); let pasted = 0;
 if (term) term.paste = () => { pasted++ };

 // Into Chat: unsub, then chatSub (FR-25).
 sent.length = 0;
 q('[data-view-option="chat"]').click(); await frames();
 check(sent.map(m => m.type + ':' + m.paneId).join(',') === 'unsub:c1,chatSub:c1','into Chat sends unsub then chatSub: ' + JSON.stringify(sent));
 check(store.getState().chatPaneId === 'c1' && localStorage.getItem('snagentsos.remote.paneView.c1') === 'chat','the choice is saved per pane');
 check(!!q('[data-chat-view="c1"]') && !!q('[data-chat-skeleton]'),'the Chat view shows a skeleton while the first page loads');
 check(!q('[data-key-bar]') || q('[data-connected]').hidden,'the KeyBar steps aside in Chat');
 check(!!q('[data-kb-input="composer"]'),'the composer is docked in Chat even in Direct mode');

 // The first page.
 const items = decodeAll(FIXTURE);
 feed({ paneId:'c1', items, cursor:null, done:true }); await frames(); await wait(50);
 check(!q('[data-chat-skeleton]') && qa('[data-chat-row]').length > 5,'the first page renders its rows');
 const log = q('[role="log"]');
 check(!!log && log.getAttribute('aria-label'),'the list is a labelled role=log');
 const labels = qa('[data-tool-label]').map(e => e.textContent);
 check(labels.includes('Read 3 files') && labels.includes('Edit App.tsx +2 -1') && labels.includes('Bash npm test'),'tool rows: "Read 3 files", "Edit App.tsx +2 -1", "Bash npm test": ' + JSON.stringify(labels));
 const bash = qa('[data-tool-run]').find(r => r.textContent.includes('Bash npm test'));
 check(bash.dataset.status === 'error','a failed tool shows in red (status error)');
 // Raw HTML and javascript: links.
 check(!log.querySelector('script') && !log.querySelector('img') && log.textContent.includes('<script>alert(1)</script>') && log.textContent.includes('<img src=x onerror=alert(2)>'),'<script> and <img onerror> show as text');
 check(![...log.querySelectorAll('a')].some(a => /^javascript:/i.test(a.getAttribute('href') || '')),'a javascript: link is not clickable');
 const docs = [...log.querySelectorAll('a')].find(a => a.textContent === 'docs');
 check(docs && docs.href === 'https://example.com/docs' && docs.target === '_blank' && docs.rel === 'noopener noreferrer','an https link opens in a new tab with noopener noreferrer');
 check(!!log.querySelector('[data-md-code] pre') && log.textContent.includes('const a = 1'),'code blocks render inside a scrolling pre');
 check(!!log.querySelector('[data-chat-image]'),'images are an [Image] chip');
 check(!!log.querySelector('[data-chat-thinking]') && log.querySelector('[data-chat-thinking]').textContent.includes('Thinking'),'thinking is a folded "Thinking" row');
 check([...log.querySelectorAll('[data-chat-system]')].some(e => e.textContent === 'Interrupted by the user'),'an interruption is a grey system row');
 // The 5-line prompt folds with "Show more".
 const bubble = log.querySelector('[data-chat-bubble]');
 check(bubble.dataset.folded === 'true' && Math.round(bubble.getBoundingClientRect().height) < 4.6 * 20 + 20,'a 5-line prompt is folded to 4 lines');
 log.querySelector('[data-chat-more]').click(); await frames();
 check(log.querySelector('[data-chat-bubble]').dataset.folded === 'false','"Show more" unfolds it');
 // Expand the Edit row: a numbered diff.
 const editRow = qa('[data-tool-run]').find(r => r.textContent.includes('Edit App.tsx'));
 editRow.querySelector('button').click(); await frames();
 const diffLines = [...editRow.querySelectorAll('[data-diff-line]')];
 check(diffLines.length === 5 && diffLines[1].dataset.diffLine === '-' && diffLines[1].textContent.startsWith('11') && diffLines[2].textContent.includes('+const y = 3'),'the Edit row expands to a numbered diff with +/- as text');
 // No horizontal overflow at phone width.
 { const wide=[...document.querySelectorAll('body *')].filter(e=>e.getBoundingClientRect().right>innerWidth+1 && !e.closest('[data-scrollable]')).slice(0,5).map(e=>e.tagName+'.'+String(e.className).slice(0,60)); check(document.documentElement.scrollWidth<=innerWidth && wide.length===0,'no horizontal overflow at 390px '+JSON.stringify(wide)) }

 // Expand all.
 q('[data-chat-toggle-all]').click(); await frames();
 check(qa('[data-tool-detail]').length === qa('[data-tool-run]').length,'the floating control expands every tool row');
 q('[data-chat-toggle-all]').click(); await frames();
 check(qa('[data-tool-detail]').length === 0,'and folds them all');

 // Long output: the 4KB preview and "Output cut".
 const longOut = { id:'99999', role:'tool', ts:null, blocks:[{ t:'toolResult', toolUseId:'toolu_b1', isError:false, text:'z'.repeat(4096), truncated:true }] };
 append('c1', [{ id:'99990', role:'assistant', ts:null, blocks:[{ t:'toolUse', id:'toolu_big', name:'Bash', summary:'cat big.log' }] }, { ...longOut, blocks:[{ ...longOut.blocks[0], toolUseId:'toolu_big' }] }]); await frames();
 const bigRow = qa('[data-tool-run]').find(r => r.textContent.includes('cat big.log'));
 bigRow.querySelector('button').click(); await frames();
 check(bigRow.querySelector('[data-tool-output]').textContent.length === 4096 && bigRow.querySelector('[data-tool-cut]').textContent === 'Output cut, full output on the PC','a cut output says the full output is on the PC');

 // "Go to the end (2)".
 const scroll = q('[data-chat-scroll]');
 for (let i = 0; i < 30; i++) append('c1', [{ id:String(100000 + i), role:'assistant', ts:null, blocks:[{ t:'text', text:'Filler line ' + i + ' with enough words to take a row.' }] }]);
 await frames(); await wait(50);
 check(scroll.scrollTop + scroll.clientHeight >= scroll.scrollHeight - 2,'at the end, new messages scroll in on their own');
 scroll.scrollTop = scroll.scrollHeight - scroll.clientHeight - 300; scroll.dispatchEvent(new Event('scroll')); await frames();
 append('c1', [{ id:'200000', role:'assistant', ts:null, blocks:[{ t:'text', text:'new one' }] }, { id:'200001', role:'assistant', ts:null, blocks:[{ t:'text', text:'new two' }] }]); await frames();
 const pill = q('[data-chat-jump]');
 check(pill && pill.textContent === 'Go to the end (2)','scrolled 300px up, two new messages show "Go to the end (2)"');
 pill.click(); await wait(400);
 check(!q('[data-chat-jump]'),'the pill takes the reader to the end and goes away');

 // Working.
 store.getState().update({ paneStatus:{ c1:{ state:'working', provider:'claude', stateSince:2 } } }); await frames();
 check(q('[data-chat-working]')?.textContent === 'Claude is working...','"Claude is working..." while the status says working');
 store.getState().update({ paneStatus:{ c1:{ state:'idle', provider:'claude', stateSince:3 } } }); await frames();

 // Composer in Chat: a 3-line prompt as one bracketed paste, then Enter, by input frames.
 sent.length = 0;
 const ta = q('[data-kb-input="composer"]');
 const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set;
 setter.call(ta, 'line one\\nline two\\nline three'); ta.dispatchEvent(new Event('input',{bubbles:true})); await frames();
 const btn = q('[data-composer-send]');
 btn.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,pointerId:1,pointerType:'touch',isPrimary:true}));
 btn.dispatchEvent(new PointerEvent('pointerup',{bubbles:true,pointerId:1,pointerType:'touch',isPrimary:true}));
 await wait(250);
 const inputs = ofType('input').map(m => m.data);
 check(inputs[0] === '\\x1b[200~line one\\rline two\\rline three\\x1b[201~' && inputs.at(-1) === '\\r' && ofType('input').every(m => m.paneId === 'c1'),'the composer sends one bracketed paste and Enter as input frames: ' + JSON.stringify(inputs));
 check(pasted === 0,'term.paste is never used in Chat');

 // Load earlier: a page with more before it.
 const many = Array.from({ length: 50 }, (_, i) => ({ id:String(5000 + i * 100), role: i % 2 ? 'assistant' : 'user', ts:null, blocks:[{ t:'text', text:'page message ' + i }] }));
 feed({ paneId:'c1', items:many, cursor:'5000', done:false }); await frames(); await wait(50);
 check(!!q('[data-chat-load-earlier]') && q('[data-chat-load-earlier]').textContent === 'Load earlier','a page with more before it offers "Load earlier"');
 sent.length = 0;
 q('[data-chat-load-earlier]').click(); await frames();
 check(sent.length === 1 && sent[0].type === 'chatMore' && sent[0].before === '5000' && !!q('[data-chat-skeleton]'),'"Load earlier" sends chatMore with the cursor and shows the skeleton');
 const firstRow = q('[data-chat-id="5000"]'); const topBefore = firstRow.getBoundingClientRect().top;
 feed({ paneId:'c1', items:[{ id:'100', role:'user', ts:null, blocks:[{ t:'text', text:'older' }] }], cursor:null, done:true }); await frames(); await wait(50);
 check(chatStore.getState().chats.c1.list.items[0].id === '100' && !q('[data-chat-load-earlier]'),'the older page goes in front and the list is done');
 check(Math.abs(q('[data-chat-id="5000"]').getBoundingClientRect().top - topBefore) < 2,'"Load earlier" does not move what the reader sees');

 // No answer in 10s: "The PC did not answer [Retry]".
 chatStore.getState().begin('c1','more'); chatStore.getState().fail('c1','more'); await frames();
 check(!!q('[data-chat-view] [data-no-reply]'),'a page that never came shows "The PC did not answer"');
 chatStore.getState().replace('c1', { items:many, cursor:'5000', done:false }); await frames();

 // 500 messages.
 const t0 = performance.now();
 const five = Array.from({ length: 500 }, (_, i) => ({ id:String(10 + i * 100), role: i % 3 === 0 ? 'user' : 'assistant', ts:null, blocks:[{ t:'text', text:'**Message** ' + i + ' with some \`code\` and a [link](https://example.com/' + i + ')' }] }));
 feed({ paneId:'c1', items:five, cursor:null, done:true }); await frames();
 const ms = performance.now() - t0;
 console.log('500 messages rendered in ' + ms.toFixed(0) + ' ms');
 check(qa('[data-chat-row]').length === 500,'500 messages render');

 // Notice: back to Terminal with the toast (FR-33).
 sent.length = 0;
 feed({ paneId:'c1', items:[{ id:'notice', role:'system', ts:null, blocks:[{ t:'notice', code:'ambiguous' }] }], cursor:null, done:true }); await frames();
 check(store.getState().chatPaneId === null && sent.map(m => m.type).join(',') === 'chatUnsub,sub' && !q('[data-chat-view]'),'a notice goes back to Terminal: chatUnsub then sub');
 const toast = store.getState().toasts.at(-1)?.text;
 check(toast === 'Chat not available for this console. Install the status hooks to enable it','the toast says why and suggests the hooks: ' + toast);
 check(localStorage.getItem('snagentsos.remote.paneView.c1') === 'chat' && q('[data-view-toggle]').dataset.viewToggle === 'terminal','the fallback is not saved (the console shows Terminal for now)');

 // Spanish labels.
 setLang('es'); flushSync(() => store.getState().update({ snapshot:{ ...snapshot, language:'es' } }));
 store.getState().setPaneView('c1','terminal',false);
 sent.length = 0;
 q('[data-view-option="chat"]').click(); await frames();
 feed({ paneId:'c1', items, cursor:null, done:true }); await frames(); await wait(50);
 const esLabels = qa('[data-tool-label]').map(e => e.textContent);
 check(esLabels.includes('Read 3 archivos') && q('[data-chat-thinking]').textContent.includes('Pensando') && q('[data-chat-more]').textContent === 'Ver mas','es: "Read 3 archivos", "Pensando", "Ver mas"');
 store.getState().update({ paneStatus:{ c1:{ state:'working', provider:'claude', stateSince:4 } } }); await frames();
 check(q('[data-chat-working]')?.textContent === 'Claude esta trabajando...','es: "Claude esta trabajando..."');
 { const wide=[...document.querySelectorAll('body *')].filter(e=>e.getBoundingClientRect().right>innerWidth+1 && !e.closest('[data-scrollable]')).slice(0,5).map(e=>e.tagName+'.'+String(e.className).slice(0,60)); check(document.documentElement.scrollWidth<=innerWidth && wide.length===0,'no horizontal overflow in Spanish '+JSON.stringify(wide)) }

 // The status losing its provider (agent gone) goes back to Terminal on its own.
 sent.length = 0;
 store.getState().update({ paneStatus:{} }); client.syncView(); await frames();
 check(store.getState().chatPaneId === null && sent.map(m => m.type).join(',') === 'chatUnsub,sub' && !q('[data-view-toggle]'),'a console that is no longer an agent returns to Terminal and hides the control');

 // A reconnect while the first page is still pending: the new socket gets
 // its chatSub at once (the old request never answers).
 store.getState().update({ paneStatus:{ c1:{ state:'idle', provider:'claude', stateSince:5 } } });
 store.getState().setPaneView('c1','chat');
 client.syncView(); await frames();
 check(store.getState().chatPaneId === 'c1' && ofType('chatSub').length === 1,'back in Chat with the first page pending');
 sent.length = 0;
 const live = { ...snapshot, language:'en', workspaces: snapshot.workspaces.map(w => ({ ...w, panes: w.panes.map(p => p.id === 'c1' ? { ...p, status:{ state:'idle', provider:'claude', stateSince:6 } } : p) })) };
 client.goLive(live, 'win32', 'test'); await frames();
 check(sent.some(m => m.type === 'chatSub' && m.paneId === 'c1') && store.getState().chatPaneId === 'c1','a reconnect re-sends chatSub even though the old one never answered: ' + JSON.stringify(sent.map(m => m.type)));
 feed({ paneId:'c1', items, cursor:null, done:true }); await frames();
 check(qa('[data-chat-row]').length > 5 && !q('[data-no-reply]'),'and the page it answers renders');

 reactRoot.unmount(); return checks;
})();
` }, bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"', __APP_VERSION__: '"test"' }, alias: { '@shared': path.join(root, 'src/shared') }, loader: { '.css': 'empty' }, outfile: path.join(dir, 'renderer.js') })
fs.writeFileSync(path.join(dir, 'index.html'), `<html><head><meta charset="utf-8"><link rel="stylesheet" href="${pathToFileURL(path.join(assets, mobileCss))}"></head><body style="margin:0"><div id="root"></div><script src="renderer.js"></script></body></html>`)
fs.writeFileSync(path.join(dir, 'main.cjs'), `
const {app,BrowserWindow}=require('electron');const path=require('path');
app.setPath('userData',path.join(__dirname,'profile'));
app.whenReady().then(async()=>{
 const w=new BrowserWindow({show:false,width:390,height:844,webPreferences:{sandbox:true,backgroundThrottling:false}});
 w.webContents.on('console-message',(_e,_l,msg)=>{ if(/rendered in/.test(msg)) console.log('  '+msg) });
 await w.loadFile(path.join(__dirname,'index.html'));
 const checks=await w.webContents.executeJavaScript('window.result');
 console.log('PASS: '+checks+' mobile Chat view checks');w.destroy();app.quit();
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
