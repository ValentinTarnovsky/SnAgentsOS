// Ctrl+click on `file:line` in the desktop terminal (app 2.7.0, A9) in an
// isolated hidden Electron window: the production WorkspaceView with two
// consoles on a fake pty (a plain one and one on a worktree), real xterm with
// its link providers, and a fake window.snApi.files whose resolveRefs answers
// from a table. Checks: a path main says exists is underlined (hover shows
// the pointer), one it does not know is not, a plain click only selects, a
// Ctrl+click asks main again and opens the Files drawer at that line and
// column (the cursor lands there), a wrapped path and one after wide
// characters map to the right cells, a line is asked once (cached), a line
// past 4096 characters is neither walked nor asked, a URL on
// the same line keeps opening through the web links addon, a worktree
// console's ref opens in its own tree (`wsId#paneId`), and a file with
// unsaved edits in the hot-exit stash opens with them (Restored banner, never
// read over them; an open clean tab takes its stash, an edited one keeps its
// buffer). Needs `npm run build` first (CSS). No pty, user config, real
// folder or file is touched.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path')
const { spawnSync } = require('node:child_process')
const { pathToFileURL } = require('node:url')
const { buildSync } = require('esbuild')
const root = path.resolve(__dirname, '..'), dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snagentsos-term-links-ui-'))
const assets = path.join(root, 'out/renderer/assets')
const css = fs.existsSync(assets) && fs.readdirSync(assets).find((f) => /^index-.*\.css$/.test(f))
if (!css) throw new Error('Run npm run build first')

const harness = String.raw`
import React from 'react'; import {createRoot} from 'react-dom/client';
import {WorkspaceView} from './src/renderer/components/workspace/WorkspaceView';
import {I18nProvider} from './src/renderer/i18n';
import {useAppStore} from './src/renderer/lib/store';
import {useFilesStore, setTabText} from './src/renderer/lib/filesStore';
import {useSidePanels, closeSidePanel} from './src/renderer/lib/sidePanels';
import {pathSpans} from './src/renderer/lib/termFileLinks';
import {applyTheme} from './src/renderer/themes/applyTheme';

const ROOT = 'C:\\fixture\\repo', WT = 'C:\\fixture\\wt\\claude-1';
const calls = { resolve: [], read: [], root: [], external: [], spawn: [], resize: [] };
const subs = [];
const noop = () => () => {};
const fallback = (base) => new Proxy(base, { get: (t, k) => (k in t ? t[k] : typeof k === 'string' ? fallback(noop) : undefined) });
// What main would find in each console's tree.
const known = { pa: new Set(['src/a.ts', 'src/deep/file.ts']), pw: new Set(['src/wt.ts', 'src/wt2.ts']) };
const parse = (ref) => { const m = /^(.*?)(?::(\d+))?(?::(\d+))?$/.exec(ref); return { path: m[1].replace(/\\/g, '/'), line: m[2] ? +m[2] : 0, col: m[3] ? +m[3] : 0 } };
const text = Array.from({ length: 40 }, (_, i) => 'line ' + (i + 1) + ' of the file').join('\n') + '\n';
window.snApi = fallback({
  platform: 'win32',
  filePath: () => '',
  pty: fallback({ reattach: async () => null, spawn: async (r) => { calls.spawn.push(r); return { ptyId: 'pty-' + r.paneId, shellKind: 'powershell' } }, onData: (cb) => { subs.push(cb); return () => {} }, onExit: noop, write() {}, resize: (r) => calls.resize.push(r), flow() {}, kill: async () => {}, setActive() {} }),
  system: fallback({ onDisplayRecovered: noop, openExternal: (u) => calls.external.push(u) }),
  status: fallback({ reportTitle() {} }),
  clipboard: fallback({ readText: async () => '', writeText() {} }),
  git: fallback({ setWatch() {}, setConfig() {}, refresh() {}, onUpdate: () => () => {}, setPanel() {}, info: async () => ({ available: true }), worktreeInspect: async () => ({ exists: true, dirtyFiles: 0, commitsAhead: 0, mergedIntoHead: true }) }),
  files: {
    resolveRefs: async (req) => {
      calls.resolve.push(JSON.parse(JSON.stringify(req)));
      return req.refs.map((ref) => {
        const p = parse(ref);
        const ok = !!known[req.paneId]?.has(p.path);
        const base = req.paneId === 'pw' ? WT : ROOT;
        return { ref, exists: ok, ...(ok ? { path: base + '\\' + p.path.replace(/\//g, '\\'), rel: p.path } : {}), ...(p.line ? { line: p.line } : {}), ...(p.col ? { col: p.col } : {}) };
      });
    },
    root: async (id, paneId) => { calls.root.push([id, paneId ?? null]); return { ok: true, root: paneId ? WT : ROOT, name: paneId ? 'claude-1' : 'repo' } },
    list: async () => ({ ok: true, entries: [], truncated: false }),
    read: async (req) => { calls.read.push(JSON.parse(JSON.stringify(req))); return { ok: true, kind: 'text', text, eol: 'lf', bom: false, rev: 'r1', size: text.length, readOnly: false } },
    write: async () => ({ ok: true, rev: 'r2', size: 1 }), create: async () => ({ ok: true }), rename: async () => ({ ok: true }),
    trash: async () => ({ ok: true }), reveal: async () => ({ ok: true }), open: async () => ({ ok: true }),
    watch() {}, onChanged: () => () => {},
  },
});
const wt = { repoRoot: ROOT, path: WT, branch: 'sn/claude-1', base: 'f6c3fc4f451077c2689a52f81295236419257c5d' };
const ws = { id: 'w1', name: 'Repo', cwd: ROOT, panes: [
  { id: 'pa', type: 'shell', title: 'Consola', color: '#fff', icon: 'terminal' },
  { id: 'pw', type: 'shell', title: 'Worktree', color: '#fff', icon: 'terminal', cwd: WT, worktree: wt },
] };
useAppStore.setState({ hydrated: true, activeWorkspaceId: 'w1', workspaces: [ws] });
applyTheme('midnight');
function App() {
  const w = useAppStore((s) => s.workspaces[0]);
  return <div style={{ height: '100vh' }} className="flex flex-col bg-bg-primary text-text-primary"><div className="flex min-h-0 w-full flex-1 overflow-hidden bg-bg-primary"><main className="relative min-w-0 flex-1"><WorkspaceView workspace={w} isActive /></main></div></div>;
}
createRoot(document.getElementById('root')).render(<I18nProvider lang="es"><App /></I18nProvider>);
const q = (s) => document.querySelector(s);
const E = String.fromCharCode(27), N = String.fromCharCode(13, 10);
window.smoke = {
  calls,
  ready: () => subs.length >= 2 && calls.spawn.length >= 2,
  write: (paneId, lines) => subs.forEach((cb) => cb({ ptyId: 'pty-' + paneId, data: E + '[2J' + E + '[H' + lines.join(N) })),
  size: (paneId) => { const r = calls.resize.filter((x) => x.ptyId === 'pty-' + paneId).at(-1) || calls.spawn.find((x) => x.paneId === paneId); return { cols: r.cols, rows: r.rows } },
  // The center of 1-based cell (x, y) of a console's screen.
  at: (paneId, x, y) => { const el = q('[data-pane-cell=' + paneId + '] .xterm-screen'); const b = el.getBoundingClientRect(); const s = smoke.size(paneId); return { el, clientX: b.left + (x - 0.5) * (b.width / s.cols), clientY: b.top + (y - 0.5) * (b.height / s.rows) } },
  hover: (paneId, x, y) => { const p = smoke.at(paneId, x, y); p.el.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: p.clientX, clientY: p.clientY })) },
  click: (paneId, x, y, ctrl) => {
    const p = smoke.at(paneId, x, y);
    const o = { bubbles: true, cancelable: true, clientX: p.clientX, clientY: p.clientY, button: 0, buttons: 1, ctrlKey: !!ctrl };
    p.el.dispatchEvent(new MouseEvent('mousedown', o));
    p.el.dispatchEvent(new MouseEvent('mouseup', { ...o, buttons: 0 }));
  },
  pointer: (paneId) => q('[data-pane-cell=' + paneId + '] .xterm-screen').classList.contains('xterm-cursor-pointer'),
  drawer: () => useSidePanels.getState().open.w1 ?? null,
  closeDrawer: () => closeSidePanel({ refocus: false }),
  treeKey: () => q('[data-files-tree-key]')?.getAttribute('data-files-tree-key') ?? null,
  back: () => q('[data-files-back]')?.click(),
  status: () => q('[data-files-status]')?.textContent ?? '',
  editorFocused: () => !!document.activeElement?.classList.contains('cm-content'),
  tab: (key, rel) => { const t = useFilesStore.getState().byWs[key]?.tabs.find((x) => x.rel === rel); return t ? { rel: t.rel, reveal: t.reveal ?? null } : null },
  // The hot-exit stash a previous run left (filesStore's localStorage key), and a tab's buffer.
  stashText: Array.from({ length: 12 }, (_, i) => 'edited ' + (i + 1)).join('\n') + '\n',
  stash: (list) => localStorage.setItem('snagentsos.files.unsaved', JSON.stringify(list)),
  stashed: () => JSON.parse(localStorage.getItem('snagentsos.files.unsaved') || '[]'),
  buffer: (key, rel) => { const t = useFilesStore.getState().byWs[key]?.tabs.find((x) => x.rel === rel); return t ? { text: t.text, restored: !!t.restored, dirty: t.text !== t.saved } : null },
  edit: (key, rel, text) => setTabText(key, rel, text),
  active: (key) => useFilesStore.getState().byWs[key]?.active ?? null,
  spans: (t) => pathSpans(t).map((s) => [s.start, s.end, s.ref, (s.parts || []).map((p) => p.ref)]),
  refsAsked: () => calls.resolve.flatMap((r) => r.refs),
};
`

buildSync({ stdin: { contents: harness, resolveDir: root, loader: 'tsx' }, bundle: true, platform: 'browser', format: 'iife', outfile: path.join(dir, 'renderer.js'), alias: { '@shared': path.join(root, 'src/shared'), '@': path.join(root, 'src/renderer') }, jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' }, loader: { '.ttf': 'empty', '.woff': 'empty', '.woff2': 'empty' } })
fs.writeFileSync(path.join(dir, 'index.html'), `<html><head><meta charset="utf-8"><link rel="stylesheet" href="${pathToFileURL(path.join(assets, css))}"><link rel="stylesheet" href="renderer.css"></head><body><div id="root"></div><script src="renderer.js"></script></body></html>`)

const main = String.raw`
const {app,BrowserWindow}=require('electron');const fs=require('fs'),path=require('path');
app.setPath('userData',path.join(__dirname,'profile'));
app.whenReady().then(async()=>{
 const w=new BrowserWindow({width:1280,height:760,show:false,webPreferences:{sandbox:true,backgroundThrottling:false}});
 const failures=[];w.webContents.on('console-message',(_e,level,message)=>{if(level>=3)failures.push(message)});
 const js=(s)=>w.webContents.executeJavaScript(s);const wait=(ms)=>new Promise((r)=>setTimeout(r,ms));
 // A hidden window runs its frames (CodeMirror's reveal waits for one) only when painted.
 const paint=async()=>{await w.webContents.capturePage();await wait(40)};
 const shot=async(name)=>{await paint();fs.writeFileSync(path.join(__dirname,name+'.png'),(await w.webContents.capturePage()).toPNG())};
 let n=0;const ok=(c,label)=>{if(!c)throw new Error(label);n++};
 const eq=(a,b,label)=>{if(JSON.stringify(a)!==JSON.stringify(b))throw new Error(label+': got '+JSON.stringify(a)+' expected '+JSON.stringify(b));n++};
 const until=async(expr,label,ms=4000)=>{for(let t=0;t<ms;t+=50){if(await js(expr))return;await paint()}throw new Error('timeout: '+label+' ('+JSON.stringify(await js(expr))+')')};
 await w.loadFile(path.join(__dirname,'index.html'));
 w.webContents.focus();
 await until('smoke.ready()','both consoles spawned');
 await wait(300);
 const {cols}=await js("smoke.size('pa')");
 ok(cols>40,'the console has a usable width '+cols);

 // What the finder proposes: wholes, the words of a spaced one, never the URL.
 eq(await js("smoke.spans('gone src/missing.ts:4 see https://example.com/docs/a.ts ok')"),[[5,21,'src/missing.ts:4',[]]],'a path beside a URL, the URL left to the web links addon');
 eq(await js("smoke.spans('Edited src/a.ts and src/b.ts')"),[[7,28,'src/a.ts and src/b.ts',['src/a.ts','src/b.ts']]],'a spaced path also offers its words');
 eq(await js("smoke.spans('v1.5 and 2.0 only')"),[],'bare versions are no paths');

 await js("smoke.write('pa',['Error in src/a.ts:12:3 here','gone src/missing.ts:4 see https://example.com/docs/a.ts ok','日本 src/a.ts:12:3','x'.repeat("+cols+"-6)+' src/deep/file.ts:7','','Edited src/a.ts and src/b.ts'])");
 await wait(200);await paint();

 // Row 1: an existing ref, underlined once main answered.
 await js("smoke.hover('pa',2,1)");await wait(150);
 ok(!(await js("smoke.pointer('pa')")),'no link over plain words');
 await js("smoke.hover('pa',12,1)");
 await until("smoke.pointer('pa')",'an existing src/a.ts:12:3 is a link');
 eq(await js("smoke.calls.resolve.at(-1)"),{paneId:'pa',refs:['src/a.ts:12:3']},'the hovered line is resolved for its console');
 await js("smoke.hover('pa',22,1)");await wait(80);
 ok(await js("smoke.pointer('pa')"),'the link ends on the last digit of the column');
 await js("smoke.hover('pa',23,1)");await wait(80);
 ok(!(await js("smoke.pointer('pa')")),'and not one cell past it');
 // A line is asked once while its answer is fresh (another line in between).
 await js("smoke.hover('pa',8,2)");await wait(250);
 const count=await js("smoke.calls.resolve.length");
 await js("smoke.hover('pa',12,1)");await wait(150);
 ok(await js("smoke.pointer('pa')"),'row 1 is a link again');
 eq(await js("smoke.calls.resolve.length"),count,'from the cache, without asking main again');
 const asked=await js("smoke.calls.resolve.length");
 // A plain click selects text, nothing opens.
 await js("smoke.click('pa',12,1,false)");await wait(250);
 ok((await js("smoke.drawer()"))===null&&(await js("smoke.calls.read.length"))===0&&(await js("smoke.calls.resolve.length"))===asked,'a plain click opens nothing');
 // Ctrl+click: main is asked again, the drawer opens the file at 12:3.
 await js("smoke.click('pa',12,1,true)");
 await until("smoke.drawer()==='files'",'Ctrl+click opens the Files drawer');
 eq(await js("smoke.calls.resolve.at(-1)"),{paneId:'pa',refs:['src/a.ts:12:3']},'the click asks main for that ref again');
 await until("smoke.calls.read.length===1",'the file is read');
 eq(await js("smoke.calls.read[0]"),{workspaceId:'w1',rel:'src/a.ts'},'a plain console opens in the workspace tree, by rel');
 await until("smoke.treeKey()==='w1'",'the drawer shows the workspace tree');
 await until("smoke.status().includes('Lín 12, Col 3')",'the cursor lands on line 12, column 3');
 await until("smoke.editorFocused()",'the editor takes the keyboard');
 ok((await js("smoke.tab('w1','src/a.ts').reveal"))===null,'the reveal is consumed once applied');
 await shot('ctrl-click');

 // Row 2: a ref main does not know is no link, and the URL beside it still opens.
 await js("smoke.hover('pa',8,2)");await wait(250);
 ok(!(await js("smoke.pointer('pa')")),'a ref that does not exist is not underlined');
 const refs=await js("smoke.refsAsked()");
 ok(refs.includes('src/missing.ts:4')&&!refs.some((r)=>r.includes('example.com')),'the URL is never sent as a file ref '+JSON.stringify(refs));
 const before=await js("({r:smoke.calls.resolve.length,f:smoke.calls.read.length})");
 await js("smoke.click('pa',8,2,true)");await wait(250);
 eq(await js("({r:smoke.calls.resolve.length,f:smoke.calls.read.length})"),before,'a Ctrl+click on it does nothing');
 await js("smoke.hover('pa',32,2)");
 await until("smoke.pointer('pa')",'the URL is a link (web links addon)');
 await js("smoke.click('pa',32,2,false)");await wait(150);
 eq(await js("smoke.calls.external"),['https://example.com/docs/a.ts'],'a click on the URL opens it outside, as before');

 // Row 3: wide characters take two cells each.
 await js("smoke.hover('pa',3,3)");await wait(200);
 ok(!(await js("smoke.pointer('pa')")),'no link over the wide characters');
 await js("smoke.hover('pa',6,3)");
 await until("smoke.pointer('pa')",'after two wide characters the path starts at cell 6');
 await js("smoke.hover('pa',18,3)");await wait(80);
 ok(await js("smoke.pointer('pa')"),'and ends at cell 18');
 await js("smoke.hover('pa',19,3)");await wait(80);
 ok(!(await js("smoke.pointer('pa')")),'not past it');

 // Rows 4 and 5: a path the terminal wrapped is one link on both rows.
 await js("smoke.hover('pa',"+cols+"-3,4)");
 await until("smoke.pointer('pa')",'the start of a wrapped path is a link');
 await js("smoke.hover('pa',3,5)");
 await until("smoke.pointer('pa')",'its wrapped end too');
 await js("smoke.click('pa',3,5,true)");
 await until("smoke.status().includes('Lín 7, Col 1')",'Ctrl+click on the wrapped part opens src/deep/file.ts at line 7');
 eq(await js("smoke.calls.resolve.at(-1)"),{paneId:'pa',refs:['src/deep/file.ts:7']},'the whole wrapped ref is asked');
 eq(await js("smoke.active('w1')"),'src/deep/file.ts','its tab is the active one');

 // Row 7: of "src/a.ts and src/b.ts" only the word that exists is underlined.
 await js("smoke.hover('pa',10,7)");
 await until("smoke.pointer('pa')",'src/a.ts inside a spaced run is a link');
 await js("smoke.hover('pa',17,7)");await wait(80);
 ok(!(await js("smoke.pointer('pa')")),'the word between is not');
 await js("smoke.hover('pa',23,7)");await wait(80);
 ok(!(await js("smoke.pointer('pa')")),'src/b.ts (not in the tree) is not');

 // A path after three wrapped rows is a link; after a blob past 4096 characters it is left plain, never asked.
 const sz=await js("smoke.size('pa')");
 await js("smoke.write('pa',['x'.repeat("+(3*sz.cols-1)+")+' src/deep/file.ts:9'])");await wait(200);await paint();
 await js("smoke.hover('pa',3,4)");
 await until("smoke.pointer('pa')",'the end of a short wrapped line is a link');
 await js("smoke.write('pa',['x'.repeat("+(Math.ceil(5000/sz.cols)*sz.cols-1)+")+' src/deep/file.ts:8'])");await wait(200);await paint();
 await js("smoke.hover('pa',3,"+sz.rows+")");await wait(250);
 ok(!(await js("smoke.pointer('pa')"))&&!(await js("smoke.refsAsked()")).includes('src/deep/file.ts:8'),'the end of a 5000-character line is no link and main is not asked');

 // A worktree console: its refs resolve in its own tree, opened as wsId#paneId.
 await js("smoke.closeDrawer()");await wait(150);
 // Its tree was never shown this run, and the last run left unsaved edits of src/wt.ts in the hot-exit stash.
 const otherStash={wsId:'w9',rel:'x.ts',text:'other tree',eol:'lf',bom:false};
 await js("smoke.stash([{wsId:'w1#pw',rel:'src/wt.ts',text:smoke.stashText,eol:'lf',bom:false},"+JSON.stringify(otherStash)+"])");
 await js("smoke.write('pw',['see src/wt.ts:5:2 now','and src/wt2.ts:3'])");await wait(200);await paint();
 await js("smoke.hover('pw',6,1)");
 await until("smoke.pointer('pw')",'the worktree console underlines its own file');
 eq(await js("smoke.calls.resolve.at(-1)"),{paneId:'pw',refs:['src/wt.ts:5:2']},'asked for the worktree console');
 await js("smoke.click('pw',6,1,true)");
 await until("smoke.drawer()==='files'&&smoke.treeKey()==='w1#pw'",'the drawer switches to the worktree tree');
 await until("smoke.status().includes('Lín 5, Col 2')",'at line 5, column 2');
 eq(await js("smoke.buffer('w1#pw','src/wt.ts')"),{text:await js('smoke.stashText'),restored:true,dirty:true},'a Ctrl+click on a stashed file opens the unsaved edits, never the disk text');
 await until("!!document.querySelector('[data-file-restored]')",'with the Restored banner, as when the drawer opens the tree');
 ok(!(await js("smoke.calls.read.some((r)=>r.rel==='src/wt.ts')")),'the stashed file is not read over its edits');
 eq(await js("smoke.stashed()"),[otherStash],'its stash entry was applied (another tree keeps its own)');
 ok((await js("JSON.stringify(smoke.calls.root)")).includes('["w1","pw"]'),'the drawer roots the tree at the pane');
 await shot('worktree-tree');
 // Another file of that tree comes from disk, through the pane.
 await js("smoke.hover('pw',6,2)");
 await until("smoke.pointer('pw')",'its second file is a link too');
 await js("smoke.click('pw',6,2,true)");
 await until("smoke.status().includes('Lín 3, Col 1')",'at line 3');
 eq(await js("smoke.calls.read.at(-1)"),{workspaceId:'w1',paneId:'pw',rel:'src/wt2.ts'},'read through the pane, by rel');
 // The workspace tree, mounted again with tabs already open: a clean tab takes its stash, an edited one keeps its buffer.
 await js("smoke.edit('w1','src/deep/file.ts','edited in this run\\n')");
 await js("smoke.stash([{wsId:'w1',rel:'src/a.ts',text:smoke.stashText,eol:'lf',bom:false},{wsId:'w1',rel:'src/deep/file.ts',text:'older stash\\n',eol:'lf',bom:false}])");
 await js("smoke.back()");
 await until("smoke.treeKey()==='w1'",'Back to the workspace folder shows the workspace tree again');
 ok((await js("smoke.active('w1')"))==='src/deep/file.ts','with its tabs as they were');
 await until("smoke.buffer('w1','src/a.ts')?.restored===true",'the open clean tab takes the stashed edits');
 eq(await js("smoke.buffer('w1','src/a.ts').text"),await js('smoke.stashText'),'with the stashed text');
 eq(await js("smoke.buffer('w1','src/deep/file.ts')"),{text:'edited in this run\n',restored:false,dirty:true},'a tab edited in this run keeps its newer buffer');
 eq(await js("smoke.stashed()"),[],'and the stash is consumed');

 if(failures.length)throw new Error(failures.join('\n'));
 console.log('PASS: '+n+' terminal link checks (finder spans, existing ref underlined and others not, plain click inert, Ctrl+click opens at line:col, wide characters, wrapped path, spaced words, per-line cache, URL via web links, worktree tree wsId#paneId, hot-exit stash kept); screenshots '+__dirname);w.destroy();app.quit();
}).catch(e=>{console.error(e);app.exit(1)});
`
fs.writeFileSync(path.join(dir, 'main.cjs'), main)
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
const res = spawnSync(require('electron'), [path.join(dir, 'main.cjs')], { env, windowsHide: true, encoding: 'utf8', timeout: 90000 })
process.stdout.write(res.stdout ?? ''); if (res.status !== 0) process.stderr.write(res.stderr ?? '')
process.exitCode = res.status ?? 1
