# OnTrack Browser Extension (Manifest V3)

Compatible with Chrome, Microsoft Edge, and Firefox (MV3).

## Privacy & Security Guarantees
- Captures **only** domain, path (query params stripped), page title, tab switch/SPA navigation, and download filenames.
- Automatically **ignores and drops** all incognito / private windows and excluded domains before transmitting to the local Desktop Agent bridge (`http://127.0.0.1:47621/browser-event`).
- Never reads page DOM text, form inputs, cookies, or keystrokes.
- Authenticates every loopback `/config` and `/browser-event` request with the per-install `X-OnTrack-Bridge-Secret` header so arbitrary web pages cannot inject spoofed telemetry or read exclusions.

## Installation & Pairing
1. Download the **Paired Collector** from **Auto-Track -> Packages** (this injects the matching `bridgeSecret` into `config.defaults.json`).
2. Open `chrome://extensions` (or `edge://extensions`), enable **Developer mode**, click **Load unpacked**, and select the unzipped extension folder.
3. Click the **OnTrack Auto-Track Collector** toolbar icon to inspect bridge sync status or update your `bridgeUrl` and `bridgeSecret` manually at any time.
