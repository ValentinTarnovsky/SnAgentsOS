// "PC awake" UI (E5-FR-24/29): the production TitleBar (AwakeIndicator) and the
// Agents settings block in an isolated hidden Electron window. main is a fake:
// no power request, tray or user config is touched. Requires npm run build (CSS).
const fs = require('node:fs'), os = require('node:os'), path = require('node:path')
const { pathToFileURL } = require('node:url')
const { spawnSync } = require('node:child_process')
const { buildSync } = require('esbuild')
const root = path.resolve(__dirname, '..'), dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snagentsos-awake-'))
const assets = path.join(root, 'out/renderer/assets')
const css = fs.readdirSync(assets).find(f => /^index-.*\.css$/.test(f))
if (!css) throw new Error('Run npm run build first')
buildSync({ stdin: { contents: `
import React from 'react'; import {createRoot} from 'react-dom/client';
import {TitleBar} from './src/renderer/components/titlebar/TitleBar';
import {SettingsModal} from './src/renderer/components/settings/SettingsModal';
import {I18nProvider} from './src/renderer/i18n';
import {useAppStore} from './src/renderer/lib/store';
import {usePowerStore} from './src/renderer/lib/powerStore';
import {applyTheme} from './src/renderer/themes/applyTheme';
const noop=()=>()=>{};
const fallback=(base)=>new Proxy(base,{get:(t,k)=>k in t?t[k]:(typeof k==='string'?fallback(noop):undefined)});
window.snApi=fallback({platform:'win32',window:fallback({isMaximized:async()=>false,onMaximizeChange:noop}),
 power:fallback({getState:async()=>null,onState:noop,setConfig(){}}),agents:fallback({setConfig(){}})});
useAppStore.setState({hydrated:true,workspaces:[],activeWorkspaceId:null});
applyTheme('midnight');
function Root(){const lang=useAppStore(s=>s.settings.language);return <I18nProvider lang={lang}><div style={{height:'100vh'}} className="flex flex-col bg-bg-primary text-text-primary"><TitleBar/><main className="p-6">PC despierta</main><SettingsModal/></div></I18nProvider>}
createRoot(document.getElementById('root')).render(<Root/>);
window.smoke={
 power:s=>usePowerStore.setState({state:s}),
 set:p=>useAppStore.getState().updateSettings(p),
 settings:()=>useAppStore.getState().settings,
 store:()=>({open:useAppStore.getState().settingsOpen}),
 theme:applyTheme,
 hover:()=>document.querySelector('#awake-indicator').dispatchEvent(new MouseEvent('mouseover',{bubbles:true})),
 unhover:()=>document.querySelector('#awake-indicator').dispatchEvent(new MouseEvent('mouseout',{bubbles:true})),
 tip:()=>document.querySelector('[role=tooltip]')?.textContent??null,
 radios:()=>[...document.querySelectorAll('[role=menuitemradio]')].map(e=>[e.textContent,e.getAttribute('aria-checked')]),
 click:sel=>document.querySelector(sel).click(),
 clickText:(role,text)=>[...document.querySelectorAll('[role='+role+']')].find(e=>e.textContent.includes(text)).click(),
 search:q=>{const i=document.querySelector('input[placeholder]');const set=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;set.call(i,q);i.dispatchEvent(new Event('input',{bubbles:true}))},
 overflow:()=>document.documentElement.scrollWidth>innerWidth,
};
`, resolveDir: root, loader: 'tsx' }, bundle: true, platform: 'browser', format: 'iife', outfile: path.join(dir, 'renderer.js'), alias: { '@shared': path.join(root, 'src/shared'), '@': path.join(root, 'src/renderer') }, jsx: 'automatic', loader: { '.css': 'empty' }, define: { 'process.env.NODE_ENV': '"production"' } })
fs.writeFileSync(path.join(dir, 'index.html'), `<html><head><meta charset="utf-8"><link rel="stylesheet" href="${pathToFileURL(path.join(assets, css))}"></head><body><div id="root"></div><script src="renderer.js"></script></body></html>`)
fs.writeFileSync(path.join(dir, 'main.cjs'), `
const {app,BrowserWindow}=require('electron');const fs=require('fs'),path=require('path');
app.setPath('userData',path.join(__dirname,'profile'));
app.whenReady().then(async()=>{
 const w=new BrowserWindow({width:1200,height:760,show:false,webPreferences:{sandbox:true,backgroundThrottling:false}});
 let failures=[];w.webContents.on('console-message',(_e,level,message)=>{if(level>=3)failures.push(message)});
 const js=s=>w.webContents.executeJavaScript(s);const wait=ms=>new Promise(r=>setTimeout(r,ms));
 const frame=()=>js('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
 const shot=async name=>{await frame();await wait(150);fs.writeFileSync(path.join(__dirname,name+'.png'),(await w.webContents.capturePage()).toPNG())};
 let n=0;const eq=(a,b,label)=>{if(JSON.stringify(a)!==JSON.stringify(b))throw new Error(label+': got '+JSON.stringify(a)+' expected '+JSON.stringify(b));n++};
 const ok=(c,label)=>{if(!c)throw new Error(label);n++};
 await w.loadFile(path.join(__dirname,'index.html'));await wait(300);
 await js("smoke.set({language:'es'})");await frame();
 ok(!(await js("!!document.querySelector('#awake-indicator')")),'no icon before the first power:state');
 await js("smoke.power({blocking:false,reason:null,mode:'auto',display:false,workingCount:0})");await frame();
 ok(!(await js("!!document.querySelector('#awake-indicator')")),'no icon in Auto while nothing is held');
 await js("smoke.power({blocking:true,reason:'agents',mode:'auto',display:false,workingCount:2})");await frame();
 ok(await js("!!document.querySelector('#awake-indicator')"),'icon visible while held');
 await js('smoke.hover()');await wait(500);
 eq(await js('smoke.tip()'),'PC despierta \\u00b7 2 agentes trabajando (Auto)','working tooltip (es)');
 await shot('awake-tooltip-midnight');await js('smoke.unhover()');await wait(200);
 await js("smoke.power({blocking:true,reason:'agents',mode:'auto',display:false,workingCount:0,releaseAt:Date.now()+105000})");await frame();
 await js('smoke.hover()');await wait(500);
 ok(/^PC despierta \\u00b7 se libera en 1:4[0-5]$/.test(await js('smoke.tip()')),'grace tooltip counts down: '+await js('smoke.tip()'));
 await js('smoke.unhover()');await wait(200);
 await js("smoke.click('#awake-indicator')");await frame();
 eq(await js('smoke.radios()'),[['Auto','true'],['Siempre','false'],['Nunca','false']],'menu radios mark Auto');
 await shot('awake-menu-midnight');
 await js("smoke.clickText('menuitemradio','Siempre')");await frame();
 eq(await js('smoke.settings().awakeMode'),'always','picking Siempre updates settings.awakeMode');
 await js("smoke.power({blocking:true,reason:'always',mode:'always',display:false,workingCount:0})");await frame();
 await js('smoke.hover()');await wait(500);
 eq(await js('smoke.tip()'),'PC despierta (Siempre)','always tooltip');await js('smoke.unhover()');await wait(200);
 await js("smoke.click('#awake-indicator')");await frame();
 await js("smoke.clickText('menuitem','Ajustes de agentes')");await wait(300);
 ok((await js('smoke.store()')).open,'Agent settings opens the settings');
 eq(await js("[...document.querySelectorAll('[role=radiogroup] [role=radio]')].map(e=>[e.textContent,e.getAttribute('aria-checked')])"),[['Auto','false'],['Siempre','true'],['Nunca','false']],'settings radiogroup mirrors the mode');
 ok(await js("document.body.textContent.includes('Comportamiento')&&document.body.textContent.includes('Mantener tambi\\u00e9n la pantalla encendida')"),'Behavior block in Spanish');
 await js("[...document.querySelectorAll('[role=switch]')].find(e=>e.closest('section[aria-labelledby=agents-behavior]')).click()");await frame();
 eq(await js('smoke.settings().agents.awakeDisplay'),true,'the display toggle writes settings.agents.awakeDisplay');
 await js("document.querySelector('[data-awake-mode=never]').click()");await frame();
 eq(await js('smoke.settings().awakeMode'),'never','the settings radio writes awakeMode');
 ok(await js("[...document.querySelectorAll('section[aria-labelledby=agents-behavior] [role=switch]')].every(e=>e.disabled)"),'the display toggle is disabled in Never');
 await shot('awake-settings-midnight');
 for(const q of ['despierta','awake','pantalla','sleep']){await js('smoke.search('+JSON.stringify(q)+')');await frame();ok(await js("document.body.textContent.includes('Comportamiento')"),'search finds the block: '+q)}
 await js("smoke.search('zzqx')");await frame();ok(!(await js("document.body.textContent.includes('Comportamiento')")),'a search that matches nothing hides the block');
 await js("smoke.search('')");
 for(const scale of [1,1.25,1.5]){w.setSize(900,600);w.webContents.setZoomFactor(scale);await wait(200);ok(!(await js('smoke.overflow()')),'no overflow at '+scale);if(scale===1.5)await shot('awake-settings-150')}
 w.webContents.setZoomFactor(1);w.setSize(1200,760);
 await js("smoke.theme('light');smoke.set({language:'en',awakeMode:'auto'})");await frame();
 await js("smoke.power({blocking:true,reason:'agents',mode:'auto',display:true,workingCount:1})");await frame();
 ok(await js("document.body.textContent.includes('Behavior')&&document.body.textContent.includes('Also keep the display on')"),'Behavior block in English');
 await shot('awake-settings-light');
 await js("document.querySelector('[role=dialog] button[aria-label]')?.click();document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))");await wait(300);
 await js('smoke.hover()');await wait(500);
 eq(await js('smoke.tip()'),'PC awake \\u00b7 1 agent working (Auto)','working tooltip (en, singular)');
 await shot('awake-tooltip-light');
 if(failures.length)throw new Error(failures.join('\\n'));
 console.log('PASS: '+n+' awake UI checks (indicator, tooltips, menu, settings block, search, es/en, midnight/light, 100/125/150%); screenshots '+__dirname);w.destroy();app.quit();
}).catch(e=>{console.error(e);app.exit(1)});
`)
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
const res = spawnSync(require('electron'), [path.join(dir, 'main.cjs')], { env, windowsHide: true, encoding: 'utf8', timeout: 45000 })
process.stdout.write(res.stdout ?? ''); if (res.status !== 0) process.stderr.write(res.stderr ?? '')
process.exitCode = res.status ?? 1
