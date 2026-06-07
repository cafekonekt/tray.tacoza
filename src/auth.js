const crypto = require('crypto')
const store = require('./store')

const AUTH_TIMEOUT_MS     = 10_000
const FAIL_WINDOW_MS      = 60_000   // sliding window for failed-auth counting
const FAIL_MAX_PER_WINDOW = 10       // max wrong tokens before the IP is locked out

// ip → { count, resetAt }  — only failed attempts are counted, never successes
const authFailures = new Map()

function recordAuthFailure(ip) {
  const now = Date.now()
  let rec = authFailures.get(ip)
  if (!rec || now > rec.resetAt) {
    rec = { count: 0, resetAt: now + FAIL_WINDOW_MS }
    authFailures.set(ip, rec)
  }
  rec.count++
  return rec.count > FAIL_MAX_PER_WINDOW
}

function getToken() {
  return store.get('token')
}

function regenerateToken() {
  const token = crypto.randomBytes(32).toString('hex')
  store.set('token', token)
  return token
}

function validateToken(token) {
  const expected = store.get('token')
  if (!expected || !token) return false
  // Constant-time comparison to prevent timing attacks
  try {
    return crypto.timingSafeEqual(
      Buffer.from(token, 'hex'),
      Buffer.from(expected, 'hex')
    )
  } catch {
    return false
  }
}

/**
 * Attaches auth enforcement to a newly connected WebSocket.
 * ip is used for per-IP failed-attempt rate limiting.
 * The client must send { type: 'auth', token: '...' } within AUTH_TIMEOUT_MS.
 * Resolves true on success, false on failure (connection is closed).
 */
function enforceAuth(ws, ip = '127.0.0.1') {
  return new Promise((resolve) => {
    ws.authenticated = false

    const timer = setTimeout(() => {
      if (!ws.authenticated) {
        safeSend(ws, { type: 'auth_failed', reason: 'Timeout — send auth within 10s' })
        ws.close()
        resolve(false)
      }
    }, AUTH_TIMEOUT_MS)

    const onMessage = (raw) => {
      let msg
      try { msg = JSON.parse(raw.toString()) } catch { return }

      if (msg.type !== 'auth') {
        safeSend(ws, { type: 'auth_failed', reason: 'First message must be { type: "auth", token: "..." }' })
        clearTimeout(timer)
        ws.close()
        return resolve(false)
      }

      if (validateToken(msg.token)) {
        clearTimeout(timer)
        ws.authenticated = true
        ws.removeListener('message', onMessage)
        resolve(true)
      } else {
        const rateLimited = recordAuthFailure(ip)
        const reason = rateLimited
          ? 'Too many failed attempts — try again later'
          : 'Invalid token'
        safeSend(ws, { type: 'auth_failed', reason })
        clearTimeout(timer)
        ws.close()
        resolve(false)
      }
    }

    ws.once('message', onMessage)

    // Announce that auth is required
    safeSend(ws, { type: 'hello', version: '1.0.0', auth: 'required' })
  })
}

function safeSend(ws, obj) {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(obj))
  }
}

module.exports = { getToken, regenerateToken, validateToken, enforceAuth }
