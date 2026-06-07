# Security Policy

## Supported Versions

| Version | Security Updates |
| ------- | ---------------- |
| 1.0.x   | ✅ Supported      |

Only the latest release receives security patches. We recommend always running the newest version.

---

## Reporting a Vulnerability

**Please do not open a public GitHub issue for security vulnerabilities.**

Use [GitHub Private Vulnerability Reporting](https://github.com/tacozaio/tacoza-tray/security/advisories/new) or email **info@tacoza.com** with:

- A description of the vulnerability and its potential impact
- Steps to reproduce (proof-of-concept if available)
- The version of Tacoza Tray you tested against

You can expect an acknowledgement within **48 hours** and a status update within **7 days**. If the issue is confirmed, a patch will be released as soon as possible and you will be credited in the release notes (unless you prefer to remain anonymous).

---

## Security Architecture

Tacoza Tray is a local hardware bridge — it runs on `localhost` only and never exposes itself to the internet.

### Trust boundary

```
Restaurant network
  └── Browser / Tacoza Seller app
        └── WebSocket ws://127.0.0.1:7777  ← loopback only
              └── Tacoza Tray (this app)
                    └── Thermal printer (USB / network)
```

### Key controls

| Control | Implementation |
|---------|----------------|
| Network binding | `127.0.0.1` only — not reachable from other machines |
| Authentication | 256-bit random hex token, `crypto.timingSafeEqual` comparison |
| Auth timeout | 10 s — unauthenticated connections are terminated |
| Rate limiting | Max 10 auth failures per IP per 60 s |
| Message size cap | 1 MB `maxPayload` — prevents memory exhaustion |
| Command injection | All shell commands use `execFile()` with argument arrays; no string interpolation |
| Input validation | Printer names, host addresses, port numbers, and copies are validated before use |
| SSRF guard | Network printer hosts are rejected if they resolve to loopback, link-local, or ULA ranges |
| XSS | All client-origin values rendered in the Settings UI are HTML-escaped via `esc()` |
| CSP | Settings window enforces `script-src 'self'`, `object-src 'none'`, `base-uri 'none'` |
| Heartbeat | 30 s ping/pong — stale connections are terminated automatically |

### What is NOT in scope

- Attacks that require physical access to the machine running Tacoza Tray
- Vulnerabilities in Electron itself (report these to the Electron project)
- Social-engineering attacks against restaurant staff

---

## Known Resolved Issues

All vulnerabilities found during the v1.0.0 security audit have been patched prior to release.

| ID | Description | Severity | Status |
|----|-------------|----------|--------|
| TA-001 | Command injection via printer name in `lp` / `lpstat` | Critical | Fixed — `execFile()` |
| TA-002 | Command injection via Windows printer name in PowerShell | Critical | Fixed — name allowlist + PS escaping |
| TA-003 | SSRF via network printer TCP connection | Critical | Fixed — host blocklist |
| TA-004 | Oversized WebSocket message DoS | High | Fixed — 1 MB `maxPayload` |
| TA-005 | No rate limiting on auth failures | High | Fixed — 10 failures/60 s limit |
| TA-006 | XSS in Settings Connected Clients panel | High | Fixed — `esc()` on all dynamic values |
| TA-007 | Weak CSP — `unsafe-inline` in `script-src` | Medium | Fixed — strict CSP |
| TA-008 | Missing input validation on printer config | Medium | Fixed — validators on all inputs |
| TA-009 | Auth handshake timeout not enforced | Medium | Fixed — 10 s enforced |
