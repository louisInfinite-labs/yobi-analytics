# Late-discovery catch-up for advance reminders

## Why it exists

An advance reminder (1 hour / 30 min / 10 min / 1 min before a stream) fires in the window `[start - offset, start - offset + 1 min)`. A stream that
first reaches the dispatcher's data **after** that fire time can therefore never be reminded on time. The incident: a 30-minute reminder for a 22:00 JST
stream that YouTube created at 21:36 JST and that first appeared in the shared snapshot at 21:50 JST (Holodex lag plus the 10-minute snapshot cadence).

The on-time behaviour is deliberate and unchanged (a late "30 minutes before" is wrong; nothing is backfilled). The catch-up is a separate, optional
branch for exactly the late-discovered case, worded with the **actual** minutes left ("about N minutes").

## Stored data (all inside the existing `streamSchedule` record)

| Where | What |
| --- | --- |
| top-level `firstSeen` | `{videoId: {startMinute, firstSeenAt, priorStartMinutes}}` |
| each `entries[videoId]` | new optional `status` (`upcoming`, `live`, ...) |

- `firstSeenAt` is the refresh time of the shared snapshot that first carried the stream's **current** start (not the time the dispatcher derived it). `null` means
  "known before tracking began, or tracking could not be trusted": it never qualifies.
- `startMinute` is the current start in epoch minutes; a stamp for another minute is ignored.
- `priorStartMinutes` are the earlier start minutes of the stream, oldest first, **at most 8** (see the limitation below).
- A stamp outlives its stream's schedule entry until 2 hours after the start, so a one-snapshot Holodex dropout does not make a known stream look new.
- Compatibility: old code ignores the new fields; new code reading a record without them treats every stream as already known. Nothing needs migrating or cleaning.
- No new table, no new scheduler execution, no extra Holodex request: the stamping happens inside the derivation the dispatcher already does when the shared snapshot is
  newer.

## The deploy guard

On a derivation where first-seen tracking cannot be trusted, every stream without a trusted history is stamped `null` ("known") instead of new. Tracking is untrusted
when there is no previous record, the previous record has no `firstSeen` (the deploy itself), the previous record's own source refresh time is unknown, the snapshot
freshness cannot be read now, or more than 21 minutes (`livestream_lifecycle.DISPLAY_FRESH_SECONDS`) passed since the previous source refresh (an outage).

Without it, the first derivation after deploying would make every stream already in the schedule look newly discovered and burst a catch-up to every client with a
30-minute or 1-hour reminder.

## When a catch-up is due

All of these (`live_reminder.is_advance_catch_up_due` plus the checks in `notification_dispatcher._deliver_catch_up_advance_if_due`):

1. the resolved setting has an advance reminder (precedence unchanged: stream override > creator 全部 > creator + topic);
2. the entry's status is `upcoming`;
3. `now >= fire_at + 1 min` (the on-time window has closed; the on-time predicate is untouched, so the two never overlap);
4. `now <= start - 2 min` (never at or after the start, never in the last two minutes);
5. `firstSeenAt` is not `null`, is strictly later than `fire_at`, and belongs to the current start minute;
6. the winning setting item **and** the push subscription were both saved at or before `fire_at` (a reminder enabled, edited or re-subscribed after the original
   trigger time is never sent retroactively, like a switch turned ON after the due moment; an unknown timestamp fails closed);
7. mute / quiet hours are clear at `fire_at` **and** now; the global switch is on and a subscription exists;
8. the kill switch is on (checked **before** the next step's delivery-log read);
9. no advance reminder was already handled for an **earlier start** of this stream (R2, below);
10. the shared atomic claim succeeds.

The wording is `"about N minutes"` with `N = round(actual minutes left)`, never below 2. The payload is unchanged.

## Deduplication and reschedules

- The catch-up uses the **same dedupe id as the on-time advance reminder** for that start (`{videoId}:reminder:advance@{startMinute}`), so both can never send, and overlapping
  runs and retries collapse into one delivery. The start reminder has its own id and is never read or written by this path.
- **R2 (catch-up only):** each start minute is its own target, so a rescheduled stream's earlier reminder is invisible to the shared claim. The catch-up therefore also looks
  up `{videoId}:reminder:advance@{m}` for every `priorStartMinutes` entry plus the legacy `{videoId}:reminder:advance`, in one uncached `BatchGetItem`
  (`notification_delivery_log_store.handled_ids`; a delivered row or a live claim counts). If any exists, no catch-up.
- The on-time path keeps its per-target behaviour: a stream moved to a materially later start still gets its on-time reminder again at the new time. R2 is **not** applied to it.

### Known limitation: only the last 8 earlier starts are remembered

`priorStartMinutes` is capped at `MAX_PRIOR_START_MINUTES = 8`. A stream rescheduled more than eight times forgets its oldest start, and an advance reminder that was
delivered for that forgotten start can no longer be found by R2 (the catch-up could then send once more). This is accepted by design and covered by
`test_the_limit_an_advance_reminder_for_a_start_older_than_the_eight_remembered_is_not_found`.

## The kill switch

A system record in `YobiRemoteConfig`: `clientId = "__system__"`, `configKey = "lateAdvanceCatchUp"`, `value = {"enabled": true}`.

- Only a stored boolean `true` turns the catch-up **on**. No record, `false`, any other value, or a read error means **off** (fail closed).
- It gates **only** the catch-up send. The on-time advance reminder, the start reminder and the `firstSeen` stamping never consult it.
- It is read lazily, once per run, and only when a run actually has a catch-up candidate, so with nothing to catch up it costs nothing. A switched-off catch-up reads
  nothing from the delivery log and records nothing, so switching it on later still sends while the stream is before the 2-minute cutoff.
- **Default after deploying the code: off** (the record does not exist). Deploying changes only what is stored in `streamSchedule`.

Operating it (an AWS write: do it only with explicit approval, and write the item in the same shape `remote_config_store` uses):

```bash
# turn on  (not run by the implementation; shown for the operator)
aws dynamodb put-item --table-name YobiRemoteConfig --item file://flag-on.json
# flag-on.json: {"clientId": {"S": "__system__"}, "configKey": {"S": "lateAdvanceCatchUp"},
#                "value": {"M": {"enabled": {"BOOL": true}}}, "updatedAt": {"S": "<ISO 8601 with +00:00>"}}
# turn off (takes effect on the next minute's run): put the same item with BOOL false, or delete the item
aws dynamodb delete-item --table-name YobiRemoteConfig --key '{"clientId":{"S":"__system__"},"configKey":{"S":"lateAdvanceCatchUp"}}'
```

Rollback: switch off (instant, no deploy), or redeploy the previous shared zip to the three Lambdas (old code ignores the new fields).

## Other limits worth knowing

- Latency is Holodex discovery lag + up to 10 minutes of snapshot cadence + up to 1 minute for the dispatcher; a stream created a few minutes before its start gets nothing.
- `updatedAt` also changes when an identical setting is re-saved or a subscription is refreshed; that only ever causes a conservative miss.
- The pre-existing `TTL=0` push risk (`push_sender.py`) applies to a catch-up like any other push.
- An on-time reminder is **not** changed by this work; in particular a very small reschedule observed just after an on-time send can still produce a second on-time reminder,
  exactly as before.

## Tests

`tests/notifications/test_late_discovery_catch_up.py` (end to end through `lambda_handler`, plus the pure rules), `tests/stores/test_delivery_log_bulk_lookup.py`
(`handled_ids`). The existing matrix, dispatcher and scheduled-start tests pass unchanged apart from one stored-shape assertion that gained the new `status` field.
