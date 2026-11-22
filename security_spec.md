# ChronoFlow Security Specification (Phase 0 TDD)

## 1. Data Invariants
1. **Strict Multi-Tenant User Isolation (PII Protection)**:
   - Every `/users/{userId}` document contains PII (`email`, `displayName`, `photoURL`) and account settings.
   - Only an authenticated, email-verified user where `request.auth.uid == userId` may `get`, `create`, `update`, or `delete` `/users/{userId}`. Collection-level `list` on `/users` is strictly denied (`if false;`).
2. **Master Gate Parent Integrity**:
   - Subcollection items under `/users/{userId}/(tasks|timeBlocks|activitySegments|appSegments|documentSegments|reports)` require `existsAfter(/databases/$(database)/documents/users/$(userId))` on create and `ownerId == request.auth.uid == userId` on every read/write.
3. **Immutable Ownership & Server Timestamps**:
   - `ownerId` and `createdAt` (`request.time`) are immutable after creation.
   - Updates must set `updatedAt == request.time` and only modify explicitly allowlisted action fields.
4. **Schema & Boundary Integrity**:
   - Document IDs must match `^[a-zA-Z0-9_\-]+$` (`<= 128` chars).
   - Every string field enforces strict `size()` limits; arrays (`tags`, `subtasks`, `accomplishments`, etc.) are bounded (`size() <= 30`) and validated.
   - Numeric ranges (`startTime`, `endTime` in `0..1440`, `durationMinutes >= 1`, `hourlyRate >= 0`) are enforced.

## 2. "Dirty Dozen" Adversarial Payloads (Must All Return PERMISSION_DENIED)
1. **Cross-User Profile Read**: Authenticated User B calls `get(/users/userA)`.
2. **User Directory Enumeration**: Authenticated User A calls `list(/users)`.
3. **Unverified Email Write**: User A with `email_verified: false` tries to create `/users/userA`.
4. **UID Spoofing on Task Create**: User A tries to create `/users/userA/tasks/tsk-1` with `ownerId: "userB"`.
5. **Shadow / Ghost Field Injection**: User A creates `/users/userA` with unexpected field `isAdmin: true`.
6. **Privilege Escalation Update**: User A updates `/users/userA` modifying `ownerId` or injecting `role: "admin"`.
7. **Timestamp Forgery on Create**: User A creates `/users/userA/timeBlocks/blk-1` with client `Date` instead of `request.time`.
8. **ID Poisoning**: User A attempts to create `/users/userA/tasks/invalid$id/../hack` or a 500-char ID.
9. **Denial-of-Wallet Oversized String**: User A updates `title` on a task with a 10,000-character string.
10. **Unbounded Tag Array Exhaustion**: User A creates a task with 50 tags (`tags.size() > 20`).
11. **Invalid Enum Injection**: User A creates a time block with `category: "hacking"` or negative `durationMinutes: -50`.
12. **Client-Side List Bypass**: User B attempts `list(/users/userA/timeBlocks)` even with matching filters.
