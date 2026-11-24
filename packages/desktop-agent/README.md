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

## Capture (ManicTime-style, metadata only)

- **Windows:** a long-running helper (`native/windows/FocusWatcher.cs`) reports foreground and title changes as they happen, plus idle time, lock/sleep, microphone/camera use and the virtual desktop id. The agent compiles it once with the .NET Framework `csc.exe` that ships with Windows. If that fails, the agent falls back to polling and reports it in capture health.
- **macOS / Linux:** polling every `pollSampleMs` (default 2000 ms). macOS reports a missing Accessibility permission; Linux reports Wayland limits.
- **Exact durations:** each event covers one real stretch of activity. Idle is back-dated to the last input. Long stretches are flushed every 15 s.
- **Documents:** Excel, Word, PowerPoint, PDF viewers and QuickBooks are reduced to document name and screen. Outlook and chat titles are replaced with `Outlook – Mail` / `<App> – Chat`, keeping only client codes.
- **States:** active, idle, away, meeting (including silent calls), locked, sleeping.

### Loopback bridge (needs `X-OnTrack-Bridge-Secret`)

| Endpoint | Purpose |
| --- | --- |
| `GET /capture-health` | Collector mode, score and issues |
| `GET /controls`, `POST /controls` | `{action: "pause", minutes}`, `{action: "offTheRecord", enabled}`, `{action: "resume"}`, `{action: "setSchedule", schedule}` |
| `GET /recent-events?limit=N` | What this device recorded, as queued |

Controls persist in `.ontrack-controls.json`. `/health` is unauthenticated and never includes window titles.
