const { exec, execFile } = require('child_process')
const { promisify } = require('util')
const fs = require('fs/promises')
const path = require('path')
const os = require('os')

const execAsync     = promisify(exec)
const execFileAsync = promisify(execFile)

// Reject printer names that contain characters dangerous in shell contexts.
// Windows printer names: letters, digits, spaces, hyphens, underscores, dots, parens, @.
// CUPS queue names: same set (lpstat/lp accept these safely).
const SAFE_PRINTER_RE = /^[A-Za-z0-9 _\-\.\(\)@\\]+$/

function validatePrinterName(name) {
  if (!name || typeof name !== 'string') throw new Error('printer name is required')
  if (name.length > 256) throw new Error('printer name too long')
  if (!SAFE_PRINTER_RE.test(name)) throw new Error(`printer name contains invalid characters: ${JSON.stringify(name)}`)
}

function validateCopies(raw) {
  const n = parseInt(raw, 10)
  if (!Number.isInteger(n) || n < 1 || n > 99) throw new Error('copies must be an integer 1–99')
  return n
}

async function list() {
  if (process.platform === 'win32') {
    const { stdout } = await execAsync(
      'powershell -NoProfile -Command "Get-Printer | Select-Object -ExpandProperty Name"'
    )
    return stdout.trim().split(/\r?\n/).map(s => s.trim()).filter(Boolean)
  }

  // macOS / Linux via CUPS
  try {
    const { stdout } = await execAsync('lpstat -a 2>/dev/null')
    return stdout.trim().split(/\r?\n/)
      .filter(Boolean)
      .map(line => line.split(' ')[0])
  } catch {
    return []
  }
}

async function print({ printer: printerName, data, type = 'raw', copies = 1, paperWidthMm }) {
  if (!printerName) throw new Error('printer required')
  if (!data) throw new Error('data required')
  validatePrinterName(printerName)
  copies = validateCopies(copies)

  if (type === 'html') {
    if (!paperWidthMm) throw new Error('paperWidthMm is required for HTML printing — configure paper width in printer settings')
    return printHtml(printerName, data, copies, paperWidthMm)
  }

  // Accept base64 string or plain array of byte values
  const buffer = Buffer.isBuffer(data)
    ? data
    : Buffer.from(data, 'base64')

  if (type === 'raw') return printRaw(printerName, buffer, copies)
  if (type === 'pdf') return printPDF(printerName, buffer, copies)

  throw new Error(`Unsupported print type: ${type}`)
}

async function printHtml(printerName, htmlBase64, copies = 1, paperWidthMm = 80) {
  const { BrowserWindow } = require('electron')

  const widthMm = parseFloat(paperWidthMm)
  if (!Number.isFinite(widthMm) || widthMm < 20 || widthMm > 500) throw new Error('paperWidthMm must be 20–500')
  paperWidthMm = widthMm

  const SIDE_MARGIN_MM = 2  // physical non-printable margin on each edge

  // Decode base64 → UTF-8 HTML fragment
  const fragment = Buffer.from(htmlBase64, 'base64').toString('utf8')

  // Wrap in a full document:
  // - @page pins page width to the paper roll and clears print-dialog margins
  // - body gets a small side margin so content never runs into the physical
  //   non-printable edge of the roller (fixes left/right clipping)
  // - max-width:100% + word-break stop any element from overflowing
  const fullHtml = `<!DOCTYPE html>
<html><head><meta charset="utf-8">
<style>
  *, *::before, *::after { box-sizing: border-box; }
  html { margin: 0; padding: 0; width: ${paperWidthMm}mm; background: white; }
  body { margin: 0 ${SIDE_MARGIN_MM}mm; padding: 0; background: white; }
  @page  { size: ${paperWidthMm}mm auto; margin: 0; }
  * { max-width: 100%; }
  img { max-width: 100%; height: auto; }
  td, th, span, p, div { word-break: break-word; overflow-wrap: break-word; }
</style>
</head><body>${fragment}</body></html>`

  const dataUrl = 'data:text/html;charset=utf-8;base64,'
    + Buffer.from(fullHtml, 'utf8').toString('base64')

  const winWidthPx = Math.round(paperWidthMm * 96 / 25.4)

  return new Promise((resolve, reject) => {
    const win = new BrowserWindow({
      width: winWidthPx,
      height: 1200,
      show: false,
      webPreferences: { contextIsolation: true }
    })

    const timer = setTimeout(() => {
      if (!win.isDestroyed()) win.close()
      reject(new Error('HTML print timeout (30s)'))
    }, 30000)

    win.loadURL(dataUrl)

    win.webContents.once('did-finish-load', () => {
      win.webContents.print(
        {
          silent: true,
          printBackground: true,
          deviceName: printerName,
          copies,
          margins: { marginType: 'none' },
          // Width in microns = mm × 1000; height 200 mm covers a tall receipt
          pageSize: { width: paperWidthMm * 1000, height: 200000 }
        },
        (success, failureReason) => {
          clearTimeout(timer)
          if (!win.isDestroyed()) win.close()
          if (success) resolve({ success: true })
          else reject(new Error(failureReason || 'Print failed'))
        }
      )
    })

    win.webContents.once('did-fail-load', (_e, _code, desc) => {
      clearTimeout(timer)
      if (!win.isDestroyed()) win.close()
      reject(new Error(`HTML load failed: ${desc}`))
    })
  })
}

async function printRaw(printerName, buffer, copies) {
  const tmpFile = path.join(os.tmpdir(), `tz-print-${Date.now()}.bin`)
  try {
    await fs.writeFile(tmpFile, buffer)

    if (process.platform === 'win32') {
      // cmd.exe /c copy is a shell built-in; printerName is validated by caller
      await execAsync(`copy /b "${tmpFile}" "\\\\.\\${printerName}"`)
        .catch(() => execAsync(`print /d:"${printerName}" "${tmpFile}"`))
    } else {
      // execFile avoids shell — args are passed directly to lp, no injection possible
      const args = ['-d', printerName, '-o', 'raw']
      if (copies > 1) args.push('-n', String(copies))
      args.push(tmpFile)
      await execFileAsync('lp', args)
    }
  } finally {
    await fs.unlink(tmpFile).catch(() => {})
  }
  return { success: true }
}

async function printPDF(printerName, buffer, copies) {
  const tmpFile = path.join(os.tmpdir(), `tz-print-${Date.now()}.pdf`)
  try {
    await fs.writeFile(tmpFile, buffer)

    if (process.platform === 'win32') {
      const sumatraExe = 'C:\\Program Files\\SumatraPDF\\SumatraPDF.exe'
      // execFile passes args directly to CreateProcess — no shell injection possible
      const sumatraArgs = ['-print-to', printerName, '-silent', tmpFile]
      if (copies > 1) sumatraArgs.splice(2, 0, '-print-settings', `${copies}x`)
      await execFileAsync(sumatraExe, sumatraArgs).catch(async () => {
        // Fallback: PowerShell Start-Process — printerName validated, tmpFile is our own path
        const safeName = printerName.replace(/'/g, "''")
        const safeTmp  = tmpFile.replace(/'/g, "''")
        await execAsync(
          `powershell -NoProfile -Command "Start-Process -FilePath '${safeTmp}' -Verb PrintTo -ArgumentList '${safeName}' -Wait"`
        )
      })
    } else {
      const args = ['-d', printerName]
      if (copies > 1) args.push('-n', String(copies))
      args.push(tmpFile)
      await execFileAsync('lp', args)
    }
  } finally {
    await fs.unlink(tmpFile).catch(() => {})
  }
  return { success: true }
}

module.exports = { list, print }
