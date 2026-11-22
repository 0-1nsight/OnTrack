# Architectural Decisions — ChronoFlow Auto-Tracking Engine

## 1. Shared TypeScript Pipeline Across Server, Browser, and Desktop Agent
- **Decision**: Implement the core 7-stage pipeline (`collect -> normalize -> filter -> sessionize -> attribute -> summarize -> learn`) in strict, runtime-agnostic TypeScript modules under `src/engine/`.
- **Rationale**: Allows identical privacy filtering, entity extraction, sessionizing, and confidence scoring across the Express server, client-side offline buffer, Desktop Agent, and offline Replay Harness with zero drift between environments.

## 2. Portable SQL Store + WebSocket Gateway (`node:sqlite` + `ws` + HTTPS Polling Fallback)
- **Decision**: Use Node's built-in `node:sqlite` (`DatabaseSync`) with standard parameterized ANSI/PostgreSQL-compatible SQL schemas and attach a `ws` WebSocket server to Express on port `3000`, paired with an HTTPS polling endpoint (`/api/engine/poll`).
- **Rationale**: Satisfies portability (`DEP-1`) so the exact build runs on-premises or in containers without cloud-only managed dependencies, while still providing sub-2-second WebSocket state fan-out (`SYNC-1`) and resilient fallback behind restrictive corporate proxies.

## 3. Pre-Persistence On-Device Privacy Boundary
- **Decision**: Evaluate exclusion lists (apps, domains, file paths), drop incognito/private browser windows, and reject content/keystroke/screenshot keys inside `sanitizeAndFilterEvent` before events enter the local offline queue or cross the network (`PRIV-1`, `PRIV-2`).
- **Rationale**: Ensures excluded personal activity never leaves the employee's workstation.

## 4. Two-Collector Merge With Explicit Fallback Confidence Penalty
- **Decision**: Join Desktop Agent (OS foreground app, window title, file paths, idle, meeting apps) and Browser Extension (URL domain/path, SPA navigation, downloads, incognito state) by UTC timestamp on the device; when the extension is absent or unsupported, fall back to browser window titles and apply a `-0.10` confidence penalty (`extensionConnected: false`).
- **Rationale**: Prevents silent over-confidence when only generic browser window titles are visible.

## 5. Deterministic 5-Signal Scoring, Context Propagation & Retroactive Revision Events
- **Decision**: Score candidate tasks deterministically across explicit active task, client/period extraction, today's tasks/due dates, neighboring blocks, and learned user rules, publishing versioned revision events whenever a later strong signal (`>= 0.85`) upgrades earlier ambiguous sessions (`ATTR-3`).
- **Rationale**: Every attribution can answer *"Why was this assigned here?"* (`ATTR-1`), respects `< 0.50` Review Tray isolation (`ATTR-2`), and produces reproducible offline replay metrics (`ATTR-4`).
