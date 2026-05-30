// Renders the Sn app icon (the </> gradient mark on a dark tile) to
// build/icon.png at 1024x1024. electron-builder derives .ico/.icns from it.
//   node node_modules/electron/dist/electron.exe scripts/make-icon.cjs
const { app, BrowserWindow } = require('electron')
const fs = require('fs')
const path = require('path')

const SIZE = 1024

const html = `<!doctype html><html><head><meta charset="utf-8"><style>
  html,body{margin:0;width:${SIZE}px;height:${SIZE}px;background:transparent;overflow:hidden}
  .wrap{width:${SIZE}px;height:${SIZE}px;display:flex;align-items:center;justify-content:center}
  .tile{width:896px;height:896px;border-radius:208px;border:4px solid #1f2937;
    background:radial-gradient(circle at 50% 40%, rgba(99,102,241,0.34), rgba(99,102,241,0) 60%),
               linear-gradient(135deg,#0f172a,#0b0f19);
    box-shadow:inset 0 0 140px rgba(99,102,241,0.20);
    display:flex;align-items:center;justify-content:center}
</style></head><body><div class="wrap"><div class="tile">
  <svg width="560" height="560" viewBox="0 0 32 32" fill="none">
    <defs>
      <linearGradient id="g" x1="2" y1="2" x2="30" y2="30" gradientUnits="userSpaceOnUse">
        <stop stop-color="#6366F1"/><stop offset="0.55" stop-color="#8B5CF6"/><stop offset="1" stop-color="#60A5FA"/>
      </linearGradient>
    </defs>
    <g stroke="url(#g)" stroke-width="5.5" stroke-linecap="round" stroke-linejoin="round" fill="none">
      <polyline points="11.5,6.5 4.5,16 11.5,25.5"/>
      <polyline points="20.5,6.5 27.5,16 20.5,25.5"/>
      <line x1="19.5" y1="5" x2="12.5" y2="27" stroke-width="4.2"/>
    </g>
  </svg>
</div></div></body></html>`

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: SIZE,
    height: SIZE,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    useContentSize: true,
  })
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html))
  await new Promise((r) => setTimeout(r, 600))
  const img = await win.webContents.capturePage()
  fs.mkdirSync(path.join(__dirname, '..', 'build'), { recursive: true })
  fs.writeFileSync(path.join(__dirname, '..', 'build', 'icon.png'), img.toPNG())
  console.log('wrote build/icon.png')
  app.quit()
})
