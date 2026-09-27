// Exercise production touch handling against real xterm in an isolated browser.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path')
const { pathToFileURL } = require('node:url')
const { spawnSync } = require('node:child_process')
const root = path.resolve(__dirname, '..')
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snmulticc-touch-'))
const assets = path.join(root, 'out/mobile/assets')
const mobileCss = fs.readdirSync(assets).find(name => /^index-.*\.css$/.test(name))
if (!mobileCss) throw new Error('Run npm run build:mobile first')
require('esbuild').buildSync({ stdin: { resolveDir: root, loader: 'ts', contents: `
import { Terminal } from '@xterm/xterm';
import { CanvasAddon } from '@xterm/addon-canvas';
import { attachTouchScroll } from './src/mobile/src/lib/touchScroll';
window.result = (async () => {
 const container = document.getElementById('terminal');
 const term = new Terminal({cols:40,rows:12,fontSize:14,scrollback:500,allowProposedApi:true});
 term.loadAddon(new CanvasAddon());term.open(container);
 const frames = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
 const write = data => new Promise(r => term.write(data, r));
 let checks=0; const check=(ok,label)=>{if(!ok)throw new Error(label);checks++};
 const data=[];term.onData(s=>data.push(s));
 const screen=container.querySelector('.xterm-screen');
 const touch=(type,x,y,count=1)=>{
   const r=screen.getBoundingClientRect();
   const points=Array.from({length:count},(_,i)=>new Touch({identifier:i,target:screen,clientX:r.left+x+i*10,clientY:r.top+y,pageX:r.left+x+i*10,pageY:r.top+y}));
   const event=new TouchEvent(type,{bubbles:true,cancelable:true,touches:type==='touchend'||type==='touchcancel'?[]:points,changedTouches:points});
   screen.dispatchEvent(event);return event;
 };
 await write(Array.from({length:80},(_,i)=>'History '+i+'\\r\\n').join(''));await frames();
 let detach=attachTouchScroll(term,container);
 const before=term.buffer.active.viewportY;
 touch('touchstart',60,40);touch('touchmove',60,160);touch('touchend',60,160);await frames();
 check(term.buffer.active.viewportY<before,'normal shell touch scrollback still works');
 check(data.length===0,'normal scrolling sends no keystrokes');
 await write('\\x1b[?1049h\\x1b[?1000h\\x1b[?1006h');await frames();
 check(term.modes.mouseTrackingMode==='vt200','fixture enables application mouse capture');
 check(getComputedStyle(term.element).touchAction.includes('pan-x')&&!getComputedStyle(term.element).touchAction.includes('pan-y'),'browser reserves vertical gestures while allowing horizontal pan');
 detach();data.length=0;
 touch('touchstart',60,40);touch('touchmove',60,160);touch('touchend',60,160);
 check(data.length===0,'reproduced original failure: xterm ignores captured touch scroll');
 detach=attachTouchScroll(term,container);
 touch('touchstart',60,40);touch('touchmove',60,160);touch('touchend',60,160);
 check(data.length>0&&data.every(s=>/^\\x1b\\[<64;/.test(s)),'drag down emits application wheel-up reports');
 data.length=0;
 touch('touchstart',60,160);touch('touchmove',60,40);touch('touchend',60,40);
 check(data.length>0&&data.every(s=>/^\\x1b\\[<65;/.test(s)),'drag up emits application wheel-down reports');
 data.length=0;
 const start=touch('touchstart',60,80);touch('touchmove',61,83);touch('touchend',61,83);
 check(!start.defaultPrevented&&data.length===0,'tap and finger jitter stay available for keyboard focus');
 touch('touchstart',40,80);const horizontal=touch('touchmove',140,85);touch('touchend',140,85);
 check(!horizontal.defaultPrevented&&data.length===0,'horizontal pan is not intercepted');
 touch('touchstart',60,40);touch('touchmove',60,100,2);touch('touchmove',60,160);touch('touchend',60,160);
 check(data.length===0,'multi-touch cancels the gesture');
 touch('touchstart',60,40);touch('touchcancel',60,40);touch('touchmove',60,160);
 check(data.length===0,'touch cancellation cannot leak a wheel report');
 touch('touchstart',60,40);touch('touchmove',60,10000);touch('touchend',60,10000);
 check(data.length<=30,'large movement has bounded input volume');
 data.length=0;detach();touch('touchstart',60,40);touch('touchmove',60,160);touch('touchend',60,160);
 check(data.length===0,'teardown removes gesture handlers');
 term.dispose();return checks;
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
 console.log('PASS: '+checks+' real-xterm mobile touch scroll checks');w.destroy();app.quit();
}).catch(e=>{console.error(e);app.exit(1)});
`)
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
// Hosted Linux CI cannot use Electron's unpacked SUID helper. This flag applies
// only to the isolated, trusted fixture; the shipped application is unchanged.
const flags = process.platform === 'linux' && process.env.CI ? ['--no-sandbox'] : []
const result = spawnSync(require('electron'), [...flags, path.join(dir, 'main.cjs')], { env, windowsHide: true, encoding: 'utf8', timeout: 20000 })
process.stdout.write(result.stdout ?? '')
if (result.status !== 0) process.stderr.write(result.stderr ?? result.error?.message ?? '')
process.exitCode = result.status ?? 1
