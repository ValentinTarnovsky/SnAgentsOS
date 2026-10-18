// Update card UI (E4-FR-12..17): the production TitleBar, NotificationStack,
// UpdateCardHost and ReleaseNotesModal in an isolated hidden Electron window.
// main is a fake: the update state is set on the store, the install never
// downloads anything and no config, pty or network is touched.
// Requires npm run build (CSS).
const fs = require('node:fs'), os = require('node:os'), path = require('node:path')
const { pathToFileURL } = require('node:url')
const { spawnSync } = require('node:child_process')
const { buildSync } = require('esbuild')
const root = path.resolve(__dirname, '..'), dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snagentsos-update-'))
const assets = path.join(root, 'out/renderer/assets')
const css = fs.readdirSync(assets).find(f => /^index-.*\.css$/.test(f))
if (!css) throw new Error('Run npm run build first')
buildSync({ stdin: { contents: `
import React from 'react'; import {createRoot} from 'react-dom/client';
import {TitleBar} from './src/renderer/components/titlebar/TitleBar';
import {NotificationStack} from './src/renderer/components/ui/NotificationStack';
import {UpdateCardHost} from './src/renderer/components/updates/UpdateCard';
import {ReleaseNotesModal} from './src/renderer/components/updates/ReleaseNotesModal';
import {I18nProvider} from './src/renderer/i18n';
import {useAppStore} from './src/renderer/lib/store';
import {useUpdaterStore} from './src/renderer/lib/updater';
import {applyTheme} from './src/renderer/themes/applyTheme';
const noop=()=>()=>{};
const fallback=(base)=>new Proxy(base,{get:(t,k)=>k in t?t[k]:(typeof k==='string'?fallback(noop):undefined)});
const calls={install:0,external:[],metrics:0};
window.snApi=fallback({platform:'win32',
 window:fallback({isMaximized:async()=>false,onMaximizeChange:()=>()=>{}}),
 system:fallback({getMetrics:async()=>{calls.metrics++;return {memMB:1,cpuPercent:0,consoles:7}},openExternal:async u=>{calls.external.push(u)}}),
 updates:fallback({downloadAndInstall:()=>{calls.install++;return new Promise(()=>{})}}),
});
const notes='## Novedades\\n\\n- **Tarjeta** de actualizacion en la pila\\n- Chip en el titlebar con el porcentaje\\n- Re-chequeo cada 6 h\\n- Cuarta linea que no entra en el extracto';
const missed=['2.3.0','2.2.0','2.1.0'].map(v=>({version:v,notes:'### '+v+'\\n- Cambio de la '+v,url:'https://github.com/x/releases/tag/v'+v,publishedAt:null}));
const offer={available:true,currentVersion:'2.0.0',latestVersion:'2.3.0',notes,releaseUrl:'https://github.com/x/releases/tag/v2.3.0',installable:true,installKind:'win-portable',newerCount:3,missed};
const panes=Array.from({length:7},(_,i)=>({id:'p'+i,type:'shell',title:'Consola '+i,icon:'terminal'}));
useAppStore.setState({hydrated:true,activeWorkspaceId:'w1',workspaces:[{id:'w1',name:'Proyecto',cwd:'',panes}],paneStatus:{p0:{state:'working',precise:true,provider:'claude',pendingCount:0},p1:{state:'action',precise:true,provider:'codex',pendingCount:1},p2:{state:'done',precise:true,provider:'claude',pendingCount:0}}});
applyTheme('midnight');
createRoot(document.getElementById('root')).render(<I18nProvider lang="es"><div style={{height:'100vh'}} className="flex flex-col bg-bg-primary text-text-primary"><TitleBar/><main className="p-6">Consola de prueba</main></div><NotificationStack/><UpdateCardHost/><ReleaseNotesModal/></I18nProvider>);
const q=s=>document.querySelector(s);
window.smoke={
 calls,
 offer:()=>useUpdaterStore.setState({info:offer,phase:'available',installing:false,progress:null,installError:null,cardCollapsed:false,userInitiated:false}),
 set:p=>useUpdaterStore.setState(p),
 store:()=>{const s=useUpdaterStore.getState();return {phase:s.phase,collapsed:s.cardCollapsed,notes:s.notesOpen}},
 dismissed:()=>useAppStore.getState().settings.updateDismissedVersion,
 setDismissed:v=>useAppStore.getState().updateSettings({updateDismissedVersion:v}),
 theme:applyTheme,
 card:()=>{const c=q('[data-update-card]');if(!c)return null;const r=c.closest('[data-toast-id]').getBoundingClientRect();return {phase:c.dataset.updatePhase,newer:q('[data-update-newer]')?.textContent??null,excerpt:q('[data-update-excerpt]')?.textContent??null,impact:q('[data-update-impact]')?.textContent??null,primary:q('[data-update-primary]')?.dataset.updatePrimary??null,label:q('[data-update-primary]')?.textContent??null,progress:q('[data-update-progress]')?.textContent??null,closeDisabled:q('[data-update-close]')?.disabled??null,text:c.textContent,box:{l:r.left,t:r.top,r:r.right,b:r.bottom}}},
 chip:()=>{const c=q('[data-update-chip]');if(!c)return null;const r=c.getBoundingClientRect();const brand=[...document.querySelectorAll('span')].find(s=>s.textContent==='SnAgentsOS').getBoundingClientRect();return {phase:c.dataset.updateChip,text:c.textContent,w:r.width,afterBrand:r.left>=brand.right,noDrag:getComputedStyle(c).webkitAppRegion||c.className.includes('app-no-drag'),cls:c.className}},
 click:s=>{const el=q(s);if(!el)throw new Error('missing '+s);el.click()},
 clickText:t=>{const el=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===t);if(!el)throw new Error('missing button '+t);el.click()},
 notes:()=>[...document.querySelectorAll('[data-release-version]')].map(e=>e.dataset.releaseVersion),
 overflow:()=>document.documentElement.scrollWidth>innerWidth,
 inViewport:()=>{const c=q('[data-update-card]')?.closest('[data-toast-id]');if(!c)return false;const r=c.getBoundingClientRect();return r.left>=0&&r.top>=0&&r.right<=innerWidth&&r.bottom<=innerHeight},
};
`, resolveDir: root, loader: 'tsx' }, bundle: true, platform: 'browser', format: 'iife', outfile: path.join(dir, 'renderer.js'), alias: { '@shared': path.join(root, 'src/shared'), '@': path.join(root, 'src/renderer') }, jsx: 'automatic', loader: { '.css': 'empty' }, define: { 'process.env.NODE_ENV': '"production"' } })
fs.writeFileSync(path.join(dir, 'index.html'), `<html><head><meta charset="utf-8"><link rel="stylesheet" href="${pathToFileURL(path.join(assets, css))}"></head><body><div id="root"></div><script src="renderer.js"></script></body></html>`)
fs.writeFileSync(path.join(dir, 'main.cjs'), `
const {app,BrowserWindow}=require('electron');const fs=require('fs'),path=require('path');
app.setPath('userData',path.join(__dirname,'profile'));
app.whenReady().then(async()=>{
 const w=new BrowserWindow({width:1100,height:720,useContentSize:true,show:false,webPreferences:{sandbox:true,backgroundThrottling:false}});
 let failures=[];w.webContents.on('console-message',(_e,level,message)=>{if(level>=3)failures.push(message)});
 const js=s=>w.webContents.executeJavaScript(s).catch(e=>{throw new Error('Renderer script failed: '+s+' | '+failures.join(' | '))});const wait=ms=>new Promise(r=>setTimeout(r,ms));
 const frame=()=>js('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
 const settle=async()=>{await frame();await wait(320)};
 const until=async(expr,ms=3000)=>{const end=Date.now()+ms;let v;do{v=await js(expr);if(v)return v;await wait(50)}while(Date.now()<end);return v};
 const shot=async name=>{await settle();fs.writeFileSync(path.join(__dirname,name+'.png'),(await w.webContents.capturePage()).toPNG())};
 let n=0;const eq=(a,b,label)=>{if(JSON.stringify(a)!==JSON.stringify(b))throw new Error(label+': got '+JSON.stringify(a)+' expected '+JSON.stringify(b));n++};
 const ok=(c,label)=>{if(!c)throw new Error(label);n++};
 await w.loadFile(path.join(__dirname,'index.html'));await wait(300);
 ok((await js('smoke.card()'))===null&&(await js('smoke.chip()'))===null,'idle: no card and no chip');

 // E4-FR-12/14/15: the offer, +3, a 3-line excerpt and the console impact.
 await js('smoke.offer()');await settle();
 await until("smoke.card()&&smoke.card().impact");
 let card=await js('smoke.card()');
 eq(card.phase,'available','the offer card is in the stack');
 ok(card.text.includes('SnAgentsOS 2.3.0 disponible')&&card.text.includes('2.0.0 → 2.3.0'),'title and versions '+card.text);
 eq(card.newer,'+3 versiones desde la tuya','+3 versions since yours');
 ok(card.excerpt.split('\\n').length===3&&card.excerpt.startsWith('Novedades')&&!card.excerpt.includes('Cuarta'),'3-line plain excerpt '+JSON.stringify(card.excerpt));
 eq(card.impact,'Se van a cerrar 7 consolas (2 con un agente trabajando o esperando)','impact notice with 7 consoles, 2 busy');
 ok(card.text.includes('Ver notas completas')&&card.text.includes('Desactivar búsqueda automática')&&card.text.includes('Más tarde'),'notes link, later and the auto-check link');
 ok(await js('smoke.inViewport()')&&!(await js('smoke.overflow()')),'card inside the viewport, no overflow');
 ok((await js('smoke.chip()'))===null,'no chip while offering');
 ok(!(await js("!!document.querySelector('[role=dialog]')")),'no modal at startup');
 await shot('update-card-available');

 // Full notes: one block per missed version, newest first.
 await js("smoke.clickText('Ver notas completas')");await settle();
 eq(await js('smoke.notes()'),['2.3.0','2.2.0','2.1.0'],'release notes list the 3 versions newest first');
 ok(await until('smoke.card()===null'),'the card steps aside while the notes are open (it would cover them)');
 await shot('update-notes');
 await js("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))");await settle();
 eq((await js('smoke.store()')).notes,false,'Esc closes the notes');
 ok(await until('smoke.card()&&smoke.card().impact'),'the card comes back after the notes');

 // Double confirm: the first click arms, the second installs.
 await js("smoke.click('[data-update-primary]')");await settle();
 card=await js('smoke.card()');
 eq([card.primary,card.label],['confirm','Cerrar 7 consolas y actualizar'],'first click arms the danger label');
 eq(await js('smoke.calls.install'),0,'the first click does not install');
 await shot('update-card-confirm');
 await js("smoke.click('[data-update-primary]')");await settle();
 eq(await js('smoke.calls.install'),1,'the second click installs');

 // E4-FR-16: download at 42%, X disabled, collapse to the chip.
 await js("smoke.set({phase:'downloading',installing:true,progress:{percent:42,transferred:42,total:100}})");await settle();
 card=await js('smoke.card()');
 ok(card.phase==='downloading'&&card.progress.includes('Descargando 42%')&&card.closeDisabled===true,'download shows 42% with the X disabled '+JSON.stringify(card));
 await js("smoke.click('[data-update-collapse]')");await settle();
 await until('smoke.card()===null');
 let chip=await js('smoke.chip()');
 ok(chip&&chip.phase==='downloading'&&chip.text==='42%','collapsed: the chip shows 42% '+JSON.stringify(chip));
 ok(chip.w<=120&&chip.afterBrand&&chip.cls.includes('app-no-drag'),'chip is no-drag, at most 120px, right of the wordmark '+JSON.stringify(chip));
 await shot('update-chip-42');
 await js("smoke.set({phase:'installing',progress:{percent:100,transferred:100,total:100}})");await settle();
 eq((await js('smoke.chip()')).text,'Instalando','100% switches the chip to installing');
 await js("smoke.click('[data-update-chip]')");await settle();
 card=await until('smoke.card()');
 ok(card&&card.phase==='installing'&&card.progress.includes('Instalando'),'a chip click reopens the card');
 ok((await js('smoke.chip()'))===null,'no chip while the card shows');

 // E4-FR-17: failure with retry, closing it leaves the amber chip.
 await js("smoke.set({phase:'failed',installing:false,installError:'HTTP 500'})");await settle();
 card=await js('smoke.card()');
 ok(card.phase==='failed'&&card.text.includes('La actualización falló: HTTP 500')&&card.text.includes('Reintentar'),'failed card with the error and retry '+card.text);
 await shot('update-card-failed');
 await js("smoke.click('[data-update-close]')");await settle();
 await until('smoke.card()===null');
 chip=await js('smoke.chip()');
 ok(chip&&chip.phase==='failed'&&chip.text==='Falló','closed failure: chip Fallo '+JSON.stringify(chip));
 await js("smoke.click('[data-update-chip]')");await settle();await until('smoke.card()');
 await js("smoke.click('[data-update-retry]')");await settle();
 eq(await js('smoke.calls.install'),2,'retry installs again');

 // E4-FR-13: X on the offer persists the dismissal; a higher version shows again.
 await js('smoke.offer()');await settle();await until('smoke.card()');
 await js("smoke.click('[data-update-close]')");await settle();
 await until('smoke.card()===null');
 eq(await js('smoke.dismissed()'),'2.3.0','X persists updateDismissedVersion');
 await js('smoke.offer()');await settle();
 ok((await js('smoke.card()'))===null,'the dismissed version stays hidden');
 await js("smoke.set({info:{available:true,currentVersion:'2.0.0',latestVersion:'2.4.0',notes:'',releaseUrl:null,installable:true,installKind:'mac-dmg',newerCount:1,missed:[]}})");await settle();
 card=await until('smoke.card()');
 ok(card&&card.text.includes('2.4.0')&&card.newer===null&&card.impact===null,'a higher version shows again (mac: no impact notice, no +N)');
 await js("smoke.click('[data-update-primary]')");await settle();
 eq(await js('smoke.calls.install'),3,'without a closing install kind one click installs');

 // Zoom 125/150% and the light theme.
 await js('smoke.setDismissed("")');await js('smoke.offer()');await settle();await until("smoke.card()&&smoke.card().impact");
 for(const zoom of [1.25,1.5]){w.webContents.setZoomFactor(zoom);await settle();ok(await js('smoke.inViewport()')&&!(await js('smoke.overflow()')),'card fits at zoom '+zoom);if(zoom===1.5)await shot('update-card-150')}
 w.webContents.setZoomFactor(1);await js("smoke.theme('light')");await wait(1000);await shot('update-card-light');

 if(failures.length)throw new Error(failures.join('\\n'));
 console.log('PASS: '+n+' update card UI checks (offer +3, impact, double confirm, chip 42%/installing/failed, notes, dismiss, 125/150%, light); screenshots '+__dirname);w.destroy();app.quit();
}).catch(e=>{console.error(e);app.exit(1)});
`)
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
const res = spawnSync(require('electron'), [path.join(dir, 'main.cjs')], { env, windowsHide: true, encoding: 'utf8', timeout: 60000 })
process.stdout.write(res.stdout ?? ''); if (res.status !== 0) process.stderr.write(res.stderr ?? '')
process.exitCode = res.status ?? 1
