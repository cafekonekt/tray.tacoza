const printer = require('../adapters/printer')
const escpos  = require('../adapters/escpos')
const serial  = require('../adapters/serial')
const hid     = require('../adapters/hid')
const usb     = require('../adapters/usb')

const HANDLERS = {
  // Generic printer (PDF / raw via OS spooler)
  'printer.list':  ()        => printer.list(),
  'printer.print': (d)       => printer.print(d),

  // ESC/POS (dedicated — primary path for thermal printers)
  'escpos.list':   ()        => escpos.listConfigured(),
  'escpos.print':  (d)       => escpos.print(d),
  'escpos.test':   (d)       => escpos.testPrint(d),
  'escpos.status': (d)       => escpos.status(d),

  // Serial
  'serial.list':   ()        => serial.list(),
  'serial.open':   (d, ws)   => serial.open(d, ws),
  'serial.close':  (d)       => serial.close(d),
  'serial.send':   (d)       => serial.send(d),

  // HID
  'hid.list':      ()        => hid.list(),
  'hid.claim':     (d)       => hid.claim(d),
  'hid.release':   (d)       => hid.release(d),
  'hid.send':      (d)       => hid.send(d),
  'hid.read':      (d)       => hid.read(d),
  'hid.stream':    (d, ws)   => hid.openStream(d, ws),

  // USB
  'usb.list':      ()        => usb.list(),
  'usb.claim':     (d)       => usb.claim(d),
  'usb.release':   (d)       => usb.release(d),
  'usb.send':      (d)       => usb.send(d),
  'usb.read':      (d)       => usb.read(d),
}

async function handleMessage(msg, ws, wss) {
  const { id, type, data } = msg

  if (!type) return { id, ok: false, error: 'Missing message type' }

  const handler = HANDLERS[type]
  if (!handler) return { id, ok: false, error: `Unknown type: ${type}` }

  try {
    const result = await handler(data || {}, ws, wss)
    return { id, ok: true, data: result ?? null }
  } catch (err) {
    return { id, ok: false, error: err.message }
  }
}

module.exports = { handleMessage }
