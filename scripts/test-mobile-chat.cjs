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
// labels, and 500 messages with the time it took reported. v2.2.1: a Codex
// console with no status is eligible by type and opens in Chat with "Open
// agent consoles in Chat", its notice toast names the Codex integration, the
// fallback is not sticky (the next open, a precise status), and a choice equal
// to the default is not saved. v2.3.0: the notice toast shows once per
// console and page session, until its provider or precise flag changes.
// v2.4.0: answer cards in Chat: the Plan card from status.menu ("Yes, and use
// auto mode"), a tap as ctl answerMenu with no input frame, the menu_changed
// and no_menu toasts, the free text row focusing the composer, Always allow
// by answerMenu and Allow as "1", the ask wizard, the key row (1 / Esc, never
// Enter) for an elicitation and a Codex request, [Terminal], the log pinned
// to the end under a card, and Spanish. v2.7.0: a Grep then a Glob fold into
// one "Search 2" phase row that expands to its tool rows ("Búsqueda 2" in es);
// the PC's `paused` notice (ChatHub's LRU) keeps the list under a bar whose
// [Resume] sends chatSub again, and the next first page clears it; neither
// the revive pong after more than 10s hidden nor a reconnect (authOk) sends
// chatSub for a paused chat (a Resume lost with the socket leaves "The PC did
// not answer" and a working [Resume]), while the pong still resyncs one not paused.
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
 // Hidden windows paint slowly: layout-driven work (ResizeObserver) gets a task-based wait.
 const until = async (fn, ms = 3000) => { const end = Date.now() + ms; while (!fn() && Date.now() < end) await wait(30); return fn() };
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
   { id:'x1', title:'Codex', type:'codex', color:'', icon:'', running:true },
  ] }],
 };
 setLang('en');
 // screen 'terminal': the console is on screen (a reconnect on Home subscribes nothing, v2.2.1).
 store.getState().update({ phase:'live', banner:null, connected:true, screen:'terminal', snapshot, activePaneId:'s1', subscribedPaneId:'s1', chatPaneId:null, paneStatus:{ c1:{ state:'idle', provider:'claude', stateSince:1 } } });
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

 // app 2.7.0: tool rows of one family fold into a phase ("Search 2"), expandable to its rows.
 const phaseItems = [{ id:'10', role:'user', ts:null, blocks:[{ t:'text', text:'find the todos' }] }, { id:'20', role:'assistant', ts:null, blocks:[{ t:'toolUse', id:'toolu_g1', name:'Grep', summary:'TODO' }] }, { id:'30', role:'tool', ts:null, blocks:[{ t:'toolResult', toolUseId:'toolu_g1', isError:false, text:'a.ts:1' }] }, { id:'40', role:'assistant', ts:null, blocks:[{ t:'toolUse', id:'toolu_g2', name:'Glob', summary:'**/*.ts' }] }, { id:'50', role:'tool', ts:null, blocks:[{ t:'toolResult', toolUseId:'toolu_g2', isError:false, text:'a.ts' }] }, { id:'60', role:'assistant', ts:null, blocks:[{ t:'text', text:'Two of them.' }] }];
 feed({ paneId:'c1', items:phaseItems, cursor:null, done:true }); await frames();
 const phase = q('[data-tool-phase="search"]');
 check(!!phase && phase.querySelector('[data-phase-label]').textContent === 'Search 2' && phase.dataset.status === 'done' && !phase.querySelector('[data-tool-run]'),'a Grep then a Glob fold into one "Search 2" phase row');
 phase.querySelector('button').click(); await frames();
 const phaseRuns = [...phase.querySelectorAll('[data-tool-run] [data-tool-label]')].map(e => e.textContent);
 check(phaseRuns.join('|') === 'Grep TODO|Glob **/*.ts' && phase.querySelector('button').getAttribute('aria-expanded') === 'true','the phase expands to its tool rows: ' + JSON.stringify(phaseRuns));
 phase.querySelector('button').click(); await frames();
 check(!phase.querySelector('[data-tool-run]'),'and folds again');

 // app 2.7.0 (A7): the PC paused this chat for another one (ChatHub's LRU): the
 // list stays under a bar, nothing reopens on its own, only [Resume] subscribes again.
 const keptIds = qa('[data-chat-id]').length;
 sent.length = 0;
 client.handleChatAppend({ v:1, type:'chatAppend', paneId:'c1', items:[], notice:'paused' }); await frames();
 check(!!q('[data-chat-paused]') && q('[data-chat-paused]').textContent.includes('This chat was paused') && q('[data-chat-resume]')?.textContent === 'Resume' && qa('[data-chat-id]').length === keptIds,'the paused notice keeps the list under "This chat was paused" with [Resume]');
 check(chatStore.getState().chats.c1.paused === true && sent.length === 0 && store.getState().chatPaneId === 'c1','it sends nothing and stays in Chat');
 { const wide=[...document.querySelectorAll('body *')].filter(e=>e.getBoundingClientRect().right>innerWidth+1 && !e.closest('[data-scrollable]')).slice(0,5).map(e=>e.tagName+'.'+String(e.className).slice(0,60)); check(document.documentElement.scrollWidth<=innerWidth && wide.length===0,'the paused bar fits '+JSON.stringify(wide)) }
 // Nor does the client ask for it: not the resync of a page back after more
 // than 10s hidden (on the revive probe's pong), not a reconnect (authOk).
 // An open authed socket stands in for the real one; send stays captured.
 const recv = msg => client.onMessage({ data: JSON.stringify({ v:1, ...msg }) });
 const revive = () => { client.hiddenAt = performance.now() - 15000; client.onRevive('visible') };
 const types = () => sent.map(m => m.type + (m.paneId ? ':' + m.paneId : '')).join();
 Object.assign(client, { ws:{ readyState: WebSocket.OPEN, close() {} }, socketAuthed:true, mode:'auth', deviceId:'dev1' });
 sent.length = 0;
 revive();
 check(client.resyncOnPong === true && types() === 'ping','a page back after 15s hidden probes the socket, to resync on the pong: ' + types());
 recv({ type:'pong', t:Date.now() }); await frames();
 check(types() === 'ping' && !!q('[data-chat-paused]') && store.getState().chatPaneId === 'c1','the revive pong sends no chatSub for the paused chat and the bar stays: ' + types());
 const withStatus = { ...snapshot, workspaces: snapshot.workspaces.map(w => ({ ...w, panes: w.panes.map(p => p.id === 'c1' ? { ...p, status:{ state:'idle', provider:'claude', stateSince:3 } } : p) })) };
 sent.length = 0;
 recv({ type:'authOk', deviceId:'dev1', state:withStatus, hostPlatform:'win32', appVersion:'test' }); await frames();
 check(store.getState().phase === 'live' && !sent.some(m => m.type === 'chatSub' || m.type === 'sub') && store.getState().chatPaneId === 'c1' && chatStore.getState().chats.c1.paused === true && !!q('[data-chat-paused]') && qa('[data-chat-id]').length === keptIds,'a reconnect (authOk) keeps the paused chat in Chat under its bar, with no chatSub: ' + types());
 sent.length = 0;
 q('[data-chat-resume]').click(); await frames();
 check(sent.map(m => m.type + ':' + m.paneId).join() === 'chatSub:c1' && q('[data-chat-resume]').disabled,'[Resume] sends chatSub again and waits, disabled, for the page: ' + JSON.stringify(sent));
 // A Resume lost with the socket (a reconnect within its 10s) is not asked
 // again on its own, and never leaves [Resume] disabled for good.
 sent.length = 0;
 recv({ type:'authOk', deviceId:'dev1', state:withStatus, hostPlatform:'win32', appVersion:'test' }); await frames();
 check(!sent.some(m => m.type === 'chatSub') && !!q('[data-chat-paused]') && !q('[data-chat-resume]').disabled && !!q('[data-chat-view] [data-no-reply]'),'a Resume the old socket never answered: the reconnect asks nothing, "The PC did not answer" and [Resume] works again: ' + types());
 sent.length = 0;
 q('[data-chat-resume]').click(); await frames();
 check(types() === 'chatSub:c1' && q('[data-chat-resume]').disabled,'and its next tap sends chatSub: ' + types());
 feed({ paneId:'c1', items:phaseItems, cursor:null, done:true }); await frames();
 check(!q('[data-chat-paused]') && chatStore.getState().chats.c1.paused === false,'the fresh first page clears the bar');
 // The same pong does resync a chat that is not paused: the path above ran.
 sent.length = 0;
 revive(); recv({ type:'pong', t:Date.now() }); await frames();
 check(types() === 'ping,chatSub:c1','a chat that is not paused gets a fresh first page on the revive pong: ' + types());
 client.stopKeepalive(); client.clearIdleWatchdog(); client.clearDeadline();
 Object.assign(client, { ws:null, socketAuthed:false, mode:'idle', deviceId:null, hiddenAt:null });
 feed({ paneId:'c1', items:phaseItems, cursor:null, done:true, notice:'paused' }); await frames();
 check(!!q('[data-chat-paused]') && !!q('[data-tool-phase="search"]'),'a first page read while the PC closed the watcher shows under the bar');
 feed({ paneId:'c1', items:phaseItems, cursor:null, done:true }); await frames();
 check(!q('[data-chat-paused]'),'and the next one clears it');

 // Notice: back to Terminal with the toast (FR-33).
 sent.length = 0;
 feed({ paneId:'c1', items:[{ id:'notice', role:'system', ts:null, blocks:[{ t:'notice', code:'ambiguous' }] }], cursor:null, done:true }); await frames();
 check(store.getState().chatPaneId === null && sent.map(m => m.type).join(',') === 'chatUnsub,sub' && !q('[data-chat-view]'),'a notice goes back to Terminal: chatUnsub then sub');
 const toast = store.getState().toasts.at(-1)?.text;
 check(toast === 'Chat not available for this console. Install the status hooks to enable it','the toast says why and suggests the hooks: ' + toast);
 check(localStorage.getItem('snagentsos.remote.paneView.c1') === 'chat' && q('[data-view-toggle]').dataset.viewToggle === 'terminal' && store.getState().chatRefused.c1 === true,'the fallback is not saved (the console shows Terminal for this open only)');

 // Spanish labels. A tap on Chat asks the desktop again after the notice.
 setLang('es'); flushSync(() => store.getState().update({ snapshot:{ ...snapshot, language:'es' } }));
 sent.length = 0;
 q('[data-view-option="chat"]').click(); await frames();
 feed({ paneId:'c1', items, cursor:null, done:true }); await frames(); await wait(50);
 const esLabels = qa('[data-tool-label]').map(e => e.textContent);
 check(esLabels.includes('Read 3 archivos') && q('[data-chat-thinking]').textContent.includes('Pensando') && q('[data-chat-more]').textContent === 'Ver más','es: "Read 3 archivos", "Pensando", "Ver más"');
 feed({ paneId:'c1', items:phaseItems, cursor:null, done:true }); await frames();
 check(q('[data-tool-phase="search"] [data-phase-label]')?.textContent === 'Búsqueda 2','es: the phase says "Búsqueda 2"');
 client.handleChatAppend({ v:1, type:'chatAppend', paneId:'c1', items:[], notice:'paused' }); await frames();
 check(q('[data-chat-paused]')?.textContent.includes('Este chat se pausó') && q('[data-chat-resume]').textContent === 'Reanudar','es: "Este chat se pausó" with [Reanudar]');
 feed({ paneId:'c1', items:phaseItems, cursor:null, done:true }); await frames();
 store.getState().update({ paneStatus:{ c1:{ state:'working', provider:'claude', stateSince:4 } } }); await frames();
 check(q('[data-chat-working]')?.textContent === 'Claude está trabajando...','es: "Claude está trabajando..."');
 { const wide=[...document.querySelectorAll('body *')].filter(e=>e.getBoundingClientRect().right>innerWidth+1 && !e.closest('[data-scrollable]')).slice(0,5).map(e=>e.tagName+'.'+String(e.className).slice(0,60)); check(document.documentElement.scrollWidth<=innerWidth && wide.length===0,'no horizontal overflow in Spanish '+JSON.stringify(wide)) }

 // A shell where an agent was started by hand: its status names the agent, so
 // the control shows; losing that status goes back to Terminal on its own.
 store.getState().update({ paneStatus:{ c1:{ state:'idle', provider:'claude', stateSince:4 }, s1:{ state:'idle', provider:'claude', stateSince:4 } } });
 client.viewPane('s1'); await frames();
 check(!!q('[data-view-toggle]'),'a shell whose status names Claude shows the control');
 q('[data-view-option="chat"]').click(); await frames();
 check(store.getState().chatPaneId === 's1','and opens as Chat');
 sent.length = 0;
 store.getState().update({ paneStatus:{ c1:{ state:'idle', provider:'claude', stateSince:4 } } }); client.syncView(); await frames();
 check(store.getState().chatPaneId === null && sent.map(m => m.type).join(',') === 'chatUnsub,sub' && !q('[data-view-toggle]'),'a shell that is no longer an agent returns to Terminal and hides the control');
 // A Claude console keeps the control by its type even with no status (v2.2.1).
 store.getState().update({ paneStatus:{} }); client.viewPane('c1'); await frames();
 check(!!q('[data-view-toggle]'),'a Claude console that lost its status keeps the control (eligible by type)');

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

 // A new session whose transcript is not written yet (a console just created,
 // a /clear): the PC answers an empty first page and the phone stays in Chat.
 feed({ paneId:'c1', items:[], cursor:null, done:true }); await frames(); await wait(50);
 const empty = q('[data-chat-empty]')?.textContent;
 check(store.getState().chatPaneId === 'c1' && !!q('[data-chat-view="c1"]') && ['No messages yet. Write the first one below.','Todavía no hay mensajes. Escribí el primero abajo.'].includes(empty) && !!q('[data-kb-input="composer"]'),'an empty first page stays in Chat, invites the first message and keeps the composer: ' + empty);
 feed({ paneId:'c1', items:[{ id:'10', role:'user', ts:null, blocks:[{ t:'text', text:'primer mensaje' }] }], cursor:null, done:true }); await frames(); await wait(50);
 check(qa('[data-chat-row]').length === 1 && !q('[data-chat-empty]'),'the first page with that message replaces the empty state');

 // v2.2.1: "Open agent consoles in Chat" is global: turning it on clears every per-console choice.
 setLang('en'); flushSync(() => store.getState().update({ snapshot }));
 store.getState().setChatDefault(true);
 const viewKeys = () => Object.keys(localStorage).filter(k => k.startsWith('snagentsos.remote.paneView.'));
 check(localStorage.getItem('snagentsos.remote.chatDefault') === 'true' && Object.keys(store.getState().paneViews).length === 0 && viewKeys().length === 0,'turning "Open agent consoles in Chat" on clears every saved per-console choice: ' + JSON.stringify(viewKeys()));
 // A Codex console without its integration (no status at all) is eligible by its type and opens straight into Chat.
 check(!store.getState().paneStatus.x1,'the Codex console has no status');
 sent.length = 0;
 client.viewPane('x1'); await frames();
 check(ofType('chatSub').at(-1)?.paneId === 'x1' && !sent.some(m => m.type === 'sub' && m.paneId === 'x1') && store.getState().chatPaneId === 'x1','a Codex console with no status opens in Chat (chatSub, no sub): ' + JSON.stringify(sent.map(m => m.type + ':' + m.paneId)));
 check(q('[data-view-toggle]')?.dataset.viewToggle === 'chat','and shows the [Terminal | Chat] control on Chat');
 // Its notice names the Codex integration, not the hooks.
 sent.length = 0;
 feed({ paneId:'x1', items:[{ id:'notice', role:'system', ts:null, blocks:[{ t:'notice', code:'noTranscript' }] }], cursor:null, done:true }); await frames();
 check(store.getState().chatPaneId === null && sent.map(m => m.type + ':' + m.paneId).join(',') === 'chatUnsub:x1,sub:x1','a Codex notice goes back to Terminal');
 const codexToast = store.getState().toasts.at(-1)?.text;
 check(codexToast === 'Chat not available for this console. Turn on the Codex integration in the PC settings to enable it','the Codex toast names the Codex integration: ' + codexToast);
 check(localStorage.getItem('snagentsos.remote.paneView.x1') === null && q('[data-view-toggle]')?.dataset.viewToggle === 'terminal','the fallback is not saved');
 // Not sticky: the next open tries Chat again.
 client.viewPane('c1'); await frames();
 check(store.getState().chatPaneId === 'c1','a Claude console opens in Chat with the default on');
 sent.length = 0;
 client.viewPane('x1'); await frames();
 check(sent.some(m => m.type === 'chatSub' && m.paneId === 'x1') && store.getState().chatPaneId === 'x1','opening the Codex console again tries Chat again (the notice only lasted for that open)');
 // v2.3.0: the toast shows once per console and page session; the fallback still runs each time.
 const codexNotice = () => feed({ paneId:'x1', items:[{ id:'notice', role:'system', ts:null, blocks:[{ t:'notice', code:'noTranscript' }] }], cursor:null, done:true });
 const toastMark = () => store.getState().toasts.reduce((m, x) => Math.max(m, x.id), 0);
 const chatToastsSince = id => store.getState().toasts.filter(x => x.id > id && /^Chat (not available|no disponible)/.test(x.text)).length;
 const reopenX1 = async () => { client.viewPane('c1'); await frames(); sent.length = 0; client.viewPane('x1'); await frames(); };
 let mark = toastMark(); sent.length = 0;
 codexNotice(); await frames();
 check(chatToastsSince(mark) === 0 && store.getState().chatPaneId === null && sent.map(m => m.type + ':' + m.paneId).join(',') === 'chatUnsub:x1,sub:x1','a second notice with the same status gives no toast but still goes back to Terminal');
 mark = toastMark(); await reopenX1();
 check(sent.some(m => m.type === 'chatSub' && m.paneId === 'x1') && store.getState().chatPaneId === 'x1' && chatToastsSince(mark) === 0,'reopening sends chatSub without a toast');
 codexNotice(); await frames();
 check(chatToastsSince(mark) === 0 && store.getState().chatPaneId === null,'and its notice gives no toast either');
 // A status that names the agent is a new key: one toast. Turns after it (working -> done -> working) are not.
 client.handlePaneStatus('x1', { state:'working', provider:'codex', stateSince:7 }); await frames();
 mark = toastMark(); await reopenX1(); codexNotice(); await frames();
 check(chatToastsSince(mark) === 1,'a status that appears is a new key: one toast');
 client.handlePaneStatus('x1', { state:'done', provider:'codex', stateSince:7 }); await frames();
 client.handlePaneStatus('x1', { state:'working', provider:'codex', stateSince:7 }); await frames();
 mark = toastMark(); await reopenX1();
 check(store.getState().chatPaneId === 'x1' && chatToastsSince(mark) === 0,'a working -> done -> working cycle and a reopen give no toast');
 codexNotice(); await frames();
 check(chatToastsSince(mark) === 0 && store.getState().chatPaneId === null,'nor does the notice after that cycle');
 await reopenX1();
 mark = toastMark();
 // Spanish toast, after a title-only status (precise:false).
 client.handlePaneStatus('x1', { state:'working', provider:'codex', precise:false, stateSince:7 }); await frames();
 setLang('es');
 feed({ paneId:'x1', items:[{ id:'notice', role:'system', ts:null, blocks:[{ t:'notice', code:'ambiguous' }] }], cursor:null, done:true }); await frames();
 const esToast = store.getState().toasts.at(-1)?.text;
 check(esToast === 'Chat no disponible para esta consola. Activá la integración de Codex en los ajustes de la PC para habilitarlo','es: the Codex toast: ' + esToast);
 check(chatToastsSince(mark) === 1,'the title-only status (precise:false) is a new key: exactly one more toast');
 setLang('en');
 // A to B and back to A, with no notice in between: the change forgot the toast, so it shows again. Once through paneStatus, once through the state snapshot.
 const titleStatus = { state:'working', provider:'codex', precise:false, stateSince:7 };
 client.handlePaneStatus('x1', null); await frames();
 client.handlePaneStatus('x1', titleStatus); await frames();
 mark = toastMark(); await reopenX1();
 check(store.getState().chatPaneId === 'x1','back on the title-only status, reopening tries Chat');
 codexNotice(); await frames();
 check(chatToastsSince(mark) === 1 && store.getState().chatPaneId === null,'a status that goes away and comes back (paneStatus) shows the toast once more');
 const stateWith = x1 => ({ ...snapshot, workspaces: snapshot.workspaces.map(ws => ({ ...ws, panes: ws.panes.map(p => { const st = p.id === 'x1' ? x1 : store.getState().paneStatus[p.id]; return st ? { ...p, status: st } : p }) })) });
 client.handleState(stateWith(null)); await frames();
 check(!store.getState().paneStatus.x1,'a state snapshot without its status clears it');
 client.handleState(stateWith(titleStatus)); await frames();
 mark = toastMark(); await reopenX1(); codexNotice(); await frames();
 check(chatToastsSince(mark) === 1 && store.getState().paneStatus.x1?.precise === false,'the same round trip through state snapshots shows the toast once more');
 mark = toastMark(); await reopenX1(); codexNotice(); await frames();
 check(chatToastsSince(mark) === 0 && store.getState().chatPaneId === null,'and the next notice with that status gives none');
 // The status turning precise (the integration or hooks took over) retries Chat live.
 sent.length = 0;
 client.handlePaneStatus('x1', { state:'idle', provider:'codex', stateSince:8 }); await frames();
 check(sent.map(m => m.type + ':' + m.paneId).join(',') === 'unsub:x1,chatSub:x1' && store.getState().chatPaneId === 'x1','a status that turns precise retries Chat: ' + JSON.stringify(sent.map(m => m.type + ':' + m.paneId)));
 feed({ paneId:'x1', items, cursor:null, done:true }); await frames();
 // A choice equal to the default is not saved; a real exception is.
 q('[data-view-option="terminal"]').click(); await frames();
 check(localStorage.getItem('snagentsos.remote.paneView.x1') === 'terminal' && store.getState().chatPaneId === null,'with Chat as the default, tapping Terminal saves the exception');
 q('[data-view-option="chat"]').click(); await frames();
 check(localStorage.getItem('snagentsos.remote.paneView.x1') === null && !('x1' in store.getState().paneViews) && store.getState().chatPaneId === 'x1','tapping Chat again removes the key (it equals the default)');
 store.getState().setChatDefault(false);
 check(localStorage.getItem('snagentsos.remote.chatDefault') === 'false' && viewKeys().length === 0,'turning the default off clears the choices too');

 // app 2.4.0: answer cards in Chat. The menu comes from main (status.menu) and
 // a tap sends ctl answerMenu (never an input digit, never Enter).
 {
  setLang('en');
  store.getState().setChatDefault(false);
  const ctls = []; let ctlReply = { ok:true };
  client.sendCtl = async action => { ctls.push(action); return ctlReply };
  store.getState().update({ appVersion:'2.4.0', promptCards:true, paneStatus:{ c1:{ state:'idle', provider:'claude', stateSince:20 } } });
  client.viewPane('c1'); await frames();
  store.getState().setPaneView('c1','chat'); client.syncView(); await frames();
  feed({ paneId:'c1', items:many, cursor:null, done:true }); await frames(); await wait(50);
  check(store.getState().chatPaneId === 'c1' && !!q('[data-chat-view="c1"]'),'2.4.0: c1 is in Chat');
  const chatScroll = q('[data-chat-scroll]');
  chatScroll.scrollTop = chatScroll.scrollHeight; chatScroll.dispatchEvent(new Event('scroll')); await frames();
  const atEnd = () => chatScroll.scrollTop + chatScroll.clientHeight >= chatScroll.scrollHeight - 2;
  check(atEnd(),'the log starts at the end');
  const planReq = { id:'tp1', kind:'plan', toolName:'ExitPlanMode', summary:'Add the parser, then wire it' };
  const planMenu = { for:'tp1', options:[{ n:1, label:'Yes, and use auto mode' }, { n:2, label:'Yes, and manually approve edits' }, { n:3, label:'No, keep planning' }] };
  const planStatus = (menu, extra) => ({ state:'action', provider:'claude', reason:'plan', pendingCount:1, stateSince:21, pending:[planReq], ...(menu ? { menu } : {}), ...(extra || {}) });
  // Without a menu from main: the key row, not "open terminal".
  client.handlePaneStatus('c1', planStatus(null)); await frames();
  check(!q('[data-prompt-card="plan"]') && !!q('[data-pending-key-row="c1"]') && !q('[data-prompt-strip="waiting"]'),'a plan without a menu from main shows the key row in Chat');
  // The menu arrives: the Plan card, translated, and the log stays at the end.
  client.handlePaneStatus('c1', planStatus(planMenu)); await frames(); await wait(50);
  const planCard = q('[data-prompt-card="plan"]');
  check(!!planCard && planCard.dataset.chatCard === 'true' && qa('[data-plan-option]').length === 3,'the Plan card shows in Chat from status.menu');
  check(qa('[data-plan-option]')[0].textContent === 'Yes, and use auto mode' && qa('[data-plan-option]')[2].textContent === 'No, keep planning','"Yes, and use auto mode" has its label');
  check(planCard.getBoundingClientRect().height <= innerHeight * 0.45 + 1,'the card takes at most 45% of the screen');
  check(await until(atEnd),'the log stays pinned to the end when the card docks below it');
  // A menu for another request is no card.
  client.handlePaneStatus('c1', planStatus({ ...planMenu, for:'other' })); await frames();
  check(!q('[data-prompt-card="plan"]') && !!q('[data-pending-key-row="c1"]'),'a menu whose for is another request gives no card');
  client.handlePaneStatus('c1', planStatus(planMenu)); await frames();
  // A tap: one answerMenu ctl, no input frame.
  sent.length = 0;
  qa('[data-plan-option]')[0].click(); await frames();
  check(ctls.length === 1 && ctls[0].kind === 'answerMenu' && ctls[0].paneId === 'c1' && ctls[0].pendingId === 'tp1' && ctls[0].n === 1 && ctls[0].label === 'Yes, and use auto mode','a Plan tap in Chat sends answerMenu with the digit and the label: ' + JSON.stringify(ctls));
  check(ofType('input').length === 0,'and no input frame (main writes the digit)');
  await wait(1600);
  // menu_changed: the toast, nothing else.
  ctlReply = { ok:false, error:'menu_changed' };
  qa('[data-plan-option]')[1].click(); await frames(); await frames();
  check(store.getState().toasts.some(x => x.text === 'The menu changed, check the terminal'),'menu_changed shows "The menu changed" toast');
  ctlReply = { ok:false, error:'no_menu' };
  qa('[data-plan-option]')[1].click(); await frames(); await frames();
  check(store.getState().toasts.some(x => x.text === "Could not read Claude's menu, use the keys or the terminal"),'no_menu has its own text (never the raw code)');
  ctlReply = { ok:true };
  // The free text row: its digit through answerMenu, then the composer gets the focus.
  const fbMenu = { for:'tp1', options:[{ n:1, label:'Yes, auto-accept edits' }, { n:2, label:'Yes, manually approve edits' }, { n:3, label:'Type here to tell Claude what to change' }] };
  client.handlePaneStatus('c1', planStatus(fbMenu, { stateSince:22 })); await frames();
  const fb = q('[data-plan-feedback]');
  check(!!fb,'the free text row shows');
  fb.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true})); fb.click(); await frames();
  check(ctls.at(-1).n === 3 && document.activeElement === q('[data-kb-input="composer"]'),'the free text row sends its digit and focuses the composer in Chat');
  q('[data-kb-input="composer"]').blur();
  await wait(1600);
  // Permission: Allow stays an input "1"; Always allow goes through answerMenu.
  const permReq = { id:'tb1', kind:'permission', toolName:'Bash', summary:'npm test' };
  const permMenu = { for:'tb1', options:[{ n:1, label:'Yes' }, { n:2, label:"Yes, and don't ask again for npm test commands" }, { n:3, label:'No, and tell Claude what to do differently' }] };
  client.handlePaneStatus('c1', { state:'action', provider:'claude', reason:'permission', pendingCount:1, stateSince:23, pending:[permReq], menu:permMenu }); await frames();
  check(!!q('[data-prompt-card="permission"][data-chat-card]') && !!q('[data-prompt-always]') && q('[data-prompt-always-scope]').textContent.includes("don't ask again"),'Always allow shows in Chat with the scope Claude wrote');
  sent.length = 0; const before = ctls.length;
  q('[data-prompt-always]').click(); await frames();
  check(ctls.length === before + 1 && ctls.at(-1).n === 2 && ctls.at(-1).pendingId === 'tb1' && ofType('input').length === 0,'Always allow in Chat sends answerMenu n=2');
  await wait(1600);
  client.handlePaneStatus('c1', { state:'action', provider:'claude', reason:'permission', pendingCount:1, stateSince:24, pending:[{ ...permReq, id:'tb2' }], menu:{ ...permMenu, for:'tb2' } }); await frames();
  sent.length = 0;
  q('[data-prompt-allow]').click(); await frames();
  check(ofType('input').map(m => m.data).join('|') === '1','Allow stays the input "1", no Enter');
  // "Sending" for one step, then "Sent" for a moment before the next card shows.
  await wait(2700);
  // The ask wizard works in Chat as in Terminal.
  client.handlePaneStatus('c1', { state:'action', provider:'claude', reason:'question', pendingCount:1, stateSince:25, pending:[{ id:'q1', kind:'question', summary:'Which?', questions:[{ question:'Which one?', header:'Pick', multiSelect:false, options:[{ label:'Alpha' }, { label:'Beta' }] }] }] }); await frames();
  check(!!q('[data-prompt-card="question"]') && qa('[data-ask-option]').length >= 2,'the ask wizard shows in Chat');
  // Elicitation: the key row; its keys are plain input, never Enter.
  client.handlePaneStatus('c1', { state:'action', provider:'claude', reason:'elicitation', pendingCount:1, stateSince:26, pending:[{ id:'e1', kind:'elicitation', summary:'Server asks' }] }); await frames();
  const row = q('[data-pending-key-row="c1"]');
  check(!!row && q('[data-pending-key-text]').textContent === 'Claude is waiting for your answer','an elicitation shows the key row with its text');
  check(qa('[data-pending-key]').every(b => b.getBoundingClientRect().height >= 44) && q('[data-pending-terminal]').getBoundingClientRect().height >= 44,'every key is 44px tall');
  sent.length = 0;
  q('[data-pending-key="1"]').click(); q('[data-pending-key="esc"]').click(); await frames();
  check(ofType('input').map(m => m.data).join('|') === '1|\\x1b' && ofType('input').every(m => m.paneId === 'c1' && !m.data.includes('\\r')),'the key row sends "1" and Esc as input, never Enter: ' + JSON.stringify(ofType('input')));
  // A Codex request gets the key row too.
  client.handlePaneStatus('c1', { state:'action', provider:'codex', reason:'permission', pendingCount:1, stateSince:27, pending:[{ id:'cx1', kind:'permission', toolName:'exec', summary:'npm test' }] }); await frames();
  check(!!q('[data-pending-key-row="c1"]') && q('[data-pending-key-text]').textContent === 'Codex is waiting for your answer','a Codex request shows the key row');
  { const wide=[...document.querySelectorAll('body *')].filter(e=>e.getBoundingClientRect().right>innerWidth+1 && !e.closest('[data-scrollable]')).slice(0,5).map(e=>e.tagName+'.'+String(e.className).slice(0,60)); check(document.documentElement.scrollWidth<=innerWidth && wide.length===0,'the key row fits at 390px '+JSON.stringify(wide)) }
  // [Terminal] goes back to the terminal: chatUnsub then sub.
  sent.length = 0;
  q('[data-pending-terminal]').click(); await frames();
  check(store.getState().chatPaneId === null && sent.map(m => m.type + ':' + m.paneId).join(',') === 'chatUnsub:c1,sub:c1','[Terminal] switches the console to Terminal: ' + JSON.stringify(sent.map(m => m.type)));
  check(!q('[data-pending-key-row]') && !!q('[data-prompt-strip="waiting"]'),'in Terminal the generic strip is back');
  // Spanish.
  setLang('es');
  store.getState().setPaneView('c1','chat'); client.syncView(); await frames();
  client.handlePaneStatus('c1', { state:'action', provider:'claude', reason:'elicitation', pendingCount:1, stateSince:28, pending:[{ id:'e2', kind:'elicitation', summary:'x' }] }); await frames();
  check(q('[data-pending-key-text]')?.textContent === 'Claude espera tu respuesta' && q('[data-pending-terminal]').textContent === 'Terminal','es: the key row');
  setLang('en');
  client.handlePaneStatus('c1', { state:'idle', provider:'claude', stateSince:29 }); await frames();
 }

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
