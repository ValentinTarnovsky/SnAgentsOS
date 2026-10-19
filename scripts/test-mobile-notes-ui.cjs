// The phone's Notes screen (v2.2, E9) in an isolated hidden browser at
// 390x844: the real WsNotesScreen over a fake client.requestNotes backed by
// an in-memory folder. Checks the list (newest first, untitled), a new note,
// Edit + Save with the loaded rev, the Markdown view, dictation into the
// note, a conflict with "Save anyway", a read-only long note, a change from
// the PC reloading the open note, delete with its confirmation, "The PC did
// not answer", Spanish labels and no horizontal overflow.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path')
const { pathToFileURL } = require('node:url')
const { spawnSync } = require('node:child_process')
const root = path.resolve(__dirname, '..')
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snagentsos-mobile-notes-'))
const assets = path.join(root, 'out/mobile/assets')
const mobileCss = fs.existsSync(assets) && fs.readdirSync(assets).find(name => /^index-.*\.css$/.test(name))
if (!mobileCss) throw new Error('Run npm run build:mobile first')
require('esbuild').buildSync({ stdin: { resolveDir: root, loader: 'tsx', contents: `
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { WsNotesScreen } from './src/mobile/src/components/notes/WsNotesScreen';
import { client } from './src/mobile/src/lib/client';
import { store } from './src/mobile/src/lib/store';
import { BackStackHost } from './src/mobile/src/lib/useBackClaim';
import { openWsNotes, noteChanged, useWsNotes } from './src/mobile/src/lib/wsNotes';
import { setLang } from './src/mobile/src/lib/i18n';
window.result = (async () => {
 let checks=0; const check=(ok,label)=>{if(!ok)throw new Error(label);checks++};
 const frames = () => new Promise(r => setTimeout(r, 40));
 const until = async (fn, label, ms = 3000) => { for (let t = 0; t < ms; t += 40) { if (fn()) return; await frames() } throw new Error('timeout: ' + label) };
 // The PC's notes.
 let rev = 1, n = 2, offline = false, conflictOnce = false;
 const notes = {
  a: { id: 'a', title: 'Plan', updatedAt: Date.now() - 60000, size: 10, rev: 'r1', text: '# Plan\\n- uno' },
  b: { id: 'b', title: '', updatedAt: Date.now() - 3600000, size: 0, rev: 'r1', text: '' },
 };
 const reqs = [];
 client.requestNotes = async (req) => {
  reqs.push(req);
  if (offline) return { ok: false, error: 'timeout' };
  const meta = ({ text, ...m }) => m;
  switch (req.op) {
   case 'list': return { ok: true, value: { ok: true, notes: Object.values(notes).map(meta).sort((x, y) => y.updatedAt - x.updatedAt) } };
   case 'read': return notes[req.noteId] ? { ok: true, value: { ok: true, note: { ...notes[req.noteId] } } } : { ok: true, value: { ok: false, error: 'not_found' } };
   case 'create': { const id = 'n' + ++n; notes[id] = { id, title: '', updatedAt: Date.now(), size: 0, rev: 'r' + ++rev, text: '' }; return { ok: true, value: { ok: true, note: meta(notes[id]) } } }
   case 'write': {
    const cur = notes[req.noteId];
    if (conflictOnce && req.baseRev) { conflictOnce = false; cur.text = 'cambiada en la PC'; cur.rev = 'r' + ++rev; return { ok: true, value: { ok: false, error: 'conflict', current: { ...cur } } } }
    if (req.baseRev && req.baseRev !== cur.rev) return { ok: true, value: { ok: false, error: 'conflict', current: { ...cur } } };
    Object.assign(cur, { text: req.text, rev: 'r' + ++rev, updatedAt: Date.now(), title: (req.text.match(/^#\\s+(.+)$/m) || [])[1] || '' });
    return { ok: true, value: { ok: true, note: meta(cur) } };
   }
   case 'delete': delete notes[req.noteId]; return { ok: true, value: { ok: true } };
  }
 };
 class FakeRec { constructor(){ window.__rec=this } start(){} stop(){} }
 window.webkitSpeechRecognition = FakeRec;
 try { Object.defineProperty(window,'isSecureContext',{ value:true, configurable:true }) } catch {}
 setLang('en');
 store.getState().update({ phase:'live', connected:true, snapshot:{ language:'en', themeTokens:{}, fontFamily:'mono', fontSize:13, activeWorkspaceId:'w1', keyButtons:[], workspaces:[{ id:'w1', name:'Front', layoutOrder:[], panes:[] }] } });
 const host=document.getElementById('root'); const reactRoot=createRoot(host);
 flushSync(() => reactRoot.render(<BackStackHost><WsNotesScreen /></BackStackHost>));
 const q = (s) => document.querySelector(s);
 const qa = (s) => [...document.querySelectorAll(s)];
 const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set;
 const typeInto = (el, value) => { setter.call(el, value); el.dispatchEvent(new Event('input', { bubbles: true })) };
 const noOverflow = () => document.documentElement.scrollWidth <= innerWidth;

 // The list.
 flushSync(() => openWsNotes('w1'));
 await until(() => qa('[data-ws-note-row]').length === 2, 'the list loads');
 check(qa('[data-ws-note-row]').map((r) => r.dataset.wsNoteRow).join() === 'a,b', 'newest first');
 check(q('[data-ws-note-row="b"]').textContent.includes('Untitled'), 'a note without a heading is Untitled');
 check(q('[data-push-screen="ws-notes"]')?.textContent.includes('Notes - Front'), 'the title names the workspace');
 check(noOverflow(), 'no horizontal overflow (list)');

 // Open, view, edit, save.
 q('[data-ws-note-row="a"]').click();
 await until(() => !!q('[data-ws-note-view]'), 'a note opens');
 check(q('[data-ws-note-view] [role=heading]')?.textContent === 'Plan' && q('[data-ws-note-view]').textContent.includes('uno'), 'it shows as Markdown');
 q('[data-ws-note-edit]').click(); await frames();
 const ta = () => q('[data-ws-note-text]');
 check(ta() && ta().value === '# Plan\\n- uno', 'Edit puts the text in a field');
 typeInto(ta(), '# Plan\\n- uno\\n- dos'); await frames();
 // Dictation adds to the end.
 q('[data-mic-button="wsNote"]').click(); await frames();
 window.__rec.onresult({ resultIndex: 0, results: [{ isFinal: true, 0: { transcript: 'y tres' } }] }); await frames();
 check(ta().value === '# Plan\\n- uno\\n- dos y tres', 'dictation lands in the note');
 q('[data-ws-note-save]').click();
 await until(() => !!q('[data-ws-note-view]'), 'saved: back to the view');
 const w = reqs.filter((r) => r.op === 'write').at(-1);
 check(w.noteId === 'a' && w.baseRev === 'r1' && w.text === '# Plan\\n- uno\\n- dos y tres', 'the save carries the text and the loaded rev');
 check(q('[data-ws-note-view]').textContent.includes('dos y tres'), 'the view shows the saved text');

 // A conflict: the PC changed it meanwhile.
 conflictOnce = true;
 q('[data-ws-note-edit]').click(); await frames();
 typeInto(ta(), 'mía'); await frames();
 q('[data-ws-note-save]').click();
 await until(() => !!q('[data-ws-note-conflict]'), 'a conflict shows the choice');
 q('[data-ws-note-force]').click();
 await until(() => !!q('[data-ws-note-view]') && !q('[data-ws-note-conflict]'), 'Save anyway overwrites');
 const forced = reqs.filter((r) => r.op === 'write').at(-1);
 check(forced.text === 'mía' && forced.baseRev === undefined, 'Save anyway goes without a rev');

 // A change from the PC reloads the open note.
 notes.a.text = '# Plan\\nnuevo desde la PC'; notes.a.rev = 'r' + ++rev;
 const reads = reqs.filter((r) => r.op === 'read').length;
 flushSync(() => noteChanged('w1', 'a'));
 await until(() => q('[data-ws-note-view]')?.textContent.includes('nuevo desde la PC'), 'a change on the PC reloads the note');
 check(reqs.filter((r) => r.op === 'read').length === reads + 1, 'one read');

 // Back to the list, a new note.
 q('[data-ws-notes-all]').click();
 await until(() => !!q('[data-ws-notes-new]'), 'All notes goes back to the list');
 q('[data-ws-notes-new]').click();
 await until(() => useWsNotes.getState().noteId === 'n3' && !!q('[data-ws-note-view]'), 'a new note opens');
 check(q('[data-ws-note-view]').textContent.includes('Empty note'), 'an empty note invites to edit');

 // Delete with the confirmation.
 q('[data-ws-note-delete]').click(); await frames(); await frames();
 check(q('[data-confirm-message]')?.textContent.includes('notes trash'), 'the confirmation says where it goes');
 q('[data-confirm-ok]').click();
 await until(() => !notes.n3 && useWsNotes.getState().noteId === null, 'delete removes it and goes back to the list');

 // A long note is read-only.
 notes.big = { id: 'big', title: 'Big', updatedAt: Date.now() + 1000, size: 99999, rev: 'r9', text: '# Big', readOnly: true };
 flushSync(() => useWsNotes.setState({ noteId: 'big' }));
 await until(() => !!q('[data-ws-note-readonly]'), 'a long note says it is read-only');
 check(!q('[data-ws-note-edit]'), 'and has no Edit');

 // The PC does not answer.
 offline = true;
 flushSync(() => useWsNotes.setState({ noteId: null }));
 await until(() => !!q('[data-no-reply]'), 'no answer: The PC did not answer');
 offline = false;
 q('[data-no-reply] button').click();
 await until(() => qa('[data-ws-note-row]').length >= 2, 'Retry loads it');

 // Spanish.
 setLang('es'); flushSync(() => store.getState().update({ snapshot: { ...store.getState().snapshot, language: 'es' } }));
 flushSync(() => reactRoot.render(<BackStackHost><WsNotesScreen key="es" /></BackStackHost>));
 await until(() => !!q('[data-ws-notes-new]'), 'the list again in Spanish');
 check(q('[data-ws-notes-new]').textContent.includes('Nueva nota') && q('[data-push-screen="ws-notes"]').textContent.includes('Notas - Front'), 'Spanish labels');
 check(noOverflow(), 'no horizontal overflow');
 reactRoot.unmount(); return checks;
})();
` }, bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"', __APP_VERSION__: '"test"' }, alias: { '@shared': path.join(root, 'src/shared') }, loader: { '.css': 'empty' }, outfile: path.join(dir, 'renderer.js') })
fs.writeFileSync(path.join(dir, 'index.html'), `<html><head><meta charset="utf-8"><link rel="stylesheet" href="${pathToFileURL(path.join(assets, mobileCss))}"></head><body style="margin:0"><div id="root"></div><script src="renderer.js"></script></body></html>`)
fs.writeFileSync(path.join(dir, 'main.cjs'), `
const {app,BrowserWindow}=require('electron');const path=require('path');
app.setPath('userData',path.join(__dirname,'profile'));
app.whenReady().then(async()=>{
 const w=new BrowserWindow({show:false,width:390,height:844,webPreferences:{sandbox:true,backgroundThrottling:false}});
 await w.loadFile(path.join(__dirname,'index.html'));
 const checks=await w.webContents.executeJavaScript('window.result');
 console.log('PASS: '+checks+' mobile Notes screen checks');w.destroy();app.quit();
}).catch(e=>{console.error(e);app.exit(1)});
`)
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
const flags = process.platform === 'linux' && process.env.CI ? ['--no-sandbox'] : []
const result = spawnSync(require('electron'), [...flags, path.join(dir, 'main.cjs')], { env, windowsHide: true, encoding: 'utf8', timeout: 90000 })
process.stdout.write(result.stdout ?? '')
if (result.status !== 0) process.stderr.write((result.stderr || '') + (result.error ? result.error.message : '') + (result.signal ? ' signal ' + result.signal : ''))
fs.rmSync(dir, { recursive: true, force: true })
process.exitCode = result.status ?? 1
