const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('api', {
  getSettings:         ()       => ipcRenderer.invoke('settings:get'),
  savePort:            (port)   => ipcRenderer.invoke('settings:savePort', port),
  regenerateToken:     ()       => ipcRenderer.invoke('token:regenerate'),
  getSystemPrinters:   ()       => ipcRenderer.invoke('printers:system'),
  getConfiguredPrinters: ()     => ipcRenderer.invoke('printers:configured'),
  addPrinter:          (config) => ipcRenderer.invoke('printers:add', config),
  removePrinter:       (id)     => ipcRenderer.invoke('printers:remove', id),
  testPrint:           (id)     => ipcRenderer.invoke('printers:test', id),
  getPrinterStatus:    (id)     => ipcRenderer.invoke('printers:status', id),
  getClients:          ()       => ipcRenderer.invoke('clients:list'),
  onClientsUpdate:     (cb)    => ipcRenderer.on('clients:update', (_, data) => cb(data)),
  getVersion:          ()       => ipcRenderer.invoke('app:version'),
  minimize:            ()       => ipcRenderer.send('window:minimize'),
  close:               ()       => ipcRenderer.send('window:close'),
})
