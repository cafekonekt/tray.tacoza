/* Settings window app — communicates with main process via window.api (preload) */

let currentToken = ''
let currentPort  = 7777

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------
window.addEventListener('DOMContentLoaded', async () => {
  setupNav()
  window.api.getVersion().then(v => {
    document.getElementById('app-version').textContent = `v${v}`
  }).catch(() => {})
  await Promise.allSettled([loadSettings(), refreshOverview(), loadPrinters()])

  // Titlebar
  document.getElementById('btn-minimize').addEventListener('click', () => window.api.minimize())
  document.getElementById('btn-close').addEventListener('click',    () => window.api.close())

  // Overview
  document.getElementById('btn-refresh-overview').addEventListener('click', refreshOverview)

  // Printers
  document.getElementById('btn-add-toggle').addEventListener('click', toggleAddForm)
  document.getElementById('btn-do-add-printer').addEventListener('click', addPrinter)
  document.getElementById('btn-cancel-add').addEventListener('click', toggleAddForm)
  document.getElementById('btn-pick-system-printer').addEventListener('click', pickSystemPrinter)
  document.getElementById('new-type').addEventListener('change', toggleTypeFields)

  // Auth
  document.getElementById('btn-copy-token').addEventListener('click', copyToken)
  document.getElementById('btn-regenerate-token').addEventListener('click', regenerateToken)

  // General
  document.getElementById('btn-save-port').addEventListener('click', savePort)

  // Realtime client updates pushed from main process on every connect/disconnect
  window.api.onClientsUpdate((clients) => renderClients(clients))

  // Event delegation for dynamically generated printer list
  document.getElementById('printer-list').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action]')
    if (!btn) return
    if (btn.dataset.action === 'test')   testPrinter(btn.dataset.id, btn)
    if (btn.dataset.action === 'remove') removePrinter(btn.dataset.id)
  })

  // Event delegation for system printer picker
  document.getElementById('system-printers-list').addEventListener('click', (e) => {
    const item = e.target.closest('.sys-printer-item')
    if (item) selectSystemPrinter(item.dataset.printerName)
  })
})

async function loadSettings() {
  try {
    const s = await window.api.getSettings()
    currentToken = s.token
    currentPort  = s.port

    document.getElementById('port-input').value = s.port
    document.getElementById('token-display').textContent = s.token

    const dot   = document.getElementById('server-dot')
    const label = document.getElementById('server-label')
    dot.className   = 'status-dot'
    label.textContent = `Port ${s.port}`
    document.getElementById('stat-port').textContent = s.port
  } catch {
    document.getElementById('server-dot').className = 'status-dot offline'
    document.getElementById('server-label').textContent = 'Error'
  }
}

// ---------------------------------------------------------------------------
// Nav
// ---------------------------------------------------------------------------
function setupNav() {
  document.querySelectorAll('.nav-item').forEach(el => {
    el.addEventListener('click', () => {
      document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'))
      document.querySelectorAll('.section').forEach(s => s.classList.remove('active'))
      el.classList.add('active')
      document.getElementById(`section-${el.dataset.section}`).classList.add('active')
    })
  })
}

// ---------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------
function renderClients(clients) {
  document.getElementById('stat-clients').textContent = clients.length
  const box = document.getElementById('clients-list')
  if (!clients.length) {
    box.innerHTML = '<span style="color:var(--muted);font-size:13px">No clients connected</span>'
    return
  }
  box.innerHTML = clients.map(c => `
    <div class="client-row">
      <span class="status-dot"></span>
      <span class="client-id">${esc(c.id.slice(0, 8))}</span>
      <span class="client-origin">${esc(c.origin || 'localhost')}</span>
    </div>`).join('')
}

async function refreshOverview() {
  try {
    const [clients, printers] = await Promise.all([
      window.api.getClients(),
      window.api.getConfiguredPrinters()
    ])
    document.getElementById('stat-printers').textContent = printers.length
    document.getElementById('stat-status').textContent   = '● Running'
    renderClients(clients)
  } catch {}
}

// ---------------------------------------------------------------------------
// Printers
// ---------------------------------------------------------------------------
async function loadPrinters() {
  try {
    const printers = await window.api.getConfiguredPrinters()
    renderPrinters(printers)
  } catch {}
}

function renderPrinters(printers) {
  const el = document.getElementById('printer-list')
  if (!printers.length) {
    el.innerHTML = '<p style="color:var(--muted);font-size:13px;margin-bottom:8px">No printers configured yet.</p>'
    return
  }
  el.innerHTML = printers.map(p => `
    <div class="printer-item">
      <div class="printer-info">
        <div class="printer-name">${esc(p.label || p.name || p.host)}</div>
        <div class="printer-meta">${printerMeta(p)}</div>
      </div>
      <span class="printer-badge ${p.type}">${p.type}</span>
      <div class="printer-actions">
        <button class="btn btn-ghost" style="font-size:12px;padding:5px 10px"
          data-action="test" data-id="${p.id}">Test</button>
        <button class="btn btn-danger" style="font-size:12px;padding:5px 10px"
          data-action="remove" data-id="${p.id}">Remove</button>
      </div>
    </div>`).join('')
}

function printerMeta(p) {
  if (p.type === 'network') return `${p.host}:${p.port || 9100}`
  if (p.type === 'windows' || p.type === 'cups') return p.name
  return ''
}

async function testPrinter(id, btn) {
  btn.textContent = 'Printing…'
  btn.disabled = true
  try {
    await window.api.testPrint(id)
    toast('Test print sent!')
  } catch (e) {
    toast(`Error: ${e.message}`, 'error')
  } finally {
    btn.textContent = 'Test'
    btn.disabled = false
  }
}

async function removePrinter(id) {
  await window.api.removePrinter(id)
  toast('Printer removed')
  await loadPrinters()
}

function toggleAddForm() {
  const form = document.getElementById('add-printer-form')
  const btn  = document.getElementById('btn-add-toggle')
  const open = form.classList.toggle('open')
  btn.innerHTML = open
    ? `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg> Cancel`
    : `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg> Add Printer`
  if (!open) resetForm()
}

function toggleTypeFields() {
  const type = document.getElementById('new-type').value
  document.getElementById('field-network').style.display = type === 'network' ? '' : 'none'
  document.getElementById('field-named').style.display   = type !== 'network' ? '' : 'none'
}

async function pickSystemPrinter() {
  const list = document.getElementById('system-printers-list')
  list.style.display = 'block'
  list.innerHTML = '<span style="color:var(--muted);font-size:12px">Loading…</span>'
  const printers = await window.api.getSystemPrinters()
  if (!printers.length) {
    list.innerHTML = '<span style="color:var(--muted);font-size:12px">No system printers found</span>'
    return
  }
  list.innerHTML = printers.map(p => `
    <div class="sys-printer-item" data-printer-name="${esc(p.name)}">
      ${esc(p.name)} <span style="color:var(--muted);margin-left:6px">${p.port || ''}</span>
    </div>`).join('')
}

function selectSystemPrinter(name) {
  document.getElementById('new-name').value = name
  document.getElementById('system-printers-list').style.display = 'none'
}

async function addPrinter() {
  const type  = document.getElementById('new-type').value
  const label = document.getElementById('new-label').value.trim()

  if (!label) { toast('Enter a label for the printer', 'error'); return }

  let config = { type, label }

  if (type === 'network') {
    const host = document.getElementById('new-host').value.trim()
    const port = parseInt(document.getElementById('new-port').value, 10)
    if (!host) { toast('Enter an IP address or hostname', 'error'); return }
    config = { ...config, host, port: port || 9100 }
  } else {
    const name = document.getElementById('new-name').value.trim()
    if (!name) { toast('Enter the printer name', 'error'); return }
    config = { ...config, name }
  }

  try {
    await window.api.addPrinter(config)
    toast('Printer added')
    toggleAddForm()
    await loadPrinters()
  } catch (e) {
    toast(`Error: ${e.message}`, 'error')
  }
}

function resetForm() {
  document.getElementById('new-label').value = ''
  document.getElementById('new-host').value  = ''
  document.getElementById('new-port').value  = '9100'
  document.getElementById('new-name').value  = ''
  document.getElementById('new-type').value  = 'network'
  document.getElementById('field-network').style.display = ''
  document.getElementById('field-named').style.display   = 'none'
  document.getElementById('system-printers-list').style.display = 'none'
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------
function copyToken() {
  navigator.clipboard.writeText(currentToken)
  toast('Token copied to clipboard')
}

async function regenerateToken() {
  if (!confirm('Regenerating the token will disconnect all existing clients. Continue?')) return
  const res = await window.api.regenerateToken()
  currentToken = res.token
  document.getElementById('token-display').textContent = res.token
  toast('Token regenerated — existing clients will need to reconnect')
}

// ---------------------------------------------------------------------------
// General
// ---------------------------------------------------------------------------
async function savePort() {
  const val = document.getElementById('port-input').value
  try {
    await window.api.savePort(val)
    currentPort = parseInt(val, 10)
    toast('Port saved — restart Tacoza Tray to apply')
  } catch (e) {
    toast(e.message, 'error')
  }
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------
function toast(msg, type = '') {
  const el = document.getElementById('toast')
  el.textContent = msg
  el.className = 'show' + (type === 'error' ? ' error' : '')
  clearTimeout(toast._t)
  toast._t = setTimeout(() => { el.className = '' }, 3000)
}

function esc(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')
}
