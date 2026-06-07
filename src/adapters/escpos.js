const net = require('net')
const crypto = require('crypto')
const { exec, execFile } = require('child_process')
const { promisify } = require('util')
const fs = require('fs/promises')
const path = require('path')
const os = require('os')
const { v4: uuidv4 } = require('uuid')
const store = require('../store')

const execAsync     = promisify(exec)
const execFileAsync = promisify(execFile)

// Printer name validation shared with printer.js
const SAFE_PRINTER_RE = /^[A-Za-z0-9 _\-\.\(\)@\\]+$/
function validatePrinterName(name) {
  if (!name || typeof name !== 'string') throw new Error('printer name is required')
  if (name.length > 256) throw new Error('printer name too long')
  if (!SAFE_PRINTER_RE.test(name)) throw new Error(`printer name contains invalid characters: ${JSON.stringify(name)}`)
}

// ---------------------------------------------------------------------------
// Windows raw-print DLL (compiled once from C#, cached on disk by source hash)
// ---------------------------------------------------------------------------

const RAWPRINT_CS = `
using System; using System.IO; using System.Runtime.InteropServices;
public class RawPrint {
    [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Ansi)]
    public class DOCINFO {
        [MarshalAs(UnmanagedType.LPStr)] public string pDocName;
        [MarshalAs(UnmanagedType.LPStr)] public string pOutputFile;
        [MarshalAs(UnmanagedType.LPStr)] public string pDataType;
    }
    [DllImport("winspool.Drv",CharSet=CharSet.Ansi)] public static extern bool OpenPrinterA(string s,out IntPtr h,IntPtr p);
    [DllImport("winspool.Drv")] public static extern bool ClosePrinter(IntPtr h);
    [DllImport("winspool.Drv",CharSet=CharSet.Ansi)] public static extern bool StartDocPrinterA(IntPtr h,int l,[In,MarshalAs(UnmanagedType.LPStruct)]DOCINFO d);
    [DllImport("winspool.Drv")] public static extern bool EndDocPrinter(IntPtr h);
    [DllImport("winspool.Drv")] public static extern bool StartPagePrinter(IntPtr h);
    [DllImport("winspool.Drv")] public static extern bool EndPagePrinter(IntPtr h);
    [DllImport("winspool.Drv")] public static extern bool WritePrinter(IntPtr h,IntPtr p,int n,out int w);
    public static void Send(string name,string file) {
        byte[] b=File.ReadAllBytes(file); IntPtr h;
        OpenPrinterA(name,out h,IntPtr.Zero);
        StartDocPrinterA(h,1,new DOCINFO{pDocName="RAW",pDataType="RAW"});
        StartPagePrinter(h);
        IntPtr p=Marshal.AllocHGlobal(b.Length); Marshal.Copy(b,0,p,b.Length);
        int w; WritePrinter(h,p,b.Length,out w);
        Marshal.FreeHGlobal(p);
        EndPagePrinter(h); EndDocPrinter(h); ClosePrinter(h);
    }
}
`
const CS_HASH = crypto.createHash('md5').update(RAWPRINT_CS).digest('hex').slice(0, 8)
const DLL_PATH = path.join(os.tmpdir(), `tz-rawprint-${CS_HASH}.dll`)

// Singleton promise — compilation runs at most once per process lifetime
let _dllReady = null

function ensureRawPrintDll() {
  if (_dllReady) return _dllReady
  _dllReady = (async () => {
    // Already compiled from a previous run?
    try { await fs.access(DLL_PATH); return DLL_PATH } catch {}

    const psFile = path.join(os.tmpdir(), `tz-compile-${CS_HASH}.ps1`)
    const safeDll = DLL_PATH.replace(/\\/g, '\\\\')
    await fs.writeFile(psFile, `Add-Type -Language CSharp -TypeDefinition @'\n${RAWPRINT_CS}\n'@ -OutputAssembly '${safeDll}'`, 'utf8')
    try {
      await execAsync(`powershell -NoProfile -ExecutionPolicy Bypass -File "${psFile}"`, { timeout: 90000 })
    } finally {
      await fs.unlink(psFile).catch(() => {})
    }
    return DLL_PATH
  })()
  // Kick off pre-compilation at module load; errors are non-fatal here
  _dllReady.catch(() => {})
  return _dllReady
}

// Start compiling immediately on Windows so first print is fast
if (process.platform === 'win32') ensureRawPrintDll()

// ---------------------------------------------------------------------------
// ESC/POS byte helpers — no external library needed
// ---------------------------------------------------------------------------

const ESC = 0x1B
const GS  = 0x1D

function escposTestPage(label) {
  const line = [...Buffer.from('--------------------------------\n')]
  const text = (s) => [...Buffer.from(s)]
  return Buffer.from([
    ESC, 0x40,              // Initialize printer
    ESC, 0x61, 0x01,        // Center align
    ESC, 0x45, 0x01,        // Bold ON
    ...text('TACOZA TRAY\n'),
    ESC, 0x45, 0x00,        // Bold OFF
    ...text('Connection Test\n'),
    ...line,
    ESC, 0x61, 0x00,        // Left align
    ...text(`Printer : ${label}\n`),
    ...text(`Status  : OK\n`),
    ...text(`Host    : ${os.hostname()}\n`),
    ...line,
    0x0A, 0x0A, 0x0A,       // Feed 3 lines
    GS, 0x56, 0x41, 0x03,   // Partial cut
  ])
}

// ---------------------------------------------------------------------------
// In-memory printer registry (persisted to electron-store)
// ---------------------------------------------------------------------------

function loadPrinters() {
  return store.get('escposPrinters', [])
}

function savePrinters(list) {
  store.set('escposPrinters', list)
}

function listConfigured() {
  return loadPrinters()
}

function addPrinter(config) {
  if (!config || typeof config !== 'object') throw new Error('invalid printer config')
  const { type, name, host, label } = config
  if (!['network', 'windows', 'cups'].includes(type)) throw new Error('type must be network | windows | cups')
  if (type === 'network') {
    validateNetworkHost(host)
    const port = parseInt(config.port, 10)
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('port must be 1–65535')
  } else {
    validatePrinterName(name)
  }
  const printers = loadPrinters()
  const printer = { id: uuidv4(), label: label || name || host, type, name, host, port: config.port }
  printers.push(printer)
  savePrinters(printers)
  return printer
}

function removePrinter(id) {
  const printers = loadPrinters().filter(p => p.id !== id)
  savePrinters(printers)
  return { removed: true }
}

function getPrinter(id) {
  const p = loadPrinters().find(p => p.id === id)
  if (!p) throw new Error(`Printer "${id}" not configured`)
  return p
}

// ---------------------------------------------------------------------------
// SSRF guard — reject hosts that would let an authenticated client port-scan
// the local machine or internal infrastructure via the printer TCP path.
// Printers live on the LAN (192.168.x.x etc.) which we allow; what we block
// is localhost / link-local / metadata ranges that have no legitimate use.
// ---------------------------------------------------------------------------

const BLOCKED_HOST_RE = /^(localhost|127\.|::1$|0\.0\.0\.0|169\.254\.|fc[0-9a-f]{2}:|fd)/i

function validateNetworkHost(host) {
  if (!host || typeof host !== 'string') throw new Error('host is required')
  if (host.length > 253) throw new Error('host too long')
  if (BLOCKED_HOST_RE.test(host.trim())) {
    throw new Error(`host "${host}" is not allowed — cannot target loopback or link-local addresses`)
  }
}

// ---------------------------------------------------------------------------
// Printing backends
// ---------------------------------------------------------------------------

/**
 * Network ESC/POS: raw TCP to port 9100 (or custom port).
 * Most reliable path — works cross-platform, no driver needed.
 */
function printNetwork(host, port, buffer) {
  return new Promise((resolve, reject) => {
    const client = new net.Socket()
    client.setTimeout(8000)

    client.connect(port, host, () => {
      client.write(buffer, () => {
        // Give the printer time to receive all bytes before closing
        setTimeout(() => { client.end(); resolve({ success: true }) }, 200)
      })
    })

    client.on('error', (err) => { client.destroy(); reject(err) })
    client.on('timeout', () => {
      client.destroy()
      reject(new Error(`Timeout connecting to ${host}:${port}`))
    })
  })
}

/**
 * Windows raw printing via pre-compiled winspool.Drv DLL.
 * The DLL is compiled once from C# and cached on disk — subsequent calls
 * only load the cached DLL (~100 ms) instead of recompiling (~20 s).
 */
async function printWindows(printerName, buffer) {
  const dataFile = path.join(os.tmpdir(), `tz-esc-${Date.now()}.bin`)
  const psFile   = path.join(os.tmpdir(), `tz-print-${Date.now()}.ps1`)

  const dllPath  = await ensureRawPrintDll()
  const safeDll  = dllPath.replace(/\\/g, '\\\\')
  const safeData = dataFile.replace(/\\/g, '\\\\')
  const safeName = printerName.replace(/'/g, "''")

  const ps = `Add-Type -Path '${safeDll}'\n[RawPrint]::Send('${safeName}', '${safeData}')`

  try {
    await fs.writeFile(dataFile, buffer)
    await fs.writeFile(psFile, ps, 'utf8')
    await execAsync(`powershell -NoProfile -ExecutionPolicy Bypass -File "${psFile}"`, { timeout: 15000 })
    return { success: true }
  } finally {
    await Promise.all([
      fs.unlink(dataFile).catch(() => {}),
      fs.unlink(psFile).catch(() => {})
    ])
  }
}

/**
 * macOS / Linux: CUPS raw printing via lp.
 */
async function printCups(printerName, buffer) {
  const tmpFile = path.join(os.tmpdir(), `tz-esc-${Date.now()}.bin`)
  try {
    await fs.writeFile(tmpFile, buffer)
    // execFile passes args directly — no shell interpolation, no injection possible
    await execFileAsync('lp', ['-d', printerName, '-o', 'raw', tmpFile])
    return { success: true }
  } finally {
    await fs.unlink(tmpFile).catch(() => {})
  }
}

// ---------------------------------------------------------------------------
// Public API (called by router)
// ---------------------------------------------------------------------------

async function print({ id, data }) {
  const printer = getPrinter(id)
  if (!data) throw new Error('data is required')
  const buffer  = Buffer.from(data, 'base64')

  if (printer.type === 'network') {
    validateNetworkHost(printer.host)
    return printNetwork(printer.host, printer.port || 9100, buffer)
  }
  if (printer.type === 'windows') {
    validatePrinterName(printer.name)
    return printWindows(printer.name, buffer)
  }
  if (printer.type === 'cups') {
    validatePrinterName(printer.name)
    return printCups(printer.name, buffer)
  }
  throw new Error(`Unknown printer type: ${printer.type}`)
}

async function testPrint({ id }) {
  const printer = getPrinter(id)
  const buffer  = escposTestPage(printer.label || printer.name || printer.host)

  if (printer.type === 'network') { validateNetworkHost(printer.host); return printNetwork(printer.host, printer.port || 9100, buffer) }
  if (printer.type === 'windows') { validatePrinterName(printer.name); return printWindows(printer.name, buffer) }
  if (printer.type === 'cups')    { validatePrinterName(printer.name); return printCups(printer.name, buffer) }
  throw new Error(`Unknown printer type: ${printer.type}`)
}

/** Ping a network printer's TCP port to check reachability. */
function status({ id }) {
  const printer = getPrinter(id)
  if (printer.type !== 'network') return { reachable: null, note: 'Status check only available for network printers' }
  validateNetworkHost(printer.host)

  return new Promise((resolve) => {
    const sock = new net.Socket()
    sock.setTimeout(3000)
    sock.connect(printer.port || 9100, printer.host, () => {
      sock.destroy()
      resolve({ reachable: true })
    })
    sock.on('error', () => resolve({ reachable: false }))
    sock.on('timeout', () => { sock.destroy(); resolve({ reachable: false }) })
  })
}

/** List printers installed in the OS (for the Settings "add Windows printer" flow). */
async function listSystem() {
  if (process.platform === 'win32') {
    try {
      const { stdout } = await execAsync(
        'powershell -NoProfile -Command "Get-Printer | Select-Object Name,PortName | ConvertTo-Json -Compress"'
      )
      const raw = JSON.parse(stdout)
      return (Array.isArray(raw) ? raw : [raw]).map(p => ({
        name: p.Name, port: p.PortName, type: 'windows'
      }))
    } catch { return [] }
  }
  try {
    const { stdout } = await execAsync('lpstat -a 2>/dev/null')
    return stdout.trim().split(/\r?\n/).filter(Boolean).map(l => ({
      name: l.split(' ')[0], type: 'cups'
    }))
  } catch { return [] }
}

module.exports = {
  listConfigured, listSystem,
  addPrinter, removePrinter,
  print, testPrint, status
}
