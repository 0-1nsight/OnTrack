# OnTrack Cross-Platform Desktop Agent

Metadata-only workstation collector for **Windows, macOS, Linux, and VDI/RDP sessions**.

## Capabilities
- Captures foreground application name, window title, open document filename hints, idle state, and meeting app status.
- Never captures screenshots, keystrokes, clipboard contents, or document contents.
- Hosts a local loopback bridge (`http://127.0.0.1:47621/browser-event`) to merge Browser Extension telemetry by UTC timestamp.
- Evaluates app/domain/path exclusions and incognito drops **on the device** before buffering to `.ontrack-offline-queue.jsonl`.
- Maintains monotonic sequence numbers (`seq`), emits 12-second heartbeats, and flushes state changes ahead of activity batches.

## Quick Start
1. Edit `agent.config.json` with your `serverUrl`, `tenantId`, and `userId`.
2. Run `npm start` (requires Node.js 22+).
