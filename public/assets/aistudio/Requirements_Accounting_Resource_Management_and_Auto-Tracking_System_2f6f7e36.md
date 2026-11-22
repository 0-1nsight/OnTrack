# Requirements: Accounting Resource Management and Auto-Tracking System

Nov 21, 2026 · @M

## Purpose and scope

The system automatically records what each accountant works on, attributes it to clients and tasks, and shows managers, executives and clients the current state of that work. The first deployment is one firm with 200 staff: a hybrid team on two shifts (8-5 and 5-9) plus a fully remote group. It must be configurable enough to sell to other firms.

**Goals**

- Remove manual time entry and task documentation: the checklist and timesheet write themselves, and the user edits instead of typing.
- Give every level of the organization a current view of what is being worked on, limited by role.
- Show capacity: whether there is room for more work, based on timelines, progress and shifts.
- Give clients a trustworthy view of the progress of their requests.
- Never let a decision be made on stale data without the viewer knowing it is stale.

**In scope for v1**

- Desktop agent and browser integration that capture activity metadata
- Attribution of activity to client, task and checklist step, with user review
- Role-based dashboards, capacity and deadline-risk views
- Real-time sync with visible freshness
- Client portal showing confirmed milestones
- Multi-firm configuration (roles, shifts, templates, dictionaries, branding, retention)

**Out of scope for v1**

- Integrations with third-party applications (accounting software, Microsoft 365, Google Workspace). The product works from what is visible on the device.
- Screenshots, keystroke logging, or capture of document contents
- Physical location tracking
- Self-service billing and sign-up for new firms (built when a second customer exists)

## Users, roles and visibility

What a person sees depends on their role, and the server enforces it, not only the screen.

| Role | Can see | Cannot see by default |
| --- | --- | --- |
| Accountant | Own tasks, timeline, checklist, time and workload | Other staff's activity |
| Team lead / manager | Own space plus direct reports' tasks, progress, workload and aggregated time | Direct reports' minute-by-minute timelines |
| Line manager | Teams below them: capacity, bottlenecks, deadline risk | Individual timelines |
| Executive / owner | Firm-wide utilization, deadlines at risk, effort per client, data freshness | Individual timelines |
| Client | Own requests, confirmed milestones, document requests, messages | Any internal activity or staff data |
| Admin / IT | Configuration, users, device sync health | Client work content |

**Rules**

1. Visibility is enforced at the data layer (row-level security by tenant, team and client) and again on every real-time subscription, so a push update never reaches someone who could not open the record.
2. A "restricted client" flag limits a sensitive client to named people regardless of hierarchy.
3. A manager viewing an individual's detailed timeline is a separate permission, and every such view is written to an audit log.
4. Staff can always see their own data, including what the system has recorded about them.

## Auto-tracking engine

Auto-tracking is the core of the product: it turns raw computer activity into an accurate record of work, and everything else depends on it. It captures metadata only, never content.

**Two collectors, merged on the device**

| Collector | Answers | Captures | Cannot see |
| --- | --- | --- | --- |
| Desktop agent (Windows, macOS, Linux) | Where is the user's attention? | Foreground app, window title, files opened or saved, active vs idle, meeting apps running | The URL inside a browser |
| Browser extension (Chrome, Edge, Firefox, Safari) | What exactly is open in the browser? | URL (domain and path), page title, tab switches, single-page navigation, incognito state, download and upload file names | Anything outside the browser, idle state |

The extension talks to the local agent, which joins both streams by timestamp, applies privacy filters in one place, and owns the single sync path. If the extension is missing or unsupported, the agent falls back to window titles and marks those events lower confidence.

**Pipeline**

1. Collect raw events from both collectors.
2. Normalize them into one event format across operating systems and browsers.
3. Filter on the device: apply exclusions and redaction before anything syncs.
4. Sessionize: group events into blocks of related work. A brief glance at chat does not break a block, and events sharing a client, file or period cluster together even when interleaved. A long idle gap closes a block.
5. Attribute each block to a client, task and step (next section).
6. Summarize blocks into checklist items and handoff notes.
7. Learn from the user's corrections.

**Operational requirements**

- Event-driven capture on window or tab change, plus a heartbeat every 10-15 seconds.
- Local buffering so recording continues offline.
- One agent adapter per operating system, code-signed, deployable through the firm's device management (for example Intune, Jamf or Group Policy), with the extension force-installed by browser policy.
- Idle time (meetings, calls, paper review) can be tagged by the user afterwards, and manual entries are allowed.
- Attribution is by login, so shared machines across shifts must use separate user sessions.
- Remote staff who work through a remote or virtual desktop need the agent to run inside that session. This is the largest technical risk and must be checked first in the pilot.

## Attribution and auto-checklists

The engine decides which client, task and checklist step each block of activity belongs to, shows its confidence and reason, and never guesses silently.

**What it extracts from titles, paths and URLs**

- **Client**, matched against a client dictionary of legal names, aliases, abbreviations, codes, folder names and known domains
- **Period** (for example Oct 2026, Q3, FY25), which separates the October close from the September close
- **Document type** (bank statement, invoice, payroll register, tax return)
- **Activity type**, from a per-firm activity dictionary (for example a title containing "Reconcile" means reconciliation), editable by admins

**Signals used to score candidate tasks**

1. The user's explicitly active task (strongest)
2. Client and period matches in the window title, file path or URL
3. Today's task list and due dates
4. Context from neighboring blocks
5. What this user did in similar past situations

**Confidence handling (proposed defaults, tuned in the pilot)**

| Confidence | Behavior |
| --- | --- |
| 0.85 or higher | Assigned provisionally, shown as detected |
| 0.50 to 0.85 | Suggested, awaiting one-click confirmation |
| Below 0.50 | Goes to the "Review your day" tray, never assigned silently |

**Two techniques that matter most**

- **Context propagation:** an ambiguous block (an untitled spreadsheet) inherits attribution from adjacent blocks that point to the same client.
- **Retroactive attribution:** when a strong signal arrives later (the client's file opens in the accounting software), earlier ambiguous blocks are re-assigned and the revision is published as an event.

**Auto-checklists**

Each task template defines ordered steps, and each step has an activity signature (for example: window title contains "reconcil", same client and period). Matching blocks mark a step as detected, suggested or confirmed. Activity that fits no step becomes a free-form item such as "Reviewed Acme\_Oct2026\_BankStatement.pdf, 14 min". The user can edit, merge, reorder or delete any item, and can click the timeline, select a block of time or a document, and assign it to a task.

**Learning loop**

- Every item can answer "why was this assigned here?"
- A correction offers to become a rule ("Always treat files named Acme\* as Acme Ltd?"), and a rejected offer teaches the model what not to generalize.
- Daily review should take under five minutes.

## Real-time sync and data freshness

Two failures must be prevented: an accountant completes a task and managers or clients do not see it, and a decision-maker acts on out-of-date numbers without knowing it. Zero latency is impossible (laptops sleep, connections drop), so the rule is that the system never presents old data as current.

**Latency targets by data type**

| Data | Example | Target to all permitted viewers |
| --- | --- | --- |
| State changes | Task completed, status change, step confirmed | Typically 2 seconds or less, 95th percentile 5 seconds |
| Live presence | "Working on Acme ledger now" | 15 seconds |
| Detected activity | New checklist step detected | 30 seconds |
| Aggregates | Capacity, utilization, deadline risk | 60 seconds |
| Offline backlog | Events recorded while disconnected | Starts the moment the device reconnects, state changes first |

**How it works**

- Each agent keeps a persistent connection (WebSocket, with HTTPS polling every few seconds as a fallback behind restrictive proxies) and sends events as they happen. State changes use a high-priority path and are never batched.
- Dashboards and the portal subscribe over WebSocket or server-sent events. The server pushes each change to every permitted viewer without a refresh.
- Events pass through a durable queue, so nothing is lost if a processor restarts.
- The server is the source of truth for status. "Complete" only counts once the server acknowledges it.
- Events carry a client-generated ID and a per-device sequence number, so retries never duplicate and gaps are detected. Agents correct their clocks against server time.

**Offline and reconnect behavior (decided)**

- Sync is silent. The agent sends everything automatically as soon as a connection returns, with no prompt. The user sees only a small indicator: Synced, Syncing, or Offline with changes saved on this device.
- On reconnect, state changes are sent first, then the activity backlog.
- If a task was marked complete offline and someone else changed it in the meantime, the system does not pick a winner. It shows a short "review this conflict" notice and keeps both versions until resolved.

**Freshness indicators**

- A device is Live while heartbeats arrive normally. If a device is silent for more than 2 minutes during a scheduled shift, the person's status turns amber ("delayed, last synced 2 min ago") and IT or an admin is notified, not the person's manager.
- Staff who are off shift or on leave are never flagged.
- The system distinguishes "no activity" from "no data": a person with zero hours is different from a person whose device has not reported.
- Every aggregate shows a "data as of" time and how many people are reporting, for example "188 of 200 staff reporting live". If missing people could change the figures materially, the total is marked provisional.
- When late data arrives, affected aggregates are recomputed and pushed with a small "updated" marker. Events store both the time the work happened and the time the server received it.

## Client portal

Clients see confirmed milestones only. The attribution engine's guesses (detected or suggested items) never appear in the portal, and raw activity such as which app was open is never exposed.

**What the portal provides**

- Request intake: a form that creates a task from the firm's template
- Status tracker with simple stages and expected dates, for example Documents received, In review, Awaiting your approval, Complete
- Secure document requests and uploads, with automatic reminders
- Approvals and signatures
- A message thread attached to each request
- Notifications when a milestone is confirmed

**Rules**

1. A milestone is published the moment it is confirmed by a person, or by a rule the firm has explicitly marked as trusted, and it appears in the portal in the same real-time path as internal views.
2. Every portal view shows a "last updated" time.
3. If a confirmed milestone is later withdrawn, the portal shows the correction with its time instead of silently changing.
4. Each firm controls branding (logo, colors, domain, wording) and the milestone names for each task template.
5. Clients can only open their own requests, enforced on the server like every other role.

## Capacity and deadline risk

Capacity needs planned work as well as tracked work: estimates, deadlines, leave and tasks not yet started. Activity data alone only shows what has already happened.

| View | Audience | What it shows |
| --- | --- | --- |
| Workload heatmap | Managers, line managers | Each person's assigned hours against available hours per week, net of leave, meetings and shift pattern |
| Planned vs actual | Managers, executives | Estimated against tracked hours per task and client, to improve estimates |
| Deadline risk | All management | Tasks whose remaining work exceeds the time left; progress comes from confirmed checklist steps plus tracked effort |
| Forecast | Line managers, executives | Recurring work (monthly close, quarterly filings, tax season) projected forward so a crunch is visible weeks ahead |
| Utilization and profitability | Executives | Hours spent against fees per client |
| Shift handoff | Accountants on the next shift | A "where I left off" summary per task: last documents, last steps, notes |

**Rules**

- Capacity is calculated per person from their shift calendar (8-5, 5-9, remote hours, leave), not from a flat 40-hour week.
- All times are stored in UTC and displayed in local time.
- Every capacity and risk figure carries the freshness information described above, including how many people are reporting, and is marked provisional when missing data could change it.
- Provisional (detected or suggested) work is shown as such and counted as confirmed progress only after confirmation.

## Privacy and employee trust

Staff adoption is the biggest threat to the product: if people resist, the data is useless. The design positions the tool as one that writes their timesheet and task notes for them, and limits what it records.

**Never captured**

- Screenshots, keystrokes, clipboard, or the contents of documents, emails or pages
- Physical location
- Private or incognito browser windows (ignored by default)

**Controls**

- Employees see their own recorded data first and can edit, delete, or pause recording at any time.
- Exclusion lists for apps and domains (personal, banking, health) are applied on the device, so excluded activity never leaves it. Firms can edit the lists.
- Managers see aggregates by default. Drilling into one person's timeline is a separate permission and is logged in an audit trail.
- Retention is configurable per firm. Proposed default: raw events kept 30 to 90 days, after which only confirmed sessions and checklist items remain.
- Each firm decides whether tracking is mandatory or opt-in, and the product records that policy.

**Before rollout**

- A written monitoring policy and staff notice, agreed with HR and legal
- A check against applicable data protection law (for example the Jamaica Data Protection Act 2020) and against client contract terms, with the firm's counsel

## Multi-firm configurability and deployment

The product is built for one firm first but is multi-tenant from the start, with everything firm-specific held in configuration, not code. Whether a customer runs it in the cloud or on its own servers does not change the product.

**Configurable per firm**

- Roles, permission sets and organization hierarchy
- Shift patterns, calendars and leave types
- Task templates, checklist steps and activity signatures
- Client dictionary and activity dictionary
- App and domain categories and exclusion lists
- Status stages and portal milestone names
- Custom fields
- Portal branding (logo, colors, domain, wording)
- Monitoring policy: what is tracked, who can drill down, retention period, mandatory or opt-in
- CSV import for clients and staff, since there are no integrations to pull them from

**Tenant isolation**

Every record carries a tenant ID and is protected by row-level security. Data residency (where a firm's data is stored) is a per-tenant setting.

**Deployment**

- Use portable, containerized components (a standard database, a message queue, a WebSocket gateway) and avoid cloud-only managed services, so the same build runs in the cloud or on a customer's servers.
- The agent and extension take the server address and update channel from configuration, so one build serves both.
- On-premises customers run updates and operations themselves; the latency targets and freshness rules are identical.

## Event schema

Activity and state changes share one envelope, so retries, ordering and gap detection work the same way for both. This draft is the starting point for the pilot.

```json
{
  "event_id": "uuid-generated-on-device",
  "schema_version": 1,
  "tenant_id": "firm_123",
  "user_id": "u_456",
  "device_id": "d_789",
  "seq": 10482,
  "type": "activity.window",
  "priority": "activity",
  "event_time_utc": "2026-11-19T20:14:05Z",
  "received_at": null,
  "payload": {
    "app": "QuickBooks",
    "window_title": "Acme Ltd - Reconcile - Chequing",
    "file_path": null,
    "url": null,
    "duration_ms": 22000,
    "idle": false,
    "provisional_match": {
      "client_id": "c_acme",
      "confidence": 0.91,
      "reason": "client alias 'Acme' in window title"
    }
  }
}
```

**Envelope fields**

| Field | Purpose |
| --- | --- |
| event\_id | Generated on the device; makes retries idempotent |
| seq | Per-device sequence number; lets the server detect gaps |
| tenant\_id, user\_id, device\_id | Isolation and attribution by login |
| type, priority | Event kind; priority is state (never batched) or activity (batched) |
| event\_time\_utc, received\_at | When the work happened vs when the server received it |
| payload | Type-specific content (metadata only) |

**Event types**

- Activity: window, browser, file, idle, meeting, heartbeat
- State: task status change, step confirmed, milestone confirmed. These carry the task ID, from and to values, and an expected version number so two people cannot overwrite each other.

**Derived records**

- **Work session:** start, end, extracted entities (client, period, document type)
- **Assignment:** task, step, confidence, reason, status (detected, suggested or confirmed), version
- **Freshness:** per device, last heartbeat and last acknowledged sequence number

## Pilot plan

Start with shadow mode: run the collectors on 10 to 15 accountants on a single operating system for 2 to 4 weeks, recording only and attributing nothing. Real window titles, file names and URLs at the firm should shape the rules, not guesses.

**What shadow mode produces**

- The real shape of titles, paths and URLs, used to build the client and activity dictionaries
- An early answer on whether remote staff work through a remote or virtual desktop
- Ground truth: the pilot users' manual labels, used to replay draft attribution rules offline and measure accuracy

**Build phases**

1. Foundation: multi-tenant core, clients, task templates, roles and visibility, shift calendars, manual timers, real-time sync and freshness
2. Capture MVP: browser extension and desktop agent on one operating system, personal timeline with manual assign-to-task
3. Rule-based assignment: client dictionary, active-task anchor, review tray
4. Auto-checklists and shift handoff summaries
5. Capacity and deadline-risk dashboards
6. Client portal
7. Further operating systems, learning model, admin customization screens

Real-time sync and freshness belong in phase 1 because every later phase depends on them.

**Success measures (targets are proposals, set after shadow mode)**

| Measure | Target |
| --- | --- |
| Auto-assignment accuracy: share of tracked time assigned correctly without edits | 80% or higher after tuning |
| Daily review time per user | Under 5 minutes |
| Checklist acceptance: auto-generated items the user keeps | Tracked from the first pilot day; target set from shadow-mode results |
| Coverage: share of the workday attributed to something | Tracked from the first pilot day; target set from shadow-mode results |
| Correction rate per user per day | Falls week over week |

## Acceptance criteria

Each requirement below is written so it can be tested. Latency and accuracy figures are proposed targets to confirm in the pilot.

| ID | Requirement | How it is tested |
| --- | --- | --- |
| SYNC-1 | A state change (task completed, status change, step confirmed) reaches every permitted viewer within 5 seconds at the 95th percentile | Mark a task complete on one device and time its appearance on manager and client views |
| SYNC-2 | Live presence updates within 15 seconds | Switch tasks and time the presence change |
| SYNC-3 | Detected activity appears within 30 seconds | Open a client file and time the checklist update |
| SYNC-4 | Aggregates (capacity, utilization, risk) refresh within 60 seconds | Complete work and time the dashboard figure change |
| SYNC-5 | On reconnect, sync starts automatically with no prompt, state changes first, and no event is duplicated | Go offline, work, reconnect, then compare event counts |
| SYNC-6 | A conflicting offline change is never silently overwritten; the user gets a review notice | Edit the same task from two devices, one offline |
| FRESH-1 | A device silent for more than 2 minutes during a scheduled shift shows as delayed and notifies IT; off-shift and on-leave staff are not flagged | Block a device's connection mid-shift and after shift end |
| FRESH-2 | Every aggregate shows a data-as-of time and the number of staff reporting | Inspect each dashboard |
| FRESH-3 | Late-arriving data recomputes affected aggregates and shows an updated marker | Reconnect a device with a backlog and watch the dashboards |
| PORT-1 | The portal shows confirmed milestones only; detected and suggested items never appear | Generate unconfirmed activity and check the client view |
| PORT-2 | Every portal view shows a last-updated time | Inspect the portal |
| VIS-1 | Role visibility is enforced on the server, including real-time subscriptions | Attempt cross-role and cross-team access through the interface and the API |
| VIS-2 | Every drill-down into an individual's timeline is written to the audit log | View a timeline as a manager and check the log |
| PRIV-1 | Excluded apps and domains and incognito windows produce no events that leave the device | Use excluded items and inspect the outbound events |
| PRIV-2 | No screenshots, keystrokes or content are captured or stored | Inspect agent payloads and the database schema |
| ATTR-1 | Every assignment shows a confidence score and a reason | Inspect assignments in the timeline |
| ATTR-2 | Blocks below the review threshold are never assigned silently | Replay low-confidence blocks and check the review tray |
| ATTR-3 | When a strong signal arrives later, earlier ambiguous blocks are re-assigned and the revision is published | Open the client's accounting file after an untitled spreadsheet session |
| ATTR-4 | Auto-assignment accuracy is 80% or higher and daily review takes under 5 minutes | Measure against pilot users' manual labels |
| DEP-1 | The same build runs in the cloud or on-premises with a configurable server address | Deploy both ways and run the SYNC and FRESH tests |

## Open questions and risks

**Open questions**

- [ ] What operating system mix do the 200 staff use (Windows only, or Mac as well)?
- [ ] Where will the client list and tasks come from at launch: manual entry or a spreadsheet import?
- [ ] Will tracking be mandatory for all staff, and have HR and legal reviewed it?
- [ ] Is there a development team, or will this be hired or outsourced?
- [ ] Do remote staff work directly on their own machines or through a remote or virtual desktop?
- [ ] Do any staff share a computer across the two shifts?
- [ ] Where are client files kept, and do folder and file names follow a consistent convention or client code?
- [ ] Which five to ten applications do accountants spend most of their time in?
- [ ] After how long should a delayed device be shown as offline (the 2-minute rule covers only the delayed state)?

**Risks**

| Risk | Mitigation |
| --- | --- |
| Staff resist tracking and the data becomes unreliable | Employees see and control their own data first, managers see aggregates by default, written policy before rollout |
| Remote or virtual desktop sessions hide the real window titles | Check in shadow mode; run the agent inside the session if needed |
| The browser integration is fragile across browser updates | Fall back to window titles and flag lower confidence; test on each browser release |
| Generic window titles make attribution weak | Weight URL paths and file paths more heavily; use context propagation and the review tray |
| Privacy law or client contracts restrict monitoring | Metadata-only capture, on-device filtering, retention limits, review by counsel |
| Scope grows too large to deliver | Build in the phases above and prove the engine in the pilot before the portal and capacity views |

## Appendix: build prompt for the engine

Paste this into a coding assistant such as Claude Code. It is self-contained, so the assistant does not need the rest of this document. The stack and the Windows-first choice are suggestions you can change.

```markdown
You are a senior engineer building the core auto-tracking and attribution engine for an accounting-firm resource management product. Work in small, tested increments. Start by writing a short plan and asking me any blocking questions before you write code.

## Product context
The product automatically records what accountants work on, attributes it to clients, tasks and checklist steps, and shows the current state of work to managers, executives and clients. First customer: one accounting firm with 200 staff, hybrid and fully remote, on two shifts (8-5 and 5-9). It will later be sold to other firms, so it is multi-tenant and everything firm-specific is configuration, not code. It must be platform agnostic and must NOT depend on third-party integrations (no accounting-software, Microsoft 365 or Google APIs). It works only from what is visible on the device.

## Your scope
Build the engine: capture on the device, on-device filtering and sessionizing, sync to the server, server-side attribution, and checklist generation. Dashboards and the client portal are out of scope, but your outputs (events, assignments, freshness state) must be consumable by them.

## Non-negotiable rules
1. Metadata only. Never capture screenshots, keystrokes, clipboard, or the contents of documents or pages.
2. Filter on the device. Exclusion lists (apps, domains, paths) and incognito or private windows are applied before anything is stored for sync or sent.
3. Two collectors, merged on the device: a desktop agent (foreground app, window title, file paths, idle state, meeting apps) and a browser extension (URL, page title, tab switches, incognito state) that talks to the local agent through native messaging. If the extension is absent, fall back to window titles and lower the confidence.
4. Local-first with offline buffering. Sync silently and automatically whenever connected, with no prompts. State changes go first on a high-priority path and are never batched. Activity is batched every few seconds. Every event carries a client-generated ID and a per-device sequence number so retries are idempotent and gaps are detectable. The sync client corrects its clock against server time.
5. Never guess silently. Every attribution has a confidence score, a human-readable reason and a status: detected, suggested or confirmed. Proposed thresholds (configurable): 0.85 or higher is assigned provisionally, 0.50 to 0.85 is suggested, below 0.50 goes to a review tray.
6. The server is the source of truth for status. A task is only complete after the server acknowledges it.
7. Multi-tenant from day one: a tenant ID on every record, row-level security, no firm-specific logic in code.
8. Portable: containerized components and no cloud-only managed services, so the same build runs in the cloud or on-premises. The agent reads the server address from configuration.
9. Store all times in UTC, with both the event time and the server-received time.

## Architecture to implement
Seven-stage pipeline: collect, normalize, filter, sessionize, attribute, summarize, learn.
- Agent adapters per operating system behind one interface. Implement Windows first unless I tell you otherwise, with stubs for macOS and Linux.
- Heartbeat every 10 to 15 seconds so the server can detect silent devices (flag after 2 minutes of silence during a scheduled shift).
- Sessionizer: brief interruptions (configurable, around 30 seconds) do not break a block. Events that share a client, file or period cluster together even when interleaved. A long idle gap closes a block.
- Entity extraction from titles, paths and URLs: client (against a dictionary of names, aliases, codes, folder names and domains, with fuzzy matching), period (Oct 2026, Q3, FY25), document type, and activity type (a per-firm dictionary that admins can edit).
- Scoring signals, strongest first: the user's explicitly active task; client and period matches; today's task list and due dates; neighboring blocks; the user's past corrections.
- Context propagation: an ambiguous block inherits attribution from neighboring blocks that point to the same client.
- Retroactive attribution: when a strong signal arrives later (for example the client's accounting file opens), re-assign the earlier ambiguous blocks and publish the revision as an event.
- Checklist generator: task templates define ordered steps with activity signatures. Matching blocks mark steps detected, suggested or confirmed. Unmatched activity becomes free-form items. Users can edit, merge, reorder and delete items, and can assign any time range or document to a task.
- Learning loop: a user correction can become a rule, and every assignment can explain why it was made.

## Event contract
One envelope for activity and state events: event_id, schema_version, tenant_id, user_id, device_id, seq, type, priority (state or activity), event_time_utc, received_at, payload.
- Activity types: window, browser, file, idle, meeting, heartbeat.
- State types: task status change (with from, to and an expected version to prevent overwrites), step confirmed, milestone confirmed.
- Derived records: work session (start, end, extracted entities), assignment (task, step, confidence, reason, status, version), device freshness (last heartbeat, last acknowledged sequence number).

## Suggested stack (change it if you have a good reason, and tell me why)
Agent in Rust or Go. Browser extension in TypeScript (Manifest V3, Chromium first). Server in TypeScript or Go with PostgreSQL, a durable queue, and a WebSocket gateway with HTTPS polling as a fallback.

## Milestones (finish and test each before starting the next)
1. Shared event schema, validation, and an event simulator that generates realistic accounting activity.
2. Windows agent: collector, normalizer, local store, exclusions, idle detection.
3. Browser extension and native-messaging bridge, with the fallback.
4. On-device sessionizer.
5. Sync: offline buffer, ingestion API, idempotency, ordering, priority path, conflict detection, heartbeats and freshness state.
6. Attribution engine with confidence, reasons, context propagation and retroactive attribution.
7. Checklist generator and the review-tray data model.
8. Replay harness: feed recorded events through attribution offline and report accuracy against labelled ground truth. Targets: 80 percent or higher auto-assignment accuracy and under 5 minutes of daily review per user. This supports a 2 to 4 week shadow-mode pilot in which we only record.

## Testing and acceptance
Write unit tests for every stage and integration tests for sync. At minimum, cover:
- Offline work followed by reconnect produces no duplicate events.
- State changes reach the server before the activity backlog.
- Conflicting offline edits are surfaced for review, never silently overwritten.
- Excluded apps and incognito windows produce no outbound events.
- No payload or schema contains a field for content, screenshots or keystrokes.
- Blocks below the review threshold are never auto-assigned.
- A late strong signal revises earlier assignments and publishes the revision.
- A state change reaches a subscribed viewer within 5 seconds at the 95th percentile.

## How to work
First read the repository if one exists, then reply with your plan, your assumptions, and your questions (operating system mix, source of the client list, whether remote staff use a remote or virtual desktop, whether any computers are shared between shifts). Then build milestone 1. Keep modules small and documented, and record decisions in a short DECISIONS.md file.
```
