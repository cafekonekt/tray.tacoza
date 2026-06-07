const Store = require('electron-store')
const crypto = require('crypto')

const store = new Store({
  name: 'tacoza-tray',
  defaults: {
    port: 7777,
    autoLaunch: true,
    token: crypto.randomBytes(32).toString('hex'),
    escposPrinters: []
  }
})

module.exports = store
