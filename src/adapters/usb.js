const usb = require('usb')

// vendorId:productId → { device, interface }
const claimedDevices = new Map()

function deviceKey(vendorId, productId) {
  return `${vendorId}:${productId}`
}

function list() {
  return usb.getDeviceList().map((d) => ({
    vendorId: d.deviceDescriptor.idVendor,
    productId: d.deviceDescriptor.idProduct,
    busNumber: d.busNumber,
    deviceAddress: d.deviceAddress
  }))
}

async function claim({ vendorId, productId, interfaceNumber = 0 }) {
  const key = deviceKey(vendorId, productId)
  if (claimedDevices.has(key)) return { claimed: true, key }

  const device = usb.findByIds(vendorId, productId)
  if (!device) throw new Error(`USB device ${key} not found`)

  device.open()

  const iface = device.interface(interfaceNumber)
  if (iface.isKernelDriverActive()) iface.detachKernelDriver()
  iface.claim()

  claimedDevices.set(key, { device, iface })
  return { claimed: true, key }
}

function release({ vendorId, productId }) {
  const key = deviceKey(vendorId, productId)
  const entry = claimedDevices.get(key)
  if (!entry) return { released: true }

  try {
    entry.iface.release(true, () => {
      try { entry.device.close() } catch { /* ignore */ }
    })
  } catch { /* ignore */ }

  claimedDevices.delete(key)
  return { released: true }
}

function send({ vendorId, productId, endpoint, data }) {
  return new Promise((resolve, reject) => {
    const key = deviceKey(vendorId, productId)
    const entry = claimedDevices.get(key)
    if (!entry) return reject(new Error(`USB device ${key} not claimed`))

    const ep = entry.iface.endpoint(endpoint)
    if (!ep) return reject(new Error(`Endpoint ${endpoint} not found`))

    const buffer = Buffer.from(data, 'base64')
    ep.transfer(buffer, (err) => {
      if (err) return reject(err)
      resolve({ sent: true })
    })
  })
}

function read({ vendorId, productId, endpoint, length = 64 }) {
  return new Promise((resolve, reject) => {
    const key = deviceKey(vendorId, productId)
    const entry = claimedDevices.get(key)
    if (!entry) return reject(new Error(`USB device ${key} not claimed`))

    const ep = entry.iface.endpoint(endpoint)
    if (!ep) return reject(new Error(`Endpoint ${endpoint} not found`))

    ep.transfer(length, (err, data) => {
      if (err) return reject(err)
      resolve({ data: data.toString('base64') })
    })
  })
}

module.exports = { list, claim, release, send, read }
