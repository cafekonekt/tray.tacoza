/**
 * tacoza-tray.js — browser client library
 * Drop into your web app. No build step required.
 *
 * Usage:
 *   const tray = new TacozaTray({ token: 'YOUR_TOKEN' })
 *   await tray.connect()
 *   const printers = await tray.escpos.list()
 *   await tray.escpos.print({ id: printers[0].id, data: base64bytes })
 */
;(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory()
  else root.TacozaTray = factory()
}(typeof self !== 'undefined' ? self : this, function () {

  const DEFAULT_PORT      = 7777
  const RECONNECT_DELAY   = 3000
  const REQUEST_TIMEOUT   = 15000
  const AUTH_TIMEOUT      = 8000

  function TacozaTray(options = {}) {
    if (!options.token) throw new Error('TacozaTray: token is required. Get it from Tacoza Tray → Settings → Authentication.')

    this._token        = options.token
    this._port         = options.port || DEFAULT_PORT
    this._ws           = null
    this._pending      = new Map()
    this._listeners    = {}
    this._autoReconnect = options.autoReconnect !== false
    this._onStatus     = options.onStatusChange || null
    this._connected    = false
    this._reconnectTimer = null

    // Public namespaces
    this.escpos  = this._ns('escpos',  ['list', 'print', 'test', 'status'])
    this.printer = this._ns('printer', ['list', 'print'])
    this.serial  = this._ns('serial',  ['list', 'open', 'close', 'send'])
    this.hid     = this._ns('hid',     ['list', 'claim', 'release', 'send', 'read', 'stream'])
    this.usb     = this._ns('usb',     ['list', 'claim', 'release', 'send', 'read'])
  }

  TacozaTray.prototype._ns = function (prefix, methods) {
    const ns = {}
    methods.forEach(m => { ns[m] = (data) => this._send(`${prefix}.${m}`, data) })
    return ns
  }

  TacozaTray.prototype.connect = function () {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${this._port}`)
      this._ws = ws

      // Auth timeout — if server never greets us
      const authTimer = setTimeout(() => {
        reject(new Error('Tacoza Tray auth timeout — is the app running?'))
        ws.close()
      }, AUTH_TIMEOUT)

      ws.onmessage = (event) => {
        let msg
        try { msg = JSON.parse(event.data) } catch { return }

        if (msg.type === 'hello') {
          // Server requires auth — send token immediately
          ws.send(JSON.stringify({ type: 'auth', token: this._token }))
          return
        }

        if (msg.type === 'ready') {
          clearTimeout(authTimer)
          this._connected = true
          this._notify('connected')
          // Swap in the real message handler
          ws.onmessage = (e) => this._onMessage(e)
          resolve({ version: msg.version, capabilities: msg.capabilities })
          return
        }

        if (msg.type === 'auth_failed') {
          clearTimeout(authTimer)
          reject(new Error(`Auth failed: ${msg.reason}`))
          ws.close()
        }
      }

      ws.onerror = () => {
        clearTimeout(authTimer)
        if (!this._connected) reject(new Error('Cannot connect to Tacoza Tray — is it running?'))
      }

      ws.onclose = () => {
        clearTimeout(authTimer)
        this._connected = false
        this._notify('disconnected')
        this._pending.forEach(p => { clearTimeout(p.timer); p.reject(new Error('Connection closed')) })
        this._pending.clear()
        if (this._autoReconnect) {
          this._reconnectTimer = setTimeout(() => this.connect().catch(() => {}), RECONNECT_DELAY)
        }
      }
    })
  }

  TacozaTray.prototype._onMessage = function (event) {
    let msg
    try { msg = JSON.parse(event.data) } catch { return }

    if (msg.type === 'event') {
      ;(this._listeners[msg.stream] || []).forEach(h => h(msg))
      return
    }

    if (msg.id != null) {
      const p = this._pending.get(msg.id)
      if (!p) return
      clearTimeout(p.timer)
      this._pending.delete(msg.id)
      msg.ok ? p.resolve(msg.data) : p.reject(new Error(msg.error))
    }
  }

  TacozaTray.prototype._send = function (type, data = {}) {
    if (!this._connected) return Promise.reject(new Error('Not connected'))
    return new Promise((resolve, reject) => {
      const id    = Math.random().toString(36).slice(2) + Date.now()
      const timer = setTimeout(() => {
        this._pending.delete(id)
        reject(new Error(`Request timeout: ${type}`))
      }, REQUEST_TIMEOUT)
      this._pending.set(id, { resolve, reject, timer })
      this._ws.send(JSON.stringify({ id, type, data }))
    })
  }

  /** Subscribe to streaming events (serial/hid). Returns an unsubscribe function. */
  TacozaTray.prototype.on = function (stream, handler) {
    if (!this._listeners[stream]) this._listeners[stream] = []
    this._listeners[stream].push(handler)
    return () => { this._listeners[stream] = this._listeners[stream].filter(h => h !== handler) }
  }

  TacozaTray.prototype.disconnect = function () {
    this._autoReconnect = false
    clearTimeout(this._reconnectTimer)
    if (this._ws) this._ws.close()
    this._ws = null
  }

  TacozaTray.prototype.isConnected = function () { return this._connected }

  TacozaTray.prototype._notify = function (status) {
    if (typeof this._onStatus === 'function') this._onStatus(status)
  }

  return TacozaTray
}))
