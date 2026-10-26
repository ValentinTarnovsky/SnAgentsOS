// Changes on the phone (E3-FR-52..55, R30-09b): the real ChangesScreen,
// DiffScreen, NoteSheet, NotesList and SendNotesSheet in an isolated, hidden
// browser at phone width, fed with the gitRes fixtures R30-09a exports
// (scripts/fixtures/git-remote). The WS client's requestGit and sendCtl are
// stubbed; no socket opens. Checks the git chip opening Changes, the status
// pages and the header, the sections and badges, the not-a-repo empty state,
// the diff pages (continued hunks joined, sticky headers, the 80% prefetch, a
// new diffRev restarting), binary / too large / gone, a note on a line with a
// range that survives a reload and turns "Outdated", the notes list, sending
// with the default console and the Enter switch, refusals and no reply, and
// the Spanish labels without horizontal overflow.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path')
const { pathToFileURL } = require('node:url')
const { spawnSync } = require('node:child_process')
const root = path.resolve(__dirname, '..')
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snagentsos-mobile-changes-ui-'))
const assets = path.join(root, 'out/mobile/assets')
const mobileCss = fs.existsSync(assets) && fs.readdirSync(assets).find(name => /^index-.*\.css$/.test(name))
if (!mobileCss) throw new Error('Run npm run build:mobile first')
const fixtures = fs.readFileSync(path.join(root, 'scripts/fixtures/git-remote/frames.json'), 'utf8')
require('esbuild').buildSync({ stdin: { resolveDir: root, loader: 'tsx', contents: `
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { ChangesScreen } from './src/mobile/src/components/changes/ChangesScreen';
import { DiffScreen } from './src/mobile/src/components/changes/DiffScreen';
import { NotesList } from './src/mobile/src/components/changes/NotesList';
import { SendNotesSheet } from './src/mobile/src/components/changes/SendNotesSheet';
import { GitChip } from './src/mobile/src/components/home/GitChip';
import { client } from './src/mobile/src/lib/client';
import { store } from './src/mobile/src/lib/store';
import { openChanges, openDiff, useChangesStore } from './src/mobile/src/lib/changes';
import { useNotesStore } from './src/mobile/src/lib/notesStore';
import { setLang } from './src/mobile/src/lib/i18n';
const FX = ${fixtures};
window.result = (async () => {
 let checks=0; const check=(ok,label)=>{if(!ok)throw new Error(label);checks++};
 const frames = () => new Promise(r => setTimeout(r, 40));
 const wait = ms => new Promise(r => setTimeout(r, ms));
 const $ = s => document.querySelector(s); const $$ = s => [...document.querySelectorAll(s)];
 const reply = f => ({ ok:true, value:{ ok:f.ok, data:f.data, page:f.page, done:f.done } });
 // requestGit: answered by 'answer' (a function of the request), recorded in 'reqs'.
 const reqs=[]; let answer = () => null;
 client.requestGit = req => { reqs.push(req); const out = answer(req); return out instanceof Promise ? out : Promise.resolve(out ?? { ok:false, error:'timeout' }) };
 const ctls=[]; const acks=[];
 client.sendCtl = action => { ctls.push(action); return new Promise(r => acks.push(r)) };
 const statusAnswer = req => req.op === 'status' ? reply(FX.status.frames[req.page]) : null;
 localStorage.clear();
 const snapshot = {
  language:'en', themeTokens:{}, fontFamily:'mono', fontSize:13, activeWorkspaceId:'w1', keyButtons:[],
  workspaces:[
   { id:'w1', name:'Repo', layoutOrder:['s1','c1','x1'], git:{ branch:'feature/login', ahead:2, behind:1, added:25, removed:6, files:5 }, panes:[
    { id:'s1', title:'Shell', type:'shell', color:'', icon:'', running:true },
    { id:'c1', title:'Claude main', type:'claude', color:'', icon:'', running:true },
    { id:'x1', title:'Codex', type:'codex', color:'', icon:'', running:true } ] },
   { id:'w2', name:'Notes', layoutOrder:[], panes:[] },
  ],
 };
 setLang('en');
 store.getState().update({ phase:'live', banner:null, connected:true, snapshot, activePaneId:null, subscribedPaneId:null, paneStatus:{}, lastViewedAt:{ c1: 5, x1: 3 }, lastPane:null, toasts:[] });
 const host=document.getElementById('root'); const reactRoot=createRoot(host);
 flushSync(() => reactRoot.render(<><GitChip git={snapshot.workspaces[0].git} workspaceId="w1" /><ChangesScreen /><DiffScreen /><NotesList /><SendNotesSheet /></>)); await frames();
 check(!$('[data-push-screen="changes"]'),'closed until opened');

 // The git chip opens Changes; the status comes in three pages.
 answer = statusAnswer;
 $('[data-git-chip]').click(); await frames(); await wait(350);
 check(useChangesStore.getState().workspaceId==='w1' && !!$('[data-push-screen="changes"]'),'a tap on the git chip opens Changes for its workspace');
 check(JSON.stringify(reqs)==='[{"workspaceId":"w1","op":"status","page":0},{"workspaceId":"w1","op":"status","page":1},{"workspaceId":"w1","op":"status","page":2}]','the status is read page by page until done: '+JSON.stringify(reqs));
 const head=$('[data-changes-header]');
 check(head.querySelector('[data-changes-branch]').textContent==='feature/login' && head.querySelector('[data-changes-counts]').textContent==='+25 -6 · 5 files','header: branch +added -removed · N files: '+head.textContent);
 check(head.querySelector('[data-changes-ahead]').textContent==='↑2' && head.querySelector('[data-changes-behind]').textContent==='↓1','ahead and behind');
 check(head.querySelector('[data-changes-op]').textContent==='Merge in progress' && head.querySelector('[data-changes-conflicts]').textContent==='1 in conflict','merge in progress and the conflict count');
 const green=getComputedStyle(head.querySelector('.text-ansi-green')).color, red=getComputedStyle(head.querySelector('.text-ansi-red')).color;
 check(green==='rgb(34, 197, 94)' && red==='rgb(239, 68, 68)','added green, removed red: '+green+' '+red);
 check(JSON.stringify($$('[data-changes-section]').map(s=>s.dataset.changesSection+':'+s.querySelector('h3').textContent))==='["conflict:Conflicts1","staged:Staged2","unstaged:Not staged2","untracked:Untracked1"]','sections Conflicts / Staged / Not staged / Untracked with counts');
 const row=(p,a)=>$('[data-changes-file="'+p+'"][data-area="'+a+'"]');
 check(row('conflict.txt','conflict').querySelector('[data-file-badge]').textContent==='U' && row('notes/ñandú.md','untracked').querySelector('[data-file-badge]').textContent==='?' && row('src/new name.ts','staged').querySelector('[data-file-badge]').textContent==='R','badges U, ?, R');
 check(row('src/app.ts','staged').querySelector('[data-file-counts]').textContent==='+12 -3' && row('img/logo.png','unstaged').querySelector('[data-file-counts]').textContent==='binary','+N -M per file, "binary" without counts');
 check(row('src/new name.ts','staged').textContent.includes('from src/old name.ts'),'a rename shows where it came from');
 check($$('[data-changes-file]').every(b=>b.getBoundingClientRect().height>=48),'file rows are at least 48px tall');

 // A conflict opens its working tree diff; it takes no notes.
 reqs.length=0;
 answer = req => reply({ ok:true, page:0, done:true, data:{ path:'conflict.txt', area:'conflict', diffRev:'c1', binary:false, hunks:[{ header:'@@ -1,3 +1,7 @@', oldStart:1, newStart:1, lines:[{kind:'ctx',oldNo:1,newNo:1,text:'a'},{kind:'add',newNo:2,text:'<<<<<<< HEAD'},{kind:'add',newNo:3,text:'mine'},{kind:'add',newNo:4,text:'======='},{kind:'add',newNo:5,text:'theirs'},{kind:'add',newNo:6,text:'>>>>>>> other'}] }] } });
 row('conflict.txt','conflict').click(); await frames(); await wait(350);
 check(JSON.stringify(reqs)==='[{"workspaceId":"w1","op":"diff","path":"conflict.txt","page":0}]','a conflict asks for its working tree diff (no staged)');
 check($('[data-push-screen="diff"]') && $('[data-diff-body]').textContent.includes('<<<<<<< HEAD') && !$('[data-note-line]'),'the conflict diff shows the markers and takes no notes');
 useChangesStore.getState().update({ diff:null }); await wait(400);

 // The staged entry asks with staged:true.
 reqs.length=0; answer = () => reply(FX.diffBinary);
 row('src/app.ts','staged').click(); await frames(); await wait(350);
 check(reqs[0].staged===true && reqs[0].path==='src/app.ts','a staged entry asks for the index diff');
 useChangesStore.getState().update({ diff:null }); await wait(400);

 // The working tree diff of src/app.ts: three pages, joined.
 reqs.length=0;
 answer = req => req.op==='diff' && req.path==='src/app.ts' ? reply(FX.diff.frames[req.page]) : null;
 row('src/app.ts','unstaged').click(); await frames(); await wait(450);
 check(JSON.stringify(reqs.map(r=>r.page))==='[0,1]','a first page that does not fill the screen asks for the next one: '+JSON.stringify(reqs));
 { const b=$('[data-push-screen="diff"] [data-scrollable]'); b.scrollTop=b.scrollHeight; b.dispatchEvent(new Event('scroll')); await wait(200) }
 check(JSON.stringify(reqs.map(r=>r.page))==='[0,1,2]','scrolling to the end reads the last page: '+JSON.stringify(reqs));
 check($$('[data-diff-hunk]').length===2 && $('[data-diff-body]').dataset.diffDone==='true','continued pieces join their hunk: 2 headers');
 check(getComputedStyle($('[data-diff-hunk]')).position==='sticky' && getComputedStyle($('[data-diff-hunk]')).top==='0px','hunk headers stick to the top');
 const del=$('[data-diff-line][data-kind="del"]'), add=$('[data-diff-line][data-kind="add"]');
 check(del.dataset.diffLine==='11' && add.dataset.diffLine==='11' && del.textContent.includes('-') && add.textContent.includes('+'),'a deleted line shows the old number, an added one the new, with -/+');
 check(getComputedStyle(add).backgroundColor!=='rgba(0, 0, 0, 0)' && getComputedStyle(del).backgroundColor!==getComputedStyle(add).backgroundColor,'green and red rows');
 check(getComputedStyle(add.lastElementChild).whiteSpace==='pre-wrap','long lines wrap');
 check($('[data-diff-next]')?.dataset.diffNext==='img/logo.png','"Next file" at the end leads to the next file in the list');
 check($('[data-push-screen="diff"] h2').textContent==='app.ts','the diff is titled with the file name');

 // A note on line 12, up to line 13.
 $('[data-note-line="12"]').click(); await frames(); await wait(350);
 check($('[data-sheet-panel]')?.textContent.includes('Note on app.ts:12'),'a tap on the line number opens "Note on app.ts:12"');
 check($('[data-note-until]').textContent==='12' && $('[data-note-until-less]').disabled,'"Up to line" starts on the line itself');
 $('[data-note-until-more]').click(); await frames(); $('[data-note-until-more]').click(); await frames();
 check($('[data-note-until]').textContent==='14' && $('[data-note-until-more]').disabled,'the range stops at the end of the hunk');
 $('[data-note-until-less]').click(); await frames();
 check($('[data-note-save]').disabled,'an empty note cannot be saved');
 const ta=$('[data-note-text]'); const setTa=v=>{Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(ta,v);ta.dispatchEvent(new Event('input',{bubbles:true}))};
 check(ta.maxLength===4000,'4000 characters at most');
 setTa('throw is better here'); await frames();
 check($('[data-note-count]').textContent==='20/4000','a character counter');
 $('[data-note-save]').click(); await frames(); await wait(350);
 const card=$('[data-note-card]');
 check(!!card && card.textContent.includes('L12-13') && card.textContent.includes('throw is better here'),'the note shows under its line with its range');
 check($('[data-push-screen="diff"] [data-notes-badge]')?.textContent==='1 note','the header badge counts it');
 const stored=JSON.parse(localStorage.getItem('snagentsos.remote.notes.w1'));
 check(stored && stored.files['src/app.ts'][0].line===12 && stored.files['src/app.ts'][0].endLine===13 && stored.files['src/app.ts'][0].lineText==='    throw new NotFound(id)','stored on the phone under snagentsos.remote.notes.w1, by path, with the line text');

 // Next file: binary, then too large.
 answer = req => req.path==='img/logo.png' ? reply(FX.diffBinary) : req.path==='notes/ñandú.md' ? reply(FX.diffTooLarge) : null;
 $('[data-diff-next]').click(); await frames(); await wait(150);
 check($('[data-diff-binary]')?.textContent==='Binary file: no text diff.' && $('[data-push-screen="diff"] h2').textContent==='logo.png','"Next file" swaps in place; a binary file says so');
 $('[data-diff-next]').click(); await frames(); await wait(150);
 check($('[data-diff-too-large]')?.textContent==='Diff too large (18000 lines). Open it on the PC.','a diff main found too large says to open it on the PC');
 check(!$('[data-diff-next]') && $('[data-diff-end]')?.textContent==='End of the changes','the last file ends the walk');

 // The file changed: line 12 reads differently now, so the note is outdated.
 const changedPage = JSON.parse(JSON.stringify(FX.diff.frames[0])); changedPage.done=true; changedPage.data.diffRev='new';
 changedPage.data.hunks[0].lines[3].text='    throw new Missing(id)';
 answer = req => req.path==='src/app.ts' ? reply(changedPage) : null;
 openDiff({ path:'src/app.ts', area:'unstaged', staged:false }); await frames(); await wait(150);
 const staleCard=$('[data-diff-stale] [data-note-card]');
 check(!!staleCard && staleCard.dataset.noteStale==='true' && staleCard.textContent.includes('Outdated') && staleCard.querySelector('[data-note-original]').textContent==='    throw new NotFound(id)','the note turns "Outdated" and shows on top with the line it was written on');
 check(useNotesStore.getState().byWs.w1[0].stale===true,'the flag is kept');

 // A file with no changes left: back to the list, which reads the status again.
 reqs.length=0;
 answer = req => req.op==='diff' ? reply(FX.errors[0]) : statusAnswer(req);
 openDiff({ path:'src/new name.ts', area:'staged', staged:true, oldPath:'src/old name.ts' }); await frames(); await wait(150);
 check($('[data-diff-gone]')?.textContent.includes('This file has no changes anymore.'),'not_found: the file has no changes anymore');
 $('[data-diff-back]').click(); await frames(); await wait(450);
 check(useChangesStore.getState().diff===null && reqs.filter(r=>r.op==='status').length===3,'"Back to the list" closes the diff and reads the status again');

 // The 80% prefetch, and a diffRev change restarting at page 0.
 const tall = (rev, from, done) => ({ ok:true, done, page:0, data:{ path:'src/app.ts', area:'unstaged', diffRev:rev, binary:false, hunks:[{ header:'@@ -1,80 +1,80 @@', oldStart:1, newStart:1, continued: from>1 || undefined, lines:Array.from({length:80},(_,i)=>({kind:'ctx',oldNo:from+i,newNo:from+i,text:'line '+(from+i)})) }] } });
 // The file changes on disk between page 0 and page 1: page 1 and every read after it carry t2.
 reqs.length=0; let rev='t1'; let changeOnPage1=false;
 answer = req => { if (req.op!=='diff') return null; if (req.page===1 && changeOnPage1) rev='t2'; return req.page===0 ? reply(tall(rev,1,false)) : reply({ ...tall(rev,81,true), page:req.page }) };
 openDiff({ path:'src/app.ts', area:'unstaged', staged:false }); await frames(); await wait(200);
 const body=$('[data-push-screen="diff"] [data-scrollable]');
 check(reqs.length===1 && body.scrollHeight>body.clientHeight*1.5,'a long first page waits for the reader');
 body.scrollTop=(body.scrollHeight-body.clientHeight)*0.5; body.dispatchEvent(new Event('scroll')); await wait(120);
 check(reqs.length===1,'halfway down asks for nothing');
 changeOnPage1=true;
 body.scrollTop=body.scrollHeight*0.85-body.clientHeight; body.dispatchEvent(new Event('scroll')); await wait(200);
 check(JSON.stringify(reqs.map(r=>r.page))==='[0,1,0,1]' && $('[data-diff-body]').dataset.diffDone==='true','at 80% it asks for page 1; another diffRev there restarts at page 0, then reads on: '+JSON.stringify(reqs.map(r=>r.page)));
 check($$('[data-diff-line]').length===160 && $$('[data-diff-hunk]').length===1,'the restarted read holds the new version only once');
 useChangesStore.getState().update({ diff:null }); await wait(400);

 // A file that keeps changing stops the read ('unstable'): a note on a line it never reached stays fresh.
 const far = useNotesStore.getState().add('w1', { file:'src/app.ts', line:150, lineText:'line 150', comment:'far down' });
 reqs.length=0; let n=0;
 answer = req => { if (req.op!=='diff') return null; n++; return req.page===0 ? reply(tall('u'+n,1,false)) : reply({ ...tall('u'+n,81,true), page:req.page }) };
 openDiff({ path:'src/app.ts', area:'unstaged', staged:false }); await frames(); await wait(200);
 const ubody=$('[data-push-screen="diff"] [data-scrollable]');
 for (let i=0;i<3 && $('[data-diff-body]')?.dataset.diffStatus!=='unstable';i++) { ubody.scrollTop=ubody.scrollHeight*0.85-ubody.clientHeight; ubody.dispatchEvent(new Event('scroll')); await wait(200); }
 check($('[data-diff-body]').dataset.diffStatus==='unstable' && !!$('[data-diff-unstable]'),'a file that changes on every page ends "unstable"');
 check(!useNotesStore.getState().byWs.w1.find(x=>x.id===far.id).stale,'an unstable read is not complete: the note on an unread line is not "Outdated"');
 useNotesStore.getState().remove('w1',[far.id]);
 useChangesStore.getState().update({ diff:null }); await wait(400);

 // Notes list: pending ones, outdated tag, delete.
 useNotesStore.getState().add('w1', { file:'src/app.ts', line:41, lineText:'x', comment:'name it' });
 useNotesStore.getState().add('w1', { file:'docs/old.md', line:3, comment:'drop me' });
 await frames();
 $('[data-push-screen="changes"] [data-notes-badge]').click(); await frames(); await wait(350);
 const items=()=>$$('[data-notes-list] [data-notes-item]');
 check(JSON.stringify(items().map(i=>i.querySelector('[data-notes-ref]').textContent))==='["docs/old.md:3","src/app.ts:12-13","src/app.ts:41"]','the list shows file:lines in the batch order');
 check(items()[1].querySelector('[data-note-tag="stale"]')?.textContent==='Outdated','the outdated note is tagged');
 items()[0].querySelector('[data-notes-remove]').click(); await frames();
 check(items().length===2 && $('[data-notes-send]').textContent.includes('Send 2 notes'),'a note can be deleted; "Send 2 notes"');

 // Send: default console = the agent viewed last, Enter off.
 $('[data-notes-send]').click(); await frames(); await wait(400);
 check(!!$('[data-notes-send-sheet]') && !$('[data-notes-list]'),'"Send" swaps the list for the send sheet');
 const radios=()=>$$('[data-notes-target]');
 check(radios().length===3 && $('[data-notes-target="c1"]').getAttribute('aria-checked')==='true','the agent console viewed last is picked');
 check($('[data-notes-enter]').getAttribute('aria-checked')==='false','"Press Enter" starts off');
 $('[data-notes-confirm]').click(); $('[data-notes-confirm]').click(); await frames();
 check(ctls.length===1 && JSON.stringify(ctls[0])===JSON.stringify({ kind:'sendReviewNotes', workspaceId:'w1', paneId:'c1', notes:[{file:'src/app.ts',lines:'12-13',comment:'throw is better here'},{file:'src/app.ts',lines:'41',comment:'name it'}], enter:false }),'one sendReviewNotes ctl with the notes inline, no Enter: '+JSON.stringify(ctls[0]));
 check($('[data-notes-confirm]').disabled && !!$('[data-notes-confirm] .animate-spin'),'the button spins until the ack');
 acks.shift()({ ok:true, info:2 }); await frames(); await wait(400);
 check(store.getState().toasts.some(t=>t.text==='2 notes sent to Claude main'),'the ack says where they went');
 check(!$('[data-notes-send-sheet]') && !$('[data-push-screen="changes"] [data-notes-badge]')?.textContent.match(/[1-9]/),'the sheet closes and no note is pending');
 check(useNotesStore.getState().byWs.w1.every(n=>n.sentAt),'sent notes are stamped');
 $('[data-push-screen="changes"] [data-notes-badge]').click(); await frames(); await wait(350);
 check(!!$('[data-notes-empty]') && $('[data-notes-show-sent]').textContent==='Show sent (2)','sent notes hide behind "Show sent"');
 $('[data-notes-show-sent]').click(); await frames();
 check($$('[data-notes-sent] [data-note-tag="sent"]').length===2,'"Show sent" lists them, tagged Sent');

 // Enter on, a shell picked: the desktop refuses with not_agent.
 useChangesStore.getState().update({ notesUi:null }); await wait(400);
 useNotesStore.getState().add('w1', { file:'src/app.ts', line:20, comment:'again' }); await frames();
 useChangesStore.getState().update({ notesUi:'send' }); await frames(); await wait(400);
 $('[data-notes-target="s1"]').click(); $('[data-notes-enter]').click(); await frames();
 $('[data-notes-confirm]').click(); await frames();
 check(ctls.at(-1).paneId==='s1' && ctls.at(-1).enter===true && ctls.at(-1).notes.length===1,'the picked console and Enter go on the ctl');
 acks.shift()({ ok:false, error:'not_agent' }); await frames();
 check(store.getState().toasts.some(t=>t.text==='That console does not take pasted notes. Pick an agent console.') && !!$('[data-notes-send-sheet]'),'a refusal says why and keeps the sheet');
 check(useNotesStore.getState().byWs.w1.some(n=>!n.sentAt),'the refused note stays pending');
 $('[data-notes-confirm]').click(); await frames();
 acks.shift()({ ok:false, error:'timeout' }); await frames();
 check(!!$('[data-notes-send-sheet] [data-no-reply]'),'no answer: "The PC did not answer [Retry]"');
 $('[data-notes-send-sheet] [data-no-reply] button').click(); await frames();
 check(ctls.length===4,'Retry sends again');
 acks.shift()({ ok:true, info:1 }); await frames(); await wait(400);
 check(useNotesStore.getState().byWs.w1.every(n=>n.sentAt),'then it goes');

 // A workspace that is not a repo.
 reqs.length=0; answer = req => reply(FX.errors[3]);
 openChanges('w2'); await frames(); await wait(400);
 check($('[data-changes-empty]')?.textContent==='This workspace is not a git repo' && reqs.length===1,'not_repo: "This workspace is not a git repo"');

 // No answer: "The PC did not answer [Retry]".
 reqs.length=0; answer = () => ({ ok:false, error:'timeout' });
 openChanges('w1'); await frames(); await wait(400);
 check(!!$('[data-changes-body] [data-no-reply]'),'a status with no answer offers Retry');
 answer = statusAnswer;
 $('[data-changes-body] [data-no-reply] button').click(); await frames(); await wait(200);
 check(reqs.length===4 && $$('[data-changes-file]').length===6,'Retry reads the list');

 // A note survives a reload of the page (a fresh store over the same storage).
 useNotesStore.setState({ byWs:{} });
 check(useNotesStore.getState().ensure('w1').length===3,'notes come back from storage after a reload');

 // Spanish at phone width.
 setLang('es'); flushSync(() => store.getState().update({ snapshot:{ ...snapshot, language:'es' } }));
 useChangesStore.getState().update({ workspaceId:null }); await wait(400);
 openChanges('w1'); await frames(); await wait(400);
 check($('[data-push-screen="changes"] h2').textContent==='Cambios' && JSON.stringify($$('[data-changes-section] h3').map(h=>h.firstChild.textContent))==='["Conflictos","Staged","Sin stage","Sin seguimiento"]','es: Cambios, Conflictos / Staged / Sin stage / Sin seguimiento');
 check($('[data-changes-counts]').textContent==='+25 -6 · 5 archivos','es header: 5 archivos');
 answer = req => req.op==='diff' ? reply(FX.diffTooLarge) : statusAnswer(req);
 row('notes/ñandú.md','untracked').click(); await frames(); await wait(400);
 check($('[data-diff-too-large]').textContent==='Diff demasiado grande (18000 líneas). Abrilo en la PC.','es: Diff demasiado grande ... Abrilo en la PC.');
 { const wide=[...document.querySelectorAll('body *')].filter(e=>e.getBoundingClientRect().right>innerWidth+1).slice(0,5).map(e=>e.tagName+'.'+String(e.className).slice(0,80)); check(document.documentElement.scrollWidth<=innerWidth,'no horizontal overflow at phone width '+JSON.stringify(wide)) }

 // The workspace disappearing on the desktop closes Changes.
 flushSync(() => store.getState().update({ snapshot:{ ...snapshot, language:'es', workspaces:[] } })); await frames();
 check(useChangesStore.getState().workspaceId===null,'Changes closes when its workspace is gone');

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
 console.log('PASS: '+checks+' mobile Changes UI checks');w.destroy();app.quit();
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
