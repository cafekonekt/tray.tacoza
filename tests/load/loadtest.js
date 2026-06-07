/**
 * Tacoza Tray — Load / Stress Test Suite
 *
 * Run WHILE Tacoza Tray is running:
 *
 *   node tests/load/loadtest.js [port] [token]
 *
 * A valid token is required for authenticated scenarios.
 * Exit 0 = all scenarios passed their thresholds | Exit 1 = at least one failed.
 */

'use strict'

const WebSocket = require('ws')

const PORT  = parseInt(process.argv[2], 10) || 7777
const TOKEN = process.argv[3] || ''
const URL   = `ws://127.0.0.1:${PORT}`

const GRN = '\x1b[32m'
const RED = '\x1b[31m'
const YEL = '\x1b[33m'
const RST = '\x1b[0m'

// ---------------------------------------------------------------------------
// Buffered WebSocket — buffers messages that arrive before nextMsg() is called.
// Prevents the race condition where a hello/ready message arrives in the same
// I/O-event batch as the 'open' event and is lost before ws.once() is set up.
// ---------------------------------------------------------------------------

function bufferedConnect(timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const ws      = new WebSocket(URL)
    const queue   = []    // messages buffered before nextMsg() is called
    const waiters = []    // nextMsg() resolvers waiting for a message

    ws.on('message', (raw) => {
      if (waiters.length) {
        const { res, timer } = waiters.shift()
        clearTimeout(timer)
        res(raw)
      } else {
        queue.push(raw)
      }
    })

    // nextMsg(ms) — returns the next buffered or incoming message within ms
    ws.nextMsg = (timeoutMs = 5000) => new Promise((res, rej) => {
      if (queue.length) { res(queue.shift()); return }
      const entry = { res, timer: null }
      entry.timer = setTimeout(() => {
        const idx = waiters.indexOf(entry)
        if (idx !== -1) waiters.splice(idx, 1)
        rej(new Error('recv timeout'))
      }, timeoutMs)
      waiters.push(entry)
    })

    const t = setTimeout(() => { ws.terminate(); reject(new Error('connect timeout')) }, timeoutMs)
    ws.on('open',  () => { clearTimeout(t); resolve(ws) })
    ws.on('error', (e) => { clearTimeout(t); reject(e) })
  })
}

// ---------------------------------------------------------------------------
// authedWs() — full connect → hello → auth → ready handshake
// ---------------------------------------------------------------------------

async function authedWs() {
  const ws = await bufferedConnect()

  const hello = JSON.parse((await ws.nextMsg(5000)).toString())
  if (hello.type !== 'hello') throw new Error(`Expected hello, got: ${hello.type}`)

  ws.send(JSON.stringify({ type: 'auth', token: TOKEN }))

  const ready = JSON.parse((await ws.nextMsg(5000)).toString())
  if (ready.type !== 'ready') throw new Error(`Auth failed: ${ready.reason || JSON.stringify(ready)}`)

  return ws
}

// ---------------------------------------------------------------------------
// request() — single shared router listener per socket dispatches by id.
// Avoids the N-listeners-per-request pattern that triggers MaxListeners
// warnings and degrades performance with large concurrency.
// ---------------------------------------------------------------------------

const routers = new WeakMap()  // ws → Map<id, { resolve, timer }>

function getRouter(ws) {
  if (routers.has(ws)) return routers.get(ws)
  const pending = new Map()
  ws.on('message', (raw) => {
    let msg
    try { msg = JSON.parse(raw.toString()) } catch { return }
    if (msg.id == null) return
    const entry = pending.get(String(msg.id))
    if (!entry) return
    pending.delete(String(msg.id))
    clearTimeout(entry.timer)
    entry.resolve(msg)
  })
  routers.set(ws, pending)
  return pending
}

function request(ws, type, data = {}) {
  const pending = getRouter(ws)
  return new Promise((resolve, reject) => {
    const id    = Math.random().toString(36).slice(2) + Date.now()
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`timeout: ${type}`)) }, 10_000)
    pending.set(id, { resolve: (msg) => { msg.ok ? resolve(msg) : reject(new Error(msg.error)) }, timer })
    ws.send(JSON.stringify({ id, type, data }))
  })
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

function stats(latencies) {
  const sorted = [...latencies].sort((a, b) => a - b)
  const avg = sorted.reduce((a, b) => a + b, 0) / sorted.length
  const p95 = sorted[Math.floor(sorted.length * 0.95)] ?? sorted[sorted.length - 1]
  const max = sorted[sorted.length - 1]
  return `avg ${avg.toFixed(0)} ms  p95 ${p95.toFixed(0)} ms  max ${max.toFixed(0)} ms`
}

// ---------------------------------------------------------------------------
// Scenario 1: Connection storm — raw TCP accept throughput
// Does NOT wait for hello — we're measuring how many connections the server
// can accept, not how fast it can exchange messages.
// ---------------------------------------------------------------------------

async function scenarioConnectionStorm(concurrency = 50) {
  console.log(`\n[1] Connection storm — ${concurrency} simultaneous TCP connections`)
  const t0 = Date.now()
  let connected = 0, failed = 0

  const tasks = Array.from({ length: concurrency }, async () => {
    try {
      const ws = new WebSocket(URL)
      await new Promise((res, rej) => {
        ws.on('open',  () => { connected++; ws.terminate(); res() })
        ws.on('error', () => { failed++; rej() })
        setTimeout(() => { failed++; ws.terminate(); rej() }, 8000)
      })
    } catch { /* already counted */ }
  })

  await Promise.allSettled(tasks)
  const elapsed = Date.now() - t0

  console.log(`  Connected: ${connected}/${concurrency}  Failed: ${failed}  Time: ${elapsed} ms`)
  const ok = connected >= concurrency * 0.95 && elapsed < 3000
  console.log(`  Result: ${ok ? GRN + 'OK' : RED + 'FAIL (expected ≥95% connected in < 3 s)'}${RST}`)
  return ok
}

// ---------------------------------------------------------------------------
// Scenario 2: Auth throughput — full connect-auth-disconnect round-trips
// ---------------------------------------------------------------------------

async function scenarioAuthThroughput(iterations = 20) {
  if (!TOKEN) { console.log('\n[2] Auth throughput — SKIPPED (no token)'); return true }
  console.log(`\n[2] Auth throughput — ${iterations} sequential full-handshake round-trips`)

  const latencies = []

  for (let i = 0; i < iterations; i++) {
    const t0 = Date.now()
    try {
      const ws = await authedWs()
      latencies.push(Date.now() - t0)
      ws.close()
    } catch (e) {
      console.log(`    iteration ${i + 1} error: ${e.message}`)
      latencies.push(Date.now() - t0)
    }
  }

  const p95 = [...latencies].sort((a, b) => a - b)[Math.floor(latencies.length * 0.95)]
  console.log(`  ${stats(latencies)}`)

  const ok = p95 < 2000
  console.log(`  Result: ${ok ? GRN + 'OK (p95 < 2 s)' : RED + 'FAIL (p95 ≥ 2 s)'}${RST}`)
  return ok
}

// ---------------------------------------------------------------------------
// Scenario 3: Message throughput — rapid-fire requests over one connection
// ---------------------------------------------------------------------------

async function scenarioMessageThroughput(count = 200) {
  if (!TOKEN) { console.log('\n[3] Message throughput — SKIPPED (no token)'); return true }
  console.log(`\n[3] Message throughput — ${count} concurrent escpos.list requests on one connection`)

  const ws = await authedWs()
  const t0  = Date.now()
  let ok_n = 0, err_n = 0

  await Promise.allSettled(
    Array.from({ length: count }, async () => {
      try {
        const msg = await request(ws, 'escpos.list')
        if (msg.ok) ok_n++; else err_n++
      } catch { err_n++ }
    })
  )

  const elapsed = Date.now() - t0
  ws.close()

  const rps = (count / (elapsed / 1000)).toFixed(0)
  console.log(`  ok: ${ok_n}  err: ${err_n}  time: ${elapsed} ms  throughput: ${rps} req/s`)

  const pass = ok_n >= count * 0.95
  console.log(`  Result: ${pass ? GRN + 'OK (≥95% succeeded)' : RED + 'FAIL'}${RST}`)
  return pass
}

// ---------------------------------------------------------------------------
// Scenario 4: Concurrent authenticated clients
// ---------------------------------------------------------------------------

async function scenarioConcurrentClients(numClients = 5, reqsEach = 20) {
  if (!TOKEN) { console.log('\n[4] Concurrent clients — SKIPPED (no token)'); return true }
  console.log(`\n[4] Concurrent clients — ${numClients} clients × ${reqsEach} requests`)

  const t0 = Date.now()
  let totalOk = 0, totalErr = 0

  // Open all clients (small stagger to avoid bursting the handshake)
  const sockets = []
  for (let i = 0; i < numClients; i++) {
    try { sockets.push(await authedWs()) } catch (e) { console.log(`    open error: ${e.message}`); totalErr += reqsEach }
    await sleep(50)
  }

  await Promise.allSettled(sockets.map(async (ws) => {
    for (let i = 0; i < reqsEach; i++) {
      try {
        const msg = await request(ws, 'escpos.list')
        if (msg.ok) totalOk++; else totalErr++
      } catch { totalErr++ }
    }
    ws.close()
  }))

  const elapsed = Date.now() - t0
  const expected = sockets.length * reqsEach
  console.log(`  ok: ${totalOk}  err: ${totalErr}  time: ${elapsed} ms`)

  const pass = totalOk >= expected * 0.95
  console.log(`  Result: ${pass ? GRN + 'OK (≥95% succeeded)' : RED + 'FAIL'}${RST}`)
  return pass
}

// ---------------------------------------------------------------------------
// Scenario 5: Oversized message — must not crash the server
// ---------------------------------------------------------------------------

async function scenarioOversizedMessage() {
  console.log('\n[5] Oversized message — 2 MB payload (server should reject, not crash)')

  try {
    const ws = new WebSocket(URL)
    await new Promise((res, rej) => {
      ws.on('open',  res)
      ws.on('error', rej)
      setTimeout(rej, 5000)
    })
    ws.send(Buffer.alloc(2 * 1024 * 1024, 0x41))  // 2 MB binary
    await new Promise(res => {
      ws.on('close', res)
      ws.on('error', res)
      setTimeout(res, 5000)
    })
    ws.terminate()
  } catch { /* expected */ }

  // Confirm the server is still alive
  let alive = false
  try {
    const ws = await bufferedConnect(3000)
    await ws.nextMsg(3000)   // hello
    ws.terminate()
    alive = true
  } catch {}

  console.log(`  Server alive after oversized payload: ${alive ? GRN + 'YES' : RED + 'NO'}${RST}`)
  return alive
}

// ---------------------------------------------------------------------------
// Scenario 6: Junk flood — sustained malformed JSON, then health check
// ---------------------------------------------------------------------------

async function scenarioJunkFlood(durationMs = 3000) {
  console.log(`\n[6] Junk flood — ${durationMs / 1000} s of malformed JSON, then health check`)

  const ws = new WebSocket(URL)
  await new Promise((res, rej) => {
    ws.on('open', res)
    ws.on('error', rej)
    setTimeout(rej, 5000)
  })
  await new Promise(res => ws.once('message', res))  // hello (sequential — no race)

  const end = Date.now() + durationMs
  while (Date.now() < end && ws.readyState === WebSocket.OPEN) {
    try { ws.send('{not: json!}') } catch { break }
    await sleep(10)
  }
  ws.terminate()

  let alive = false
  try {
    const ws2 = await bufferedConnect(3000)
    await ws2.nextMsg(3000)
    ws2.terminate()
    alive = true
  } catch {}

  console.log(`  Server healthy after junk flood: ${alive ? GRN + 'YES' : RED + 'NO'}${RST}`)
  return alive
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

;(async () => {
  console.log('\nTacoza Tray — Load Test Suite')
  console.log(`Target: ${URL}`)
  if (!TOKEN) console.log(`${YEL}Tip: pass the auth token as the 3rd arg to run all scenarios${RST}`)
  else        console.log(`Token:  ${TOKEN.slice(0, 8)}…`)

  const results = []
  results.push(await scenarioConnectionStorm(50))
  results.push(await scenarioAuthThroughput(20))
  results.push(await scenarioMessageThroughput(200))
  results.push(await scenarioConcurrentClients(5, 20))
  results.push(await scenarioOversizedMessage())
  results.push(await scenarioJunkFlood(3000))

  const passed = results.filter(Boolean).length
  console.log('\n' + '─'.repeat(60))
  console.log(`Load test results: ${passed}/${results.length} scenarios passed`)
  console.log('─'.repeat(60))
  process.exit(passed === results.length ? 0 : 1)
})()
