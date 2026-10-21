# Notification dispatcher: due-candidate lookup and 同時開播預告

Status: implemented on branch `feat/notification_dispatcher_simultaneous_live` (base `develop` `c70dc8a`). Rollout and rollback are in section 5; the production result is recorded in the pull request.

Two goals, one change:

- **A.** The 1-minute reminder dispatcher no longer reads every registered client every minute.
- **B.** 同時開播預告: an opt-in push notice when two or more creators the user has live notifications for are scheduled to start in the same minute.

Everything below is labelled **measured** (counted by running the real code), **derived** (computed from real item shapes with DynamoDB's billing rules), or **assumption** (an input).

---

## 1. What the old dispatcher did (verified in `c70dc8a`)

`notification_dispatcher.lambda_handler`, every minute (`terraform/eventbridge.tf`, `rate(1 minute)`, no `DISABLED` state, commented "APPLIED to production 2026-10-10"):

| Step | Code | Cost shape |
|---|---|---|
| load every client's preference | `remote_config_store.list_by_key("notificationPreference")` (a `configKey-index` Query returning *whole* preference items) | O(registered clients) bytes read |
| each client's subscription | `get_remote_config(client, "pushSubscription")` | 1 GetItem per client |
| each subscribed client's reminders | `list_remote_config_by_prefix` x2 (`creatorReminder#`, `streamOverride#`) | 2 Queries per client, even if nothing could be due |

So an idle minute cost about `N x (preference bytes + 1 + 2)` operations. The earlier estimate (300 k / 2.9 M / 28.8 M RRU/day at 100 / 1 k / 10 k clients) is **confirmed within 1 %** by the measurement in section 6 (301,680 / 2,978,640 / 29,779,920).

Whether the *deployed* Lambda zip equals this tree was **not verified**: no AWS call was made. Terraform and the module docstring say the schedule is enabled at 1 minute; the code path above is what runs if the deployed zip matches `develop`. Read-only checks you can run yourself are in section 8.

## 2. Architecture chosen: per-stream follower lookup on the existing `configKey-index`

A reminder is due at a pure function of the stream's scheduled start (start, and 1/10/30/60 minutes before). So the dispatcher inverts the work (`src/notifications/reminder_candidates.py`):

1. **In memory:** from the `streamSchedule` snapshot it already reads, pick the streams whose on-time minute is *now* (plus, only when the kill-switch is on, late-discovery catch-up candidates). Most minutes: none, and the run reads nothing else (no preference, subscription, creator list or VAPID key).
2. **Followers of those streams only:** a `configKey-index` Query for `creatorReminder#<creator>#all`, `creatorReminder#<creator>#<topic>` and `streamOverride#<video>`. The index items carry the stored setting and `updatedAt`, so precedence (`override > creator 全部 > creator + topic`) is resolved by the *existing* `live_reminder.resolve_effective_setting` with no per-client Query.
3. **Only clients whose resolved setting can be due this minute** (a start-only client is not read at the 30-minute moment, etc.) get their preference + subscription read, then the **unchanged** claim -> send -> confirm/release delivery code runs.

### Why not a materialised due index (the `YobiNotificationDeliverySlots` question)

Investigated and rejected; no new table, no new index, no new item type in the slot table:

- `YobiNotificationDeliverySlots` is keyed `slotKey = "<IANA zone>|<local half-hour>"`, sort `clientId`, with only `clientId-index`. It has no time-ordered key, so it cannot answer "what is due at minute M" without a new key scheme.
- `notification_slot_store.sync_client_slots` and `remove_client` list **every item whose `clientId` matches** through `clientId-index` and delete whatever is not in the desired slot set. Any due-item written with the client's id would be deleted by the next preference save. It would also need `scripts/migration/backfill_notification_slots.py` extended.
- A materialised due record per (client x upcoming stream x moment) must be rewritten on every reminder edit *and* every reschedule: a creator 全部 reminder over 20 upcoming streams is up to 100 items (x2 for the index) per edit. The on-demand lookup has **zero maintenance writes** and cannot drift: adding, editing, disabling or removing a reminder is the one item write that already happened.

Result: requirement 7 ("keep due records synchronised") holds by construction, because no derived record exists.

### Other changes in the dispatcher

- Per-client isolation: one client's store/push error is logged and skipped; only a run where *every* candidate failed raises (so a systemic outage still reaches the Lambda error metric).
- `confirm_delivered` failing after a successful push no longer aborts the run (the claim stays and expires: never a resend).
- One immediate retry for a plausibly transient push failure (`PushResult.retryable`: transport error, 429, 5xx) via `push_sender.send_with_bounded_retry`; a 4xx rejection and 404/410 are never retried.
- The `streamSchedule` write is revision-guarded (`put_remote_config_if_newer`, `value.revision` = the shared snapshot's refresh time): an older overlapping run loses the conditional write and adopts the stored newer schedule.
- Creators and the VAPID key (an SSM read) are loaded lazily, so an idle minute no longer reads SSM.

Reminder semantics are untouched: same windows (`[fire, fire + 1 min)`), same mute / quiet-hours / creator-disabled rules, same dedupe ids, same late-discovery catch-up, same "skipped, never delayed or replayed".

## 3. 同時開播預告

Flow: Holodex refresh (the existing ~10-minute job; nothing here refreshes or polls) -> existing shared snapshot -> existing `streamSchedule` derivation (only when the snapshot is newer) -> **in-memory comparison of the previous and the new schedule's collisions** -> for a NEW collision: a pending ledger, then relevant-user lookup -> delivery through the existing dispatcher machinery. **Triggered by schedule changes, with no time window.**

- **Opt-in:** `(clientId, "simultaneousLiveNotice") = {"enabled": true}` in `YobiRemoteConfig`, written by new `PUT` / `DELETE /clients/{clientId}/simultaneous-live-notice`. A separate item, not a preference field: the preference PUT replaces the whole item, so a stale writer could switch it off by omission. Absent = off. It is a sparse index: one `configKey-index` Query lists exactly the opted-in clients. The Settings page gets one switch (existing `notification-detail-section` + antd `Switch`, shown on topics that send live notifications, after the delivery-times section); it reads and writes the backend, never localStorage.
- **Collision:** >= 2 *different* creators, status exactly `upcoming`, the **exact same scheduled start** (whole seconds, see section 9.3 for the production data this was checked against). Id = start second + digest of the member streams, so an unchanged collision keeps its id, and a new member / a leaving member / a reschedule is a different collision.
- **Relevance:** only members for which the client has live notifications enabled (resolved exactly like a reminder; `{notifyAtStart:false, advanceReminder:null}` counts as off), and at least two distinct creators. Candidates come from the same `configKey-index` Queries, intersected with the opted-in set. **With nobody opted in, no follower Query is made.**
- **When:** a collision that is **new** compared with the schedule being replaced is announced at once, however early or late it is discovered (20:55 for a 21:00 start is as eligible as a day ahead): A known -> nothing; B discovered -> A+B; C discovered -> A+B+C. **New** means the group brings a creator/stream that was not part of any collision at that start before (a stream joined, two streams came to share the start, a stream was rescheduled onto it); a group that merely **shrinks** (C cancelled) announces nothing and costs no lookup. The first-ever schedule is a baseline: nothing that already existed is announced. There is **no lead time and no minimum remaining time**; the only limit is the scheduled start: nothing is ever sent once it has passed (a retry that falls due after it is dropped). Mute, quiet hours, master switch and the per-creator switch all apply; a muted / quiet-hours client is looked at again **exactly when its suppression ends** (never polled), unless that is not before the start.
- **Idempotency key per client:** `simul:<startSecond>:<digest of the client's relevant video ids>` in the delivery log. Stable across retries; a different valid collision is a different key; a client that follows only A+B has the **same key** for the A+B and the A+B+C group (no repeat), while a client following A+C or B+C becomes eligible when C is discovered and one following A+B+C is told about the expanded group.
- **Ledger and pending list:** one small item per NEW collision (`__system__` / `simulNotice#<id>`), created by the derivation **before** the new schedule record is written (a crash in between loses nothing: the next derivation sees the same difference and finds the ledger there): `version` (compare-and-set), `leaseUntilMs`, `resolved`, `cursor`, open retries `work`, counters. The recipient list is **never stored**. The ids of collisions still waiting for their notice are listed in the `pendingNotices` field of the `streamSchedule` record the dispatcher already reads every minute (rewritten by the derivation that writes the record anyway): **with none listed, not even a cold container reads anything for this feature.**

Pass for one collision: read ledger -> take a lease (CAS write; of two overlapping runs exactly one proceeds) -> derive recipients -> for each (client-id order): delivery-log row first (already delivered = done), then re-read opt-in + preference + subscription, claim, push (one immediate retry), confirm/release -> one closing CAS write (open retries, cursor, counters, lease released).

| Case | Behaviour |
|---|---|
| unchanged collision, later minutes / identical refresh | zero feature reads and writes: no new collision means no ledger, no lookup, no delivery-log row (the stale pending id of an already settled notice costs at most one ledger read, once, in a container that does not remember it) |
| nobody opted in (the default) | one query of the sparse opt-in index at the discovery; no follower Query, no per-client read |
| new / changed / cancelled / rescheduled collision | detected from the schedule diff; the removed collision's ledger is deleted by the derivation that dropped it; delivery always works from the *current* collisions, so a failed cleanup can never cause a stale send |
| Holodex / snapshot failure | the previous schedule **and its pending list** are reused untouched; nothing is invented or destroyed; pending retries still go out |
| failed push | claim released; retried after 1 min then 3 min, at most 3 attempts in total, then given up (counted) |
| a claim held by another (maybe dead) worker | not an attempt: looked at again every minute until it settles or expires (20 min) or the start passes |
| opt-out / master OFF / creator disabled / subscription removed before the send | the client is dropped, not notified (everything is re-read right before the claim) |
| crash mid-pass | the lease expires (2 min); the next pass starts again and the delivery log skips everyone already served |
| more recipients than one invocation can serve | the pass stops 20 s before the Lambda deadline, records a cursor, and the next minute resumes after it |

## 4. Delivery log: verified order and what changed

Existing order for every reminder: eligibility (mute / creator / quiet hours) -> `handled_within(legacy)` GetItem -> `already_delivered` GetItem -> `mark_delivered` conditional PutItem (**claim**) -> Web Push -> `confirm_delivered` on success, `release_claim` (DeleteItem) on failure / expiry. A claim whose process died expires after 20 minutes and can be taken over.

- Claim-then-failed-push was already recoverable (claim released), but a reminder's 1-minute window made a *later* retry impossible; the immediate bounded retry above is the practical fix, deliberately not a replay.
- New `row_status(client, id)` (one GetItem): distinguishes delivered / suppressed / live claim / absent-or-expired.
- **No new Query on the delivery log**, so no new IAM action.

**Unavoidable ambiguity (Web Push is not exactly-once):** a push service accepting a message does not prove the browser showed it, and a crash between "accepted" and "confirmed" leaves a claim that expires and is then attempted again: *at-least-once*, never silently lost, with a possible duplicate in that one narrow case. Everything else (overlapping runs, retries, redeploys) collapses into one notification per client and notice. The service worker sets no notification `tag`, so a duplicate would show twice; adding a `tag` is a frontend/service-worker change that was out of scope.

## 5. IAM, Terraform, migration, rollout

**IAM: no new action on any table.** Used: `GetItem`, `PutItem` (incl. conditional), `DeleteItem`, `Query` on `YobiRemoteConfig` and `configKey-index` (already used by the old dispatcher), `GetItem` / `PutItem` / `DeleteItem` on `YobiNotificationDeliveryLog`. I deliberately avoided `UpdateItem` and `BatchGetItem` on the config table (the 2026-09 audit lists `UpdateItem` as absent from `src/`, and `BatchGetItem` on the delivery log needed its own manual policy). The live role's policy could not be read (no IAM access, per `terraform/lambda.tf`); the claim "no IAM change" rests on the action list above.

**Terraform:** `terraform/api_gateway.tf` gains `PUT` and `DELETE /clients/{clientId}/simultaneous-live-notice` in `local.api_routes` (additive; `tests/test_api_gateway_routes.py` keeps handlers and routes in lock-step), and `terraform/eventbridge.tf` gives the `notification_dispatch` schedule an input carrying the Scheduler's `scheduledTime` and a 5-attempt / 600 s retry policy (a failed minute is retried only while it can still be recovered; the dead-letter queue stays). No other `.tf` change. Apply with `-target` on exactly those resources (two routes, one schedule) after reading the plan; never bulk-apply (the repo has unapplied drift, per project notes).

**Data migration: none.** No schema change. The `streamSchedule` record gains a `revision` field on its next derivation (a stored record without one is always replaced). Old code ignores the extra field and the new items, so the two versions can coexist during a rollout.

**Rollout order:**

1. Code: build the `api` and `notification-dispatcher` zips by patching each function's LIVE zip with exactly the files this PR changes (new top-level modules added explicitly), import-check them, upload to the artifact bucket and `update-function-code`; keep the previous live zips as rollback artifacts. The new notice is dormant until someone opts in; the reminder path changes immediately and is covered by `test_reminder_candidates.py` and the existing suites.
2. Targeted Terraform apply: the two API routes and the dispatch schedule (input + retry policy).
3. Frontend (Firebase Hosting; the switch calls the new routes, which exist by then).
4. Watch Lambda `Errors`, the dispatcher log (a "Warning: reminders for client ... failed" line means the per-client isolation fired), and one idle and one due reminder minute.

**Rollback:** `update-function-code` back to the previous zips (the old dispatcher resumes the full scan; it ignores `revision`, `pendingNotices`, opt-in items and ledgers); `terraform apply -target` of the previous schedule block (or the console) restores the default retry and no input; Firebase `hosting:clone` of the previous release. Leftover `simulNotice#...` ledgers and opt-in items are inert; ledgers can be deleted by key under `clientId = __system__`.

## 6. DynamoDB cost, before vs after

Source: `scripts/analysis/notification_dispatch_cost_model.py` (re-runnable: `PYTHONUTF8=1 PYTHONPATH=src:. python -m scripts.analysis.notification_dispatch_cost_model`). It runs the **old dispatcher from git and the new one** on the same in-memory world with every storage operation counted (**measured** counts), sizes items from the real shapes (**derived**), and bills with the documented rules (eventually consistent reads 0.5 RRU / 4 KB; Query = summed size rounded up to 4 KB; 1 WRU / KB; every config-table write also writes `configKey-index`). It does *not* use moto's consumed capacity. The old dispatcher is simulated at <= 1,000 clients and scaled linearly to 10,000 (its work is exactly linear; the 100 -> 1,000 rows show it).

**Assumptions (inputs, not production facts):** each client follows 8 creators; every client subscribed; 60 streams on an active day, each with its five reminder moments; one advance offset per client spread evenly over none / 1 / 10 / 30 / 60 min; 30 % opt in; prices `$0.1425` per M RRU and `$0.715` per M WRU (AWS's page lists $0.625 / $0.125 for its reference region; Tokyo has historically been ~14 % higher; **verify against the Tokyo price list**, the unit counts do not depend on it). Derived sizes: preference 4,633 B, push subscription 398 B, reminder 132 B, `streamSchedule` (60 streams) 16,172 B, opt-in 97 B.

| clients | day | version | GetItem | Query | Put/Delete | RRU/day | WRU/day | USD/day | USD/30 d |
|---:|---|---|---:|---:|---:|---:|---:|---:|---:|
| 100 | idle | before | 146,880 | 289,440 | 144 | 301,680 | 4,608 | 0.0463 | 1.39 |
| 100 | idle | **after** | 2,880 | 0 | 144 | 3,600 | 4,608 | 0.0038 | 0.11 |
| 100 | active | before | 148,560 | 289,440 | 1,824 | 302,520 | 6,288 | 0.0476 | 1.43 |
| 100 | active | **after** | 6,240 | 600 | 1,824 | 6,000 | 6,288 | 0.0054 | 0.16 |
| 1,000 | idle | before | 1,442,880 | 2,881,440 | 144 | 2,978,640 | 4,608 | 0.4278 | 12.83 |
| 1,000 | idle | **after** | 2,880 | 0 | 144 | 3,600 | 4,608 | 0.0038 | 0.11 |
| 1,000 | active | before | 1,458,120 | 2,881,440 | 15,384 | 2,986,260 | 19,848 | 0.4397 | 13.19 |
| 1,000 | active | **after** | 33,360 | 600 | 15,384 | 23,250 | 19,848 | 0.0175 | 0.53 |
| 10,000 | idle | before | 14,415,840 | 28,814,400 | 144 | 29,779,920 | 4,608 | 4.2469 | 127.41 |
| 10,000 | idle | **after** | 2,880 | 0 | 144 | 3,600 | 4,608 | 0.0038 | 0.11 |
| 10,000 | active | before | 14,568,240 | 28,814,400 | 152,544 | 29,856,120 | 157,008 | 4.3668 | 131.00 |
| 10,000 | active | **after** | 308,640 | 600 | 153,024 | 198,450 | 157,488 | 0.1409 | 4.23 |

What remains in "after": the per-minute schedule record read (2.5 RRU x 1,440), the shared heartbeat read, the 144 schedule re-derivation writes a day (16 KB record, base + index = 32 WRU each), and the reminder deliveries themselves (claim + confirm writes, two delivery-log reads), which both versions pay. **The idle recurring cost no longer depends on the number of clients.**

Per minute at 10,000 clients (measured): idle 20,680 RRU before, **2** after; a start minute for a creator ~7 % of clients follow: 21,410 before, **1,834** after (10,010 GetItem + 20,010 Query before; 2,913 GetItem + 2 Query after).

**Worst case:** one creator followed by *every* client, at its start minute: 25,160 RRU after vs 30,680 before at 10,000 clients, i.e. the new design's *worst minute* costs about what the old design cost on *every* minute. Reads for a due stream are bounded by `5 x (that creator's followers)` per day; they cannot exceed one full client scan per reminder moment.

| event (new code, measured counts) | GetItem | Query | Put/Delete | RRU | WRU |
|---|---:|---:|---:|---:|---:|
| B discovered: new collision A+B delivered (1,000 clients, 334 opted in and following both) | 1,338 | 5 | 672 | 875 | 676 |
| C discovered: A+B+C (half the clients deduplicated, half told; 1,000 clients) | 873 | 7 | 363 | 574 | 368 |
| same two steps at 10,000 clients | 13,338 / 8,697 | 5 / 7 | 6,672 / 3,579 | 8,700 / 5,692 | 6,676 / 3,584 |
| an ordinary refresh that changes nothing / the next one / a plain minute | 1 (the schedule read every minute pays) | 0 | 0-1 (the schedule record write that already happened) | 2 | 0-2 |
| C cancelled (group shrinks back to A+B): the A+B+C ledger deleted, nobody looked up | 1 | 0 | 2 | 2 | 4 |
| opt in / out (one item, base + index) | 0 | 0 | 1 | 0 | 2 |
| reminder add / edit / remove (unchanged by this work) | 0 | 0 | 1 | 0 | 2 |
| notification preference change (unchanged) | 0 | 0 | 1 | 0 | 10 |
| one retry attempt of one client (code-derived from `_attempt`) | opt-in + preference + subscription + delivery row + 2 reminder prefix Queries | | claim + release | ~4 | 2 |

Additional storage: opt-in items 97 B each (x2 with the index; 0.58 MB at 3,000 opted-in clients); one ledger per new collision (a few hundred bytes plus ~110 B per open retry), deleted when the collision disappears; the pending ids add a few bytes to the existing schedule record. At `$0.285` per GB-month this is below a cent.

## 7. Tests (all focused; the full frontend suite was not run)

Backend: `tests/notifications/test_reminder_candidates.py` (due-stream selection, idle / due / worst-case read counts through the real dispatcher, override precedence, add / edit / disable / remove, per-client isolation, revision-guarded schedule), `test_simultaneous_live.py` (exact-minute detection, status filter, ids, window, relevance, ledger shape, wording in 3 locales), `test_simultaneous_dispatch.py` (opt-in, collisions, schedule change / cancellation / reschedule / dropout, identical-snapshot no-op counted in storage operations, refresh failure, durable cursor, crash recovery, retries and the attempt bound, held claims, overlapping runs, opt-out before send, mute / quiet hours, 2,500 recipients), moto tests for the conditional writes and `row_status`, API route tests, push-sender retry tests. The existing reminder suites pass on the new read path with only their stubs adapted (a client's preference is now declared per client instead of a global list).
Frontend: `simultaneousLiveNoticeApi.test.ts`, `SimultaneousLiveNotice.test.tsx`, plus the existing Settings tests; `tsc -p tsconfig.app.json --noEmit` is clean.

## 8. Limits, risks, and what was not verified

- **Production state not read.** No AWS call was made. To check the live path read-only: CloudWatch `Invocations` / `Duration` for `yobi-analytics-notification-dispatcher` over 24 h, the item counts of `YobiRemoteConfig` by `configKey` (`notificationPreference`), and the Lambda's deployed code hash vs the release you expect.
- **Sequential sends:** fixed in the follow-up, see 9.1.
- **Missed minutes:** recovered in the follow-up, see 9.2 (bounded and only while still true).
- **Eventually consistent reads** (boto3's default, as before): an opt-out written less than ~1 s before the send may be missed once.
- The live `notification_dispatch` schedule still has the Scheduler default retry policy (24 h / 185 attempts) until the Terraform change in this PR is applied; see 9.5.
- A collision needs *different* creators and the identical start second; streams without `status == "upcoming"` (records from before status was stored) never take part.
- A user who opts in after a collision's notice was already served is not told (never replayed), by the same rule as every other "turned on later" case.
- The opt-in switch lives in each live-capable topic panel (like the delivery-times section); it is one global setting.


---

## 9. Follow-up review (2026-10-21): scale, recovery, precision, window, live inspection

At the time of this review nothing was applied to AWS; the only AWS calls were read-only `get` / `list` / `describe` / metric / log-filter calls under the existing `yobi-analytics-cli` profile (account 189461315571, ap-northeast-1); no environment variable or secret was read or printed.

### 9.1 Sequential Web Push no longer ends in a silent timeout

- **Bounded concurrency** (`notifications/parallel.py`, 16 workers, `_SEND_WORKERS`): the due clients of a minute are served by a thread pool; results come back in item order, one client's exception is its own result, and one worker runs inline (deterministic tests). About 50 clients/s at ~0.3 s each: a 300 s Lambda serves ~15,000 clients, versus ~1,000 sequentially.
- **boto3 resources are per thread** (`remote_config_store`, `notification_delivery_log_store`): a Resource is not documented as thread-safe. The push `requests.Session` gets a pool of 32 connections so 16 workers do not discard each other's.
- **Deadline guard:** a client is only *started* while more than 30 s remain (`_DEADLINE_MARGIN_MS`: a client in flight needs up to 2 pushes x 10 s timeout plus DynamoDB calls). The unstarted clients are counted (`unserved` in the response), logged, and the container does not mark the minute served, so the next run serves them as recovered reminders (9.2) instead of losing them.
- The simultaneous notice attempts recipients in chunks of one worker-round, so the deadline is checked between rounds and its cursor stays exact.
- Not changed: the 15-minute `new_video_slots` dispatcher (its own deadline guard already leaves later clients "late rather than lost" and it was not in scope).

### 9.2 Recovery of missed, delayed, failed or cut-short runs

Policy preserved: no deliberate delay, no replay after the user changed something, mute / quiet hours judged at the fire time and now. What is new is that a minute **nobody served** is served by the next run, **only while the reminder is still true**:

- A run serves its own instant: the Scheduler's `scheduledTime` when the schedule passes it (the Terraform input added by this PR), else the wall clock; plus the instants between the last one **this warm container** finished and its own (no storage, no writes, no polling); a **cold** container serves the minute before its own (a cold start is exactly what follows a timeout or a deploy); never beyond a 10-minute lookback; gaps under 30 s of jitter are not gaps.
- A recovered **advance** reminder is sent only while >= 2 minutes remain, worded "in about N minutes" with the real time left (the late-discovery wording); a recovered **start** reminder until 5 minutes after the start.
- The setting, the push subscription **and** the preference must all have been saved before the fire time (unknown fails closed): enabling or editing anything later never replays what already came due.
- Delivery uses the same atomic claim as an on-time reminder, so re-serving a served minute sends nothing twice.
- A run in which every candidate failed still raises (Lambda error metric, Scheduler retry) and does not advance the memory.

Cost (measured, 10,000 clients): idle warm / cold / after a 5-minute gap all cost **1 GetItem, 0 Query, 2 RRU** (the schedule read every minute pays); a start minute served 2 minutes late after a gap costs 1,984 RRU against 1,834 on time (one more follower Query pass).

### 9.3 Holodex start-time precision, checked on live production data

Read-only `GetItem` of the shared `streamSchedule` and `liveStreamDisplaySnapshot` records (public stream data; analysed locally, snapshot refreshed 2026-10-21T08:51Z): 39 schedule entries, 42 display streams. **Every planned upcoming stream starts at second :00 with no sub-second part (41 of 42 raw `scheduledStart` values; the 42nd is a week-old, already-live spontaneous waiting room at :32).** The 6 start minutes shared by two or more streams (up to 5 creators at 12:00 UTC) each have exactly **one** distinct exact timestamp, so "same second" and "same minute" agree on real data. The agreed requirement is *exactly* the same start time, so collisions now match the identical second (not the minute); an odd-second unplanned stream only collides with the identical second. Observation worth knowing: 6 of 25 start times in that snapshot were shared, so users following many creators will see these notices often; the opt-in and the "two followed creators" rule are what bound it.

### 9.4 The fixed 3 h to 10 min window was removed (correction)

The window was never authorised and is gone from the code (`NOTICE_LEAD_MS`, `NOTICE_MIN_REMAINING_MS`, `notice_window_open` no longer exist; a unit test guards that). The notice is now **change-triggered**, as described in section 3, with the scheduled start as its only limit. Verified by tests: A -> A+B -> A+B+C with five different subscription sets; default OFF; discovery a day, six hours, ten minutes, five minutes, one minute and ten seconds before the start (all notified) and at / one second / three minutes after it (none, and no lookup); a retry due after the start is dropped; identical refreshes and plain minutes perform zero feature operations; cancellation before delivery (pending ledger deleted, never retried), after delivery, and a Holodex dropout that returns (no duplicate); rescheduling away, onto and together (a new exact start is a new notice); a failed refresh (nothing rewritten, pending retry still delivered); a crash between creating the ledger and writing the schedule; overlapping runs and runs that lose the schedule write; retries, claims, opt-out, mute and quiet hours.

### 9.5 Live (read-only) inspection

| Item | Live value | Consequence |
|---|---|---|
| `yobi-analytics-notification-dispatch` | `ENABLED`, `rate(1 minute)`, UTC, no input, retry policy default (24 h, 185 attempts), DLQ `yobi-analytics-scheduler-dlq` | Confirms the 1-minute path. **Prepared (not applied):** input `{"scheduledTime":"<aws.scheduler.scheduled-time>"}` and retry 5 attempts / 600 s in `terraform/eventbridge.tf` |
| `yobi-analytics-new-video-dispatch` | `ENABLED`, `cron(0/15 * * * ? *)`, retry 2 attempts / 3600 s | unchanged |
| Dispatcher Lambda | python3.12, handler `notifications.notification_dispatcher.lambda_handler`, 300 s, 512 MB, role `yobi-analytics-lambda-role`, code last modified 2026-10-19 11:49 UTC (the push-deep-link release) | the live zip post-dates `c70dc8a`, so it contains the old per-minute global scan this work replaces |
| Reserved concurrency | none (account limit 1000, 949 unreserved) | overlapping runs are possible: the claims and the ledger lease already cover that |
| Last 24 h | 1,536 invocations, **0 errors, 0 throttles**, max concurrency 1, duration avg 681 ms / max 4.2 s; last 3 h: 168 minutes with exactly one invocation and 12 with two (the :00/:15/:30/:45 slot runs) | no missed minute in the sample; the dispatcher is nowhere near its timeout today |
| Logs (48 h) | no `AccessDenied` / `not authorized` / `Task timed out`; the only warnings are unrelated video-classification lines | functional evidence that the role holds the actions the code already used |
| Scheduler DLQ | 0 messages (retention 14 days) | no undelivered invocation recently |
| Tables | `YobiRemoteConfig` 66 items (157 KB), `YobiNotificationDeliveryLog` 7,477 items (892 KB), `YobiNotificationDeliverySlots` 20 items; all on-demand; `configKey-index` ACTIVE | today's population is tiny (a few clients): the cost problem is about growth, not the current bill |
| **IAM policy of the role** | **not readable** (`ListAttachedRolePolicies`, `ListRolePolicies`, `SimulatePrincipalPolicy` all `AccessDenied` for the CLI user, as `terraform/lambda.tf` already documents) | the IAM claim stays what it was: the new code uses no action the old code did not (`Query` on `configKey-index`, `GetItem` / `PutItem` incl. conditional / `DeleteItem`), and the live logs show those succeeding. A person with IAM read access should confirm the policy text |

### 9.6 Remaining risks after this pass

- A **cold** container re-serves one earlier minute at every cold start (a deploy, or after a timeout): harmless (the claim) and free when nothing was due, but it is extra reads when something was.
- **Recovery is bounded on purpose:** beyond 10 minutes, or after the grace (start +5 min, advance until 2 min before the start), a missed reminder is dropped. A run killed *by the platform* (not at our deadline) leaves its container cold, so the next run recovers only the minute before its own.
- With the Scheduler input **not yet applied**, a failed invocation retried later runs as an ordinary current minute; its own missed minute is then covered only by the warm / cold lookback above, not by its scheduled time.
- Threads share one `requests.Session` per container (a pooled, widely used pattern, not formally guaranteed thread-safe for cookies; the push service sets none that matter).
- `new_video_slots` sends are still sequential (out of scope here); the 30-second deadline margin is also a floor for how late a run can finish.
- Reads are still eventually consistent; an opt-out written less than about a second before a send may be missed once.
- Browser-side duplicate suppression (a notification `tag`) is still not set by the service worker.
