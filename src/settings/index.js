const { BrowserWindow, ipcMain, shell, app } = require('electron')
const path = require('path')

let win = null

function openSettings() {
  if (win && !win.isDestroyed()) {
    win.focus()
    return
  }

  win = new BrowserWindow({
    width: 780,
    height: 620,
    minWidth: 680,
    minHeight: 520,
    title: 'Tacoza Tray — Settings',
    icon: path.join(__dirname, '..', '..', 'assets', 'icon.png'),
    frame: false,
    resizable: true,
    maximizable: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  win.loadFile(path.join(__dirname, 'ui', 'index.html'))
  win.setMenuBarVisibility(false)

  win.on('closed', () => { win = null })
}

function registerIPC({ store, auth, escpos, getClients, serverEvents }) {
  // Push client list to the renderer whenever a WS client connects or disconnects
  serverEvents.on('clients-changed', (clients) => {
    if (win && !win.isDestroyed()) {
      win.webContents.send('clients:update', clients)
    }
  })
  ipcMain.handle('settings:get', () => ({
    port: store.get('port'),
    token: auth.getToken(),
    autoLaunch: store.get('autoLaunch')
  }))

  ipcMain.handle('settings:savePort', (_, port) => {
    const p = parseInt(port, 10)
    if (isNaN(p) || p < 1024 || p > 65535) throw new Error('Port must be 1024–65535')
    store.set('port', p)
    return { saved: true, restartRequired: true }
  })

  ipcMain.handle('token:regenerate', () => {
    return { token: auth.regenerateToken() }
  })

  ipcMain.handle('printers:system', () => escpos.listSystem())

  ipcMain.handle('printers:configured', () => escpos.listConfigured())

  ipcMain.handle('printers:add', (_, config) => escpos.addPrinter(config))

  ipcMain.handle('printers:remove', (_, id) => escpos.removePrinter(id))

  ipcMain.handle('printers:test', (_, id) => escpos.testPrint({ id }))

  ipcMain.handle('printers:status', (_, id) => escpos.status({ id }))

  ipcMain.handle('clients:list', () => getClients())
  ipcMain.handle('app:version', () => app.getVersion())

  ipcMain.on('window:minimize', () => win?.minimize())
  ipcMain.on('window:close',    () => win?.close())
}

module.exports = { openSettings, registerIPC }
