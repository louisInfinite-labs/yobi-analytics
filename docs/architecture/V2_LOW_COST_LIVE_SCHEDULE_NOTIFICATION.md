# V2 Low-Cost Live-Schedule Notification — Architecture Draft

> ## Status note, November 2026 (added when this draft was tracked in Git)
>
> **This note is not part of the original 2026-10-05 draft.** Everything below the horizontal rule that follows this note is the original draft, kept unchanged as a historical design. Where the two disagree about what exists today, this note is the current statement. It records facts as of `develop` at `dcdf88e` (2026-11-24); it does not redesign anything.
>
> **Status: Proposal / Deferred / Not Implemented.**
>
> - `NEW_SCHEDULE` notifications are **not implemented**. Nothing in `src/`, `terraform/` or `frontend/` on `develop` sends, stores or configures them.
> - **No V2 infrastructure or functionality is approved for implementation** by this note or by the pull request that adds this file. Every design choice below stays an open decision for the owner.
>
> ### Historical assumptions vs current implementation
>
> | Original draft says | Current implementation (source) | Consequence for any future V2 work |
> |---|---|---|
> | There is **no shared Live/Upcoming cache**; each `/live-streams` call queries Holodex (sections 6.1 and 17 item 2). | Superseded. One Holodex request every 10 minutes is stored as a shared snapshot, `GET /live-streams` reads that snapshot and never calls Holodex, and a page view never causes a Holodex request. See [`docs/livestream-10min-shared-snapshot.md`](../livestream-10min-shared-snapshot.md) and `src/tracking/livestream_lifecycle.py`. | The **separate 30-minute Holodex polling job** in section 5 should be reconsidered. A detector that reads the existing snapshot would avoid a second, duplicate poll. The snapshot's 10-minute cadence and freshness rules would then define detection latency instead of section 5.3. |
> | First sighting of a stream needs a new Stream Registry with an atomic conditional-write claim (sections 5.1, 8.1 and 10.2). | The shared `streamSchedule` record already carries a top-level `firstSeen` map (`{videoId: {startMinute, firstSeenAt, priorStartMinutes}}`). It exists so a reminder for a stream that was discovered late can be caught up. See `src/notifications/live_reminder.py` and [`docs/late-discovery-advance-catch-up.md`](../late-discovery-advance-catch-up.md). | `firstSeen` gives **partial first-sighting tracking only**. It does not select subscribers, send anything for a first sighting, or provide the per-video atomic claim and idempotency record this draft describes. Whether it can be a basis for `NEW_SCHEDULE` is undecided. |
> | The existing notification pipeline loads every client on every run, with per-client reads and a 3-day event window (section 6.3). | Changed since the draft. Livestream reminders now find their due streams in memory from the shared schedule and look up only those streams' followers through the `configKey-index` (`src/notifications/reminder_candidates.py`, [`docs/notification-dispatch-due-candidates.md`](../notification-dispatch-due-candidates.md)). New-video push delivery uses per-client local-time slots (`src/notifications/delivery_slots.py`, `src/stores/notification_slot_store.py`). Delivery already uses **server-side notification preferences including quiet hours** (`src/notifications/notification_dispatch.py`), a **delivery log** (`src/stores/notification_delivery_log_store.py`), and **retry of failed reminder pushes** (`src/notifications/reminder_retry.py`). | Section 6.3 describes the pipeline as it was on 2026-10-05 and must not be read as current. Re-verify before relying on either its cost argument or its "do not reuse" conclusion. |
> | Per-creator subscriptions need a **new subscriptions table with a `typeCreator` index** (section 8.2); reusing `YobiRemoteConfig` is the alternative (section 8.4). | Per-creator reminder settings are already stored as `creatorReminder#<creator>#...` items in `YobiRemoteConfig` and are found through the existing `configKey-index` (`src/notifications/reminder_candidates.py`, `src/notifications/premiere_reminder.py`). No `typeCreator` index or `NEW_SCHEDULE` subscription item exists. | The proposed new table and `typeCreator` index should be **reassessed against the existing `configKey-index` architecture** (the section 8.4 alternative, and open decision 1 in section 17). That includes the IAM and Terraform consequences noted there. |
> | `NEW_SCHEDULE` uses **at-most-once** delivery after the claim (section 10.2, open decision 5). | Existing reminder delivery uses a per-recipient delivery claim plus bounded retry of failed sends (`src/notifications/reminder_retry.py`), which is a different trade-off from the one proposed here. | At-most-once versus at-least-once for `NEW_SCHEDULE` **remains an open design decision**. |
>
> ### Decisions this note leaves open
>
> These are recorded, not made. Each needs an explicit owner decision and, where it touches AWS, Terraform or Firebase, separate authorization:
>
> 1. Detection source: read the existing 10-minute snapshot, or poll Holodex separately.
> 2. First-sighting record: extend `streamSchedule.firstSeen`, or add the proposed registry.
> 3. Subscription storage: `YobiRemoteConfig` plus `configKey-index`, or the proposed new table and index.
> 4. Delivery semantics: at-most-once, or at-least-once with a cursor.
> 5. Whether `NEW_SCHEDULE` honors the existing server-side preferences, quiet hours and delivery slots (section 17 item 4).
> 6. Privacy and Security Baseline work listed in sections 14 and 17, which must be completed before any V2 production deployment.
>
> Nothing in this note changes the original proposal text, cost analysis or architecture below.

---

```
Status:                  V2 / Deferred
V1 Launch Requirement:   No
Implementation Status:   Not started
Document type:           Architecture / specification draft (documentation only)
Drafted:                 2026-10-05
```

This feature is **V2, not V1**. It is not a V1 launch requirement and must not become a V1 implementation dependency. Nothing in this document changes existing notification behavior, Terraform, AWS resources or code. It preserves the agreed architecture so it can be built after V1.

Product naming: the public product is **OshiYobi**. Internal identifiers below (table names such as `YobiRemoteConfig`, module names, repository paths) are real internal identifiers and are not renamed here.

---

## 1. Status

| Item | Value |
|---|---|
| Release | V2 |
| V1 launch requirement | No |
| Implementation | Not started; no code, Terraform or AWS change accompanies this document |
| Feature | `NEW_SCHEDULE` Web Push: "a scheduled livestream was discovered for a creator you follow" |
| Depends on V1 work | Nothing; V1 neither needs nor is blocked by it |
| Related V1 documents | Privacy & Data Use draft (must be updated before this ships, section 14); Security Baseline (new routes must meet its controls, section 17) |

---

## 2. Goal

Design the lowest-cost practical AWS architecture to:

- check Holodex for newly announced livestreams every 30 minutes
- notify users when OshiYobi first discovers a new scheduled livestream
- notify only users who explicitly enabled this notification for that creator
- support roughly 500 initial users
- keep incremental AWS cost as close to zero as practical
- avoid any design whose cost scales as `all users × all creators × every poll`

Design principle: **cost scales with real new-stream events and real subscribed recipients, not with registered users on every polling cycle.**

---

## 3. Non-goals

- Not a V1 deliverable and not a V1 dependency.
- No near-real-time detection (see section 5.3).
- No WebSub / YouTube push in the baseline (section 15).
- No reminders (`REMINDER_*`) or `LIVE_START` in the baseline (section 15).
- No per-user scheduled jobs of any kind.
- No new analytics or tracking.
- No change to the existing `NEW_VIDEO` notification pipeline (section 6.3).
- No exact AWS price claim (section 13).
- No NAT Gateway, EC2, ECS/Fargate, always-on process, or Redis/ElastiCache.

---

## 4. V2 assumptions

| Assumption | Value |
|---|---|
| Initial users | ~500 |
| Tracked channels | ~119 creators in Creator Master; the live roster uses the polling-eligible subset |
| Detection schedule | **exactly** minute `00` and `30` of every hour |
| Polls | 48/day, ~1,440/month |
| Recipients per new stream | a subset, for example 43 of 500 |
| Compute | existing serverless AWS only; the Lambda functions use no VPC in the current Terraform, so no NAT is needed |
| Push delivery | Web Push direct to browser push services (not through AWS), as the existing sender already does |

---

## 5. 30-minute detection flow

### 5.1 Flow

```
EventBridge Scheduler
  cron at :00 and :30
        |
        v
scheduled Lambda
        |
        v
current Holodex Live + Upcoming state
  (one aggregate request for the whole roster; shared path where safe, section 6)
        |
        v
compare returned upcoming videoIds against the Stream Registry
  (BatchGetItem by videoId; no subscriber data touched)
        |
        v
new scheduled livestream first seen?
   |-- NO  --> (update changed schedule/status only) --> exit
   |
   '-- YES
        |
        v
   conditional write: create registry item (attribute_not_exists(videoId))
   = atomic "first seen" claim; stores firstSeenAt, scheduledStart
        |
        v
   Query subscribers: creatorId + NEW_SCHEDULE   (never Scan)
        |
        v
   fetch push subscriptions for exactly those recipients
        |
        v
   Web Push to those recipients only
        |
        v
   write ONE event-level summary on the registry item
```

### 5.2 Schedule

```
EventBridge Scheduler: cron(0,30 * * * ? *)   (the 00 and 30 minute of every hour)
```

The baseline is exactly 30 minutes. The schedule is a constant; changing the cadence is a deliberate decision, not a runtime option. A time zone for the schedule is irrelevant for a 30-minute cadence.

### 5.3 Expected detection latency

```
Polling delay, best case:    ~0 minutes
Polling delay, average:      ~15 minutes
Polling delay, worst case:   ~30 minutes
```

Actual discovery latency can additionally depend on how quickly **Holodex itself** learns about the YouTube scheduled livestream; OshiYobi cannot see a schedule Holodex does not yet return. This design deliberately prioritizes **very low AWS cost** over near-real-time detection. A future event-driven path (WebSub, section 15) can improve latency without replacing this reconciliation path.

---

## 6. Existing backend components that can be reused

Read-only inspection of the repository on `develop` (2026-10-05). Nothing below was modified.

### 6.1 Live/Upcoming source

| Finding | Evidence | Consequence for V2 |
|---|---|---|
| `GET /live-streams` makes **one aggregate Holodex `/users/live` request** for every polling-eligible creator's channel (`channels=<comma-separated>`), never one per creator, then normalizes it. | `src/api/read_api.py` `get_live_streams`; `src/api/holodex_client.py` `holodex_get`; `src/api/holodex_normalization.py` | The **fetch + normalize path is reusable as code**: V2 needs exactly this one aggregate call. 48 calls/day. |
| There is **no shared cache or persisted store** in front of it today. The docstring states Holodex is queried directly "with no persistence layer in front of it yet". Each `/live-streams` request calls Holodex, and the web app polls it about once a minute per open tab. | `get_live_streams` docstring; `frontend/dashboard/src/shared/api/liveStreamsStore.ts` (`POLL_INTERVAL_MS = 60_000`) | There is **no existing shared Live/Upcoming state to read**. The preferred diagram (shared state feeding both `/live-streams` and the detector) is a target, not something that exists. |
| A shared-cache / stale-if-error / cooldown design for `/live-streams` is planned as part of the V1 security work (control SEC-API-005, cache ADR not yet chosen). | Security Baseline / roadmap | If that shared state is built, the detector should read it (or populate it) instead of calling Holodex separately. This is coupling to a **not-yet-existing** component, so V2 must not assume it. |
| `/live-streams` filters upcoming items to a local 7-day lookahead (`_HOLODEX_MAX_UPCOMING_HOURS = 24 * 7`) and to polling-eligible creators. | `src/api/read_api.py` | Open decision (section 17, item 3): whether detection uses the filtered or unfiltered normalized list. |
| `holodex_get` has a 10-second timeout, raises `HolodexAPIError` on any failure (never returns a fabricated empty result), and uses a module-level `requests.Session`. | `src/api/holodex_client.py` | Reuse as is. |

**Decision recorded:** V2's baseline reuses the existing **fetch-and-normalize code path** (one aggregate call, extracted behind a small "live/upcoming source" function so both `/live-streams` and the detector call the same code). It does **not** claim a shared cache, because none exists. The detector is written against that function so that, if a shared cache is later introduced, the detector switches to it without redesign. If code reuse is later judged unsafe (for example the lookahead filter or error semantics are API-specific), the detector may keep its own thin caller of `holodex_get` + `normalize_holodex_live_response`; that is **one extra Holodex call every 30 minutes (48/day)**, a negligible fraction next to user-driven `/live-streams` traffic. The reason would be documented at that time rather than inventing a dependency.

### 6.2 Reusable pieces

| Component | Path | Reuse |
|---|---|---|
| Holodex transport | `src/api/holodex_client.py` | Yes, unchanged |
| Holodex normalization (per-item degrade posture) | `src/api/holodex_normalization.py` | Yes |
| Creator Master and eligibility predicates | `src/tracking/creator_master.py` | Yes, to know which creators are in scope |
| Web Push sender (VAPID, endpoint allowlist, 10 s timeout, no redirects, 404/410 detection via `subscription_expired`) | `src/notifications/push_sender.py` | Yes, unchanged |
| VAPID credentials | `ops.config.get_vapid_credentials` | Yes |
| Stored push subscription (opaque value under key `pushSubscription` in `YobiRemoteConfig`, written by `PUT /clients/{clientId}/push-subscription`) | `src/stores/remote_config_store.py`, `src/api/api_handler.py` | Yes, read per recipient only |
| Per-client secret authentication of client-scoped routes (`X-Client-Secret`) | `src/api/client_credential_api.py`, `api_handler.py` | Yes, for any new subscription route |
| Scheduler dead-letter queue | `terraform/eventbridge.tf` (`scheduler_dlq`) | Yes, for the new schedule |
| Lambda conventions (no VPC; `local.lambda_role_arn`; DynamoDB `PAY_PER_REQUEST`, PITR, deletion protection) | `terraform/lambda.tf`, `terraform/dynamodb.tf` | Follow as convention |

### 6.3 Existing notification pipeline (NOT reused for V2, not modified)

The existing `NEW_VIDEO` pipeline runs a scheduled dispatcher every 15 minutes (`aws_scheduler_schedule.notification_dispatch`, `rate(15 minutes)`; Lambda `yobi-analytics-notification-dispatcher`, 60 s / 512 MB). Whether it is enabled in V1 production is `TO VERIFY` and is outside this document. Its shape is the **opposite** of what V2 requires:

| Existing behavior | Where | Why V2 must not copy it |
|---|---|---|
| Each run loads **every** client with a stored `notificationPreference` (a `Query` on `configKey-index`, but one that returns all clients having that key) | `notification_dispatcher.py` → `remote_config_store.list_by_key` | Reads scale with total clients per run, even when nothing is new |
| For each client, a separate `GetItem` for the push subscription | same | N reads per run |
| For each (client, event) pair, a delivery-log read; plus a conditional write per recipient and a confirm write | `notification_delivery_log_store.py` | `clients × events` reads and per-recipient writes |
| Events live in a 3-day lookback window, so most runs have candidates | `_EVENT_LOOKBACK_DAYS = 3` | The early exit rarely fires |
| Per-creator choices are a JSON blob (`creatorOverride`) inside the preference value; the current web app keeps muted-creator lists in browser storage and sends only the global enabled flag, level, time zone and windows | `notification_dispatch.py`, `NotificationToggle.tsx` | Not queryable by creator and type; a creator-and-type subscriber lookup cannot be answered without a new key structure |

Illustrative shape of that cost (a formula, not a measurement): reads per run ≈ `C + C + (C × E)` for `C` clients with a preference and `E` candidate events in the window, times 96 runs/day. V2 is designed so that nothing like `C × E` appears on a poll. A later decision may migrate `NEW_VIDEO` to the V2 model; that is out of scope here.

---

## 7. DynamoDB access patterns

Access patterns come first; the schema (section 8) follows from them.

### Access Pattern A — known stream lookup

```
videoId  ->  Stream Registry record
```

Used for first-seen detection, deduplication, schedule/status updates. Operations: `BatchGetItem` of the videoIds in the current Holodex result (≤100 keys per call); conditional `PutItem` to claim a first sighting; `UpdateItem` for changes.

### Access Pattern B — notification subscriber lookup

```
creatorId + notificationType  ->  subscribed clients/users only
```

Example logical key:

```
NEW_SCHEDULE#aizawa_ema   ->   U001, U017, U052, ...
```

Implemented as a **`Query` on a key or GSI whose hash key is the creator-and-type value**. Never a `Scan`, never an application-side filter over preferences. Returns only the subscribed users; the others are not read.

### Access Pattern C — user settings lookup

```
clientId  ->  all of this client's creator notification subscriptions
```

Used by the Settings UI to render and edit the user's choices. A `Query` on the base table partition key.

### Not an access pattern

"List all clients" and "list all preferences" are deliberately **not** access patterns. Nothing in the design needs them.

---

## 8. Proposed data model

Follows the repository's existing convention (one DynamoDB table per concern, on-demand billing, point-in-time recovery, deletion protection), without forcing a single-table design. Exact names and attributes are an implementation decision (section 17).

### 8.1 Stream Registry (new table, e.g. `YobiStreamRegistry`)

| Attribute | Notes |
|---|---|
| `videoId` (PK, S) | YouTube/Holodex video id: the core stream identity |
| `creatorId` | Creator Master id |
| `firstSeenAt` | ISO 8601 UTC, set once at creation |
| `scheduledStart` | ISO 8601 UTC; updated when it changes |
| `status` | `upcoming` / `live` / `ended` as observed |
| `lastObservedAt` | updated only when something changed or at a coarse interval (section 12) |
| `newScheduleClaimedAt` | set in the same conditional write that creates the item |
| `newScheduleProcessedAt` | set when sending finishes |
| `newScheduleRecipientCount`, `newScheduleSuccessCount`, `newScheduleFailureCount` | the one event-level summary |
| `ttlAt` | epoch seconds for DynamoDB TTL cleanup (retention value is an open decision) |

No personal data lives in this table. Per-type state is stored as attributes on the same item (for example a later `liveStartProcessedAt`) so a stream stays one item.

### 8.2 Notification Subscriptions (new table, e.g. `YobiNotificationSubscriptions`)

One item per (client, creator, notification type) that the user turned **on**. Absence means off.

| Attribute | Notes |
|---|---|
| `clientId` (PK, S) | the anonymous technical identifier (browser-generated random ID) |
| `subKey` (SK, S) | `<notificationType>#<creatorId>`, for example `NEW_SCHEDULE#aizawa_ema` |
| `typeCreator` (GSI hash key, S) | equal to `subKey` |
| `createdAt` | optional |

GSI `typeCreator-index`: hash = `typeCreator`, range = `clientId`, projection `KEYS_ONLY` (the recipient set needs only `clientId`).

- Pattern B = `Query` GSI where `typeCreator = "NEW_SCHEDULE#aizawa_ema"`.
- Pattern C = `Query` base table where `clientId = :c` (optionally `begins_with(subKey, "NEW_SCHEDULE#")`).
- A user subscribing/unsubscribing is one item write/delete per creator.

### 8.3 Existing items, read only for recipients

- `YobiRemoteConfig` (`clientId`, `configKey = "pushSubscription"`) — fetched with `BatchGetItem` for the recipient set only (≤100 keys per call).
- `YobiRemoteConfig` (`clientId`, `configKey = "notificationPreference"`) — optionally fetched the same way if the global enabled flag, temporary mute or quiet hours are honored (open decision, section 17 item 4).

### 8.4 Alternative: reuse `YobiRemoteConfig` instead of a new table

The existing `configKey-index` GSI (hash `configKey`) would answer Pattern B if each subscription were stored as `configKey = "notifySub#NEW_SCHEDULE#<creatorId>"`, and Pattern C is a `Query` on `clientId`. This needs **no new subscriptions table or GSI**. Trade-offs:

| | New subscriptions table (8.2) | Reuse `YobiRemoteConfig` (8.4) |
|---|---|---|
| New Terraform resource | Table + GSI | None |
| IAM | New resource ARNs; the Lambda roles are manually managed, so this is an **IAM gap to flag and request before apply** | Existing permissions (the existing dispatcher already queries the index) |
| Isolation | Clean, single purpose | Mixes subscription edges with generic config; generic reads (`list_remote_config`) would return the new keys, so the generic reader and admin routes must be checked |
| Convention | Matches the repo's table-per-concern pattern | Reuses an existing generic store |

Both satisfy the access patterns. The choice is open (section 17, item 1).

---

## 9. NEW_SCHEDULE notification flow

`NEW_SCHEDULE` means: **OshiYobi detected this scheduled livestream for this creator for the first time.** It is separate from `LIVE_START`, `NEW_VIDEO` and the reminder types.

1. **Scheduled Lambda starts** at :00 or :30.
2. **Fetch current Live + Upcoming** (section 6). On any failure see section 11; exit with no subscriber access.
3. **Collect candidate videoIds**: items with status `upcoming` (and a usable `scheduledStart`).
4. **Pattern A lookup**: `BatchGetItem` on the Stream Registry for those ids.
5. **For each id already known**: if `scheduledStart` or `status` differs, `UpdateItem` those fields only. No notification. No subscriber access.
6. **For each id not found**: attempt the conditional `PutItem` (`attribute_not_exists(videoId)`) with `firstSeenAt`, `scheduledStart`, `status`, `creatorId`, `newScheduleClaimedAt`. If the condition **fails**, someone else already created it (a concurrent or retried run): treat it as known and do **not** notify. If it **succeeds**, this invocation owns the notification for that video.
7. **Pattern B `Query`**: `typeCreator = NEW_SCHEDULE#<creatorId>`. Zero results → write the summary with zero counts and stop.
8. **Recipient data**: `BatchGetItem` the push subscriptions (and, if honored, the preferences) for exactly those `clientId`s.
9. **Send** with the existing push sender, bounded concurrency, an overall deadline below the Lambda timeout.
10. **Summarize**: one `UpdateItem` on the registry item setting `newScheduleProcessedAt` and the three counts.
11. **Invalid subscriptions**: only for a 404/410 result, the recipient-specific cleanup of section 11.

If no new stream was found, steps 6–11 never run. **There is no subscriber `Query` on a normal poll.**

### 9.1 Concrete example

```
17:00  poll
       -> Holodex returns no scheduled stream for Emma
       -> registry BatchGet finds nothing new
       -> exit (no subscriber Query)

17:12  Emma creates a YouTube waiting room for 21:00

17:30  poll
       -> Holodex now returns video abc123
       -> registry lookup: abc123 does not exist
       -> conditional create succeeds: firstSeenAt = 17:30, scheduledStart = 21:00
       -> Query: creator = aizawa_ema, type = NEW_SCHEDULE
          -> returns 43 users out of 500
       -> fetch push subscriptions for those 43 only
       -> Web Push to those 43
       -> write one summary: recipientCount 43, successCount ..., failureCount ...

       The other 457 registered users are never read for this notification.

18:00  poll
       -> abc123 already exists in the registry
       -> update lastObservedAt only if the coarse interval has elapsed
       -> no subscriber Query
       -> no duplicate push
```

---

## 10. Deduplication and idempotency

### 10.1 Rules

| Situation | Behavior |
|---|---|
| First observation of an upcoming `videoId` | Eligible for `NEW_SCHEDULE`; the conditional write is the atomic claim |
| Same video next poll | Registry hit → no event, no subscriber Query |
| Title changes | No `NEW_SCHEDULE` resend (title is not part of identity) |
| `scheduledStart` changes | Update schedule metadata only; no notification |
| `upcoming` → `live` | Update `status`; a separate `LIVE_START` event only if that type is later supported |
| Duplicate Holodex item in one response | De-duplicate by `videoId` in memory before the lookup |

### 10.2 Retry safety

The identity is `videoId`, and the creation of its registry item is a **single conditional write**. Two concurrent invocations, a Lambda retry, or a re-delivered schedule event cannot both create it, so cannot both begin sending.

The remaining question is a crash **after** the claim but **before** the summary. V2 default policy (recommended; an owner decision, section 17 item 5):

- **At-most-once for `NEW_SCHEDULE`.** A retry or a later poll that finds an item with `newScheduleClaimedAt` set but no `newScheduleProcessedAt` does **not** resend. If the claim is older than a lease (longer than the Lambda timeout) with no processed marker, mark it `abandoned`, emit a metric, and stop. A missed notification is accepted over a duplicate one, because a late "new stream scheduled" notice has little value and a duplicate is user-visible noise.
- Optional at-least-once variant: record an event-level cursor (for example the last recipient chunk completed) so a retry resumes after the last completed chunk. This is a handful of event-level writes, not per-recipient writes; the cost is possible duplicate delivery within one chunk.

Supplementary, delivery-level duplicate suppression (not a guarantee, `TO VERIFY` with the push library): set the notification's `tag` (for example `new-schedule:<videoId>`) so the browser replaces a displayed duplicate, and use the Web Push `Topic` header derived from the videoId so a message queued but not yet delivered is replaced by a retried one.

### 10.3 Scheduler and Lambda retries

EventBridge Scheduler invokes the Lambda; Lambda's own asynchronous-invocation retries and the schedule's retry policy can cause an invocation to run more than once. The retry count, maximum event age and the dead-letter queue are set explicitly at implementation (open decision), and the idempotency above holds regardless of how many times a run repeats.

---

## 11. Failure handling

Prefer simple V2-safe behavior over added infrastructure. In every failure below, **no subscriber data is read unless a new stream was actually claimed.**

| Failure | Behavior |
|---|---|
| **Lambda retry** | Idempotent by the conditional claim (section 10). A retry cannot create a second `NEW_SCHEDULE` for the same videoId. |
| **Duplicate Holodex result** | De-duplicate by `videoId`; registry lookup makes a repeated item a no-op. |
| **Duplicate notification attempt** | Prevented by the claim and the at-most-once policy; `tag`/`Topic` reduce visible duplicates if a send is repeated. |
| **Holodex timeout** (the client times out after 10 s) | The poll fails closed: log, emit a metric, exit. No subscriber access. The next poll 30 minutes later is the retry. No in-run retry loop. |
| **Holodex 429** | Same as timeout; do not retry within the run, so the detector does not worsen rate limiting. If a shared cooldown exists (the planned `/live-streams` protection), honor it. |
| **Malformed Holodex item** | The existing normalization posture applies: degrade that item (skip it and log a count), never take down the batch. A structurally invalid whole payload fails the poll like a timeout. |
| **Scheduled time changes** | `UpdateItem` of `scheduledStart` only when it differs. No notification. |
| **Cancelled / deleted scheduled stream** | It disappears from the Holodex result. V2 does nothing active: no notification, no extra read to find "missing" items (that would need a scan or an extra index). The registry item ages out by TTL. If it reappears it is already known, so no duplicate. |
| **Expired push subscription** (HTTP 404 / 410) | The one recipient-specific write: delete or disable that client's stored push subscription, and delete that client's subscription items (a `Query` on the client partition then deletes) so it stops being selected. Transient failures (5xx, timeout) are counted in `failureCount` and are not retried in the run. |
| **User disables the notification between discovery and send** | The send-time recipient data is fetched after the `Query`, so a deleted subscription item or removed push subscription is excluded. A GSI is eventually consistent, so a toggle in the last moments may still produce one notification; this is accepted. If the global enabled flag or temporary mute is honored (section 17 item 4), it is checked on the freshly fetched preference. |
| **Registry write throttled / DynamoDB error** | The poll fails before the claim; no notification; the next poll retries naturally. A failure after the claim follows the at-most-once policy. |
| **Repeated Holodex failures** | A metric/alarm after N consecutive failed polls (threshold is an open decision), so a silent detector outage is visible. |

---

## 12. Cost-minimization rules

### 12.1 Mandatory rules

1. **No full-user scan.** Never read all users and inspect preferences in application code.
2. **No `Scan`** for subscriber selection or on the notification preference data.
3. **Subscriber selection is a `Query`** on creator + notification type, returning only subscribed users.
4. **No subscriber access on a normal poll.** The only per-poll data work is the registry lookup.
5. **Stream-level state, not per-user jobs.** One registry item per stream.
6. **No per-user EventBridge schedules.** Scheduled work is per stream/event.
7. **No per-recipient success-delivery writes by default.** One event-level summary per stream and type. Recipient-specific writes happen only on 404/410 cleanup.
8. **Write only on change.** `lastObservedAt` is not written every poll for every stream.
9. **Recipient-bounded reads.** Push subscriptions (and preferences, if used) are fetched for the Query result only, using `BatchGetItem`.
10. **Reuse the upstream fetch path**; one aggregate Holodex request, never per creator.
11. **No NAT Gateway, no always-on compute, no Redis/ElastiCache** for this feature.

### 12.2 Forbidden anti-patterns

| Anti-pattern | Why it scales badly |
|---|---|
| DynamoDB full-user Scan | cost ∝ total users per use |
| Notification-preference Scan | same, on every new stream |
| Every poll × all users | 1,440 polls/month × 500 reads, zero value on a normal poll |
| Every poll × all creators × all users | multiplies a third axis |
| Per-user EventBridge schedules | streams × users × reminder types jobs |
| Per-recipient successful-delivery writes | one write per user per stream, forever |
| NAT Gateway solely for notifications | fixed hourly cost unrelated to usage |
| Always-on EC2/ECS/Fargate solely for notifications | idle fixed cost |
| Redis/ElastiCache solely for this feature | idle fixed cost |

### 12.3 Why event-level summaries cut DynamoDB write cost

A per-recipient delivery record costs at least one write (the existing pipeline uses a claim, a confirm and sometimes a release per recipient). With `R` recipients and `S` streams that is `S × R` writes plus the reads that check it. One event-level summary is **one write per stream per notification type**, independent of `R`, and carries the counts the owner needs for monitoring. Per-recipient writes remain only for the rare 404/410 cleanup.

---

## 13. Approximate workload model

Baseline: 48 polls/day (~1,440/month), ~500 users, ~119 channels. **No monthly AWS price is claimed.** An exact figure needs the real request, read and write paths measured in production and current AWS pricing.

### 13.1 Operations that generate cost

| Operation | Occurs | Scales with |
|---|---|---|
| EventBridge Scheduler invocation | 48/day | constant |
| Lambda invocation and runtime | 48/day, plus a longer run when sending | polls; plus recipients on a new stream |
| Holodex request | 48/day (one aggregate call) | polls |
| Stream Registry reads | one `BatchGetItem` per poll (a second only if more than 100 ids) | videoIds in the current Holodex result |
| Stream Registry writes | on a new stream, a schedule/status change, and a coarse `lastObservedAt` refresh | real new/changed streams |
| Subscriber `Query` | **only when a new stream is claimed** | new streams × subscribers returned |
| Push-subscription `BatchGetItem` | only on a new stream | recipients |
| Web Push requests | only on a new stream | recipients |
| Invalid-subscription cleanup | rare | expired subscriptions |

### 13.2 Normal poll (no new stream)

```
1 scheduled invocation
1 Holodex request
1 registry BatchGetItem (no subscriber reads)
0 writes (unless a schedule/status actually changed)
exit
```

### 13.3 New stream

```
1 conditional registry write
1 subscriber Query returning only that creator+type's subscribers
ceil(R/100) BatchGetItem calls for R recipients
R Web Push requests
1 summary UpdateItem
```

### 13.4 Scaling statement

With this design, cost scales mostly with **actual new livestream events** plus **actual subscribed recipients**, not with total registered users or the number of polls. Doubling registered users who subscribe to nothing adds no per-poll cost.

### 13.5 Compute sizing note

Sending `R` pushes sequentially with a 10-second per-request timeout could exceed a short Lambda timeout in a bad case. Use bounded concurrency (a small thread pool) and an overall deadline; the timeout and memory are an implementation decision (the existing dispatcher Lambda is 60 s / 512 MB, shown only as a reference).

---

## 14. Privacy and data-retention considerations

Data this feature needs on the backend:

- anonymous technical identifier (`clientId`)
- push subscription endpoint and encryption keys (already stored when a user enables notifications)
- the user's per-creator, per-type notification choice
- the notification type
- optionally the time zone, only if another feature needs it
- stream notification state (registry item; contains no user data)

Rules:

- **No new analytics or tracking** for this feature. The event-level summary holds counts only.
- **This changes what OshiYobi stores.** Today the web app keeps muted-creator lists in browser storage and sends only the global flag, level, time zone and windows. V2 moves the user's per-creator choices to the server, linked to the anonymous identifier. The public Privacy & Data Use page must be updated **before V2 ships** to state the fields, purpose, retention and the link to the identifier.
- **Expired subscriptions are cleaned up**: 404/410 triggers deletion of the push subscription and of that client's subscription items.
- **Retention and deletion** for subscription items, the Stream Registry TTL, and any logs must be decided and aligned with the Privacy design before V2 production deployment (`TO DEFINE`). Point-in-time recovery on the new tables keeps backup copies for the recovery window, which the deletion policy must account for.
- Unsubscribing or disabling notifications removes the items, not just a flag.
- Do not store push endpoints or keys in logs or in the summary.

---

## 15. Future extensions (not part of the V2 baseline)

### 15.1 Reminder and live-start types

`LIVE_START`, `NEW_VIDEO`, `REMINDER_1H`, `REMINDER_30M`, `REMINDER_10M`, `REMINDER_1M` are separate notification types sharing the same subscription table (`<type>#<creatorId>`) and the same registry item (per-type processed attributes).

Reminders must remain **stream/event-based**:

```
a stream's reminder becomes due
-> one trigger for that stream and reminder type
-> one subscriber Query at execution time
-> send to that Query's recipients
```

Forbidden: one scheduled job per user per reminder (`1 stream × 500 users × reminder types`). A due-time trigger is per stream and type (for example a one-time EventBridge Scheduler entry per stream and reminder type, created or replaced when `scheduledStart` changes). The 30-minute poll cannot deliver 10-minute or 1-minute reminders precisely, so reminder precision is a separate design question; this baseline does not attempt it.

### 15.2 YouTube WebSub (optional, not a V2 dependency)

```
YouTube event
-> WebSub callback
-> immediate stream verification
-> NEW_SCHEDULE notification

+

30-minute Holodex polling
-> reconciliation / missed-event fallback
```

WebSub could reduce detection latency. It must **not** become a dependency of the baseline: the 30-minute reconciliation path stays authoritative, uses the same registry and the same conditional claim, so an event arriving from both paths cannot produce two notifications.

---

## 16. Acceptance criteria

The architecture is acceptable only if all of the following hold:

- [ ] Clearly marked V2 / deferred, with "V1 Launch Requirement: No".
- [ ] Explicitly not a V1 launch dependency.
- [ ] Baseline polling is exactly every 30 minutes (:00 and :30).
- [ ] No full-user `Scan`.
- [ ] No notification-preference `Scan`.
- [ ] No subscriber `Query` when there is no new stream.
- [ ] Subscriber retrieval is a creator + notification type `Query`.
- [ ] Only subscribed users are read for a notification.
- [ ] First-seen `videoId` prevents a duplicate `NEW_SCHEDULE`.
- [ ] A Lambda retry cannot intentionally generate a duplicate `NEW_SCHEDULE`.
- [ ] No per-user scheduled jobs.
- [ ] No per-recipient successful-delivery writes by default.
- [ ] No NAT Gateway requirement.
- [ ] No always-on server requirement.
- [ ] The existing Holodex fetch/normalize path is reused where safe; the absence of a shared cache is documented rather than assumed away.
- [ ] Cost scales mainly with real new-stream events and real subscribers.
- [ ] Reliability cases in section 11 are each handled.
- [ ] Privacy changes in section 14 are listed for the Privacy page.
- [ ] No implementation performed; no AWS mutation; no commit/push/PR as part of this draft.

---

## 17. Open implementation decisions

| # | Decision | Notes |
|---|---|---|
| 1 | Subscriptions: new table (8.2) vs reuse of `YobiRemoteConfig` + `configKey-index` (8.4) | A new table needs manual IAM (the roles are manually managed); reuse avoids IAM but mixes concerns |
| 2 | Live source: call the shared fetch/normalize function, or switch to a shared cache once the `/live-streams` protection design exists | No shared cache exists today; do not assume one |
| 3 | Detection filter: use the `/live-streams` 7-day lookahead-filtered list, or the unfiltered normalized list | Affects whether a stream announced far ahead is notified on first sight or only when it enters the window |
| 4 | Whether `NEW_SCHEDULE` honors the global enabled flag, temporary mute, quiet hours and delivery windows | Honoring them needs a preference read per recipient (recipient-bounded), and "as soon as discovered" conflicts with delivery windows |
| 5 | At-most-once (recommended) vs at-least-once with an event-level cursor | Section 10.2 |
| 6 | New Lambda vs a new mode of the existing dispatcher Lambda; timeout, memory and send concurrency | Keep the existing `NEW_VIDEO` dispatcher unmodified |
| 7 | Scheduler retry policy, maximum event age and DLQ settings | Idempotency must hold regardless |
| 8 | Stream Registry TTL / retention value and the `lastObservedAt` refresh interval | Must align with the Privacy design |
| 9 | Per-user cap and validation of subscription writes (`creatorId` must exist in Creator Master; maximum items per client) | New client-scoped write routes must meet the Security Baseline (input bounds, App Check, throttling) |
| 10 | Frontend: per-creator, per-type toggles that write to the server; migration of the existing browser-local muted lists | Privacy page must be updated first |
| 11 | Notification text language and payload content (the browser's stored locale is not available to the server) | Keep the payload minimal |
| 12 | Alarm/metric thresholds (consecutive Holodex failures, abandoned claims, high failure ratio) | Ties to the V1 alarm baseline |
| 13 | Interaction with the Holodex rate budget shared with `/live-streams`; Holodex attribution requirements | Verify before relying on quota assumptions |
| 14 | Whether to later migrate `NEW_VIDEO` to the Query-based model | Out of scope for the V2 baseline |
