# Tacoza Tray

A lightweight Electron tray app that bridges your thermal printer to the [Tacoza Seller](https://seller.tacoza.io) dashboard. It runs silently in the background, listens on `localhost:7777`, and prints bills automatically every time an order is placed.

**Open source. Free for all Tacoza customers.**

---

## How it works

```
Tacoza Seller (browser)
  └── WebSocket  ws://127.0.0.1:7777
        └── Tacoza Tray  (this app)
              ├── Network printer  (ESC/POS over TCP port 9100)
              ├── USB/Windows printer  (raw via winspool.Drv)
              └── CUPS printer  (macOS / Linux via lp)
```

1. Tacoza Tray starts and opens a WebSocket server on `127.0.0.1:7777` (loopback only — not reachable from the network)
2. Tacoza Seller connects and authenticates using a secret token shown in Tray's Settings window
3. When an order is placed in the browser, Seller sends a print job over the WebSocket
4. Tray converts it to ESC/POS bytes and sends them directly to the printer

---

## Download

Pre-built installers are available on the [Releases](https://github.com/tacozaio/tacoza-tray/releases) page:

| Platform | File |
|----------|------|
| Windows (recommended) | `Tacoza-Tray-Setup-x.x.x.exe` |
| Windows (portable) | `Tacoza-Tray-x.x.x-portable.exe` |
| macOS | `Tacoza-Tray-x.x.x.dmg` |
| Linux | `Tacoza-Tray-x.x.x.AppImage` or `.deb` |

---

## Development setup

**Requirements:** Node.js 20+, npm 10+

```bash
git clone https://github.com/tacozaio/tacoza-tray.git
cd tacoza-tray
npm install       # also rebuilds native modules for your Electron version
npm start         # launches Electron in dev mode
```

> **Windows note:** Native modules (node-hid, serialport, usb) require C++ Build Tools.
> Install [Visual Studio Build Tools 2022](https://visualstudio.microsoft.com/downloads/#build-tools-for-visual-studio-2022)
> with the "Desktop development with C++" workload, then re-run `npm install`.

---

## Building distributables

Builds are automated via GitHub Actions on every version tag. To build locally:

```bash
npm run build:win    # Windows: NSIS installer + portable .exe
npm run build:mac    # macOS: .dmg + .zip  (must run on macOS)
npm run build:linux  # Linux: AppImage + .deb  (must run on Linux)
```

Output goes to the `dist/` directory.

To publish a new release, push a version tag:

```bash
npm version patch    # bumps version in package.json
git push --follow-tags
```

GitHub Actions will build all three platforms and create a release automatically.

---

## Project structure

```
tacoza-tray/
├── main.js                  # Electron main process — tray icon, settings window, IPC
├── src/
│   ├── server/
│   │   ├── index.js         # WebSocket server (ws, auth, heartbeat)
│   │   └── router.js        # Message dispatcher
│   ├── auth.js              # Token auth + per-IP rate limiting
│   ├── store.js             # electron-store wrapper (persists settings)
│   ├── adapters/
│   │   ├── escpos.js        # ESC/POS printer adapter (network, Windows, CUPS)
│   │   ├── printer.js       # OS printer list (PowerShell / lpstat)
│   │   ├── serial.js        # Serial port adapter
│   │   ├── hid.js           # HID device adapter
│   │   └── usb.js           # USB device adapter
│   └── settings/
│       ├── index.js         # IPC handlers for the Settings window
│       ├── preload.js       # Electron contextBridge (renderer ↔ main)
│       └── ui/
│           ├── index.html   # Settings window HTML
│           └── app.js       # Settings window JS
├── tests/
│   ├── security/pentest.js  # 22-test penetration test suite
│   └── load/loadtest.js     # Load test (connection storm, throughput, concurrency)
└── assets/
    └── icon.*               # App icon (png / icns / ico)
```

---

## WebSocket API

Connect to `ws://127.0.0.1:7777` and send the auth token as the first message:

```json
{ "token": "<your-token>" }
```

On success the server replies:

```json
{ "type": "ready", "version": "1.0.0", "capabilities": ["printer","escpos","serial","hid","usb"] }
```

All subsequent messages follow the request/response pattern:

```json
// Request
{ "id": "req-1", "type": "escpos.print", "data": { "id": "<printer-id>", "data": "<base64-escpos>" } }

// Response
{ "id": "req-1", "ok": true, "data": { "success": true } }
// or
{ "id": "req-1", "ok": false, "error": "printer not found" }
```

### Available message types

| Type | Description |
|------|-------------|
| `escpos.list` | List configured ESC/POS printers |
| `escpos.print` | Print ESC/POS data (`data.id`, `data.data` base64) |
| `escpos.test` | Print a test page (`data.id`) |
| `escpos.status` | Check if a network printer is reachable (`data.id`) |
| `printer.list` | List OS printers (Windows: PowerShell, Linux: lpstat) |
| `printer.print` | Print via OS spooler |
| `serial.list` | List serial ports |
| `serial.open` | Open a serial port |
| `serial.close` | Close a serial port |
| `serial.send` | Send bytes to a serial port |
| `hid.list` | List HID devices |
| `hid.claim` / `hid.release` | Open/close a HID device |
| `hid.send` / `hid.read` | Send/receive HID reports |
| `usb.list` | List USB devices |
| `usb.claim` / `usb.release` | Open/close a USB device |
| `usb.send` / `usb.read` | Transfer USB data |

---

## Running tests

```bash
# Security / penetration tests (22 tests — requires the app to be running)
npm run test:security

# Load tests (connection storm, auth throughput, message throughput, concurrency)
npm run test:load
```

---

## Security

Tacoza Tray is loopback-only and uses token-based auth with rate limiting. See [SECURITY.md](SECURITY.md) for the full security model and how to report a vulnerability.

---

## Contributing

Pull requests are welcome. For significant changes, open an issue first to discuss what you'd like to change.

1. Fork the repo
2. Create a feature branch (`git checkout -b feature/my-feature`)
3. Commit your changes
4. Push and open a PR

---

## License

MIT — see [LICENSE](LICENSE) for details.
