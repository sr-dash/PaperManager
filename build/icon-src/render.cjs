// Renders icon.svg to a transparent 1024×1024 PNG with Electron's Chromium:
//   npx electron build/icon-src/render.cjs
const { app, BrowserWindow } = require('electron')
const { readFileSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')

app.whenReady().then(async () => {
  const svg = readFileSync(join(__dirname, 'icon.svg'), 'utf8')
  const win = new BrowserWindow({
    width: 1024,
    height: 1024,
    show: false,
    transparent: true,
    frame: false,
    webPreferences: { offscreen: true }
  })
  win.webContents.setZoomFactor(1)
  await win.loadURL(
    'data:text/html,' +
      encodeURIComponent(`<html><body style="margin:0;background:transparent">${svg}</body></html>`)
  )
  await new Promise((r) => setTimeout(r, 300))
  const image = await win.webContents.capturePage({ x: 0, y: 0, width: 1024, height: 1024 })
  const png = image.resize({ width: 1024, height: 1024 }).toPNG()
  writeFileSync(join(__dirname, '..', 'icon.png'), png)
  app.quit()
})
