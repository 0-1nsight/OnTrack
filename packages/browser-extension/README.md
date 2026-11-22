# onTrack Browser Extension (Manifest V3)

Compatible with Chrome, Microsoft Edge, and Firefox (MV3).

## Privacy Guarantees
- Captures **only** domain, path (query params stripped), page title, tab switch/SPA navigation, and download filenames.
- Automatically **ignores and drops** all incognito / private windows and excluded domains before transmitting to the local Desktop Agent bridge (`http://127.0.0.1:47621/browser-event`).
- Never reads page DOM text, form inputs, cookies, or keystrokes.

## Installation
1. Open `chrome://extensions` (or `edge://extensions`).
2. Enable **Developer mode** and click **Load unpacked**.
3. Select this folder (deployable at scale via Enterprise Browser Policy).
