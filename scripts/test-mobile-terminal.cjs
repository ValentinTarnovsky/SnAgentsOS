// Mobile terminal engine (E6-FR-05/14/15/33) against real xterm + Canvas +
// Unicode11 in an isolated Electron window: emoji widths match the desktop
// table, and a replay built by the real PtyManager for a pane whose mouse
// capture scrolled out of the ring still routes the phone's swipe to the TUI.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path')
const { pathToFileURL } = require('node:url')
const { spawnSync } = require('node:child_process')
const { buildSync } = require('esbuild')
const vm = require('node:vm')
const root = path.resolve(__dirname, '..')
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snagentsos-mterm-'))
const assets = path.join(root, 'out/mobile/assets')
const mobileCss = fs.existsSync(assets) && fs.readdirSync(assets).find(name => /^index-.*\.css$/.test(name))
if (!mobileCss) throw new Error('Run npm run build:mobile first')

// Build the replay in node with the production PtyManager and a fake node-pty:
// mouse capture + bracketed paste first, then far more than the 256 KB ring, a
// DA1 query (must not be answered by the phone) and a prompt.
function buildReplays() {
  const code = buildSync({ entryPoints: [path.join(root, 'src/main/pty/PtyManager.ts')], bundle: true, platform: 'node', format: 'cjs', write: false, external: ['electron', 'node-pty'], alias: { '@shared': path.join(root, 'src/shared') } }).outputFiles[0].text
  let emit = null
  const fakePty = { spawn: (_s, _a, o) => ({ cols: o.cols, rows: o.rows, onData: cb => { emit = cb }, onExit() {}, write() {}, resize() {}, kill() {}, pause() {}, resume() {} }) }
  const mod = { exports: {} }
  vm.runInNewContext(code, { module: mod, exports: mod.exports, console: { ...console, warn() {} }, process, Buffer, setTimeout, clearTimeout, require: id => id === 'node-pty' ? fakePty : id === 'electron' ? { app: { getPath: () => os.tmpdir() } } : require(id) })
  const pm = new mod.exports.PtyManager(() => null)
  pm.spawn({ paneId: 'p', cols: 40, rows: 12 })
  emit('\x1b[?1049h\x1b[?1000h\x1b[?1006h\x1b[?2004h\x1b[c')
  const line = '\x1b[38;2;120;200;80m' + 'claude output '.repeat(4) + '\x1b[0m\r\n'
  let ring = ''
  for (let i = 0; i < 5000; i++) { emit(line); ring += line }
  emit('\x1b[H> prompt\x1b[6n')
  const replay = pm.getReplay('p').replay
  pm.killAll()
  return { replay, rawTail: ring.slice(-200 * 1024) + '\x1b[H> prompt' }
}
const { replay, rawTail } = buildReplays()

buildSync({ stdin: { resolveDir: root, loader: 'ts', contents: `
import { Terminal } from '@xterm/xterm';
import { CanvasAddon } from '@xterm/addon-canvas';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { attachTouchScroll } from './src/mobile/src/lib/touchScroll';
const REPLAY = ${JSON.stringify(replay)};
const RAW_TAIL = ${JSON.stringify(rawTail)};
window.result = (async () => {
 let checks=0; const check=(ok,label)=>{if(!ok)throw new Error(label);checks++};
 const frames = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
 const container = document.getElementById('terminal');
 // Mirrors RemoteTerminal: Canvas loaded before open, Unicode11 after open.
 const make = () => {
   const term = new Terminal({cols:40,rows:12,fontSize:14,scrollback:500,allowProposedApi:true});
   term.loadAddon(new CanvasAddon());term.open(container);term.loadAddon(new Unicode11Addon());
   return term;
 };
 let term = make();
 const write = data => new Promise(r => term.write(data, r));
 check(term.unicode.versions.includes('11'), 'Unicode11 addon registers version 11');
 term.unicode.activeVersion = '11';
 await write('\\u{1F600}x');
 check(term.buffer.active.cursorX === 3, 'emoji takes 2 cells with Unicode 11 (x lands on column 2)');
 const cell = term.buffer.active.getLine(0).getCell(0);
 check(cell.getWidth() === 2, 'the emoji cell reports width 2');
 term.reset(); term.unicode.activeVersion = '6';
 await write('\\u{1F600}x');
 check(term.buffer.active.cursorX === 2, 'without the desktop field (v6) the emoji is 1 cell: the field matters');
 term.reset(); term.unicode.activeVersion = '11';
 await write('\\u2733 Claude \\u2502 \\u{1F916}|');
 // 'U+2733 Claude ' = 9 cells, box border + space = 2, robot emoji = 2, then '|'.
 const v11Cursor = term.buffer.active.cursorX;
 check(v11Cursor === 14, 'Claude title glyph, box border and robot emoji measure like the desktop table');
 term.dispose();

 // Replay with mouse capture that scrolled out of the ring (E6-FR-05/33).
 term = make(); term.unicode.activeVersion = '11';
 const data=[]; term.onData(s=>data.push(s));
 await write(REPLAY); await frames();
 check(data.length===0, 'writing the replay makes the phone answer nothing (queries stripped)');
 check(term.modes.mouseTrackingMode==='vt200' && term.modes.bracketedPasteMode, 'mouse capture and bracketed paste are active after the replay');
 check(term.buffer.active.type==='alternate', 'the alternate screen is restored');
 check(!/^;|^\\d+;\\d+;\\d+m/.test(term.buffer.active.getLine(0).translateToString(true)), 'no escape fragment printed as text at the top');
 const screen=container.querySelector('.xterm-screen');
 const touch=(type,x,y)=>{
   const r=screen.getBoundingClientRect();
   const p=new Touch({identifier:0,target:screen,clientX:r.left+x,clientY:r.top+y,pageX:r.left+x,pageY:r.top+y});
   screen.dispatchEvent(new TouchEvent(type,{bubbles:true,cancelable:true,touches:type==='touchend'?[]:[p],changedTouches:[p]}));
 };
 const detach=attachTouchScroll(term,container);
 touch('touchstart',60,40);touch('touchmove',60,160);touch('touchend',60,160);
 check(data.length>0 && data.every(s=>/^\\x1b\\[<64;/.test(s)), 'the first swipe reaches the TUI as SGR wheel reports, nothing sent before');
 detach(); term.dispose();

 // The same pane replayed from the raw ring alone (pre-fix behavior).
 term = make();
 const raw=[]; term.onData(s=>raw.push(s));
 await write(RAW_TAIL); await frames();
 check(term.modes.mouseTrackingMode==='none', 'reproduced original failure: the raw ring loses mouse capture');
 term.dispose();
 return checks;
})();
` }, bundle: true, platform: 'browser', format: 'iife', outfile: path.join(dir, 'renderer.js') })
const css = pathToFileURL(path.join(root, 'node_modules/@xterm/xterm/css/xterm.css'))
fs.writeFileSync(path.join(dir, 'index.html'), `<html><head><meta charset="utf-8"><link rel="stylesheet" href="${css}"><link rel="stylesheet" href="${pathToFileURL(path.join(assets, mobileCss))}"></head><body><div id="terminal" style="width:400px;height:280px"></div><script src="renderer.js"></script></body></html>`)
fs.writeFileSync(path.join(dir, 'main.cjs'), `
const {app,BrowserWindow}=require('electron');const path=require('path');
app.setPath('userData',path.join(__dirname,'profile'));
app.whenReady().then(async()=>{
 const w=new BrowserWindow({show:false,width:430,height:800,webPreferences:{sandbox:true,backgroundThrottling:false}});
 await w.loadFile(path.join(__dirname,'index.html'));
 const checks=await w.webContents.executeJavaScript('window.result');
 console.log('PASS: '+checks+' real-xterm mobile terminal engine checks');w.destroy();app.quit();
}).catch(e=>{console.error(e);app.exit(1)});
`)
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
// Hosted Linux CI cannot use Electron's unpacked SUID helper. This flag applies
// only to the isolated, trusted fixture; the shipped application is unchanged.
const flags = process.platform === 'linux' && process.env.CI ? ['--no-sandbox'] : []
const result = spawnSync(require('electron'), [...flags, path.join(dir, 'main.cjs')], { env, windowsHide: true, encoding: 'utf8', timeout: 30000 })
process.stdout.write(result.stdout ?? '')
if (result.status !== 0) process.stderr.write(result.stderr ?? result.error?.message ?? '')
fs.rmSync(dir, { recursive: true, force: true })
process.exitCode = result.status ?? 1
