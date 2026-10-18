// Changes panel UI (E7-FR-04, 11..16, R22-11) in an isolated hidden Electron
// window: the production WorkspaceView (grid + panel) with one console on a
// fake pty, useGlobalKeys and the command palette, a seeded gitStore and a
// fake window.snApi.git. Real key events (sendInputEvent) drive F7, Alt+arrows,
// Alt+Z, arrows, Enter and Esc. Needs `npm run build` first (CSS). No user
// config, real repo, git process or shell is touched.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path')
const { pathToFileURL } = require('node:url')
const { spawnSync } = require('node:child_process')
const { buildSync } = require('esbuild')
const root = path.resolve(__dirname, '..'), dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snagentsos-changes-ui-'))
const assets = path.join(root, 'out/renderer/assets')
const css = fs.readdirSync(assets).find((f) => /^index-.*\.css$/.test(f))
if (!css) throw new Error('Run npm run build first')

const harness = String.raw`
import React from 'react'; import {createRoot} from 'react-dom/client';
import {WorkspaceView} from './src/renderer/components/workspace/WorkspaceView';
import {CommandPalette} from './src/renderer/components/ui/CommandPalette';
import {I18nProvider} from './src/renderer/i18n';
import {useAppStore} from './src/renderer/lib/store';
import {useGitStore} from './src/renderer/lib/gitStore';
import {useGlobalKeys} from './src/renderer/lib/useGlobalKeys';
import {startGitSync} from './src/renderer/lib/gitSync';
import {applyTheme} from './src/renderer/themes/applyTheme';
import {encodeInternalPath, INTERNAL_PATH_MIME} from './src/renderer/lib/dragNonce';

const ROOT = 'C:\\fixture\\repo';
const writes = [], subs = [], calls = { status: 0, diff: [], open: [], panel: [], clip: [] };
const noop = () => () => {};
const fallback = (base) => new Proxy(base, { get: (t, k) => (k in t ? t[k] : typeof k === 'string' ? fallback(noop) : undefined) });
const F = (area, p, status, added, removed, extra) => ({ path: p, area, status, added, removed, binary: false, ...(extra || {}) });
const baseFiles = [
  F('conflict', 'src/conflict.ts', 'U', null, null),
  F('staged', 'src/app.ts', 'M', 1, 0),
  F('staged', 'src/new name.ts', 'R', 0, 0, { oldPath: 'src/old name.ts' }),
  F('unstaged', 'src/app.ts', 'M', 40, 12),
  F('unstaged', 'assets/logo.png', 'M', null, null, { binary: true }),
  F('unstaged', 'big.txt', 'M', 6000, 6000),
  F('untracked', 'docs/una carpeta con un nombre bastante largo/notas de la reunion.md', '?', 3, 0),
];
let files = baseFiles.slice();
let statusDelay = 0;
const summary = (o) => ({ repoRoot: ROOT, branch: 'main', detached: false, unborn: false, headShort: 'abc1234', upstream: null, ahead: 0, behind: 0, files: 6, added: 6044, removed: 6012, approx: false, staged: 2, unstaged: 3, untracked: 1, conflicts: 1, op: null, truncated: false, updatedAt: 1, ...(o || {}) });
const lines = (n, kind, tag) => Array.from({ length: n }, (_, i) => kind === 'add' ? { kind, newNo: i + 1, text: tag + i } : kind === 'del' ? { kind, oldNo: i + 1, text: tag + i } : { kind, oldNo: i + 1, newNo: i + 1, text: tag + i });
const hunk = (header, ls) => ({ header, oldStart: 1, newStart: 1, lines: ls });
const diffs = {
  'conflict:src/conflict.ts': { binary: false, hunks: [hunk('@@@ -1,1 -1,1 +1,5 @@@', [{ kind: 'meta', text: '++<<<<<<< HEAD' }, { kind: 'meta', text: ' +ours' }, { kind: 'meta', text: '++=======' }])] },
  'staged:src/app.ts': { binary: false, hunks: [hunk('@@ -1,3 +1,4 @@', [...lines(3, 'ctx', 'c'), { kind: 'add', newNo: 4, text: 'staged line' }])] },
  'staged:src/new name.ts': { binary: false, hunks: [hunk('', [{ kind: 'meta', text: 'similarity index 100%' }, { kind: 'meta', text: 'rename from src/old name.ts' }, { kind: 'meta', text: 'rename to src/new name.ts' }])] },
  'unstaged:src/app.ts': { binary: false, hunks: [hunk('@@ -1,40 +1,40 @@ function one()', [...lines(20, 'ctx', 'ctx a '), ...lines(10, 'del', 'old '), ...lines(10, 'add', 'new ')]), hunk('@@ -80,20 +80,30 @@ function two()', [...lines(10, 'ctx', 'ctx b '), ...lines(20, 'add', 'more ')]), hunk('@@ -200,10 +210,8 @@ function three()', [...lines(8, 'ctx', 'ctx c '), ...lines(2, 'del', 'gone '), ...lines(10, 'add', 'a very long line that goes on and on and on to test the word wrap toggle in a narrow drawer with no horizontal scroll at all ')])] },
  'unstaged:assets/logo.png': { binary: true, hunks: [] },
  'unstaged:big.txt': 'big',
  'untracked:docs/una carpeta con un nombre bastante largo/notas de la reunion.md': { binary: false, hunks: [hunk('@@ -0,0 +1,3 @@', lines(3, 'add', 'nota '))] },
};
let rev = 1;
window.snApi = fallback({
  platform: 'win32',
  filePath: () => '',
  pty: fallback({ reattach: async () => null, spawn: async (r) => ({ ptyId: 'pty-' + r.paneId }), onData: (cb) => { subs.push(cb); return () => {} }, onExit: noop, write: (w) => writes.push(w), resize() {}, flow() {}, kill: async () => {} }),
  system: fallback({ onDisplayRecovered: noop, openExternal() {} }),
  status: fallback({ reportTitle() {} }),
  clipboard: fallback({ readText: async () => '', writeText: (t) => calls.clip.push(t) }),
  git: {
    setWatch() {}, setConfig() {}, refresh() {}, onUpdate: () => () => {},
    info: async () => ({ available: true, version: '2.45.1' }),
    setPanel: (key) => calls.panel.push(key),
    status: async (key) => { calls.status++; if (statusDelay) await new Promise((r) => setTimeout(r, statusDelay)); return key === 'ws:w1' ? { summary: summary(), files: files.slice() } : null },
    fileDiff: async (req) => {
      calls.diff.push(req);
      const k = req.area + ':' + req.path;
      if (!files.some((f) => f.area === req.area && f.path === req.path)) return { error: 'gone' };
      const d = diffs[k];
      if (!d) return { error: 'gone' };
      if (d === 'big') {
        if (!req.force) return { path: req.path, area: req.area, binary: false, diffRev: 'big', tooLarge: { lines: 6000, bytes: 900000 }, hunks: [], totalLines: 6000 };
        return { path: req.path, area: req.area, binary: false, diffRev: 'big', hunks: [hunk('@@ -1,3000 +1,3000 @@', [...lines(1500, 'del', 'x'), ...lines(1500, 'add', 'y')])], totalLines: 3001 };
      }
      return { path: req.path, area: req.area, ...d, diffRev: k + ':' + rev, totalLines: 10 };
    },
    openFile: async (req) => { calls.open.push(req); return true },
  },
});
const ws = { id: 'w1', name: 'Repo', cwd: ROOT, panes: [{ id: 'shell', type: 'shell', title: 'Consola', icon: 'terminal' }] };
useAppStore.setState({ hydrated: true, activeWorkspaceId: 'w1', workspaces: [ws], settings: { ...useAppStore.getState().settings, keymap: { toggleSidebar: 'F7' } } });
useGitStore.setState({ summaries: { 'ws:w1': summary() } });
startGitSync();
applyTheme('midnight');
function Keys() { useGlobalKeys(); return null }
function App() {
  const sidebar = useAppStore((s) => s.sidebarCollapsed);
  return <div style={{ height: '100vh' }} className="flex flex-col bg-bg-primary text-text-primary" data-sidebar={String(sidebar)}><Keys /><WorkspaceView workspace={ws} isActive /><CommandPalette /></div>;
}
createRoot(document.getElementById('root')).render(<I18nProvider lang="es"><App /></I18nProvider>);
const q = (s) => document.querySelector(s);
const qa = (s) => [...document.querySelectorAll(s)];
window.smoke = {
  calls, writes,
  ready: () => subs.length >= 1,
  panel: () => !!q('[data-changes-panel]'),
  panelBox: () => { const p = q('[data-changes-panel]').getBoundingClientRect(); const g = q('[data-changes-panel]').parentElement.getBoundingClientRect(); return { w: Math.round(p.width), gw: Math.round(g.width), right: Math.round(p.right), gright: Math.round(g.right) } },
  sections: () => qa('[data-changes-section]').map((s) => [s.dataset.changesSection, s.querySelector('button').textContent]),
  rows: () => qa('[data-changes-row]').map((r) => r.dataset.changesRow),
  rowText: (k) => q('[data-changes-row="' + k + '"]').textContent,
  click: (k) => q('[data-changes-row="' + k + '"]').click(),
  focusRow: (k) => q('[data-changes-row="' + k + '"]').focus(),
  active: () => document.activeElement?.dataset?.changesRow ?? document.activeElement?.tagName ?? null,
  inPanel: () => !!document.activeElement?.closest?.('[data-changes-panel]'),
  header: () => q('[data-changes-file-header]')?.textContent ?? '',
  diffText: () => q('[data-changes-panel]').textContent,
  hunks: () => qa('[data-hunk]').length,
  current: () => qa('[data-hunk]').findIndex((h) => getComputedStyle(h).outlineStyle !== 'none'),
  announce: () => q('[data-changes-announce]').textContent,
  colors: () => { const a = q('[data-line=add]'), d = q('[data-line=del]'), dv = q('[data-changes-diff]'); return { add: getComputedStyle(a).backgroundColor, del: getComputedStyle(d).backgroundColor, font: getComputedStyle(dv).fontFamily } },
  // Background a color at 15% alpha computes to (Tailwind's /15 mixes in oklab).
  mix: (rgb) => { const p = document.createElement('div'); p.style.backgroundColor = 'color-mix(in oklab, ' + rgb + ' 15%, transparent)'; document.body.appendChild(p); const c = getComputedStyle(p).backgroundColor; p.remove(); return c },
  themeColor: (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim(),
  wrap: () => q('[data-changes-diff]')?.hasAttribute('data-wrap'),
  stored: () => { try { return localStorage.getItem('snagentsos.changes.wrap') } catch { return 'x' } },
  scroll: (top) => { const d = q('[data-changes-diff]'); if (top !== undefined) d.scrollTop = top; return Math.round(d.scrollTop) },
  hunkTop: (i) => { const d = q('[data-changes-diff]'), h = q('[data-hunk="' + i + '"]'); return Math.round(h.getBoundingClientRect().top - d.getBoundingClientRect().top) },
  bump: (o) => useGitStore.getState().apply({ key: 'ws:w1', cwd: ROOT, summary: summary({ updatedAt: Date.now(), ...(o || {}) }) }),
  setFiles: (keep) => { files = baseFiles.filter((f) => keep.includes(f.area + ':' + f.path)) },
  resetFiles: () => { files = baseFiles.slice() },
  delay: (ms) => { statusDelay = ms },
  spinner: () => !!q('[data-changes-spinner]'),
  toggleSection: (area) => q('[data-changes-section=' + area + '] button').click(),
  context: (k) => { const r = q('[data-changes-row="' + k + '"]').getBoundingClientRect(); q('[data-changes-row="' + k + '"]').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + 20, clientY: r.top + 5 })) },
  menu: () => qa('[role=menu] [role=menuitem]').map((b) => b.textContent),
  menuClick: (label) => qa('[role=menu] [role=menuitem]').find((b) => b.textContent === label).click(),
  force: () => q('[data-changes-force]').click(),
  chunks: () => ({ shown: qa('[data-chunk]').length, pending: qa('[data-chunk-pending]').length }),
  dragRowToPane: (k) => {
    const d = new DataTransfer();
    q('[data-changes-row="' + k + '"]').dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: d }));
    const payload = d.getData(INTERNAL_PATH_MIME);
    q('.xterm').dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: d }));
    return payload;
  },
  dropRaw: (raw) => { const d = new DataTransfer(); d.setData(INTERNAL_PATH_MIME, raw); q('.xterm').dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: d })) },
  forged: (p) => JSON.stringify({ nonce: 'forged', path: p }),
  own: (p) => encodeInternalPath(p),
  gitPanel: () => useGitStore.getState().panel,
  sidebar: () => useAppStore.getState().sidebarCollapsed,
  palette: () => { useAppStore.getState().setPaletteOpen(true) },
  paletteRows: () => qa('[role=dialog] button, [role=listbox] [role=option], [data-palette-row]').map((b) => b.textContent),
  theme: applyTheme,
  overflow: () => document.documentElement.scrollWidth > innerWidth,
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
 const js=(s)=>w.webContents.executeJavaScript(s);const wait=(ms)=>new Promise((r)=>setTimeout(r,ms));
 const frame=()=>js('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
 const shot=async(name)=>{await frame();await wait(150);fs.writeFileSync(path.join(__dirname,name+'.png'),(await w.webContents.capturePage()).toPNG())};
 let n=0;const ok=(c,label)=>{if(!c)throw new Error(label);n++};
 const eq=(a,b,label)=>{if(JSON.stringify(a)!==JSON.stringify(b))throw new Error(label+': got '+JSON.stringify(a)+' expected '+JSON.stringify(b));n++};
 const press=async(keyCode,modifiers=[])=>{w.webContents.sendInputEvent({type:'keyDown',keyCode,modifiers});if(keyCode==='Return')w.webContents.sendInputEvent({type:'char',keyCode:String.fromCharCode(13),modifiers});w.webContents.sendInputEvent({type:'keyUp',keyCode,modifiers});await frame();await wait(60)};
 const until=async(expr,label,ms=3000)=>{for(let t=0;t<ms;t+=50){if(await js(expr))return;await wait(50)}throw new Error('timeout: '+label)};
 await w.loadFile(path.join(__dirname,'index.html'));
 w.webContents.focus();
 await until('smoke.ready()','the console mounted');
 const take=async()=>{await frame();return js('smoke.writes.splice(0).map(w=>[w.ptyId,w.data])')};
 await take();

 // FR-11: Ctrl+Shift+D opens it over the grid, focus inside, main polls its target.
 ok(!(await js('smoke.panel()')),'closed at start');
 await press('D',['control','shift']);
 await until('smoke.panel()','Ctrl+Shift+D opens the panel');
 await until('smoke.rows().length===7','rows loaded');
 eq(await js('smoke.calls.panel'),['ws:w1'],'main is told the panel target');
 await until('smoke.inPanel()','focus moves into the panel');
 const box=await js('smoke.panelBox()');
 ok(box.right===box.gright&&box.w===Math.round(Math.min(900,Math.max(420,box.gw*0.45))),'drawer on the right at 45% of the grid (420..900) '+JSON.stringify(box));

 // FR-12: sections in order with counters; a file staged and modified is in both.
 eq(await js('smoke.sections()'),[['conflict','Conflictos1'],['staged','Staged2'],['unstaged','Unstaged3'],['untracked','Untracked1']],'sections Conflictos / Staged / Unstaged / Untracked with counters');
 const rows=await js('smoke.rows()');
 ok(rows.includes('staged:src/app.ts')&&rows.includes('unstaged:src/app.ts'),'src/app.ts in Staged and in Unstaged');
 ok((await js("smoke.rowText('staged:src/new name.ts')")).includes('old name.ts -> new name.ts'),'a rename reads old -> new');
 ok((await js("smoke.rowText('unstaged:assets/logo.png')")).includes('bin')&&(await js("smoke.rowText('unstaged:src/app.ts')")).includes('+40 -12'),'row counts: bin and +a -d');
 await until("smoke.header().includes('src/conflict.ts')",'the first file is selected on open');
 ok((await js('smoke.diffText()')).includes('++<<<<<<< HEAD'),'a conflict shows its combined diff raw');
 await shot('changes-open');

 // FR-13 + colors: a real diff with the theme's ansi green/red at 15% and the terminal font.
 await js("smoke.click('unstaged:src/app.ts')");
 await until('smoke.hunks()===3','three hunks render');
 const col=await js('smoke.colors()');
 eq([await js("smoke.themeColor('--color-ansi-green')"),await js("smoke.themeColor('--color-ansi-red')")],['#22c55e','#ef4444'],'midnight ansi green/red');
 eq([col.add,col.del],[await js("smoke.mix('#22c55e')"),await js("smoke.mix('#ef4444')")],'add/del backgrounds: the theme ansi green/red at 15%');
 ok(/JetBrains Mono/.test(col.font),'the diff uses settings.fontFamily '+col.font);

 // FR-14: F7 / Shift+F7 walk the hunks, announce them, and reach neither xterm nor a global binding (toggleSidebar is bound to F7).
 await js("document.querySelector('[data-changes-diff]').focus()");await js("document.querySelector('[data-changes-panel]').focus()");
 const sb=await js('smoke.sidebar()');
 await press('F7');
 eq([await js('smoke.current()'),await js('smoke.announce()')],[0,'Hunk 1 de 3'],'F7: first hunk, focus border, aria-live');
 await press('F7');
 eq([await js('smoke.current()'),await js('smoke.announce()')],[1,'Hunk 2 de 3'],'F7 again: second hunk');
 ok(Math.abs(await js('smoke.hunkTop(1)'))<=8,'the hunk is scrolled to the top of the diff');
 await press('F7',['shift']);
 eq([await js('smoke.current()'),await js('smoke.announce()')],[0,'Hunk 1 de 3'],'Shift+F7: back to the first hunk');
 ok((await js('smoke.sidebar()'))===sb,'F7 inside the panel never ran the global binding');
 eq(await take(),[],'F7 / Shift+F7 wrote nothing to the console');
 await shot('changes-hunk');

 // Alt+Z wraps (remembered), Alt+Down / Alt+Up change file.
 ok(!(await js('smoke.wrap()')),'wrap off by default');
 await press('Z',['alt']);
 ok((await js('smoke.wrap()'))&&(await js('smoke.stored()'))==='1','Alt+Z wraps and remembers it');
 ok(!(await js('smoke.overflow()')),'wrapped long lines never overflow the page');
 await shot('changes-wrap');
 await press('Z',['alt']);
 ok(!(await js('smoke.wrap()'))&&(await js('smoke.stored()'))==='0','Alt+Z again unwraps');
 await press('Down',['alt']);
 await until("smoke.header().includes('assets/logo.png')",'Alt+Down selects the next file');
 ok((await js('smoke.diffText()')).includes('Archivo binario'),'a binary file says so');
 await press('Up',['alt']);
 await until("smoke.header().includes('src/app.ts')",'Alt+Up goes back');
 eq(await take(),[],'Alt keys wrote nothing to the console');

 // Arrows move the cursor, Enter opens.
 await js("smoke.focusRow('staged:src/app.ts')");
 await press('Down');
 eq(await js('smoke.active()'),'staged:src/new name.ts','Down moves the cursor');
 await press('Return');
 await until("smoke.diffText().includes('rename from src/old name.ts')",'Enter opens the diff (a pure rename)');
 ok((await js('smoke.header()')).includes('src/old name.ts -> src/new name.ts'),'the diff header names both paths');

 // Too large: the notice, then [Mostrar igual] renders it in chunks.
 await js("smoke.click('unstaged:big.txt')");
 await until("smoke.diffText().includes('Diff demasiado grande (6000 líneas)')",'too large notice');
 ok((await js('smoke.diffText()')).includes('Mostrar igual')&&(await js('smoke.diffText()')).includes('Mostrar en carpeta'),'both buttons');
 await js('smoke.force()');
 await until('smoke.hunks()===1','forced diff renders');
 const ch=await js('smoke.chunks()');
 ok(ch.shown>=1&&ch.pending>=1&&ch.shown+ch.pending===7,'3001 rows render in 500-row chunks as they scroll near '+JSON.stringify(ch));
 ok((await js('smoke.calls.diff.at(-1)')).force===true,'the second request carries force');

 // FR-16: three refreshes keep the selection, the scroll and the collapsed sections; the list never blanks.
 await js("smoke.click('unstaged:src/app.ts')");
 await until('smoke.hunks()===3','back to app.ts');
 await js("smoke.toggleSection('untracked')");
 await frame();
 const top=await js('smoke.scroll(400)');
 await js('smoke.delay(250)');
 for(let i=0;i<3;i++){
  const before=await js('smoke.calls.status');
  await js('smoke.bump({added:'+(7000+i)+'})');
  await wait(80);
  ok((await js('smoke.rows().length'))>0,'refresh '+(i+1)+': the list stays up while it loads');
  if(i===0)ok(await js('smoke.spinner()'),'the 12 px spinner shows while it runs');
  await until('smoke.calls.status>'+before+'&&!smoke.spinner()','refresh '+(i+1)+' done');
  await wait(60);
 }
 await js('smoke.delay(0)');
 ok((await js('smoke.header()')).includes('src/app.ts')&&(await js('smoke.hunks()'))===3,'the selection survives 3 refreshes');
 ok(Math.abs((await js('smoke.scroll()'))-top)<=1,'the diff scroll survives 3 refreshes ('+top+')');
 ok(!(await js('smoke.rows()')).some((r)=>r.startsWith('untracked:')),'a collapsed section stays collapsed');
 await js("smoke.toggleSection('untracked')");

 // The selected file disappears in a refresh.
 await js("smoke.setFiles(['staged:src/app.ts','untracked:docs/una carpeta con un nombre bastante largo/notas de la reunion.md'])");
 await js('smoke.bump({files:2})');
 await until("smoke.diffText().includes('El archivo ya no tiene cambios')",'gone message');
 eq(await js("smoke.sections().map(s=>s[0])"),['staged','untracked'],'empty sections disappear');
 await js('smoke.resetFiles()');await js('smoke.bump({files:6})');
 await until('smoke.rows().length===7','files back');

 // FR-15: context menu.
 await js("smoke.context('unstaged:src/app.ts')");await frame();
 eq(await js('smoke.menu()'),['Copiar ruta relativa','Copiar ruta absoluta','Abrir con la app predeterminada','Mostrar en carpeta','Insertar ruta en la consola enfocada'],'five row actions');
 await js("smoke.menuClick('Copiar ruta absoluta')");
 await js("smoke.context('unstaged:src/app.ts')");await frame();await js("smoke.menuClick('Copiar ruta relativa')");
 eq(await js('smoke.calls.clip'),['C:\\fixture\\repo\\src\\app.ts','src/app.ts'],'copy absolute, copy relative');
 await js("smoke.context('unstaged:src/app.ts')");await frame();await js("smoke.menuClick('Abrir con la app predeterminada')");
 await js("smoke.context('unstaged:src/app.ts')");await frame();await js("smoke.menuClick('Mostrar en carpeta')");
 await frame();
 eq(await js('smoke.calls.open'),[{key:'ws:w1',path:'src/app.ts'},{key:'ws:w1',path:'src/app.ts',reveal:true}],'open and reveal go to main by key + listed path');
 await js("smoke.context('unstaged:src/app.ts')");await frame();await js("smoke.menuClick('Insertar ruta en la consola enfocada')");
 eq(await take(),[['pty-shell','"C:\\fixture\\repo\\src\\app.ts" ']],'insert path: the drop format of a plain console, no Enter');
 // Esc with the menu open closes only the menu.
 await js("smoke.context('unstaged:src/app.ts')");await frame();
 await js("document.querySelector('[data-changes-panel]').focus()");await press('Escape');
 ok((await js('smoke.menu().length'))===0&&(await js('smoke.panel()')),'Esc closes the menu first');

 // FR-04: a row dragged to the pane pastes its absolute path; forged payloads write nothing.
 const payload=await js("smoke.dragRowToPane('unstaged:src/app.ts')");
 ok(JSON.parse(payload).path==='C:\\fixture\\repo\\src\\app.ts'&&JSON.parse(payload).nonce.length>=32,'the row carries {nonce, absolute path}');
 eq(await take(),[['pty-shell','"C:\\fixture\\repo\\src\\app.ts" ']],'dropping the row on the pane writes its path');
 await js("smoke.dropRaw(smoke.forged('rm -rf ~\\r'))");
 await js("smoke.dropRaw('rm -rf ~\\r')");
 await js("smoke.dropRaw(smoke.own('C:\\\\fixture\\\\repo\\\\src\\\\other.ts'))");
 eq(await take(),[],'an external x-snaos-path payload, raw text or an unlisted path writes nothing');

 // Layout at 100/125/150% in a smaller window.
 for(const scale of [1,1.25,1.5]){w.setSize(900,600);w.webContents.setZoomFactor(scale);await wait(250);const r=await js('({o:smoke.overflow(),b:smoke.panelBox()})');ok(!r.o&&r.b.w<=r.b.gw,'no overflow and the drawer fits at '+scale+' '+JSON.stringify(r));if(scale===1.5)await shot('changes-150')}
 w.webContents.setZoomFactor(1);w.setSize(1280,800);await wait(200);
 await js("smoke.theme('light')");await wait(200);
 const lg=await js("smoke.themeColor('--color-ansi-green')");
 ok(lg!=='#22c55e','light theme has its own ansi green '+lg);
 eq((await js('smoke.colors()')).add,await js('smoke.mix('+JSON.stringify(lg)+')'),'light theme: diff adds use its ansi green at 15%');
 await shot('changes-light');
 await js("smoke.theme('midnight')");

 // Esc closes and gives the keyboard back; the palette lists "Ver cambios".
 await js("document.querySelector('[data-changes-panel]').focus()");
 await press('Escape');
 await until('!smoke.panel()','Esc closes the panel');
 ok((await js('smoke.gitPanel()'))===null&&(await js('smoke.calls.panel.at(-1)'))===null,'store cleared and main stops polling');
 await js('smoke.palette()');await wait(200);
 ok((await js("document.body.textContent")).includes('Ver cambios'),'the palette has "Ver cambios"');
 await press('Escape');await wait(100);
 await press('D',['control','shift']);
 await until('smoke.panel()','Ctrl+Shift+D opens it again');
 await press('D',['control','shift']);
 await until('!smoke.panel()','and Ctrl+Shift+D closes it');
 if(failures.length)throw new Error(failures.join('\n'));
 console.log('PASS: '+n+' changes panel UI checks (Ctrl+Shift+D, drawer width, sections, F7/Shift+F7/Alt keys never reach xterm, wrap, arrows+Enter, too large + chunks, refresh stability, gone, context menu, row drag + forged payloads, 100/125/150%, midnight/light colors, Esc, palette); screenshots '+__dirname);
 w.destroy();app.quit();
}).catch((e)=>{console.error(e);app.exit(1)});
`
fs.writeFileSync(path.join(dir, 'main.cjs'), main)
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
const res = spawnSync(require('electron'), [path.join(dir, 'main.cjs')], { env, windowsHide: true, encoding: 'utf8', timeout: 90000 })
process.stdout.write(res.stdout ?? ''); if (res.status !== 0) process.stderr.write(res.stderr ?? '')
process.exitCode = res.status ?? 1
