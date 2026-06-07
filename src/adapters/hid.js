const HID = require('node-hid')

// vendorId:productId → HID.HID instance
const openDevices = new Map()

function deviceKey(vendorId, productId) {
  return `${vendorId}:${productId}`
}

function list() {
  return HID.devices()
}

function claim({ vendorId, productId }) {
  if (vendorId == null || productId == null) throw new Error('vendorId and productId required')
  const key = deviceKey(vendorId, productId)
  if (openDevices.has(key)) return { claimed: true, key }

  const device = new HID.HID(vendorId, productId)
  openDevices.set(key, device)
  return { claimed: true, key }
}

function release({ vendorId, productId }) {
  const key = deviceKey(vendorId, productId)
  const device = openDevices.get(key)
  if (device) {
    try { device.close() } catch { /* already closed */ }
    openDevices.delete(key)
  }
  return { released: true }
}

function send({ vendorId, productId, data }) {
  const key = deviceKey(vendorId, productId)
  const device = openDevices.get(key)
  if (!device) throw new Error(`HID device ${key} not claimed`)

  const bytes = Array.isArray(data)
    ? data
    : [...Buffer.from(data, 'base64')]

  device.write(bytes)
  return { sent: true }
}

function read({ vendorId, productId, timeout = 1000 }) {
  const key = deviceKey(vendorId, productId)
  const device = openDevices.get(key)
  if (!device) throw new Error(`HID device ${key} not claimed`)

  const data = device.readTimeout(timeout)
  return { data: Array.from(data) }
}

// Attaches a continuous data listener; events are pushed to the WebSocket client
function openStream({ vendorId, productId }, ws) {
  const key = deviceKey(vendorId, productId)
  const device = openDevices.get(key)
  if (!device) throw new Error(`HID device ${key} not claimed`)

  const push = (payload) => {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({ type: 'event', stream: 'hid', device: key, ...payload }))
    }
  }

  device.on('data', (data) => push({ data: Array.from(data) }))
  device.on('error', (err) => push({ error: err.message }))

  // Clean up stream when client disconnects
  ws.on('close', () => {
    device.removeAllListeners('data')
    device.removeAllListeners('error')
  })

  return { streaming: true, key }
}

module.exports = { list, claim, release, send, read, openStream }
