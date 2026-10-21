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
import {useSidePanels, openNoteInPanel, openSidePanel, closeSidePanel, setSidePanelMaximized} from './src/renderer/lib/sidePanels';
import {openChangesPanel} from './src/renderer/lib/changesPanel';
import {useToastStore} from './src/renderer/lib/toast';

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
    read: async ({ rel }) => { const f = files[rel]; return f ? { ok: true, kind: 'text', text: f.text, eol: f.eol, bom: f.bom, rev: f.rev, size: f.text.length, readOnly: !!f.readOnly } : { ok: false, error: 'not_found' } },
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
      calls.noteWrites.push({ ...req, at: performance.now() });
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
// The real shell around the workspace (App.tsx): an overflow-hidden row with the sidebar and main,
// so a drawer that scrolls its ancestors shows up as a shifted shell (v2.2.1).
function App() {
  return <div style={{ height: '100vh' }} className="flex flex-col bg-bg-primary text-text-primary"><Keys /><div data-shell className="flex min-h-0 w-full flex-1 overflow-hidden bg-bg-primary"><aside style={{ width: 220, flexShrink: 0 }} /><main className="relative min-w-0 flex-1"><WorkspaceView workspace={ws} isActive /></main></div><CommandPalette /></div>;
}
createRoot(document.getElementById('root')).render(<I18nProvider lang="es"><App /></I18nProvider>);
const q = (s) => document.querySelector(s);
const qa = (s) => [...document.querySelectorAll(s)];
window.addEventListener('error',(e)=>{window.__err=String(e.message)});
// When the last primary press landed and how many note writes had happened by then.
window.addEventListener('pointerdown',()=>{window.__downAt=performance.now();window.__writesAtDown=calls.noteWrites.length},true);
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
  search: () => !!q('[data-find-widget]'),
  // The find widget (v2.3): its counter, whether its field has the focus, its replace row.
  findCount: () => q('[data-find-count]')?.textContent ?? null,
  findFocused: () => document.activeElement === q('[data-find-input]'),
  replaceRow: () => !!q('[data-find-replace-row]'),
  replaceFocused: () => document.activeElement === q('[data-find-replace-input]'),
  replaceToggle: () => !!q('[data-find-action="toggleReplace"]'),
  toggleOn: (k) => q('[data-find-toggle="' + k + '"]')?.dataset.on === 'true',
  findInvalid: () => q('[data-find-input]')?.getAttribute('aria-invalid') === 'true',
  editorFocused: () => !!document.activeElement?.classList.contains('cm-content'),
  closeTab: (rel) => q('[data-file-tab="' + rel + '"] button').click(),
  // Collapse folders (v2.3) and the tree filter.
  collapse: () => q('[data-files-collapse]').click(),
  collapseDisabled: () => q('[data-files-collapse]').disabled,
  filter: (text) => { const el = q('[data-files-filter]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, text); el.dispatchEvent(new Event('input', { bubbles: true })) },
  filterValue: () => q('[data-files-filter]').value,
  // Outside click (v2.3): a point on the console beside the drawer, the resize edge, the pin, the header toggle.
  consolePoint: () => { const d = q('[data-drawer]').getBoundingClientRect(); const x = q('.xterm-screen').getBoundingClientRect(); return { x: Math.round(Math.min(x.left + 60, d.left - 60)), y: Math.round(x.top + 40) } },
  resizePoint: () => { const r = q('[data-drawer-resize]').getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) } },
  filesButtonPoint: () => { const r = q('[data-files-button]').getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) } },
  // A point on the title of the console's header, which takes no focus itself.
  paneTitlePoint: () => { const s = qa('main span.font-medium').find((e) => e.textContent === 'Consola').getBoundingClientRect(); return { x: Math.round(s.left + 6), y: Math.round(s.top + s.height / 2) } },
  // Lets presses fall through a maximized drawer to the console under it (the drawer's own filter is off).
  passThrough: (on) => { q('[data-drawer]').style.pointerEvents = on ? 'none' : '' },
  xtermAt: (x, y) => !!document.elementFromPoint(x, y)?.closest('.xterm'),
  pin: () => q('[data-drawer-pin]').click(),
  pinned: () => q('[data-drawer-pin]')?.dataset.drawerPin ?? null,
  pinStored: (id, scope = 'w1') => localStorage.getItem('snagentsos.drawer.' + id + '.pinned.' + scope),
  xtermFocused: () => !!document.activeElement?.closest?.('.xterm'),
  notesNew: () => (q('[data-notes-first]') || q('[data-notes-new]')).click(),
  noteRows: () => qa('[data-note-row]').map((r) => r.textContent),
  preview: () => q('[data-note-preview]')?.textContent ?? '',
  previewHeading: () => q('[data-note-preview] [role=heading]')?.textContent ?? '',
  saved: () => q('[data-note-saved]')?.textContent ?? '',
  openChanges: () => openChangesPanel(),
  side: () => useSidePanels.getState().open.w1 ?? null,
  // Every workspace's drawer (app 2.5.0), and a switch of the active one under the same grid.
  sides: () => useSidePanels.getState().open,
  activate: (id) => useAppStore.setState({ activeWorkspaceId: id }),
  openSide: (kind) => openSidePanel(kind),
  closeSide: () => closeSidePanel({ refocus: false }),
  overflow: () => document.documentElement.scrollWidth > innerWidth,
  shellScroll: () => Math.max(q('[data-shell]').scrollLeft, q('[data-shell]').scrollTop, document.scrollingElement.scrollLeft, document.body.scrollLeft),
  // Samples the shell's scroll every frame for ms, across a drawer's 150 ms slide-in.
  sampleShift: (ms) => { window.__maxShift = 0; const end = performance.now() + ms; const tick = () => { window.__maxShift = Math.max(window.__maxShift, smoke.shellScroll()); if (performance.now() < end) requestAnimationFrame(tick); else window.__sampled = true }; window.__sampled = false; tick() },
  maximize: (v) => setSidePanelMaximized('w1', v),
  newConsole: () => q('[data-new-console-button]').click(),
  menuOpen: () => !!q('[data-new-console-menu]'),
  // Is the menu what paints at a point inside it? The drawer sits right under it.
  menuOnTop: () => { const m = q('[data-new-console-menu]'); if (!m) return false; const r = m.getBoundingClientRect(); return m.contains(document.elementFromPoint(r.left + r.width / 2, r.top + Math.min(r.height - 4, 20))) },
  drawerPoint: () => { const r = q('[data-drawer]').getBoundingClientRect(); return { x: Math.round(r.left + 40), y: Math.round(r.bottom - 40) } },
  palette: () => useAppStore.getState().setPaletteOpen(true),
  // snaos notes open (v2.3): a note straight into the store (the CLI writes through main), then the request.
  addNote: (id, title) => { const text = '# ' + title + ' texto'; notes[id] = { id, title, updatedAt: Date.now(), size: text.length, rev: 'n' + ++revN, text, path: 'C:/data/notes/w1/' + id + '.md' } },
  noteIdOf: (title) => Object.values(notes).find((n) => n.title === title)?.id ?? null,
  openNote: (id) => openNoteInPanel('w1', id),
  noteTitle: () => q('[data-note-title]')?.textContent ?? null,
  noteRequest: () => useSidePanels.getState().noteRequest,
  // Someone else changed the note on disk (no event yet).
  bumpRev: (id) => { notes[id].rev = 'n' + ++revN },
  toasts: () => useToastStore.getState().items.map((t) => t.title),
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
 // Collapse folders (v2.3): disabled while there is nothing to collapse.
 ok(await js('smoke.collapseDisabled()'),'collapse is disabled on a fresh tree');
 await js("smoke.clickRow('src')");
 await until("smoke.rows().includes('src/app.ts')",'a click expands a folder');
 eq(await js('smoke.rows()'),['src','src/app.ts','src/util.ts','README.md','win.txt'],'children under their folder');
 ok(!(await js('smoke.collapseDisabled()')),'an open folder enables collapse');
 await js('smoke.collapse()');
 await until('smoke.rows().length===3','collapse goes back to the first level');
 eq(await js('smoke.rows()'),['src','README.md','win.txt'],'collapsed: the first level only');
 ok(await js('smoke.collapseDisabled()'),'and collapse is disabled again');
 ok(await js("document.activeElement===document.querySelector('[data-files-tree]')"),'the disabled button hands the keyboard to the tree');
 // With text in the filter every loaded match shows open: collapse also clears the filter.
 await js("smoke.filter('app')");
 await until("smoke.rows().includes('src/app.ts')&&!smoke.rows().includes('README.md')",'the filter shows the loaded match under its folder');
 ok(!(await js('smoke.collapseDisabled()')),'a filter enables collapse');
 await js('smoke.collapse()');
 await until("smoke.filterValue()===''&&smoke.rows().length===3",'collapse with a filter clears it and shows the first level');
 eq(await js('smoke.rows()'),['src','README.md','win.txt'],'filter cleared, folders closed');
 await js("smoke.clickRow('src')");
 await until("smoke.rows().includes('src/app.ts')",'src open for the next steps');

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

 // Global keys stay out of the editor: Ctrl+F opens the find widget (v2.3) with the focus in its field.
 eq(await js('smoke.editorText()'),'const a = 1\n// hola','the text to search');
 await js('smoke.focusEditor()');
 await press('F',['control']);
 await until('smoke.search()&&smoke.findFocused()','Ctrl+F opens the find widget with the focus in the query');
 ok(!(await js("!!document.querySelector('.cm-search')")),'not the stock CodeMirror panel');
 eq(await js('smoke.findCount()'),'','nothing typed: no counter');
 await type('o');
 await until("smoke.findCount()==='1 de 2'",'typing jumps to the first match: 1 of N');
 await press('Return');
 await until("smoke.findCount()==='2 de 2'",'Enter: next match');
 await press('Return');
 await until("smoke.findCount()==='1 de 2'",'Enter wraps around');
 await press('Return',['shift']);
 await until("smoke.findCount()==='2 de 2'",'Shift+Enter: previous match');
 await press('F3');
 await until("smoke.findCount()==='1 de 2'",'F3: next match');
 await press('F3',['shift']);
 await until("smoke.findCount()==='2 de 2'",'Shift+F3: previous match');
 ok(await js('smoke.findFocused()'),'the keys keep the focus in the query');
 await press('A',['control']);await type('Hola');
 await until("smoke.findCount()==='1 de 1'",'a case-insensitive match');
 await press('C',['alt']);
 await until("smoke.findCount()==='Sin resultados'",'Alt+C (match case) changes the count');
 ok(await js("smoke.toggleOn('case')")&&await js('smoke.findInvalid()'),'the toggle shows on and the field marks no results');
 await press('C',['alt']);
 await until("smoke.findCount()==='1 de 1'&&!smoke.toggleOn('case')",'Alt+C again: back to case-insensitive');
 ok(!(await js('smoke.replaceRow()')),'replace starts hidden');
 await press('H',['control']);
 await until('smoke.replaceRow()&&smoke.replaceFocused()','Ctrl+H shows the replace row with the focus in it');
 await type('Chau');
 // Readable at 100 / 125 / 150%: inside the editor, and the first line is not under it (room on top).
 for(const z of [1,1.25,1.5]){
  w.webContents.setZoomFactor(z);await frame();await wait(150);
  ok(await js("(()=>{const r=document.querySelector('[data-find-widget]').getBoundingClientRect(),ed=[...document.querySelectorAll('[data-code-editor]')].find((e)=>e.offsetParent!==null),c=ed.getBoundingClientRect(),l=ed.querySelector('.cm-line').getBoundingClientRect();return r.right<=c.right+1&&r.left>=c.left-1&&r.height>60&&l.top>=r.bottom})()"),'the widget fits the editor and leaves the first line visible at zoom '+z);
  await shot('find-widget-zoom-'+String(z).replace('.','_'));
 }
 w.webContents.setZoomFactor(1);await frame();await wait(100);
 ok(await js('smoke.replaceFocused()'),'the replace field kept the focus');
 await press('Return');
 await until("smoke.editorText()==='const a = 1\\n// Chau'",'Enter in replace replaces the match');
 await until("smoke.tabs()[0][1]==='true'",'replacing marks the tab unsaved');
 await press('F',['control']);
 await until('smoke.findFocused()&&!smoke.replaceRow()','Ctrl+F from the replace field goes back to the query alone (replace hides)');
 await type('Chau');
 await until("smoke.findCount()==='1 de 1'",'the replaced text is found');
 await press('H',['control']);
 await until('smoke.replaceRow()&&smoke.replaceFocused()','Ctrl+H from the query shows replace again with the focus in it');
 await js("document.querySelector('[data-find-input]').focus()");
 await press('H',['control']);
 await until('smoke.replaceRow()&&smoke.replaceFocused()','Ctrl+H with replace open moves the focus to it (never hides it)');
 await press('A',['control']);await type('hola');
 await press('Return',['control','alt']);
 await until("smoke.editorText()==='const a = 1\\n// hola'",'Ctrl+Alt+Enter replaces all');
 await until("smoke.findCount()==='Sin resultados'&&smoke.tabs()[0][1]==='false'",'nothing left to find; the text is back to the saved one');
 await press('Escape');
 await until('!smoke.search()','Esc closes the widget first');
 ok((await js('smoke.drawer()'))==='files','and keeps the drawer open');
 ok(await js('smoke.editorFocused()'),'the focus goes back to the text');
 // A read-only file finds but never replaces.
 await js("smoke.files['ro.txt']={text:'solo lectura\\n',eol:'lf',bom:false,rev:'r1',readOnly:true};smoke.emitFiles([''])");
 await until("smoke.rows().includes('ro.txt')",'a read-only file in the tree');
 await js("smoke.clickRow('ro.txt')");
 await until("smoke.editorText()==='solo lectura'",'the read-only file opens');
 await js('smoke.focusEditor()');
 await press('F',['control']);
 await until('smoke.search()&&smoke.findFocused()','Ctrl+F finds in a read-only file');
 ok(!(await js('smoke.replaceToggle()')),'no replace chevron when read-only');
 await press('H',['control']);
 ok(!(await js('smoke.replaceRow()')),'Ctrl+H shows no replace row when read-only');
 await type('lect');
 await until("smoke.findCount()==='1 de 1'",'and it counts');
 await press('Escape');
 await until('!smoke.search()','Esc closes it');
 await js("smoke.closeTab('ro.txt')");
 await until('smoke.tabs().length===1','the read-only tab closes');
 await js("delete smoke.files['ro.txt'];smoke.emitFiles([''])");
 await until("!smoke.rows().includes('ro.txt')",'and leaves the tree');

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
 await js('smoke.sampleShift(500)');
 await press('M',['control','shift']);
 await until("smoke.drawer()==='notes'",'Ctrl+Shift+M opens Notes (one drawer at a time)');
 await until('window.__sampled','the Notes slide-in sampler ran');
 eq(await js('window.__maxShift'),0,'opening Notes does not scroll the app shell');
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
 // The same find widget in a note.
 await js('smoke.focusEditor()');
 await press('F',['control']);
 await until('smoke.search()&&smoke.findFocused()','Ctrl+F opens the find widget in a note');
 await type('login');
 await until("smoke.findCount()==='1 de 1'",'a note counts its matches');
 await js('smoke.focusEditor()');
 await press('H',['control']);
 await until('smoke.replaceRow()&&smoke.replaceFocused()','Ctrl+H from the note text (find open) shows replace with the focus in it');
 await shot('notes-find');
 await press('Escape');
 await until('!smoke.search()','Esc closes the note find');
 ok(await js('smoke.editorFocused()'),'the note text has the focus back');
 await press('H',['control']);
 await until('smoke.search()&&smoke.replaceRow()&&smoke.replaceFocused()','Ctrl+H from the note text (find closed) opens it with replace focused');
 await press('Escape');
 await until('!smoke.search()','Esc closes it again');
 await press('F',['control']);
 await until('smoke.search()&&smoke.findFocused()','Ctrl+F after Ctrl+H, Esc');
 ok(!(await js('smoke.replaceRow()')),'opens find alone: closing forgot the replace row');
 await press('Escape');
 await until('!smoke.search()','Esc closes the find alone');
 ok((await js('smoke.drawer()'))==='notes'&&await js('smoke.editorFocused()'),'the Notes drawer stays and the note has the focus');

 // Changes takes over; Esc closes a drawer; the palette lists both.
 await js('smoke.openChanges()');
 await until('smoke.side()===null','opening Changes closes Notes');
 // Reopening Files with tabs still open (they live in filesStore) mounts the active tab while the
 // drawer is off-screen: neither it nor the editor's focus may scroll the shell (v2.2.1).
 await js('smoke.sampleShift(500)');
 await press('E',['control','shift']);
 await until("smoke.drawer()==='files'",'Files again');
 await until('window.__sampled','the Files slide-in sampler ran');
 ok((await js('smoke.tabs().length'))===2,'the Files tabs survived closing the drawer');
 eq(await js('window.__maxShift'),0,'opening Files with open tabs does not scroll the app shell');
 eq(await js('smoke.shellScroll()'),0,'and the shell stays in place after the slide-in');

 // The New console menu paints above the drawer, and a click on the drawer closes it (v2.2.1).
 const click=async(x,y)=>{w.webContents.sendInputEvent({type:'mouseDown',x,y,button:'left',clickCount:1});w.webContents.sendInputEvent({type:'mouseUp',x,y,button:'left',clickCount:1});await frame();await wait(60)};
 for(const max of [false,true]){
  await js('smoke.maximize('+max+')');await frame();
  await js('smoke.newConsole()');
  await until('smoke.menuOpen()','the New console menu opens'+(max?' (drawer maximized)':''));
  ok(await js('smoke.menuOnTop()'),'New console menu paints above the drawer'+(max?' (maximized)':''));
  if(!max)await shot('new-console-over-drawer');
  const pt=await js('smoke.drawerPoint()');
  await click(pt.x,pt.y);
  await until('!smoke.menuOpen()','a click on the drawer closes the menu'+(max?' (maximized)':''));
  ok((await js('smoke.drawer()'))==='files','and the drawer stays open'+(max?' (maximized)':''));
 }
 await js('smoke.maximize(false)');await frame();

 // A click on the console beside the drawer closes it (v2.3), and the console keeps the keyboard.
 let pt=await js('smoke.drawerPoint()');
 await click(pt.x,pt.y);
 ok((await js('smoke.drawer()'))==='files','a click inside the drawer keeps it');
 pt=await js('smoke.resizePoint()');
 w.webContents.sendInputEvent({type:'mouseDown',x:pt.x,y:pt.y,button:'left',clickCount:1});
 w.webContents.sendInputEvent({type:'mouseMove',x:pt.x-40,y:pt.y,button:'left'});
 w.webContents.sendInputEvent({type:'mouseUp',x:pt.x-40,y:pt.y,button:'left',clickCount:1});
 await frame();await wait(60);
 ok((await js('smoke.drawer()'))==='files','dragging the resize edge keeps it');
 await js("smoke.context('README.md')");
 await until('smoke.menu().length>5','the tree menu is open');
 pt=await js('smoke.consolePoint()');
 await click(pt.x,pt.y);
 await until('smoke.menu().length===0','a click on the console with the menu open closes the menu');
 ok((await js('smoke.drawer()'))==='files','and only the menu');
 await js('smoke.maximize(true)');await frame();
 await js('smoke.passThrough(true)');
 ok(await js('smoke.xtermAt('+pt.x+','+pt.y+')'),'with the maximized drawer let through, the press lands on the console');
 await click(pt.x,pt.y);
 ok((await js('smoke.drawer()'))==='files','maximized: a press on the grid keeps it');
 await js('smoke.passThrough(false)');
 await js('smoke.maximize(false)');await frame();
 // Pinned: a click outside keeps it, and the pin survives a reopen.
 eq(await js('smoke.pinned()'),'off','unpinned by default');
 await js('smoke.pin()');
 await until("smoke.pinned()==='on'",'the pin turns on');
 eq(await js("smoke.pinStored('files')"),'1','the pin is kept per drawer and workspace');
 await click(pt.x,pt.y);
 ok((await js('smoke.drawer()'))==='files','pinned: a click on the console keeps it');
 await press('E',['control','shift']);
 await until('smoke.drawer()===null','Ctrl+Shift+E closes it');
 await press('E',['control','shift']);
 await until("smoke.drawer()==='files'&&smoke.pinned()==='on'",'reopened, still pinned');
 // Each workspace keeps its own drawer and pin (app 2.5.0): another one opening or closing its drawer leaves this one.
 await js("smoke.activate('w2')");
 await js("smoke.openSide('notes')");
 eq(await js('smoke.sides()'),{w1:'files',w2:'notes'},'Notes on another workspace keeps the pinned Files of this one');
 eq(await js("smoke.pinStored('files','w2')"),null,'and the other workspace does not share the pin');
 await js('smoke.closeSide()');
 eq(await js('smoke.sides()'),{w1:'files'},'closing the drawer there leaves this one');
 await js("smoke.activate('w1')");
 await until("smoke.drawer()==='files'&&smoke.pinned()==='on'",'back here: the same drawer, still pinned');
 await js('smoke.pin()');
 await until("smoke.pinned()==='off'",'unpinned');
 eq(await js("smoke.pinStored('files')"),'0','unpinning is kept for this workspace');
 // A dirty tab survives an outside close.
 await until('smoke.focusEditor()','the editor of the open tab');
 await press('End',['control']);await type('!');
 await until("smoke.tabs().some(t=>t[1]==='true')",'a tab with edits');
 pt=await js('smoke.consolePoint()');
 await click(pt.x,pt.y);
 await until('smoke.drawer()===null','a click on the console closes the drawer');
 await wait(100);
 ok(await js('smoke.xtermFocused()'),'and the clicked console has the keyboard');
 await press('E',['control','shift']);
 await until("smoke.drawer()==='files'&&smoke.tabs().some(t=>t[1]==='true')",'the edited tab survived');
 ok(!(await js('smoke.xtermFocused()')),'the reopened drawer has the keyboard');
 pt=await js('smoke.paneTitlePoint()');
 await click(pt.x,pt.y);
 await until('smoke.drawer()===null','a click on the pane title closes the drawer');
 await until('smoke.xtermFocused()','and the last console gets the keyboard back (the title takes no focus)');
 await press('E',['control','shift']);
 await until("smoke.drawer()==='files'",'Files again for the header toggle');
 // The header toggle still toggles once (the header is outside the grid).
 pt=await js('smoke.filesButtonPoint()');
 await click(pt.x,pt.y);await wait(100);
 eq(await js('smoke.drawer()'),null,'the Files button closes it once, no reopen');
 // A note typed and clicked away before its 600 ms autosave is saved anyway.
 await press('M',['control','shift']);
 await until("smoke.drawer()==='notes'",'Notes again');
 await until('smoke.focusEditor()','the note has the editor');
 await press('End',['control']);await type(' afuer');
 await until("smoke.calls.noteWrites.at(-1)?.text.includes(' afuer')",'the autosave of the first keys');
 const writesBefore=await js('smoke.calls.noteWrites.length');
 pt=await js('smoke.consolePoint()');
 // The last key and the press back to back, well inside the 600 ms debounce.
 w.webContents.sendInputEvent({type:'char',keyCode:'a'});
 await wait(80);
 w.webContents.sendInputEvent({type:'mouseDown',x:pt.x,y:pt.y,button:'left',clickCount:1});
 w.webContents.sendInputEvent({type:'mouseUp',x:pt.x,y:pt.y,button:'left',clickCount:1});
 await until('smoke.drawer()===null','a click on the console closes Notes');
 await until("smoke.calls.noteWrites.length>"+writesBefore+"&&smoke.calls.noteWrites.at(-1).text.includes(' afuera')",'the pending note text is saved on close');
 eq(await js('window.__writesAtDown'),writesBefore,'no autosave had run when the press landed');
 const lag=await js('smoke.calls.noteWrites.at(-1).at-window.__downAt');
 ok(lag>=0&&lag<300,'the close itself wrote it, not the debounce ('+Math.round(lag)+' ms after the press)');
 await press('E',['control','shift']);
 await until("smoke.drawer()==='files'",'Files for the Esc check');
 await js("document.querySelector('[data-drawer]').focus()");
 await press('Escape');
 await until('smoke.drawer()===null','Esc closes the drawer');
 // snaos notes open (v2.3): the request opens the drawer on that note, also when it is already open.
 await js("smoke.addNote('n-cli','Desde la CLI')");
 await js("smoke.openNote('n-cli')");
 await until("smoke.drawer()==='notes'&&smoke.noteTitle()==='Desde la CLI'",'notes open: the drawer opens on the asked note, not the last one');
 eq(await js('smoke.noteRequest()'),null,'the first load took the request');
 const planId=await js("smoke.noteIdOf('Plan del login')");
 await js('smoke.openNote('+JSON.stringify(planId)+')');
 await until("smoke.noteTitle()==='Plan del login'",'a later request switches the open drawer to that note');
 await js("smoke.addNote('n-nueva','Recien creada')");
 await js("smoke.openNote('n-nueva')");
 await until("smoke.noteTitle()==='Recien creada'&&smoke.noteRows().some(r=>r.includes('Recien creada'))",'a note the drawer had not listed yet: the list refreshes and it opens');
 eq(await js('smoke.noteRequest()'),null,'every request is consumed');
 // Two requests in a row: the latest one is the note that stays open.
 await js('smoke.openNote('+JSON.stringify(planId)+');smoke.openNote("n-cli")');
 await until("smoke.noteRequest()===null&&smoke.noteTitle()==='Desde la CLI'",'two quick requests: the last one wins');
 await wait(200);
 eq(await js('smoke.noteTitle()'),'Desde la CLI','an older request still in flight never replaces the latest');
 // A request never switches away from edits that did not save (here a conflict).
 await js("smoke.bumpRev('n-cli')");
 await js('smoke.focusEditor()');await press('End',['control']);await type(' local');
 await js('smoke.openNote('+JSON.stringify(planId)+')');
 await until('smoke.noteRequest()===null','the request is consumed');
 await until("smoke.toasts().some(t=>t.includes('cambios sin guardar'))",'a toast says why the note did not switch');
 ok((await js('smoke.noteTitle()'))==='Desde la CLI'&&(await js('smoke.editorText()')).endsWith(' local'),'the conflicting note stays open with the unsaved text',await js('smoke.editorText()'));
 await press('M',['control','shift']);
 await until('smoke.drawer()===null','Ctrl+Shift+M closes Notes');
 await js('smoke.palette()');await wait(200);
 const body=await js('document.body.textContent');
 ok(body.includes('Abrir los archivos del workspace')&&body.includes('Abrir las notas del workspace'),'the palette has both drawers');
 await press('Escape');

 if(failures.length)throw new Error(failures.join('\n'));
 console.log('PASS: '+n+' files and notes drawer UI checks (Ctrl+Shift+E/M, tree, open, type, Ctrl+S with rev, collapse folders, find widget with counter / options / replace / read-only / zoom, CRLF + BOM, agent changes clean and dirty, context menu, autosaved note + preview, snaos notes open (latest wins, never over unsaved edits), one drawer at a time and one per workspace, Esc, palette, no shell shift on open, New console menu over the drawer, close on outside click with pin); screenshots '+__dirname);
 w.destroy();app.quit();
}).catch((e)=>{console.error(e);app.exit(1)});
`
fs.writeFileSync(path.join(dir, 'main.cjs'), main)
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
const res = spawnSync(require('electron'), [path.join(dir, 'main.cjs')], { env, windowsHide: true, encoding: 'utf8', timeout: 240000 })
process.stdout.write(res.stdout ?? ''); if (res.status !== 0) process.stderr.write(res.stderr ?? '')
process.exitCode = res.status ?? 1
