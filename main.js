const { app } = require('electron')
const path    = require('path')

// Single instance — must run before whenReady
if (!app.requestSingleInstanceLock()) {
  app.quit()
  process.exit(0)
}

// Hide from macOS dock immediately
if (process.platform === 'darwin') app.dock.hide()

let tray = null

app.whenReady().then(async () => {
  // Defer all other requires until after app is ready.
  // electron-store calls app.getPath() in its constructor — must happen post-ready.
  const { Tray, Menu, nativeImage, dialog } = require('electron')
  const { startServer, stopServer, getClients, serverEvents } = require('./src/server')
  const auth                                    = require('./src/auth')
  const escpos                                  = require('./src/adapters/escpos')
  const store                                   = require('./src/store')
  const { openSettings, registerIPC }           = require('./src/settings')

  function buildMenu(status) {
    const port = store.get('port')
    return Menu.buildFromTemplate([
      { label: 'Tacoza Tray', enabled: false },
      { label: `Status: ${status}`, enabled: false },
      { label: `ws://127.0.0.1:${port}`, enabled: false },
      { type: 'separator' },
      { label: 'Settings…', click: () => openSettings() },
      { type: 'separator' },
      {
        label: 'Restart Service', click: async () => {
          tray.setContextMenu(buildMenu('Restarting…'))
          await stopServer()
          await startServer(store.get('port'))
          tray.setContextMenu(buildMenu('Running'))
        }
      },
      {
        label: 'Launch at login',
        type: 'checkbox',
        checked: store.get('autoLaunch'),
        click: (item) => {
          store.set('autoLaunch', item.checked)
          app.setLoginItemSettings({ openAtLogin: item.checked })
        }
      },
      { type: 'separator' },
      {
        label: 'Quit', click: async () => {
          await stopServer()
          app.quit()
        }
      }
    ])
  }

  // Register IPC handlers for the Settings window
  registerIPC({ store, auth, escpos, getClients, serverEvents })

  // Tray icon
  const iconPath = path.join(__dirname, 'assets', 'icon.png')
  const icon     = nativeImage.createFromPath(iconPath)
  tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon.resize({ width: 16, height: 16 }))
  tray.setToolTip('Tacoza Tray')
  tray.setContextMenu(buildMenu('Starting…'))
  tray.on('double-click', () => openSettings())

  // Sync auto-launch with OS
  app.setLoginItemSettings({ openAtLogin: store.get('autoLaunch') })

  try {
    await startServer(store.get('port'))
    tray.setContextMenu(buildMenu('Running'))
  } catch (err) {
    tray.setContextMenu(buildMenu(`Error: ${err.message}`))
    dialog.showErrorBox('Tacoza Tray', `Failed to start on port ${store.get('port')}:\n${err.message}`)
  }
})

app.on('window-all-closed', (e) => e.preventDefault())
process.on('uncaughtException', () => {})
