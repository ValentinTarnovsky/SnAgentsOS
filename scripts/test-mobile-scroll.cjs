// Exercise production touch handling against real xterm in an isolated browser:
// the original swipe/wheel checks plus R22-16 (E2-FR-26..34): momentum and its
// stop, the 8-per-frame wheel cap, long-press, tap, pinch, selection mode, and
// the execCommand copy running inside the tap's own handler.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path')
const { pathToFileURL } = require('node:url')
const { spawnSync } = require('node:child_process')
const root = path.resolve(__dirname, '..')
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snagentsos-touch-'))
const assets = path.join(root, 'out/mobile/assets')
const mobileCss = fs.readdirSync(assets).find(name => /^index-.*\.css$/.test(name))
if (!mobileCss) throw new Error('Run npm run build:mobile first')
require('esbuild').buildSync({ stdin: { resolveDir: root, loader: 'ts', contents: `
import { Terminal } from '@xterm/xterm';
import { CanvasAddon } from '@xterm/addon-canvas';
import { attachTouchScroll, MAX_WHEEL_PER_FRAME } from './src/mobile/src/lib/touchScroll';
import { copyText } from './src/mobile/src/lib/clipboard';
window.result = (async () => {
 const container = document.getElementById('terminal');
 const term = new Terminal({cols:40,rows:12,fontSize:14,scrollback:500,allowProposedApi:true});
 term.loadAddon(new CanvasAddon());term.open(container);
 const frames = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
 const write = data => new Promise(r => term.write(data, r));
 let checks=0; const check=(ok,label)=>{if(!ok)throw new Error(label);checks++};
 const data=[];term.onData(s=>data.push(s));
 const screen=container.querySelector('.xterm-screen');
 const touch=(type,x,y,count=1,spread=10)=>{
   const r=screen.getBoundingClientRect();
   const points=Array.from({length:count},(_,i)=>new Touch({identifier:i,target:screen,clientX:r.left+x+i*spread,clientY:r.top+y,pageX:r.left+x+i*spread,pageY:r.top+y}));
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
 // --- R22-16: momentum (E2-FR-31), long-press and tap (E2-FR-26/28), pinch (E2-FR-34), copy (E2-FR-27) ---
 const sleep = ms => new Promise(r => setTimeout(r, ms));
 const raf = () => new Promise(r => requestAnimationFrame(r));
 await write('\\x1b[?1000l\\x1b[?1006l\\x1b[?1049l');
 await write(Array.from({length:300},(_,i)=>'More '+i+'\\r\\n').join(''));term.scrollToBottom();await frames();
 check(term.modes.mouseTrackingMode==='none','fixture is back in the normal buffer');
 const calls={long:[],tap:[],pinch:[],pinchEnd:[]};let tapAnswer=false,selecting=false;
 detach=attachTouchScroll(term,container,{onLongPress:(x,y)=>calls.long.push([x,y]),onTap:(x,y)=>{calls.tap.push([x,y]);return tapAnswer},isSelecting:()=>selecting,onPinch:r=>calls.pinch.push(r),onPinchEnd:r=>calls.pinchEnd.push(r)});
 const swipe=(a,b,steps=4)=>{touch('touchstart',60,a);for(let i=1;i<=steps;i++)touch('touchmove',60,a+(b-a)*i/steps);return touch('touchend',60,b)};
 const y0=term.buffer.active.viewportY;
 swipe(40,200);const atRelease=term.buffer.active.viewportY;
 check(atRelease<y0,'the swipe scrolls the normal buffer by itself');
 await frames();await frames();
 check(term.buffer.active.viewportY<atRelease,'momentum keeps scrolling after the finger lifts');
 let last=-1,stable=0;for(let i=0;i<400&&stable<15;i++){await raf();const v=term.buffer.active.viewportY;stable=v===last?stable+1:0;last=v}
 check(stable>=15,'momentum decays and stops on its own');
 check(data.length===0,'normal-buffer momentum sends no input to the pty');
 term.scrollToBottom();await frames();
 swipe(40,200);await frames();touch('touchstart',60,100);const held=term.buffer.active.viewportY;await frames();await frames();
 check(term.buffer.active.viewportY===held,'a new touch stops the inertia');
 touch('touchend',60,100);
 term.scrollToBottom();await frames();
 touch('touchstart',60,40);touch('touchmove',60,120);touch('touchmove',60,200);await sleep(150);const rest=term.buffer.active.viewportY;touch('touchend',60,200);await frames();await frames();
 check(term.buffer.active.viewportY===rest,'a finger that rested before lifting throws no momentum');
 calls.tap.length=0;
 touch('touchstart',80,60);await sleep(560);
 check(calls.long.length===1,'a 500 ms hold fires the long-press');
 const lift=touch('touchend',80,60);
 check(lift.defaultPrevented&&calls.tap.length===0,'the lift after a long-press is cancelled (no click, no keyboard) and is no tap');
 touch('touchstart',80,60);touch('touchmove',80,75);await sleep(560);touch('touchend',80,75);
 check(calls.long.length===1,'moving more than 10 px cancels the long-press');
 touch('touchstart',80,60);await sleep(150);touch('touchend',80,60);
 check(calls.long.length===1&&calls.tap.length===1,'a short press is a tap, not a long-press');
 calls.tap.length=0;tapAnswer=false;
 touch('touchstart',80,60);let up=touch('touchend',80,60);
 check(calls.tap.length===1&&!up.defaultPrevented,'a tap on plain text keeps its click (keyboard focus)');
 tapAnswer=true;touch('touchstart',80,60);up=touch('touchend',80,60);
 check(calls.tap.length===2&&up.defaultPrevented,'a handled tap (a link) cancels the click, so no keyboard opens');
 touch('touchstart',80,60);touch('touchmove',80,90);touch('touchend',80,90);
 check(calls.tap.length===2,'a 30 px drag is not a tap');
 tapAnswer=false;data.length=0;
 touch('touchstart',60,60,2,40);touch('touchmove',60,60,2,80);
 check(calls.pinch.length===1&&Math.abs(calls.pinch[0]-2)<0.01,'two spreading fingers report the live ratio');
 touch('touchend',60,60);
 check(calls.pinchEnd.length===1&&Math.abs(calls.pinchEnd[0]-2)<0.01&&data.length===0,'the pinch ends with its final ratio and sends nothing');
 selecting=true;await frames();const vy=term.buffer.active.viewportY;swipe(40,200);await frames();
 check(term.buffer.active.viewportY===vy,'selection mode switches the touch scroll off');
 selecting=false;detach();
 await write('\\x1b[?1049h\\x1b[?1000h\\x1b[?1006h');await frames();
 detach=attachTouchScroll(term,container);data.length=0;
 touch('touchstart',60,40);touch('touchmove',60,10040);
 check(data.length===MAX_WHEEL_PER_FRAME,'one huge move sends exactly the 8-report cap');
 touch('touchend',60,10040);const atLift=data.length;
 const perFrame=[];let seen=atLift,counting=true;const count=()=>{perFrame.push(data.length-seen);seen=data.length;if(counting)requestAnimationFrame(count)};
 requestAnimationFrame(count);await sleep(400);counting=false;await frames();
 check(data.length>atLift,'momentum keeps sending wheel reports to a mouse-mode app after the lift');
 check(perFrame.length>3&&perFrame.every(n=>n<=MAX_WHEEL_PER_FRAME),'never more than 8 wheel reports per frame');
 check(data.every(s=>/^\\x1b\\[<64;/.test(s)),'the momentum keeps the swipe direction');
 detach();
 // E2-FR-27: the execCommand fallback runs inside the tap's own handler.
 const btn=document.createElement('button');document.body.appendChild(btn);
 const realExec=document.execCommand;let rec=null,execResult=true;
 document.execCommand=(cmd)=>{const ta=document.querySelector('textarea[data-copy-buffer]');rec={cmd,event:window.event&&window.event.type,readOnly:!!ta&&ta.readOnly,start:ta&&ta.selectionStart,end:ta&&ta.selectionEnd,value:ta&&ta.value,font:ta&&ta.style.fontSize};return execResult};
 Object.defineProperty(navigator,'clipboard',{value:undefined,configurable:true});
 let copied=null;btn.onclick=()=>{copied=copyText('hola mundo')};btn.click();
 check(rec&&rec.cmd==='copy'&&rec.event==='click','execCommand(copy) runs synchronously inside the click');
 check(rec.readOnly&&rec.start===0&&rec.end===10&&rec.value==='hola mundo'&&rec.font==='16px','readonly textarea, full range, 16px font (no iOS keyboard, no zoom)');
 check(copied===true&&!document.querySelector('textarea[data-copy-buffer]')&&!(document.activeElement instanceof HTMLTextAreaElement),'the buffer is blurred and removed right after');
 execResult=false;btn.click();
 check(copied===false,'a refused execCommand reports false (the caller opens the fallback sheet)');
 const written=[];rec=null;
 Object.defineProperty(navigator,'clipboard',{value:{writeText:t=>{written.push(t);return Promise.resolve()}},configurable:true});
 btn.click();
 check(window.isSecureContext?(written[0]==='hola mundo'&&rec===null&&copied===true):(rec&&rec.cmd==='copy'),'the Clipboard API is used where it exists');
 delete navigator.clipboard;document.execCommand=realExec;
 term.dispose();return checks;
})();
` }, bundle: true, platform: 'browser', format: 'iife', outfile: path.join(dir, 'renderer.js') })
const css = pathToFileURL(path.join(root, 'node_modules/@xterm/xterm/css/xterm.css'))
fs.writeFileSync(path.join(dir, 'index.html'), `<html><head><meta charset="utf-8"><link rel="stylesheet" href="${css}"><link rel="stylesheet" href="${pathToFileURL(path.join(assets, mobileCss))}"></head><body><div id="terminal" style="width:400px;height:280px"></div><script src="renderer.js"></script></body></html>`)
fs.writeFileSync(path.join(dir, 'main.cjs'), `
const {app,BrowserWindow}=require('electron');const path=require('path');
app.setPath('userData',path.join(__dirname,'profile'));
app.whenReady().then(async()=>{
 const w=new BrowserWindow({show:false,width:430,height:800,webPreferences:{sandbox:true,backgroundThrottling:false,offscreen:true}});
 await w.loadFile(path.join(__dirname,'index.html'));
 const checks=await w.webContents.executeJavaScript('window.result');
 console.log('PASS: '+checks+' real-xterm mobile touch scroll checks');w.destroy();app.quit();
}).catch(e=>{console.error(e);app.exit(1)});
`)
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
// Hosted Linux CI cannot use Electron's unpacked SUID helper. This flag applies
// only to the isolated, trusted fixture; the shipped application is unchanged.
const flags = process.platform === 'linux' && process.env.CI ? ['--no-sandbox'] : []
const result = spawnSync(require('electron'), [...flags, path.join(dir, 'main.cjs')], { env, windowsHide: true, encoding: 'utf8', timeout: 40000 })
process.stdout.write(result.stdout ?? '')
if (result.status !== 0) process.stderr.write(result.stderr ?? result.error?.message ?? '')
process.exitCode = result.status ?? 1
