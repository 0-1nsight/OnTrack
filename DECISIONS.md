# Architectural Decisions — OnTrack Platform

## 1. Shared TypeScript Pipeline Across Server, Browser, and Desktop Agent
- **Decision**: Implement the core 7-stage pipeline (`collect -> normalize -> filter -> sessionize -> attribute -> summarize -> learn`) in strict, runtime-agnostic TypeScript modules under `src/engine/`.
- **Rationale**: Allows identical privacy filtering, entity extraction, sessionizing, and confidence scoring across the Express server, client-side offline buffer, Desktop Agent, and offline Replay Harness with zero drift between environments.

## 2. PostgreSQL Production Store With Row-Level Security + SQLite Dev/Test Adapter
- **Decision**: Run versioned forward/rollback migrations (`server/migrations/`) across PostgreSQL (production, enforcing `SET LOCAL app.tenant_id` and RLS policies on every tenant-scoped table) and Node's built-in `node:sqlite` (local development and automated tests). Use Express + `ws` WebSocket gateway with PostgreSQL `LISTEN/NOTIFY` multi-instance fan-out and HTTPS polling fallback.
- **Rationale**: Guarantees database-enforced tenant isolation (`VIS-1`) and portable cloud or on-premises deployment (`DEP-1`) without cloud-vendor lock-in.

## 3. Self-Hosted Authentication, MFA, and Device Pairing
- **Decision**: Replace Firebase Auth and Firestore completely with self-hosted invite-only email/password (`argon2id`), mandatory TOTP MFA for `admin_it` and `executive`, `httpOnly` cookie sessions with CSRF protection, optional per-tenant OIDC SSO, separate Client Portal principal isolation, and `ontrack_dev_*` device pairing tokens.
- **Rationale**: Allows full air-gapped or private-VPC on-premises deployment while enforcing `VIS-1`, `VIS-2`, and `PORT-1` on the server.

## 4. Pre-Persistence On-Device Privacy Boundary
- **Decision**: Evaluate exclusion lists (apps, domains, file paths), drop incognito/private browser windows, and reject content/keystroke/screenshot keys inside `sanitizeAndFilterEvent` before events enter the local offline queue or cross the network (`PRIV-1`, `PRIV-2`).
- **Rationale**: Ensures excluded personal activity never leaves the employee's workstation.

## 5. Two-Collector Merge With Explicit Fallback Confidence Penalty
- **Decision**: Join Desktop Agent (OS foreground app, window title, file paths, idle, meeting apps) and Browser Extension (URL domain/path, SPA navigation, downloads, incognito state) by UTC timestamp on the device; when the extension is absent or unsupported, fall back to browser window titles and apply a `-0.10` confidence penalty (`extensionConnected: false`).
- **Rationale**: Prevents silent over-confidence when only generic browser window titles are visible.

## 6. Deterministic 5-Signal Scoring, Context Propagation & Retroactive Revision Events
- **Decision**: Score candidate tasks deterministically across explicit active task, client/period extraction, today's tasks/due dates, neighboring blocks, and learned user rules, persisting versioned `state.session_attributed` revision events whenever a later strong signal (`>= 0.85`) upgrades earlier ambiguous sessions (`ATTR-3`).
- **Rationale**: Every attribution can answer *"Why was this assigned here?"* (`ATTR-1`), respects `< 0.50` Review Tray isolation (`ATTR-2`), and produces reproducible offline replay metrics (`ATTR-4`).
