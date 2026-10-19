// Files and Notes drawers (v2.2, E9) in an isolated hidden Electron window:
// the production WorkspaceView with one console on a fake pty, useGlobalKeys,
// the command palette and fake window.snApi.files / wsNotes over an
// in-memory folder. Real key events (sendInputEvent) open the drawers, type
// into CodeMirror and save. Needs `npm run build` first (CSS). No user
// config, real folder, shell or file is touched.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path')
const { spawnSync } = require('node:child_process')
const { pathToFileURL } = require('node:url')
const { buildSync } = require('esbuild')
const root = path.resolve(__dirname, '..'), dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snagentsos-files-ui-'))
const assets = path.join(root, 'out/renderer/assets')
const css = fs.readdirSync(assets).find((f) => /^index-.*\.css$/.test(f))
if (!css) throw new Error('Run npm run build first')

const harness = String.raw`
import React from 'react'; import {createRoot} from 'react-dom/client';
import {WorkspaceView} from './src/renderer/components/workspace/WorkspaceView';
import {CommandPalette} from './src/renderer/components/ui/CommandPalette';
import {I18nProvider} from './src/renderer/i18n';
import {useAppStore} from './src/renderer/lib/store';
import {useGlobalKeys} from './src/renderer/lib/useGlobalKeys';
import {applyTheme} from './src/renderer/themes/applyTheme';
import {useSidePanels} from './src/renderer/lib/sidePanels';
import {openChangesPanel} from './src/renderer/lib/changesPanel';

const ROOT = 'C:\\fixture\\repo';
const calls = { writes: [], watch: [], creates: [], noteWrites: [], noteCreates: [], clip: [] };
const subs = [];
const noop = () => () => {};
const fallback = (base) => new Proxy(base, { get: (t, k) => (k in t ? t[k] : typeof k === 'string' ? fallback(noop) : undefined) });
// The in-memory folder: rel -> { text, eol, bom, rev }.
const files = {
  'README.md': { text: '# Hola\n\nUn repo de prueba.\n', eol: 'lf', bom: false, rev: 'r1' },
  'src/app.ts': { text: 'const a = 1\n', eol: 'lf', bom: false, rev: 'r1' },
  'src/util.ts': { text: 'export {}\n', eol: 'lf', bom: false, rev: 'r1' },
  'win.txt': { text: 'uno\ndos\n', eol: 'crlf', bom: true, rev: 'r1' },
};
let revN = 1;
const kids = (rel) => {
  const pre = rel ? rel + '/' : '';
  const names = new Map();
  for (const k of Object.keys(files)) if (k.startsWith(pre)) { const rest = k.slice(pre.length); const seg = rest.split('/')[0]; names.set(seg, rest.includes('/') ? 'dir' : 'file') }
  return [...names].map(([name, kind]) => ({ name, kind, size: 1, mtimeMs: 1 })).sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'dir' ? -1 : 1));
};
let filesChanged = null, notesChanged = null;
const notes = {};
let noteN = 0;
window.snApi = fallback({
  platform: 'win32',
  filePath: () => '',
  pty: fallback({ reattach: async () => null, spawn: async (r) => ({ ptyId: 'pty-' + r.paneId }), onData: (cb) => { subs.push(cb); return () => {} }, onExit: noop, write() {}, resize() {}, flow() {}, kill: async () => {} }),
  system: fallback({ onDisplayRecovered: noop, openExternal() {} }),
  status: fallback({ reportTitle() {} }),
  clipboard: fallback({ readText: async () => '', writeText: (t) => calls.clip.push(t) }),
  git: fallback({ setWatch() {}, setConfig() {}, refresh() {}, onUpdate: () => () => {}, setPanel() {}, info: async () => ({ available: true }), status: async () => null }),
  files: {
    root: async () => ({ ok: true, root: ROOT, name: 'repo' }),
    list: async ({ rel }) => ({ ok: true, entries: kids(rel), truncated: false }),
    read: async ({ rel }) => { const f = files[rel]; return f ? { ok: true, kind: 'text', text: f.text, eol: f.eol, bom: f.bom, rev: f.rev, size: f.text.length, readOnly: false } : { ok: false, error: 'not_found' } },
    write: async (req) => {
      calls.writes.push(req);
      const f = files[req.rel];
      if (!f) return { ok: false, error: 'not_found' };
      if (req.baseRev !== undefined && req.baseRev !== f.rev) return { ok: false, error: 'conflict' };
      Object.assign(f, { text: req.text, eol: req.eol, bom: req.bom, rev: 'r' + ++revN });
      return { ok: true, rev: f.rev, size: req.text.length };
    },
    create: async (req) => { calls.creates.push(req); files[req.rel] = { text: '', eol: 'lf', bom: false, rev: 'r' + ++revN }; return { ok: true } },
    rename: async () => ({ ok: true }), trash: async () => ({ ok: true }), reveal: async () => ({ ok: true }), open: async () => ({ ok: true }),
    watch: (id) => calls.watch.push(id),
    onChanged: (cb) => { filesChanged = cb; return () => { filesChanged = null } },
  },
  wsNotes: {
    list: async () => ({ ok: true, notes: Object.values(notes).map(({ text, path, ...m }) => m).sort((a, b) => b.updatedAt - a.updatedAt) }),
    read: async ({ noteId }) => (notes[noteId] ? { ok: true, note: { ...notes[noteId] } } : { ok: false, error: 'not_found' }),
    write: async (req) => {
      calls.noteWrites.push(req);
      const n = notes[req.noteId];
      if (!n) return { ok: false, error: 'not_found' };
      if (req.baseRev !== undefined && req.baseRev !== n.rev) return { ok: false, error: 'conflict', current: { ...n } };
      Object.assign(n, { text: req.text, title: (req.text.match(/^#\s+(.+)$/m) || [])[1] || '', rev: 'n' + ++revN, updatedAt: Date.now() });
      const { text, path, ...meta } = n;
      return { ok: true, note: meta };
    },
    create: async (req) => {
      calls.noteCreates.push(req);
      const id = 'n-' + ++noteN;
      notes[id] = { id, title: '', updatedAt: Date.now(), size: 0, rev: 'n' + ++revN, text: req.text || '', path: 'C:\\data\\notes\\w1\\' + id + '.md' };
      const { text, path, ...meta } = notes[id];
      return { ok: true, note: meta };
    },
    delete: async () => ({ ok: true }), open: async () => true, prune() {},
    onChanged: (cb) => { notesChanged = cb; return () => {} },
  },
});
const ws = { id: 'w1', name: 'Repo', cwd: ROOT, panes: [{ id: 'shell', type: 'shell', title: 'Consola', icon: 'terminal' }] };
useAppStore.setState({ hydrated: true, activeWorkspaceId: 'w1', workspaces: [ws] });
applyTheme('midnight');
function Keys() { useGlobalKeys(); return null }
function App() {
  return <div style={{ height: '100vh' }} className="flex flex-col bg-bg-primary text-text-primary"><Keys /><WorkspaceView workspace={ws} isActive /><CommandPalette /></div>;
}
createRoot(document.getElementById('root')).render(<I18nProvider lang="es"><App /></I18nProvider>);
const q = (s) => document.querySelector(s);
const qa = (s) => [...document.querySelectorAll(s)];
window.addEventListener('error',(e)=>{window.__err=String(e.message)});
window.smoke = {
  calls, files, notes,
  ready: () => subs.length >= 1,
  drawer: () => q('[data-drawer]')?.dataset.drawer ?? null,
  rows: () => qa('[data-file-row]').map((r) => r.dataset.fileRow),
  clickRow: (rel) => q('[data-file-row="' + rel + '"]').click(),
  context: (rel) => { const r = q('[data-file-row="' + rel + '"]').getBoundingClientRect(); q('[data-file-row="' + rel + '"]').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + 20, clientY: r.top + 5 })) },
  menu: () => qa('[role=menu] [role=menuitem]').map((b) => b.textContent),
  menuClick: (label) => qa('[role=menu] [role=menuitem]').find((b) => b.textContent === label).click(),
  tabs: () => qa('[data-file-tab]').map((t) => [t.dataset.fileTab, t.dataset.dirty]),
  editorText: () => { const els = qa('[data-code-editor]').filter((e) => e.offsetParent !== null); return els.length ? els[0].querySelector('.cm-content').innerText.trimEnd() : null },
  focusEditor: () => { const els = qa('[data-code-editor]').filter((e) => e.offsetParent !== null); const cm = els[0]?.querySelector('.cm-content'); if (!cm) return false; cm.focus(); return document.activeElement?.classList.contains('cm-content') },
  status: () => q('[data-files-status]')?.textContent ?? '',
  external: () => q('[data-file-external]')?.dataset.fileExternal ?? null,
  emitFiles: (dirs) => filesChanged && filesChanged({ workspaceId: 'w1', dirs }),
  search: () => !!q('.cm-search'),
  notesNew: () => (q('[data-notes-first]') || q('[data-notes-new]')).click(),
  noteRows: () => qa('[data-note-row]').map((r) => r.textContent),
  preview: () => q('[data-note-preview]')?.textContent ?? '',
  previewHeading: () => q('[data-note-preview] [role=heading]')?.textContent ?? '',
  saved: () => q('[data-note-saved]')?.textContent ?? '',
  openChanges: () => openChangesPanel(),
  side: () => useSidePanels.getState().open,
  overflow: () => document.documentElement.scrollWidth > innerWidth,
  palette: () => useAppStore.getState().setPaletteOpen(true),
};
`

buildSync({ stdin: { contents: harness, resolveDir: root, loader: 'tsx' }, bundle: true, platform: 'browser', format: 'iife', outfile: path.join(dir, 'renderer.js'), alias: { '@shared': path.join(root, 'src/shared'), '@': path.join(root, 'src/renderer') }, jsx: 'automatic', loader: { '.css': 'empty' }, define: { 'process.env.NODE_ENV': '"production"' } })
fs.writeFileSync(path.join(dir, 'index.html'), `<html><head><meta charset="utf-8"><link rel="stylesheet" href="${pathToFileURL(path.join(assets, css))}"></head><body><div id="root"></div><script src="renderer.js"></script></body></html>`)

const main = String.raw`
const {app,BrowserWindow}=require('electron');const fs=require('fs'),path=require('path');
app.setPath('userData',path.join(__dirname,'profile'));
app.whenReady().then(async()=>{
 const w=new BrowserWindow({width:1280,height:800,show:false,webPreferences:{sandbox:true,backgroundThrottling:false}});
 const failures=[];w.webContents.on('console-message',(_e,level,message)=>{if(level>=3)failures.push(message)});
 const js=(s)=>w.webContents.executeJavaScript(s).catch(async(e)=>{const m=await w.webContents.executeJavaScript('(window.__err||"")+" | "+typeof smoke+" | "+(document.body.innerText||"").slice(0,400)').catch(()=>'?');throw new Error('js failed: '+s.slice(0,120)+' :: '+m)});const wait=(ms)=>new Promise((r)=>setTimeout(r,ms));
 const frame=()=>js('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
 const shot=async(name)=>{await frame();await wait(150);fs.writeFileSync(path.join(__dirname,name+'.png'),(await w.webContents.capturePage()).toPNG())};
 let n=0;const ok=(c,label)=>{if(!c)throw new Error(label);n++};
 const eq=(a,b,label)=>{if(JSON.stringify(a)!==JSON.stringify(b))throw new Error(label+': got '+JSON.stringify(a)+' expected '+JSON.stringify(b));n++};
 const press=async(keyCode,modifiers=[])=>{w.webContents.sendInputEvent({type:'keyDown',keyCode,modifiers});if(keyCode==='Return')w.webContents.sendInputEvent({type:'char',keyCode:String.fromCharCode(13),modifiers});w.webContents.sendInputEvent({type:'keyUp',keyCode,modifiers});await frame();await wait(60)};
 const type=async(text)=>{for(const ch of text){w.webContents.sendInputEvent({type:'char',keyCode:ch});await wait(5)}await frame();await wait(40)};
 const until=async(expr,label,ms=4000)=>{for(let t=0;t<ms;t+=50){if(await js(expr))return;await wait(50)}throw new Error('timeout: '+label+' ('+(await js(expr))+')')};
 await w.loadFile(path.join(__dirname,'index.html'));
 w.webContents.focus();
 await until('smoke.ready()','the console mounted');

 // Files: Ctrl+Shift+E opens the drawer over the grid, the tree loads, the folder is watched.
 ok((await js('smoke.drawer()'))===null,'no drawer at start');
 await press('E',['control','shift']);
 await until("smoke.drawer()==='files'",'Ctrl+Shift+E opens Files');
 await until('smoke.rows().length===3','the first level of the tree');
 eq(await js('smoke.rows()'),['src','README.md','win.txt'],'folders first');
 eq(await js('smoke.calls.watch'),['w1'],'the drawer watches the workspace folder');
 await js("smoke.clickRow('src')");
 await until("smoke.rows().includes('src/app.ts')",'a click expands a folder');
 eq(await js('smoke.rows()'),['src','src/app.ts','src/util.ts','README.md','win.txt'],'children under their folder');

 // Open, type, save.
 await js("smoke.clickRow('src/app.ts')");
 await until("smoke.editorText()==='const a = 1'",'the file opens in the editor');
 eq(await js('smoke.tabs()'),[['src/app.ts','false']],'one clean tab');
 ok(await js('smoke.status().includes("TypeScript")&&smoke.status().includes("LF")&&smoke.status().includes("UTF-8")'),'status bar: language, LF, UTF-8 '+(await js('smoke.status()')));
 ok(await js('smoke.focusEditor()'),'the editor takes the focus');
 await press('End',['control']);
 await type('// hola');
 await until("smoke.tabs()[0][1]==='true'",'typing marks the tab unsaved');
 await press('S',['control']);
 await until('smoke.calls.writes.length===1','Ctrl+S saves');
 const wr=await js('smoke.calls.writes[0]');
 ok(wr.rel==='src/app.ts'&&wr.text.includes('// hola')&&wr.baseRev==='r1'&&wr.eol==='lf'&&wr.bom===false,'the save carries the text, the loaded rev, eol and bom '+JSON.stringify(wr));
 await until("smoke.tabs()[0][1]==='false'",'saved: the dot goes away');
 ok((await js('smoke.drawer()'))==='files','Ctrl+S did not leave the drawer');

 // Global keys stay out of the editor: Ctrl+F opens its search.
 await js('smoke.focusEditor()');
 await press('F',['control']);
 await until('smoke.search()','Ctrl+F opens the editor search panel');
 await press('Escape');
 await until('!smoke.search()','Esc closes the search first');
 ok((await js('smoke.drawer()'))==='files','and keeps the drawer open');

 // CRLF + BOM keep their shape.
 await js("smoke.clickRow('win.txt')");
 await until("smoke.tabs().length===2",'a second tab');
 await until('smoke.status().includes("CRLF")&&smoke.status().includes("BOM")','status bar shows CRLF and the BOM');
 await js('smoke.focusEditor()');await press('End',['control']);await type('tres');
 await press('S',['control']);
 await until('smoke.calls.writes.length===2','second save');
 const wr2=await js('smoke.calls.writes[1]');
 ok(wr2.eol==='crlf'&&wr2.bom===true&&wr2.text==='uno\ndos\ntres','a CRLF file with BOM saves as such (main restores the endings) '+JSON.stringify(wr2));

 // An agent changes the clean open file: it reloads on its own.
 await js("smoke.clickRow('src/app.ts')");
 await js("smoke.files['src/app.ts'].text='const b = 2\\n';smoke.files['src/app.ts'].rev='agent1';smoke.emitFiles(['src'])");
 await until("(smoke.editorText()||'').startsWith('const b = 2')",'a clean tab reloads when the file changes on disk');
 ok((await js('smoke.external()'))===null,'without a banner');
 // ...and with edits pending: a banner, never a silent overwrite.
 await js('smoke.focusEditor()');await type('x');
 await js("smoke.files['src/app.ts'].text='const c = 3\\n';smoke.files['src/app.ts'].rev='agent2';smoke.emitFiles(['src'])");
 await until("smoke.external()==='changed'",'with edits the change shows Reload / Keep mine');
 await shot('files-conflict');
 await js("document.querySelector('[data-file-reload]').click()");
 await until("(smoke.editorText()||'').startsWith('const c = 3')&&smoke.external()===null",'Reload takes the file from disk');

 // Context menu: copy path (absolute, as Windows spells it), insert path.
 await js("smoke.context('README.md')");
 await until('smoke.menu().length>5','the context menu');
 ok((await js('smoke.menu()')).includes('Copiar ruta')&&(await js('smoke.menu()')).includes('Mover a la papelera'),'menu items in Spanish');
 await js("smoke.menuClick('Copiar ruta')");
 eq(await js('smoke.calls.clip.at(-1)'),'C:\\fixture\\repo\\README.md','Copy path gives the absolute path');
 await shot('files-drawer');
 ok(!(await js('smoke.overflow()')),'no horizontal overflow');

 // Notes: Ctrl+Shift+M replaces Files, a first note, autosave and the preview.
 await press('M',['control','shift']);
 await until("smoke.drawer()==='notes'",'Ctrl+Shift+M opens Notes (one drawer at a time)');
 eq(await js('smoke.calls.watch.at(-1)'),null,'closing Files stops the watch');
 await js('smoke.notesNew()');
 await until('smoke.calls.noteCreates.length===1&&smoke.focusEditor()','a new note opens in the editor');
 await type('# Plan del login');
 await press('Return');
 await type('- revisar tokens');
 await until('smoke.calls.noteWrites.length>=1',"it saves on its own (600 ms after the last key)",3000);
 await until("smoke.previewHeading()==='Plan del login'",'split mode previews the heading');
 await until("smoke.noteRows().some(r=>r.includes('Plan del login'))",'the list shows the note by its heading');
 const nw=await js('smoke.calls.noteWrites.at(-1)');
 ok(nw.text.includes('# Plan del login')&&nw.text.includes('- revisar tokens')&&typeof nw.baseRev==='string','the autosave carries the text and the loaded rev');
 await shot('notes-drawer');

 // Changes takes over; Esc closes a drawer; the palette lists both.
 await js('smoke.openChanges()');
 await until('smoke.side()===null','opening Changes closes Notes');
 await press('E',['control','shift']);
 await until("smoke.drawer()==='files'",'Files again');
 await js("document.querySelector('[data-drawer]').focus()");
 await press('Escape');
 await until('smoke.drawer()===null','Esc closes the drawer');
 await js('smoke.palette()');await wait(200);
 const body=await js('document.body.textContent');
 ok(body.includes('Abrir los archivos del workspace')&&body.includes('Abrir las notas del workspace'),'the palette has both drawers');
 await press('Escape');

 if(failures.length)throw new Error(failures.join('\n'));
 console.log('PASS: '+n+' files and notes drawer UI checks (Ctrl+Shift+E/M, tree, open, type, Ctrl+S with rev, Ctrl+F search, CRLF + BOM, agent changes clean and dirty, context menu, autosaved note + preview, one drawer at a time, Esc, palette); screenshots '+__dirname);
 w.destroy();app.quit();
}).catch((e)=>{console.error(e);app.exit(1)});
`
fs.writeFileSync(path.join(dir, 'main.cjs'), main)
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
const res = spawnSync(require('electron'), [path.join(dir, 'main.cjs')], { env, windowsHide: true, encoding: 'utf8', timeout: 120000 })
process.stdout.write(res.stdout ?? ''); if (res.status !== 0) process.stderr.write(res.stderr ?? '')
process.exitCode = res.status ?? 1
