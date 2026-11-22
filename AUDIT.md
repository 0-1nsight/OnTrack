# OnTrack Codebase Audit (`AUDIT.md`)

**Audit Date:** 2026-11-21  
**Target Product Name:** **OnTrack**  
**Scope:** Phase 0 discovery and verification (read-only audit; zero application code modified).  
**Total Tracked Source/Config Files Audited:** 59 workspace files (excluding `node_modules/`, `dist/`, `.aistudio/` artifacts, and runtime `/data/` files), totaling ~29,370 lines (including binary/generated asset byte counts).

---

## 1. Environment & Verification Command Results

All commands below were executed directly against the repository at `/app/applet`.

| Check | Command | Exit / Result | Verified Output & Engineering Finding |
| --- | --- | --- | --- |
| **Toolchain** | `node -v && npm -v && bun -v` | **PASS** | `node v22.23.2`, `npm 10.9.8`, `bun 1.4.4` |
| **Git Status** | `git status` | **FAIL (128)** | `fatal: not a git repository (or any of the parent directories): .git` — **Repo is not a Git repository**, despite assuming a clean commit baseline. Phase 1 must run `git init` and establish branch/commit hygiene with `.gitignore` excluding `/data/` and secrets. |
| **Clean Install (`npm ci`)** | `npm ci --dry-run` | **FAIL (`EUSAGE`)** | `The npm ci command can only install with an existing package-lock.json or npm-shrinkwrap.json`. Repo contains `bun.lock` (1,073 lines) but **no `package-lock.json`**, breaking `Dockerfile` (`RUN npm ci`). |
| **Lockfile Generation** | `npm --prefix /tmp/ontrack-audit install --package-lock-only --ignore-scripts` | **FAIL (`ERESOLVE`)** | `vite@8.3.8` declares `peerOptional esbuild@"^0.27.0 || ^0.28.0"`, which conflicts with `devDependencies.esbuild: "^0.25.0"` (`0.25.12` installed) in `package.json`. |
| **Security CVE Audit** | `npm audit` | **FAIL (`ENOLOCK`)** | `This command requires an existing lockfile`. Automated CVE auditing cannot run in CI without generating a clean `package-lock.json`. |
| **Type Check** | `npm run lint` (`tsc --noEmit`) | **PASS (0)** | Compiles cleanly with `tsconfig.json` (`noEmit: true`), `typescript@7.0.2`. |
| **ESLint** | `npx eslint .` | **PASS (0) — FALSE GREEN** | `eslint.config.js` sets `ignores: ['dist/**/*', 'node_modules/**/*', 'src/**/*', '*.ts', '*.tsx', '*.js']` and only lints `**/*.rules`. **Zero JS/TS linting runs today.** |
| **Production Build** | `npm run build` (`vite build`) | **PASS (0) with Warnings** | Built `1700` modules in `2.02s`. Bundle `dist/assets/index-Bjsuu1kq.js` is **`1,472.62 kB`** (`385.68 kB` gzip) — single unsplit chunk > 500 kB. Also warns `__dirname` in `vite.config.ts:11:27` is unsupported with native config loader. |
| **Live Acceptance API** | `curl -sS "http://localhost:3000/api/engine/acceptance?tenantId=firm_demo"` | **11 / 12 PASS (`FRESH-1` FAIL)** | **`FRESH-1` FAILED**: `Threshold=120s enforced across shifts`. All 11 synthetic in-memory checks passed (`PRIV-1`, `PRIV-2`, `SYNC-5`, `SYNC-6`, `FRESH-3`, `ATTR-1/2`, `ATTR-3`, `ATTR-4`, `VIS-1`, `AUTH-1`, `RET-1`). Root cause of `FRESH-1` failure: seeded device `demo-dev-vdi-elena` had `last_heartbeat_utc` set to `Date.now() - 190s` when `data/chronoflow-engine.db` was created; once >600s elapsed, `getDeviceFreshness()` transitioned it from `delayed` to `offline`, leaving zero `delayed` devices. |
| **Unit / Int / E2E Tests** | Repo scan | **NONE EXIST** | Zero `.test.ts`, `.spec.ts`, Playwright, Vitest, or load test files exist. |

---

## 2. Complete File Inventory (`Keep` / `Migrate` / `Delete`)

### 2.1 Core Shared Engine (`src/engine/` — 2,047 lines)

| File | Lines | Decision | Rationale & Required Changes |
| --- | --- | --- | --- |
| `src/engine/types.ts` | 385 | **Migrate** | Strong event/session/attribution contracts. Add client portal types (milestones, requests, documents, messages, approvals), team/hierarchy & drilldown permission types, capacity/shift-calendar/leave types, and multi-tenant branding/AI opt-in config fields. Rename any `chronoflow` comments if present. |
| `src/engine/privacyFilter.ts` | 149 | **Keep** | Clean `PRIV-1`/`PRIV-2` boundary (`FORBIDDEN_METADATA_KEYS`, `sanitizeAndFilterEvent`). Reuse directly inside Desktop Agent instead of duplicated `isExcluded()` substring helper; add unit tests. |
| `src/engine/sessionizer.ts` | 239 | **Keep** | Clean UTC chronological merge, 30s interruption bridge, client/period clustering, idle closing. Add comprehensive unit tests (interleaved clients, midnight UTC boundaries, missing duration fallback). |
| `src/engine/entityExtractor.ts` | 206 | **Keep** | Solid regex + dictionary extractor (domains, folder patterns, client codes, aliases, periods, doc types, activity rules). Add unit tests & benchmark coverage. |
| `src/engine/attributionEngine.ts` | 549 | **Migrate** | Deterministic 5-signal scoring, context propagation, retroactive revision, auto-checklist generator, shift handoff summaries. Persist retroactive revisions as durable `state.session_attributed` events and verify `todayIso` uses UTC calendar correctly across shifts. |
| `src/engine/csvDictionaryParser.ts` | 163 | **Keep** | Clean CSV/TSV/JSON/folder-list parser. Add unit tests for malformed CSVs, quoted fields, restricted user IDs. |
| `src/engine/simulatorAndReplay.ts` | 356 | **Migrate** | Useful offline replay harness and benchmark metrics (`runReplayHarness`). Separate test/demo fixtures from production bundle (`simulator` moved to dev/test fixtures or gated behind `DEMO_MODE=true`). |

### 2.2 Backend (`server/` & `server.ts` — 5,073 lines)

| File | Lines | Decision | Rationale & Required Changes |
| --- | --- | --- | --- |
| `server.ts` | 1,272 | **Migrate (Split)** | Decompose into modular Express routers (`auth`, `engine`, `capacity`, `portal`, `admin`, `ai`), WS gateway (`LISTEN/NOTIFY`), Zod validation, `helmet`, CORS allowlist, rate limiting, CSRF, `/healthz` + `/readyz` + `/metrics`, graceful shutdown, and compiled JS entry (`dist/server.js`). Remove unauthenticated `firm_demo` fallback in production, remove `previewRole` spoofing, remove unauthenticated `/api/reports/generate`, gate `/api/engine/package/:kind` behind auth (never embed tokens in query params). |
| `server/auth.ts` | 171 | **Migrate (Replace)** | Currently verifies Firebase RS256 JWKS and generates `cf_dev_*` device tokens. **Delete Firebase JWKS logic**; implement self-hosted auth (`argon2id` passwords, TOTP MFA with backup codes, `httpOnly` `SameSite=Lax` cookie sessions, invite tokens, password reset, session list/revoke, optional per-tenant OIDC SSO, `ontrack_dev_*` device tokens, and separate `client_portal` principal). |
| `server/sqlAdapter.ts` | 344 | **Migrate** | Currently runs ad-hoc `CREATE TABLE IF NOT EXISTS` and rewrites `?` -> `$1` with filename `chronoflow-engine.db`. Add versioned SQL migration runner (up + rollback), PostgreSQL connection transaction wrapper running `SET LOCAL app.tenant_id = ...` + RLS policies, rename SQLite file to `ontrack-engine.db` (dev/test only). |
| `server/engineStore.ts` | 2,194 | **Migrate (Split)** | Too large for one module. Split into repositories/services (`tenantRepo`, `eventIngestService`, `attributionService`, `freshnessService`, `capacityService`, `portalService`, `auditService`, `deviceRepo`). Fix `getDeviceFreshness` shift window logic & IT delayed alert dispatch; fix `getEngineSnapshot` `VIS-1`/`VIS-2`/`PORT-1` permission enforcement; replace in-memory `lateUpdateNoticeByTenant` Map with DB state. |
| `server/fileStorage.ts` | 93 | **Migrate** | Good path-confinement & SHA-256 hashing. Add optional S3-compatible object storage adapter behind storage interface (local disk default per `DEP-1`) and magic-byte/MIME validation. |

### 2.3 Collectors (`packages/` — 783 lines)

| File | Lines | Decision | Rationale & Required Changes |
| --- | --- | --- | --- |
| `packages/desktop-agent/src/agent.ts` | 442 | **Migrate** | Fix branding (`onTrack` -> `OnTrack`), remove `CHRONOFLOW_*` fallback envs, authenticate loopback bridge (`127.0.0.1:47621` shared secret + extension origin check, remove `Access-Control-Allow-Origin: *`), replace naive `isExcluded()` with `sanitizeAndFilterEvent`, **do not clear `.ontrack-offline-queue.jsonl` until `sync:ack` arrives**, encrypt/protect offline buffer, support MSI/PKG/DEB & auto-update manifest. |
| `packages/desktop-agent/src/adapters/osCollector.ts` | 171 | **Migrate** | **Critical Windows defect:** spawns `powershell` compiling inline C# via `Add-Type` every 5 seconds. Replace with persistent helper / native Win32/N-API or compiled lightweight helper binary + real active document path capture (Windows UIA/OpenFiles/Office/QuickBooks handles, macOS AppleScript/AX, Linux X11 + documented Wayland/GNOME/Sway support). |
| `packages/desktop-agent/package.json` | 10 | **Migrate** | Update branding (`onTrack` -> `OnTrack`), add build/bundle/signing scripts and Node/native packaging metadata. |
| `packages/desktop-agent/README.md` | 14 | **Migrate** | Update to **OnTrack** and document installer/MDM deployment (Intune, Jamf, GPO) & Wayland notes. |
| `packages/browser-extension/background.js` | 123 | **Migrate** | Include bridge secret/token handshake on `127.0.0.1:47621`, ensure query-param stripping & incognito drop unit tests pass, align branding. |
| `packages/browser-extension/manifest.json` | 20 | **Migrate** | Rename `onTrack` -> `OnTrack`, prepare Chromium/Edge enterprise force-install manifest & Safari/Firefox build variants. |
| `packages/browser-extension/README.md` | 13 | **Migrate** | Update branding to **OnTrack** and MDM policy docs. |

### 2.4 Frontend Application (`src/` — excluding `src/engine/`)

| File | Lines | Decision | Rationale & Required Changes |
| --- | --- | --- | --- |
| `src/firebase.ts` | 78 | **Delete** | Firebase Auth + Firestore initialization. Must be removed completely to unblock on-premises deployment. |
| `src/services/firestoreWorkspace.ts` | 837 | **Delete** | Legacy personal Firestore CRUD & real-time listener. Replaced by backend PostgreSQL/SQLite REST + WebSocket APIs. |
| `src/services/engineClient.ts` | 702 | **Migrate (Split)** | Remove `firebase.ts` import (`getFirebaseIdToken`), rename `chronoflow_engine_*` localStorage keys to `ontrack_engine_*`, use `httpOnly` cookie session auth (`credentials: 'include'`), do not clear local queue until ack verified, split into typed API client modules (`auth`, `engine`, `capacity`, `portal`, `admin`). |
| `src/App.tsx` | 1,600 | **Migrate (Rewrite/Split)** | Currently couples Firebase Auth, legacy localStorage personal tracker (`chronoflow_*`), active stopwatch, and tabs into a single 1,600-line root. Replace with React Router + lazy-loaded feature routes, session auth provider, role-aware navigation (Accountant, Team Lead, Line Manager, Executive, Client Portal, Admin/IT), and explicit `DEMO_MODE`-only sandbox banner. |
| `src/components/LandingPage.tsx` | 534 | **Migrate** | Currently displays `onTrack`, Google/Firebase sign-in, Local Browser Mode, and an AI-generated illustration image (`hero_ontrack_workspace_1795323315338.jpg`). Update to **OnTrack**, self-hosted Email/Password + MFA/OIDC sign-in + Client Portal login link, privacy disclosures, and **real captured screenshots** of the built app (Phase 5). |
| `src/assets/images/hero_ontrack_workspace_1795323315338.jpg` | (794 KB) | **Delete** | Generated workspace artwork (`hero_ontrack_workspace...`). Replace with real application screenshots in Phase 5. |
| `src/components/AutoTrackView.tsx` | 2,829 | **Migrate (Split)** | Core engine UI (review tray, auto-checklists, device freshness, client/activity/privacy dictionaries, device pairing, replay/acceptance). Split into focused feature modules: `ReviewDayView`, `CaptureHealthView`, `DictionariesAdminView`, `DevicesAndPackagesView`, `ChecklistPanel`, `ShiftHandoffView`. Remove `firebase/auth` `User` prop & `chronoflow`/demo leakage. |
| `src/components/TimelineView.tsx` | 1,591 | **Migrate** | Reusable 3-track visual timeline (`TimeBlock`, app usage, document usage). Re-back with OnTrack Engine `WorkSession` + `AttributionRecord` API data (for Accountant own timeline and audited Manager drill-down), remove `ManicTime` copy and legacy `seedData` constants. |
| `src/components/TaskWorkspaceView.tsx` | 1,008 | **Migrate (Trim)** | Reuse Kanban/List task board backed by `EngineTask` + `TaskTemplate` checklist APIs; strip `localStorage`/Firestore personal tasks and `seedData.ts` software-engineering projects. |
| `src/components/TaskGanttView.tsx` | 518 | **Migrate** | Reuse Gantt timeline for Manager/Team Lead task & deadline planning backed by `EngineTask` due dates, estimates, and actual tracked effort. |
| `src/components/TaskCalendarView.tsx` | 451 | **Migrate** | Reuse Calendar view for shift schedules, leave, and task due dates (`Deadline Risk` / recurring schedule integration); remove `ManicTime` copy. |
| `src/components/AnalyticsView.tsx` | 473 | **Delete (or Replace)** | Built strictly for personal `TimeBlock`/`ActivitySegment` local data with zero freshness, zero shift calendar, zero capacity/utilization, and `ManicTime` copy. Replace in Phase 3 with dedicated **Capacity Heatmap, Planned vs Actual, Deadline Risk, Forecast, and Utilization** views (`FRESH-2` compliant). |
| `src/components/WeeklyReportView.tsx` | 949 | **Migrate (Refactor)** | Currently triggers unauthenticated `/api/reports/generate` sending raw task titles/notes/apps/docs to Gemini (`ManicTime` prompt text). Convert into **Aggregate Firm/Team Weekly Export** (deterministic Markdown/PDF from DB aggregates; AI narrative strictly off by default, opt-in per tenant, aggregates-only payload). |
| `src/components/ActiveTimerBar.tsx` | 376 | **Migrate** | Useful explicit active-task anchor bar (Signal 1 in attribution engine!). Rewire to emit `state.task_status` / active-task focus updates to `/api/engine/sync` and remove `ManicTime` references & hardcoded software-dev seed defaults. |
| `src/components/IdleReconcileModal.tsx` | 244 | **Migrate** | Useful idle-time tagging modal (matches requirement: *"Idle time (meetings, calls, paper review) can be tagged by the user afterwards"*). Rewire to resolve idle `WorkSession` attributions via `/api/engine/attributions/:id/resolve` and remove `ManicTime` text. |
| `src/components/QuickLogModal.tsx` | 403 | **Migrate** | Useful manual entry modal (*"manual entries are allowed"*). Rewire to create manual session/attribution entries via `/api/engine/sync` backed by tenant clients/tasks instead of personal `seedData` projects; remove `ManicTime` text. |
| `src/components/AccountModal.tsx` | 453 | **Delete (Replace)** | Coupled to Firebase Google Sign-In, Firestore profile/workspace migration, and `onTrack` branding. Replace with **Account & Security Settings** (profile, change password, TOTP MFA enroll/verify, active sessions list + revoke). |
| `src/components/DataPreferencesModal.tsx` | 186 | **Migrate** | Keep light/dark theme toggle + workstation idle threshold preference; remove local JSON workspace reset/seed hacks and `ManicTime` copy. |
| `src/components/TopBar.tsx` | 104 | **Migrate** | Rename `onTrack` -> `OnTrack`, remove `firebase/auth` prop, render role-scoped routes, user/tenant indicator, MFA badge, and sign-out action. |
| `src/components/ErrorBoundary.tsx` | 81 | **Keep (Clean)** | Update `onTrack` -> `OnTrack` and remove Firestore JSON error parsing fallback. |
| `src/types.ts` | 157 | **Delete (Merge into `src/engine/types.ts` / feature types)** | Legacy personal time-tracker types (`UserProfile` with `hourlyRate`, local `TimeBlock`, `Task`) duplicated alongside `src/engine/types.ts`. Unify into engine-backed domain types. |
| `src/data/seedData.ts` | 900 | **Delete (Extract formatters/colors)** | Personal software-engineering demo tasks (`VS Code`, `intervalTree.ts`, `ChronoFlow`, `ManicTime`). Extract small pure utilities (`formatDuration`, `formatMinutesToHHMM`) into `src/utils/time.ts` and move any demo fixtures cleanly into server/dev seed scripts. |
| `src/main.tsx` | 10 | **Keep** | Root mount. Update to wrap React Router `BrowserRouter` + AuthProvider in Phase 5. |
| `src/index.css` | 47 | **Keep** | Clean Tailwind v4 + font tokens + print styles. |

### 2.5 Root Config, Security, Deployment & Artifacts

| File | Lines | Decision | Rationale & Required Changes |
| --- | --- | --- | --- |
| `package.json` | 45 | **Migrate** | Name is `"react-example"`. Rename to `"ontrack"`, fix `esbuild` conflict, pin standard TypeScript (or verified Vite/TS pairing), remove `firebase` + `@firebase/eslint-plugin-security-rules`, add `argon2`, `otpauth` (or TOTP), `openid-client` (OIDC), `helmet`, `express-rate-limit`, `cors`, `zod`, `cookie-parser`, `vitest`, `@playwright/test`, ESLint TS plugins; build `"start": "node dist/server.js"`. |
| `bun.lock` | 1,073 | **Delete / Replace with `package-lock.json`** | `Dockerfile` uses `npm ci`, which requires `package-lock.json`. |
| `index.html` | 21 | **Migrate** | Update `onTrack` -> `OnTrack`, remove "AI-generated weekly progress reports" marketing placeholder from `<meta description>`. |
| `metadata.json` | 6 | **Migrate** | Rename `"ChronoFlow..."` -> `"OnTrack — Accounting Resource Management & Auto-Tracking"` and remove `"ManicTime-inspired"` description. |
| `vite.config.ts` | 22 | **Migrate** | Replace `__dirname` with `import.meta.dirname` (fixes Vite 8 warning) and configure manualChunks / route-level code splitting. |
| `tsconfig.json` | 28 | **Migrate** | Enable `strict: true` and separate client/server build configs (`tsconfig.server.json`) so production runs compiled JS (`dist/server.js`) without `tsx`. |
| `eslint.config.js` | 11 | **Migrate** | Remove `@firebase/eslint-plugin-security-rules` and `ignores: ['src/**/*', '*.ts', '*.tsx', '*.js']`; enable real TypeScript + React Hooks ESLint enforcement. |
| `Dockerfile` | 19 | **Migrate** | Multi-stage build, `npm ci`, compile TS server + Vite client, non-root `node` user, `HEALTHCHECK` hitting `/healthz`, `CMD ["node", "dist/server.js"]`. |
| `docker-compose.yml` | 36 | **Migrate** | Rename `chronoflow` user/DB defaults to `ontrack`, remove unsafe fallback passwords without explicit `.env` warning, add healthchecks and optional Caddy/Nginx TLS reverse proxy notes. |
| `.env.example` | 16 | **Migrate** | Replace `chronoflow` DB example, document `SESSION_SECRET`, `COOKIE_SECURE`, `DATABASE_URL`, `SMTP_*`, `DATA_DIR`, `DEMO_MODE`, `AI_REPORTS_ENABLED`, `OIDC_*`. |
| `DECISIONS.md` | 21 | **Migrate** | Update title/content from `ChronoFlow` / `node:sqlite`-primary to **OnTrack** / PostgreSQL + RLS production architecture. |
| `firebase-applet-config.json` | 11 | **Delete** | Committed Firebase config/API keys; blocks pure on-prem model and exposes project config. |
| `firebase-blueprint.json` | 560 | **Delete** | Legacy Firestore entity blueprint referencing `ChronoFlow` and `ManicTime`. |
| `firestore.rules` | 362 | **Delete** | Legacy Firestore rules; Firebase is being removed. |
| `security_spec.md` | 29 | **Delete (or Replace)** | Legacy "ChronoFlow Security Specification" for Firestore dirty-dozen payloads; replace with OnTrack Multi-Tenant RLS, Auth, and Privacy Security Spec. |
| `public/assets/aistudio/Requirements_...md` | 460 | **Keep** | Source-of-truth customer requirements document. |
| `data/chronoflow-engine.db*` & `data/uploads/...` | (runtime) | **Delete (from repo/runtime) & Gitignore** | Leftover smoke-test DB & CSV artifact (`fil-1795322718270-f2179e5a_smoke-test.csv`). Must be gitignored and excluded from Docker images. |

---

## 3. Dependency Audit

### Installed Top-Level Dependencies (`npm list --depth=0`)
- **To Remove:**
  - `firebase@13.4.0` — Cloud-only vendor dependency (Firebase Auth & Firestore); blocks on-premises deployment.
  - `@firebase/eslint-plugin-security-rules@0.0.2` — Only used for deleted `firestore.rules`.
  - `@google/genai@2.32.0` — Evaluate: keep server-side **only** behind strict per-tenant opt-in (`off` by default) and aggregates-only sanitization, or isolate behind an optional provider adapter.
- **Misconfigured / Version Conflicts:**
  - `package.json` has `"esbuild": "^0.25.0"` while `vite@8.3.8` expects `peerOptional esbuild@"^0.27.0 || ^0.28.0"`, causing `npm install --package-lock-only` to abort with `ERESOLVE`.
  - `package-lock.json` is missing while `Dockerfile` executes `npm ci`.
  - `typescript@7.0.2` (TS 7 native preview / pre-release semantics) — verify compatibility or pin standard `typescript` + `@typescript-eslint/*`.
  - `tsx@4.23.15` is used in `"start": "tsx server.ts"` (dev runtime in production). Production must execute compiled JS (`node dist/server.js`).
  - `eslint@10.15.0` is installed, **but** no `typescript-eslint` or React ESLint plugins are installed and `eslint.config.js` ignores all `.ts`/`.tsx`/`.js` files.
- **Missing Production Dependencies Needed Across Phases 1–7:**
  - **Auth & Security:** `argon2` (argon2id password hashing), `otpauth` + `qrcode` (TOTP MFA), `openid-client` (optional per-tenant OIDC SSO), `helmet`, `cors`, `express-rate-limit`, `cookie-parser`, `zod` (strict runtime schema validation).
  - **Email & Scheduling:** `nodemailer` (SMTP invite / password reset / IT delayed-device alert / client portal notification emails).
  - **Frontend Routing & Architecture:** `react-router-dom` (route-based lazy loading to split the 1.47 MB bundle).
  - **Testing:** `vitest` (unit + API/DB integration + load/latency harnesses), `supertest` (HTTP endpoint tests), `@playwright/test` (E2E browser & portal tests).

---

## 4. Top Technical, Security & Operational Risks

1. **CRITICAL — Partial Tenancy & Missing PostgreSQL RLS (`server/sqlAdapter.ts`, `server/engineStore.ts`):** Tenant isolation relies solely on manual `WHERE tenant_id = ?` clauses in code. There is no `SET LOCAL app.tenant_id` transaction boundary and zero PostgreSQL RLS policies. Two tenants (`firm_demo`, `firm_apex`) are hardcoded in `server.ts` and `engineStore.ts`.
2. **CRITICAL — Unauthenticated Demo Fallback & Role Spoofing (`server.ts:57-180`):** Any request omitting `tenantId` or passing `tenantId=firm_demo` bypasses authentication and accepts `previewRole`/`previewUserId` freely. There is no `DEMO_MODE` environment gate separating dev demo sandboxes from production builds.
3. **CRITICAL — Real-Time WebSocket `VIS-1` Leak & Single-Instance State (`server.ts:196-235`):** `broadcastEngineUpdate` blocks `accountant` (non-self) and `client`/`admin_it` (`activity:updated`), **but does NOT filter `activity:updated` away from `executive` or `line_manager`**, nor does it enforce team hierarchy or `restrictedUserIds` on WS pushes. Additionally, `subscribers` and `lateUpdateNoticeByTenant` live in single-process memory (no Postgres `LISTEN/NOTIFY`).
4. **HIGH — Unauthenticated Gemini Endpoint Leaking Metadata (`server.ts:354-502`):** `POST /api/reports/generate` has **no auth middleware**, cannot be disabled per tenant, and forwards raw task titles, project names, time-block notes, app names, and document names to an external LLM API (`gemini-3.8-flash`).
5. **HIGH — Failing `FRESH-1` Acceptance Check & Flawed Shift Logic (`server/engineStore.ts:1694-1700`, `2165-2172`):** `getDeviceFreshness` evaluates `r.shift_pattern === '5-9'` statically rather than checking real UTC shift windows (`shift_start_hour_utc`..`shift_end_hour_utc`), never dispatches IT/admin alerts, and currently **fails** `FRESH-1` on `/api/engine/acceptance`.
6. **HIGH — Desktop Agent Performance & Loopback Security (`packages/desktop-agent/`):**
   - `osCollector.ts` spawns a fresh `powershell.exe` process and compiles inline C# via `Add-Type` every 5 seconds on Windows (high CPU/AV-trigger risk).
   - `filePath` is merely a regex match on the window title rather than actual open file paths.
   - `agent.ts` loopback HTTP server (`127.0.0.1:47621`) sets `Access-Control-Allow-Origin: *` with no auth token/secret, letting any local process or malicious browser tab inject spoofed browser events.
   - `flushQueue()` deletes `.ontrack-offline-queue.jsonl` immediately after `wsClient.send()` *before* receiving `sync:ack`.
7. **HIGH — Unauthenticated Package Export & Query Token Exposure (`server.ts:1184-1249`):** `/api/engine/package/:kind` requires no authentication and accepts `deviceToken` via URL query string (exposing bearer secrets in proxy/server access logs).
8. **HIGH — Broken Container Build & Missing Migrations (`Dockerfile`, `sqlAdapter.ts`):** `Dockerfile` runs `npm ci` (fails without `package-lock.json`), runs as `root`, runs TypeScript via `tsx`, has no `HEALTHCHECK`, and lacks versioned DB migrations with rollback.
9. **HIGH — Missing Core Product Modules (`PORT-1/2`, `CAPACITY`):** The entire Client Portal (intake, confirmed milestones, withdrawals, documents, approvals, messages, notifications, branding) and Capacity/Deadline Risk/Forecast/Utilization dashboards are missing.
10. **MEDIUM — Maintainability & Bundle Size:** `AutoTrackView.tsx` (2,829 lines), `engineStore.ts` (2,194 lines), `App.tsx` (1,600 lines), `TimelineView.tsx` (1,591 lines), and `server.ts` (1,272 lines) create high regression risk; frontend builds into a single `1.47 MB` JS bundle with zero code splitting.
11. **MEDIUM — Inconsistent Naming & Residual Legacy References:** 29+ files still reference `ChronoFlow`, `chronoflow`, `react-example`, `ManicTime`, or lowercase `onTrack`.
12. **HIGH — Zero Automated Test Suite:** No unit, integration, API authorization, latency, portability, or E2E browser tests exist outside the 12 synthetic checks inside `engineStore.ts`.
