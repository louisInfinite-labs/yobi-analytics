# New-video discovery windows + scheduled push delivery

Branch `feat/new_video_scheduled_push`. Phase 1 (source only, no AWS access) is implemented and verified locally. **Nothing has been
applied or deployed.** Phase 2 (a machine with AWS credentials) must verify the assumptions in section 4 before anything is merged.

## 1. What it does

```
 5 JST discovery windows ──► collector Lambda (mode discovery_only, window=<id>)
   00:00 09:00 13:00 20:00 22:00 JST  one uploads-playlist incremental run for the whole roster (not per subscriber)
                                       │  records, BEFORE writing Video Master, one durable event per new video
                                       ▼
                              YobiNotificationEvents  (eventDate, videoId)  first-write-wins, eventId new_video:<videoId>

 client picks ≤4 of 48 half-hour JST slots ──► PUT notification-preference
   (always Asia/Tokyo wall-clock)                │ writes the slot index first, then the preference
                                                  ▼
                       YobiNotificationDeliverySlots  (slotKey "<slot 00-47>", clientId)   + clientId-index GSI

 one recurring 30-minute dispatcher (UTC :00/:30, mode new_video_slots of the EXISTING dispatcher Lambda)
   tick ─► which JST slot does this tick start? ─► Query that slot's recipients
        ─► per recipient: re-read stored preference (source of truth), deliver pending events through the existing
           claim → Web Push → confirm/release delivery log (clientId, videoId)
```

Live reminders are untouched and stay on the existing `rate(1 minute)` run. That run **no longer delivers new videos** (section 6).
Livestream completion, the 18:00 history Step Functions workflow, Holodex polling and `/live-streams` are not modified.

## 2. Design decisions (and why)

| Topic | Decision |
| --- | --- |
| Slots | 48 fixed half-hour slots of the **JST (Asia/Tokyo) day** (slot 0 = 00:00–00:30 JST). **No browser-local or DST reinterpretation:** the client's stored `notificationTimeZone` is ignored for new-video slots (it still governs quiet hours and reminders). Max 4 per client; min 1 (the existing backend already rejects an empty `deliveryWindows`, section 6). Wire format unchanged: `deliveryWindows` = distinct `"HH:MM"` on `:00`/`:30`. New writes are rejected (HTTP 400) otherwise; stored legacy values are floored to the half hour and capped at 4, and are now read as JST. |
| Tick | JST is a whole-hour UTC offset (+9) with no daylight saving, so every UTC `:00/:30` tick is the start of exactly one JST slot: "who is due" is one Query of that slot. |
| Tick source | Scheduler passes `<aws.scheduler.scheduled-time>`; a late start stays in its slot. A missing/invalid/stale (>2 h) value falls back to the current half hour. |
| Index | New table `YobiNotificationDeliverySlots`: one item per `(slot, client)` (`slotKey` = `"00"`..`"47"`) + `clientId-index` GSI (own items, for cleanup). |
| Dedupe | Logical identity of a notification = `(clientId, videoId)` in the existing delivery log (kept as-is so every existing row stays valid). Events are first-write-wins and the dispatcher dedupes events by `videoId` (a rediscovery on a later date is a second row). |
| No replay | Index items carry `activeSince` (start of the client's current enabled stretch). An event whose delivery window had **already passed** before `activeSince` is never delivered; one still waiting is delivered normally. Turning OFF removes the client from the index. |
| Index is a hint | The dispatcher re-reads the stored preference and skips a client that is disabled or no longer lists the slot (counted as `staleIndexEntries`). The PUT writes the index **first**, so a failed second write can only leave a superset the dispatcher ignores. |
| Durable events | `run_discovery` records events before the Video Master upsert and **fails the run** if it cannot (a video already in Video Master is never rediscovered, so a lost event could not be recovered). `main()`'s legacy 18:00 path is unchanged (best-effort). |
| Deadline | The run stops starting new clients ~20 s before the Lambda deadline; the rest are served at their next slot (late, not lost, within the 3-day lookback). |
| Lambda | **No new Lambda.** The existing dispatcher Lambda gains `mode: new_video_slots`; unknown modes raise. Timeout 60 → 300 s. |

## 3. Cutover order (do NOT run on the source machine; Phase 2 / deploy time)

1. Create `YobiNotificationDeliverySlots` (Terraform) and attach `terraform/manual-iam/policy-lambda-notification-delivery-slots.json`
   to the Lambda role (hand-managed).
2. `python scripts/migration/backfill_notification_slots.py` (dry run) → review → `--apply`. Existing clients are invisible to the
   new dispatcher until indexed.
3. Deploy Lambda code (collector, API, dispatcher).
4. Apply the schedules: five discovery windows + `new_video_dispatch`. The old `yobi-analytics-discovery-only` schedule is *moved*
   onto window `0000` (same name, updated in place) by the `moved` block.

Rollback: disable `new_video_dispatch`; the reminder run is unaffected. Events stay deliverable for 3 days.

## 4. Assumptions Phase 2 must verify (read-only, no apply)

| # | Assumption in the source | Verify | If wrong |
| --- | --- | --- | --- |
| 1 | The only discovery schedule today is `yobi-analytics-discovery-only`, `cron(0 0 * * ? *)` Asia/Tokyo, input `{"mode":"discovery_only"}` (Roadmap §1.4.3 still says 08:00/18:00). | `aws scheduler list-schedules` / `get-schedule` for `yobi-analytics-*`. | Adjust the `moved` block / names in `eventbridge.tf`. |
| 2 | Discovery-enabled creators ≈ **106** (119 active in `src/creators.json`) → 5 windows ≈ 530 playlist reads/day (~5.3 % of a 10,000-unit quota). | Count deployed Creator Master / the manifest; check the quota ledger headroom (Roadmap budgets ~100 units/day for discovery). | Reduce windows or revisit the quota budget. |
| 3 | The five windows are exactly `00:00 / 09:00 / 13:00 / 20:00 / 22:00` Asia/Tokyo (specified by the product owner). | Confirm the plan shows exactly these five cron times. | Edit `src/tracking/discovery_windows.py` **and** `eventbridge.tf`'s `discovery_windows_jst` (parity + exact-value tests fail if they differ). |
| 4 | Existing indexes cannot answer "recipients of slot S": `configKey-index` (remote config) lists *every* client with a `notificationPreference` (slots are nested inside `value`); `creatorId-index` is Video Master's; events are `(eventDate, videoId)`; the delivery log is `(clientId, videoId)`. | `aws dynamodb describe-table` for all five tables; compare with `terraform/dynamodb.tf`. | See alternative below. |
| 5 | Table names/keys: events `(eventDate S, videoId S)` no GSI; delivery log `(clientId, videoId)`; remote config `(clientId, configKey)` + `configKey-index`. | `describe-table`. | Update the stores' constants/queries. |
| 6 | Scheduler substitutes `<aws.scheduler.scheduled-time>` inside the plain-string input. | `terraform plan` shows the exact input string; confirm after deploy in the first run's `tick`. | Safe by design: an unsubstituted value is ignored and the current tick is used. |
| 7 | The scheduler role can already invoke `yobi-analytics-notification-dispatcher` (reused), and the DLQ policy covers the new schedule. | Inspect the role policy and the DLQ queue policy. | Add the invoke/DLQ grant manually. |
| 8 | The Lambda role allows `dynamodb:PutItem` on `YobiNotificationEvents` (events used to be written with `BatchWriteItem`) and Query/PutItem/DeleteItem/BatchWriteItem on the new table + index. | `aws iam simulate-principal-policy` or read the role policies. | Attach the new policy JSON / extend the existing one. |
| 9 | Peak recipients per slot fit one sequential 300 s run (every client now shares ONE clock, and the defaults `08:00`/`18:00` concentrate them). Sends are sequential (boto3 resources are not thread-safe). | Count `notificationPreference` items and the distribution of `deliveryWindows`; the backfill dry run reports them. | Fan out per slot shard (several invokes), or add bounded concurrency with per-thread clients. |
| 10 | Stored preferences mostly satisfy the new rule. Existing windows were written as the client's LOCAL wall-clock times; they are now read as JST, so a client outside Japan changes its effective delivery time. | Backfill dry run lists floored/capped clients; count clients whose `notificationTimeZone` is not Asia/Tokyo. | Decide whether to migrate/notify those users. |
| 11 | Deployed Python 3.12 runtime has IANA tzdata for `Asia/Tokyo` (existing code already used `ZoneInfo`). | Invoke-free: check the package/runtime. | Bundle `tzdata`. |
| 12 | Package layout `notifications/`, `stores/`, `tracking/` is deployed as-is (handler `notifications.notification_dispatcher.lambda_handler`). | Inspect the last packaged zip. | n/a |

**Alternative to a new table (if Phase 2 prefers zero new infra):** denormalize one item per `(client, slot)` into
`YobiRemoteConfig` with `configKey = "deliverySlot#<slot>"`; the *existing* `configKey-index` (hash `configKey`) then returns a
slot's recipients, and `list_remote_config_by_prefix(client, "deliverySlot#")` finds a client's own items. Trade-offs: slot items show
up in the generic `GET /remote-config` listing (needs an exclusion like `pushSubscription`), and share the table's throughput cap. Only `stores/notification_slot_store.py` would change; its public functions are the seam.

## 5. Local verification performed (source machine, no AWS)

- `pytest` — whole Python suite green, including moto-backed tests of the slot store, events store and backfill.
- New dispatcher tests cover: fixed-JST slot selection (a client's stored zone, DST and a +05:45 zone do not move it; quiet hours still follow the stored zone), stale index entries, dedupe across
  dates, `activeSince`, tick resolution, deadline stop, bulk delivery-log read, routing, and that the reminder run no longer reads
  events or the slot index.
- Static checks: `terraform fmt -check` and `terraform validate` pass (local provider cache, no credentials, no plan/apply);
  `tests/test_discovery_windows_schedule.py` and `tests/test_new_video_dispatch_schedule.py` pin Terraform ↔ Python parity and the exact five windows.
- The backfill script is a dry run unless `--apply` is passed.

## 6. Evidence from the existing product (what was NOT invented)

Read from the code at `HEAD` (before this branch):

| Question | Existing behavior | Consequence here |
| --- | --- | --- |
| Is there a persisted delivery timezone? | `notificationTimeZone` is a required, validated field of every stored preference (`parse_notification_preference`); the dashboard fills it silently from the browser (`Intl`), and there is **no UI to choose it**. Roadmap 4.6: default `Asia/Tokyo` during Japanese development; per-user selection is listed as a pre-production TODO. | Treated as **not a confirmed product feature**: new-video slots are fixed JST. The field is untouched and still drives quiet hours and reminders. A client outside Japan now receives at its chosen time **in JST** (Phase 2 item 10). |
| Behavior with no delivery time configured | The backend rejects a missing/empty `deliveryWindows` (HTTP 400, `tests/notifications/test_notification_dispatch.py::test_parse_notification_preference_rejects_malformed_delivery_windows`); the dashboard has no UI and always sends a constant. A client with no stored preference receives nothing. | There is no zero-slot state to preserve; the minimum of one slot is the existing rule, surfaced in the UI. |
| 08:00 / 18:00 default | Roadmap 4.6: "the default local delivery windows are `08:00` and `18:00`"; `DEFAULT_DELIVERY_WINDOWS = ["08:00", "18:00"]` in `notificationPreferenceApi.ts` at `HEAD`. | Kept as the default until the user picks their own; not new. |
| New-video path before this branch | One `rate(1 minute)` run loaded all events and EVERY stored preference, then looped clients x events, holding each event until the client's next window (`next_delivery_window_utc`, client zone, any minute). | Replaced by the 30-minute slot dispatcher (below). |

Why the 1-minute run no longer delivers new videos: with both paths active, new videos would be timed by two different rules (any-minute
client-zone windows vs half-hour JST slots), and the old path would keep reading every client's preference every minute — the full scan the
slot-recipient index exists to remove. The shared `(clientId, videoId)` delivery log means a double send would be prevented, but the old path
would still deliver at times the client did not choose. Live and reminder behavior is otherwise unchanged: the reminder code, the schedule
snapshot refresh, the Holodex handling and their tests are not edited, and the only other thing that imports the module is the Lambda
handler entry (`src/notification_dispatcher.py`) and Terraform's handler string. No other notification type used the removed code.

