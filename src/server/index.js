const { WebSocketServer } = require('ws')
const { EventEmitter }   = require('events')
const { handleMessage }  = require('./router')
const { enforceAuth }    = require('../auth')
const { v4: uuidv4 }     = require('uuid')

let wss = null
let heartbeatTimer = null

// Track connected clients for the Settings UI
const clients      = new Map()   // id → { id, origin }
const serverEvents = new EventEmitter()

function getClients() {
  return Array.from(clients.values())
}

function notifyClientsChanged() {
  serverEvents.emit('clients-changed', getClients())
}

function startServer(port) {
  return new Promise((resolve, reject) => {
    wss = new WebSocketServer({
      host: '127.0.0.1',
      port,
      maxPayload: 1 * 1024 * 1024  // 1 MB — prevents memory-exhaustion via oversized messages
    })

    wss.on('error', (err) => { wss = null; reject(err) })

    wss.on('listening', () => {
      heartbeatTimer = setInterval(() => {
        wss.clients.forEach((ws) => {
          if (!ws.isAlive) return ws.terminate()
          ws.isAlive = false
          ws.ping()
        })
      }, 30_000)

      resolve()
    })

    wss.on('connection', async (ws, req) => {
      const clientId = uuidv4()
      const ip       = req.socket.remoteAddress || '127.0.0.1'
      const origin   = req.headers.origin || ip

      ws.clientId  = clientId
      ws.isAlive   = true

      ws.on('pong', () => { ws.isAlive = true })
      ws.on('error', () => {})

      // Auth must succeed before any messages are processed; ip is used for rate limiting failed attempts
      const authed = await enforceAuth(ws, ip)
      if (!authed) return

      clients.set(clientId, { id: clientId, origin })
      notifyClientsChanged()

      ws.send(JSON.stringify({
        type: 'ready',
        version: '1.0.0',
        capabilities: ['printer', 'escpos', 'serial', 'hid', 'usb']
      }))

      ws.on('message', async (raw) => {
        let msg
        try {
          msg = JSON.parse(raw.toString())
        } catch {
          ws.send(JSON.stringify({ id: null, ok: false, error: 'Invalid JSON' }))
          return
        }

        const response = await handleMessage(msg, ws, wss)
        if (response != null) ws.send(JSON.stringify(response))
      })

      ws.on('close', () => {
        clients.delete(clientId)
        notifyClientsChanged()
      })
    })
  })
}

function stopServer() {
  return new Promise((resolve) => {
    if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null }
    clients.clear()
    if (!wss) return resolve()
    wss.clients.forEach((ws) => ws.terminate())
    wss.close(() => { wss = null; resolve() })
  })
}

module.exports = { startServer, stopServer, getClients, serverEvents }
