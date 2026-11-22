# OnTrack Cross-Platform Desktop Agent

Metadata-only workstation collector for **Windows, macOS, Linux, and VDI/RDP sessions**.

## Capabilities
- Captures foreground application name, window title, open document filename hints, idle state, and meeting app status.
- Never captures screenshots, keystrokes, clipboard contents, or document contents.
- Hosts an authenticated local loopback bridge (`http://127.0.0.1:47621`) protected by a per-install `X-OnTrack-Bridge-Secret` header (`POST /browser-event`, `GET /config`) and strict `Origin` checks to merge Browser Extension telemetry by UTC timestamp.
- Evaluates app/domain/path exclusions and incognito drops **on the device** before buffering to `.ontrack-offline-queue.jsonl`.
- Maintains monotonic sequence numbers (`seq`), emits 12-second heartbeats, and flushes state changes ahead of activity batches.

## Quick Start
1. Unzip `ontrack-desktop-agent.zip` and review `agent.config.json` (`serverUrl`, `tenantId`, `userId`, `deviceToken`, `bridgeSecret`).
2. Launch the agent:
   - **macOS / Linux**: `chmod +x start-agent.sh && ./start-agent.sh`
   - **Windows**: double-click `start-agent.bat` (or run `npm start`)
3. Requires Node.js 22+. Pair the Browser Extension using the same `bridgeSecret` (automatic when using **Download Paired Bundle** in **Auto-Track -> Packages**).
