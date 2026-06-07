const { SerialPort } = require('serialport')

// port path → SerialPort instance
const openPorts = new Map()

async function list() {
  const ports = await SerialPort.list()
  return ports
}

function open({ port, baudRate = 9600, dataBits = 8, stopBits = 1, parity = 'none' }, ws) {
  return new Promise((resolve, reject) => {
    if (openPorts.has(port)) return resolve({ opened: true, port })

    const sp = new SerialPort({ path: port, baudRate, dataBits, stopBits, parity, autoOpen: false })

    sp.open((err) => {
      if (err) return reject(new Error(`Cannot open ${port}: ${err.message}`))

      openPorts.set(port, sp)

      // Push incoming bytes to the connected WebSocket client
      sp.on('data', (data) => {
        if (ws && ws.readyState === ws.OPEN) {
          ws.send(JSON.stringify({
            type: 'event',
            stream: 'serial',
            port,
            data: data.toString('base64')
          }))
        }
      })

      sp.on('error', (err) => {
        if (ws && ws.readyState === ws.OPEN) {
          ws.send(JSON.stringify({ type: 'event', stream: 'serial', port, error: err.message }))
        }
      })

      // Auto-close when client disconnects
      ws.on('close', () => {
        if (openPorts.has(port)) {
          sp.close(() => openPorts.delete(port))
        }
      })

      resolve({ opened: true, port })
    })
  })
}

function close({ port }) {
  return new Promise((resolve, reject) => {
    const sp = openPorts.get(port)
    if (!sp) return resolve({ closed: true })

    sp.close((err) => {
      if (err) return reject(err)
      openPorts.delete(port)
      resolve({ closed: true })
    })
  })
}

function send({ port, data }) {
  return new Promise((resolve, reject) => {
    const sp = openPorts.get(port)
    if (!sp) return reject(new Error(`Port ${port} is not open`))

    const buffer = Buffer.from(data, 'base64')
    sp.write(buffer, (err) => {
      if (err) return reject(err)
      sp.drain(() => resolve({ sent: true }))
    })
  })
}

module.exports = { list, open, close, send }
