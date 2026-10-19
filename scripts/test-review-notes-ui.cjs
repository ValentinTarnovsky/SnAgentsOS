// Review notes UI (E7-FR-17..21) in an isolated hidden Electron window: the
// production WorkspaceView (grid + Changes panel) with three consoles on fake
// ptys (Claude with bracketed paste, a shell with bracketed paste, a plain
// shell), a fake window.snApi.git and an in-page review note store with
// main's rules. Real key events drive `c`, Ctrl+Enter, Esc and the picker;
// the pasted bytes are read from the fake pty. Needs `npm run build` first
// (CSS). No user config, repo, shell or agent is touched.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path')
const { pathToFileURL } = require('node:url')
const { spawnSync } = require('node:child_process')
const { buildSync } = require('esbuild')
const root = path.resolve(__dirname, '..'), dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snagentsos-notes-ui-'))
const assets = path.join(root, 'out/renderer/assets')
const css = fs.readdirSync(assets).find((f) => /^index-.*\.css$/.test(f))
if (!css) throw new Error('Run npm run build first')

const harness = String.raw`
import React from 'react'; import {createRoot} from 'react-dom/client';
import {WorkspaceView} from './src/renderer/components/workspace/WorkspaceView';
import {NotificationStack} from './src/renderer/components/ui/NotificationStack';
import {I18nProvider} from './src/renderer/i18n';
import {useAppStore} from './src/renderer/lib/store';
import {useGitStore} from './src/renderer/lib/gitStore';
import {useGlobalKeys} from './src/renderer/lib/useGlobalKeys';
import {startGitSync} from './src/renderer/lib/gitSync';
import {startReviewNotesSync} from './src/renderer/lib/reviewNotesStore';
import {setFocusedPane} from './src/renderer/lib/focus';
import {sendReviewNotes} from './src/renderer/lib/sendReviewNotes';
import {isBracketedPaste} from './src/renderer/lib/pasteRegistry';
import {applyTheme} from './src/renderer/themes/applyTheme';

const ROOT = 'C:\\fixture\\repo';
const writes = [], subs = [], clip = [];
const noop = () => () => {};
const fallback = (base) => new Proxy(base, { get: (t, k) => (k in t ? t[k] : typeof k === 'string' ? fallback(noop) : undefined) });
const F = (area, p, status, added, removed) => ({ path: p, area, status, added, removed, binary: false });
const files = [F('conflict', 'src/conflict.ts', 'U', null, null), F('unstaged', 'src/app.ts', 'M', 3, 1), F('untracked', 'notes.md', '?', 2, 0)];
const summary = () => ({ repoRoot: ROOT, branch: 'main', detached: false, unborn: false, headShort: 'abc1234', upstream: null, ahead: 0, behind: 0, files: 3, added: 5, removed: 1, approx: false, staged: 0, unstaged: 1, untracked: 1, conflicts: 1, op: null, truncated: false, updatedAt: 1 });
let appLines = ['const a = 1', 'const b = 2', 'const c = 3'];
const appDiff = () => ({ binary: false, hunks: [{ header: '@@ -1,3 +1,5 @@', oldStart: 1, newStart: 1, lines: [
  { kind: 'ctx', oldNo: 1, newNo: 1, text: 'import x from "y"' },
  { kind: 'del', oldNo: 2, text: 'const old = 0' },
  { kind: 'add', newNo: 2, text: appLines[0] },
  { kind: 'add', newNo: 3, text: appLines[1] },
  { kind: 'add', newNo: 4, text: appLines[2] },
  { kind: 'ctx', oldNo: 3, newNo: 5, text: 'export default x' },
] }] });
let rev = 1;

// In-page review note store with main's rules (ReviewNoteStore is covered by test-review-notes.cjs).
const notes = []; const revs = {}; const changed = []; let ids = 0;
const emit = (ws) => { revs[ws] = (revs[ws] || 0) + 1; changed.forEach((cb) => cb({ workspaceId: ws, rev: revs[ws] })) };
const reviewNotes = {
  list: async (ws) => ({ notes: notes.filter((n) => n.workspaceId === ws).map((n) => ({ ...n })), rev: revs[ws] || 0 }),
  upsert: async (input) => {
    const now = Date.now();
    const prev = input.id ? notes.find((n) => n.id === input.id) : null;
    const { sentAt, sentToPaneId, ...rest } = input;
    let note;
    if (prev) {
      const edited = prev.body !== input.body;
      note = { ...rest, id: prev.id, createdAt: prev.createdAt, updatedAt: edited ? now : prev.updatedAt };
      if (!edited && prev.sentAt !== undefined) { note.sentAt = prev.sentAt; note.sentToPaneId = prev.sentToPaneId }
      notes.splice(notes.indexOf(prev), 1, note);
    } else {
      note = { ...rest, id: 'n' + ++ids, createdAt: now, updatedAt: now };
      notes.push(note);
    }
    if (!note.line) { delete note.startLine; delete note.lineText }
    emit(note.workspaceId);
    return { ...note };
  },
  delete: async (req) => { for (let i = notes.length - 1; i >= 0; i--) if (req.ids ? req.ids.includes(notes[i].id) : notes[i].workspaceId === req.workspaceId) notes.splice(i, 1); emit(req.workspaceId || 'w1') },
  markSent: async (req) => { for (const n of notes) if (req.ids.includes(n.id)) { n.sentAt = req.sentAt; n.sentToPaneId = req.paneId } emit('w1') },
  prune() {},
  onChanged: (cb) => { changed.push(cb); return () => {} },
};

window.snApi = fallback({
  platform: 'win32',
  filePath: () => '',
  pty: fallback({ reattach: async () => null, spawn: async (r) => ({ ptyId: 'pty-' + r.paneId }), onData: (cb) => { subs.push(cb); return () => {} }, onExit: noop, write: (w) => writes.push(w), resize() {}, flow() {}, kill: async () => {}, submit: async () => ({ ok: true }) }),
  system: fallback({ onDisplayRecovered: noop, openExternal() {} }),
  status: fallback({ reportTitle() {} }),
  clipboard: fallback({ readText: async () => '', writeText: (t) => clip.push(t) }),
  reviewNotes,
  git: {
    setWatch() {}, setConfig() {}, refresh() {}, onUpdate: () => () => {}, setPanel() {}, openFile: async () => true,
    info: async () => ({ available: true, version: '2.45.1' }),
    status: async (key) => (key === 'ws:w1' ? { summary: summary(), files: files.slice() } : null),
    fileDiff: async (req) => {
      const k = req.area + ':' + req.path;
      if (k === 'unstaged:src/app.ts') return { path: req.path, area: req.area, ...appDiff(), diffRev: 'app:' + rev, totalLines: 7 };
      if (k === 'untracked:notes.md') return { path: req.path, area: req.area, binary: false, hunks: [{ header: '@@ -0,0 +1,2 @@', oldStart: 0, newStart: 1, lines: [{ kind: 'add', newNo: 1, text: 'one' }, { kind: 'add', newNo: 2, text: 'two' }] }], diffRev: 'md', totalLines: 2 };
      if (k === 'conflict:src/conflict.ts') return { path: req.path, area: req.area, binary: false, hunks: [{ header: '@@@ -1 -1 +1 @@@', oldStart: 1, newStart: 1, lines: [{ kind: 'meta', text: '++<<<<<<< HEAD' }] }], diffRev: 'c', totalLines: 1 };
      return { error: 'gone' };
    },
  },
});
const P = (id, type, title) => ({ id, type, title, color: '#888', icon: type === 'claude' ? 'claude' : 'terminal' });
const ws = { id: 'w1', name: 'Repo', cwd: ROOT, panes: [P('claude', 'claude', 'Claude 1'), P('safe', 'shell', 'Bash SSH'), P('plain', 'shell', 'PowerShell')], layout: { grid: 4, order: ['claude', 'safe', 'plain'] } };
useAppStore.setState({ hydrated: true, activeWorkspaceId: 'w1', workspaces: [ws] });
useGitStore.setState({ summaries: { 'ws:w1': summary() } });
startGitSync();
startReviewNotesSync({ prune: false });
applyTheme('midnight');
function Keys() { useGlobalKeys(); return null }
function App() {
  const live = useAppStore((s) => s.workspaces.find((w) => w.id === 'w1'));
  return <div style={{ height: '100vh' }} className="flex flex-col bg-bg-primary text-text-primary"><Keys />{live && <WorkspaceView workspace={live} isActive />}<NotificationStack /></div>;
}
createRoot(document.getElementById('root')).render(<I18nProvider lang="es"><App /></I18nProvider>);
const q = (s) => document.querySelector(s);
const qa = (s) => [...document.querySelectorAll(s)];
window.smoke = {
  writes, notes, clip,
  ready: () => subs.length >= 3 && isBracketedPaste('claude') !== null && isBracketedPaste('plain') !== null,
  emit: (ptyId, data) => subs.forEach((cb) => cb({ ptyId, data })),
  bracketed: (id) => isBracketedPaste(id),
  status: (id, st) => useAppStore.setState((s) => ({ paneStatus: { ...s.paneStatus, [id]: st } })),
  focusHistory: (id) => setFocusedPane(id, 'w1'),
  open: () => useGitStore.getState().openChanges('ws:w1'),
  rows: () => qa('[data-changes-row]').map((r) => r.dataset.changesRow),
  click: (k) => q('[data-changes-row="' + k + '"]').click(),
  header: () => q('[data-changes-file-header]')?.textContent ?? '',
  lines: () => qa('[data-new-line]').map((r) => Number(r.dataset.newLine)),
  focusLine: (n) => q('[data-new-line="' + n + '"]').focus(),
  active: () => document.activeElement?.dataset?.newLine ?? document.activeElement?.tagName ?? null,
  plusHidden: (n) => getComputedStyle(q('[data-note-add="' + n + '"]')).display === 'none',
  rangeClick: (a, b) => {
    const ra = q('[data-new-line="' + a + '"]'), rb = q('[data-new-line="' + b + '"]');
    ra.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); ra.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    rb.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, shiftKey: true })); rb.dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true }));
  },
  plus: (n) => q('[data-note-add="' + n + '"]').click(),
  editor: () => !!q('[data-note-editor]'),
  editorLabel: () => q('[data-note-editor] span')?.textContent ?? '',
  editorFocused: () => document.activeElement?.hasAttribute?.('data-note-textarea') ?? false,
  under: (n) => qa('[data-line-notes="' + n + '"] [data-note-card]').map((c) => c.querySelector('[data-note-body]')?.textContent ?? c.textContent),
  editorUnder: (n) => !!q('[data-line-notes="' + n + '"] [data-note-editor]'),
  top: () => qa('[data-notes-top] [data-note-card]').map((c) => c.textContent),
  cards: () => qa('[data-note-card]').length,
  tags: (body) => { const c = qa('[data-note-card]').find((x) => x.textContent.includes(body)); return c ? qa.call(null, '[data-note-card="' + c.dataset.noteCard + '"] [data-note-tag]').map((t) => t.dataset.noteTag + ':' + t.textContent) : null },
  cardAction: (body, act) => { const c = qa('[data-note-card]').find((x) => x.textContent.includes(body)); c.querySelector('[data-note-' + act + ']').click() },
  fileNote: () => q('[data-note-file]').click(),
  bar: () => q('[data-notes-bar]')?.textContent ?? null,
  pending: () => q('[data-notes-pending]')?.textContent ?? null,
  filter: (f) => q('[data-notes-filter="' + f + '"]').click(),
  clear: () => q('[data-notes-clear]').click(),
  sendBtn: () => { const b = q('[data-notes-send]'); return b ? { text: b.textContent, disabled: b.disabled } : null },
  openMenu: () => q('[data-notes-send]').click(),
  menu: () => !!q('[data-notes-menu]'),
  targets: () => qa('[data-notes-target]').map((b) => ({ id: b.dataset.notesTarget, kind: b.dataset.notesKind ?? null, checked: b.getAttribute('aria-checked') === 'true', disabled: b.disabled, text: b.textContent })),
  pick: (id) => q('[data-notes-target="' + id + '"]').click(),
  enterBox: () => { const c = q('[data-notes-enter]'); return { checked: c.checked, disabled: c.disabled } },
  toggleEnter: () => q('[data-notes-enter]').click(),
  confirm: () => q('[data-notes-confirm]').click(),
  confirmDisabled: () => q('[data-notes-confirm]').disabled,
  rowNotes: (k) => q('[data-changes-row="' + k + '"] [data-row-notes]')?.dataset.rowNotes ?? null,
  toasts: () => document.body.textContent,
  dialog: () => !!q('.fixed.inset-0 h2'),
  panel: () => !!q('[data-changes-panel]'),
  setLine: (i, text) => { appLines[i] = text; rev++; useGitStore.getState().apply({ key: 'ws:w1', cwd: ROOT, summary: { ...summary(), updatedAt: Date.now() } }) },
  overflow: () => document.documentElement.scrollWidth > innerWidth,
  forceSend: (paneId) => sendReviewNotes('w1', paneId, { submit: false }),
};
`
buildSync({ stdin: { contents: harness, resolveDir: root, loader: 'tsx' }, bundle: true, platform: 'browser', format: 'iife', outfile: path.join(dir, 'renderer.js'), alias: { '@shared': path.join(root, 'src/shared'), '@': path.join(root, 'src/renderer') }, jsx: 'automatic', loader: { '.css': 'empty' }, define: { 'process.env.NODE_ENV': '"production"' } })
fs.writeFileSync(path.join(dir, 'index.html'), `<html><head><meta charset="utf-8"><link rel="stylesheet" href="${pathToFileURL(path.join(assets, css))}"></head><body><div id="root"></div><script src="renderer.js"></script></body></html>`)

const main = String.raw`
const {app,BrowserWindow}=require('electron');const fs=require('fs'),path=require('path');
app.setPath('userData',path.join(__dirname,'profile'));
app.whenReady().then(async()=>{
 const w=new BrowserWindow({width:1400,height:860,show:false,webPreferences:{sandbox:true,backgroundThrottling:false}});
 const failures=[];w.webContents.on('console-message',(_e,level,message)=>{if(level>=3)failures.push(message)});
 const js=(s)=>w.webContents.executeJavaScript(s);const wait=(ms)=>new Promise((r)=>setTimeout(r,ms));
 const frame=()=>js('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
 const shot=async(name)=>{await frame();await wait(150);fs.writeFileSync(path.join(__dirname,name+'.png'),(await w.webContents.capturePage()).toPNG())};
 let n=0;const ok=(c,label)=>{if(!c)throw new Error(label);n++};
 const eq=(a,b,label)=>{if(JSON.stringify(a)!==JSON.stringify(b))throw new Error(label+': got '+JSON.stringify(a)+' expected '+JSON.stringify(b));n++};
 const press=async(keyCode,modifiers=[])=>{w.webContents.sendInputEvent({type:'keyDown',keyCode,modifiers});if(keyCode==='Return')w.webContents.sendInputEvent({type:'char',keyCode:String.fromCharCode(13),modifiers});w.webContents.sendInputEvent({type:'keyUp',keyCode,modifiers});await frame();await wait(60)};
 const type=async(text)=>{w.webContents.insertText(text);await frame();await wait(40)};
 const until=async(expr,label,ms=3000)=>{for(let t=0;t<ms;t+=50){if(await js(expr))return;await wait(50)}throw new Error('timeout: '+label)};
 const take=async()=>{await frame();return js('smoke.writes.splice(0).map(w=>[w.ptyId,w.data])')};
 await w.loadFile(path.join(__dirname,'index.html'));
 w.webContents.focus();
 await until('smoke.ready()','three consoles mounted');
 // Claude and the SSH shell turn bracketed paste on; PowerShell does not.
 await js("smoke.emit('pty-claude','\\x1b[?2004h')");await js("smoke.emit('pty-safe','\\x1b[?2004h')");
 await until("smoke.bracketed('claude')===true&&smoke.bracketed('safe')===true&&smoke.bracketed('plain')===false",'bracketed paste modes');
 await js("smoke.status('claude',{state:'idle',precise:true,provider:'claude'})");
 await take();

 await js('smoke.open()');
 await until("smoke.rows().length===3",'panel lists the files');
 // The panel takes the focus two frames after it opens (slow frames in a hidden window).
 await until("!!document.activeElement?.closest?.('[data-changes-panel]')",'focus moved into the panel',5000);
 await js("smoke.click('unstaged:src/app.ts')");
 await until("smoke.lines().length===5",'the diff of src/app.ts with five new-side lines');
 eq(await js('smoke.lines()'),[1,2,3,4,5],'add and context lines take notes, deleted ones do not');
 ok(await js('smoke.plusHidden(2)'),'the gutter + only shows on hover');
 ok((await js('smoke.bar()'))===null,'no notes bar while the workspace has no notes');

 // FR-17: c on a focused line opens the editor; Ctrl+Enter saves the card under the line.
 await js('smoke.focusLine(3)');
 await press('C');
 await until('smoke.editor()','c opens the editor');
 ok(await js('smoke.editorUnder(3)'),'the editor sits under line 3');
 ok(await js('smoke.editorFocused()'),'the textarea has the focus');
 eq(await js('smoke.editorLabel()'),'Línea 3','editor names its line');
 await type('usar const\nverificar "null"');
 await press('Return',['control']);
 await until('!smoke.editor()','Ctrl+Enter saves');
 eq(await js('smoke.under(3)'),['usar const\nverificar "null"'],'the saved card is under its line');
 eq(await js("smoke.notes[0].lineText"),'const b = 2','the note keeps the line text');
 eq(await js('smoke.active()'),'3','the keyboard goes back to the line');
 eq(await take(),[],'typing a note writes nothing to any console');

 // Esc cancels the editor and never closes the panel; F7 / Alt+Z typed in it stay in it.
 await js('smoke.plus(5)');
 await until('smoke.editorUnder(5)','the gutter + opens the editor');
 await press('Escape');
 ok(!(await js('smoke.editor()'))&&(await js('smoke.panel()')),'Esc cancels the editor and the panel stays open');

 // Shift+click builds a range.
 await js('smoke.rangeClick(2,4)');
 await until('smoke.editorUnder(4)','Shift+click opens a range editor');
 eq(await js('smoke.editorLabel()'),'Líneas 2-4','range 2-4');
 await type('extraer funcion');
 await press('Return',['control']);
 await until("smoke.under(4).length===1",'range note saved under its last line');
 eq(await js("[smoke.notes[1].startLine,smoke.notes[1].line]"),[2,4],'startLine..line stored');

 // File note from the file header.
 await js('smoke.fileNote()');
 await until('smoke.editor()','Nota de archivo opens the editor');
 await type('falta el header');
 await press('Return',['control']);
 await until("smoke.top().length===1",'the file note shows above the diff');
 ok((await js('smoke.top()'))[0].includes('Archivo'),'the file note names its scope');
 eq(await js("smoke.pending()"),'3 notas pendientes','K pending notes');
 eq(await js("smoke.rowNotes('unstaged:src/app.ts')"),'3','the file row shows its note count');
 eq(await js('smoke.sendBtn()'),{text:'Enviar 3 notas a...',disabled:false},'Send 3 notes to...');
 await shot('notes-cards');

 // FR-19 picker: plain console disabled, last agent preselected, Enter unchecked.
 await js("smoke.focusHistory('safe')");await js("smoke.focusHistory('claude')");await js("smoke.focusHistory('plain')");
 await js('smoke.openMenu()');
 await until('smoke.menu()','the picker opens');
 const targets=await js('smoke.targets()');
 eq(targets.map(t=>[t.id,t.kind,t.checked,t.disabled]),[['claude','agent',true,false],['safe','safe',false,false],['plain','plain',false,true],['__new_claude__',null,false,false]],'agent preselected (last focused), safe enabled, plain disabled, new Claude available');
 ok(targets[2].text.includes('Esta consola no acepta pegado seguro'),'the plain console says why');
 eq(await js('smoke.enterBox()'),{checked:false,disabled:false},'Send with Enter starts unchecked');
 await js("smoke.pick('safe')");await frame();
 eq(await js('smoke.enterBox()'),{checked:false,disabled:true},'Enter is disabled for a console that is not an agent');
 await js("smoke.pick('plain')");await frame();
 ok((await js('smoke.targets()')).find(t=>t.id==='safe').checked,'a disabled console cannot be picked');
 await js("smoke.pick('claude')");await frame();
 await shot('notes-menu');
 await js('smoke.confirm()');
 await until('!smoke.menu()','sending closes the picker');
 const sent=await take();
 eq(sent.length,1,'one write: a single paste');
 const [ptyId,data]=sent[0];
 eq(ptyId,'pty-claude','to Claude');
 const body='File: src/app.ts\nScope: file\nUser comment: "falta el header"\n\nFile: src/app.ts\nLines: 2-4\nUser comment: "extraer funcion"\n\nFile: src/app.ts\nLine: 3\nUser comment: "usar const\\nverificar \\"null\\""';
 eq(data,'\x1b[200~'+body.replace(/\n/g,'\r')+'\x1b[201~','one bracketed paste with the exact format (xterm turns LF into CR)');
 await wait(400);
 eq(await take(),[],'no Enter without the checkbox');
 await until("smoke.pending()==='0 notas pendientes'",'all notes are sent');
 ok((await js("smoke.tags('extraer funcion')")).some(t=>t.startsWith('sent:enviada ')),'cards are tagged "enviada hh:mm"');
 eq(await js('smoke.sendBtn().disabled'),true,'nothing pending: the send button is disabled');
 await until("smoke.toasts().includes('Notas enviadas a Claude 1')",'toast names the console');

 // FR-18: editing a sent note puts it back to pending.
 await js("smoke.cardAction('extraer funcion','edit')");
 await until('smoke.editor()','Edit opens the editor with the text');
 await type(' ya');
 await press('Return',['control']);
 await until("smoke.pending()==='1 nota pendiente'",'edited note is pending again');
 eq(await js("smoke.tags('extraer funcion ya')"),[],'and loses its sent tag');

 // Send with Enter: the CR follows after the delay.
 await js('smoke.openMenu()');await until('smoke.menu()','picker again');
 eq(await js('smoke.enterBox()'),{checked:false,disabled:false},'Enter unchecked again on every open');
 await js('smoke.toggleEnter()');await frame();
 await js('smoke.confirm()');
 await until('smoke.writes.length>=1','the paste goes');
 const one=await js('smoke.writes.splice(0).map(w=>[w.ptyId,w.data])');
 ok(one.length===1&&one[0][1].startsWith('\x1b[200~File: src/app.ts\rLines: 2-4\r'),'only the pending note is pasted '+JSON.stringify(one));
 await until('smoke.writes.length>=1','the Enter follows');
 eq(await take(),[['pty-claude','\r']],'then one Enter starts the turn');

 // FR-18: a changed line shows "desactualizada" (and can still be sent).
 await js("smoke.setLine(1,'const b = 22')");
 await until("(smoke.tags('usar const')||[]).some(t=>t.startsWith('stale:'))",'the annotated line changed: outdated');
 ok(!(await js("smoke.tags('extraer funcion ya')")).some(t=>t.startsWith('stale:')),'a note whose line text is unchanged is not outdated');

 // FR-20: Resolve collapses; Pending hides sent and resolved; Clear sent asks first.
 await js("smoke.cardAction('falta el header','resolve')");
 await until("(smoke.tags('falta el header')||[]).some(t=>t.startsWith('resolved:'))",'resolved and collapsed');
 await js("smoke.filter('pending')");
 await until('smoke.cards()===0','Pending hides sent and resolved notes');
 await js("smoke.filter('all')");
 await until('smoke.cards()===3','All shows them again');
 await js('smoke.clear()');
 await until('smoke.dialog()','Clear sent asks for confirmation');
 ok((await js('smoke.toasts()')).includes('Borra 3 notas enviadas o resueltas'),'the dialog counts them');
 await press('Escape');
 ok(!(await js('smoke.dialog()'))&&(await js('smoke.panel()'))&&(await js('smoke.cards()'))===3,'Esc cancels the dialog only');
 await js('smoke.clear()');await until('smoke.dialog()','dialog again');
 await press('Return');
 await until('smoke.cards()===0','confirmed: sent and resolved notes are gone');
 ok((await js('smoke.bar()'))===null,'no notes left: the bar hides');

 // A conflict diff takes no notes; an untracked file does.
 await js("smoke.click('conflict:src/conflict.ts')");
 await until("smoke.header().includes('src/conflict.ts')",'conflict selected');
 ok((await js('smoke.lines()')).length===0&&!(await js("!!document.querySelector('[data-note-file]')")),'no notes on a conflict');
 await js("smoke.click('untracked:notes.md')");
 await until('smoke.lines().length===2','untracked lines take notes');

 // Refused send: forcing the plain console writes nothing (FR-19 acceptance).
 await js('smoke.focusLine(1)');await press('C');await until('smoke.editor()','editor');await type('para powershell');await press('Return',['control']);
 await until("smoke.pending()==='1 nota pendiente'",'one pending');
 await js('smoke.openMenu()');await until('smoke.menu()','picker');
 await js("document.querySelector('[data-notes-target=\"plain\"]').disabled=false");
 await js("smoke.pick('plain')");await frame();
 ok(!(await js('smoke.targets()')).find(t=>t.id==='plain').checked,'even enabled by hand in the DOM, the plain console cannot be picked');
 await press('Escape');
 eq(await js("smoke.forceSend('plain')"),{ok:false,sent:0,error:'not_agent'},'forcing the call on the plain console: not_agent');
 await wait(300);
 eq(await take(),[],'and nothing reaches its pty');
 eq(await js("smoke.pending()"),'1 nota pendiente','the note stays pending');
 ok(!(await js('smoke.overflow()')),'no horizontal overflow');
 await shot('notes-final');

 if(failures.length)throw new Error(failures.join('\n'));
 console.log('PASS: '+n+' review notes UI checks (c / + / Shift+click / file note, Ctrl+Enter / Esc, cards and counts, picker: preselect, plain disabled, Enter off by default, exact bracketed paste, Enter delay, edit -> pending, outdated, resolve, filter, clear with confirm, conflict without notes, forced plain send writes nothing); screenshots '+__dirname);
 w.destroy();app.quit();
}).catch((e)=>{console.error(e);app.exit(1)});
`
fs.writeFileSync(path.join(dir, 'main.cjs'), main)
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
const res = spawnSync(require('electron'), [path.join(dir, 'main.cjs')], { env, windowsHide: true, encoding: 'utf8', timeout: 120000 })
process.stdout.write(res.stdout ?? ''); if (res.status !== 0) process.stderr.write(res.stderr ?? '')
process.exitCode = res.status ?? 1
