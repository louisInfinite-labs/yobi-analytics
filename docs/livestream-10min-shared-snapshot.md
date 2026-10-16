# Live / Upcoming: the 10-minute shared snapshot and scheduled-start notifications

Product decisions (final): Holodex is polled **once every 10 minutes**; every visitor shares the same backend snapshot; a page view never causes a
Holodex request; 開播時通知 means "notify when the **stored scheduled start** arrives", not "after the stream is confirmed live".

## Architecture

```
EventBridge  cron(0/10 * * * ? *)  (:00 :10 :20 :30 :40 :50 UTC)
   └─ yobi-analytics-livestream-lifecycle  {"mode":"display"}
        ONE Holodex  GET /users/live?channels=<every tracked channel>   -> LIVE *and* upcoming in one response
        └─ DynamoDB YobiRemoteConfig (clientId "__system__")
             liveStreamDisplaySnapshot   large item, rewritten only when the stream list changed
             liveStreamDisplayHeartbeat  tiny item, written every run (freshness = max(snapshot, heartbeat))

GET /live-streams (every visitor)  ── reads that snapshot (+ liveStreamEnded); never calls Holodex

EventBridge  rate(5 minutes)  -> same Lambda (no input) = COMPLETION lifecycle
        reads the snapshot; ONE batched YouTube videos.list call (1 quota unit / 50 ids) for
        candidates + the streams listed live (live-end watch) + the archive watch
        └─ liveStreamSnapshot / liveStreamEnded (YouTube-confirmed ends, verified archives)

EventBridge  rate(1 minute)   -> yobi-analytics-notification-dispatcher
        compares the clock with the stored schedule; sends due reminders by Web Push (works with the PWA closed)
```

One `/users/live` request already covers both statuses and every tracked channel (97 when last probed; no pagination, no channel limit hit); there is no second request.
The 7-day lookahead is not a Holodex parameter (the endpoint ignores it); it is applied locally.

## Freshness constants (all in `tracking/livestream_lifecycle.py`, derived from `DISPLAY_REFRESH_INTERVAL_SECONDS = 600`)

| Constant | Value | Why |
| --- | --- | --- |
| `DISPLAY_FRESH_SECONDS` | 1260 s | one interval + one **missed** run + 1 min. It is also the age at which the completion job gives up on the shared snapshot and fetches Holodex itself, so it must stay above one interval: at the old 180 s the 5-minute completion job would have made its own Holodex request on **every** cycle (a test reproduces exactly this: 24 requests in two hours instead of 12). |
| `MAX_SNAPSHOT_AGE_SECONDS` | 1800 s | three missed runs; beyond it `/live-streams` answers a bounded 503 instead of an old list. |
| `DISPLAY_CONTENT_REFRESH_SECONDS` | 6 h | self-heal rewrite only; readers follow the heartbeat. |

A static test pins the Terraform cron expression to `DISPLAY_REFRESH_INTERVAL_SECONDS`.
**Deploy order matters:** ship the code first (the new thresholds also work at 1-minute cadence), then move the schedule.

## Stream-end detection and archive visibility

Measured in production before this change (35 ended streams, 29 verified archives): `actualEnd -> confirmed end` p50 5.9 min / mean 8.7 min
(Holodex keeps listing a stream for a few minutes after it ended); `actualEnd -> archive visible` p50 10.1 min / mean 13.2 min. A cadence change alone
would add up to one display interval on top of that. Two compensations keep it from regressing:

1. **Live-end watch.** Every completion cycle also asks YouTube about the streams the snapshot lists as live (same single batched call). A stream YouTube
   already reports with an `actualEndTime` is confirmed ended by the next cycle even while Holodex still lists it, so the end is confirmed within one
   completion interval (≤ 5 min) of YouTube's own end, independent of the Holodex cadence. `GET /live-streams` stops listing such a stream as live so the
   Schedule's overnight hold (which needs "ended **and** no longer listed") releases at the same moment.
2. **Archive window anchored to the end.** 14 % of verified archives needed the third attempt, 14–16 min after the end. Confirming ends earlier would have
   moved that third attempt to 10–15 min and handed those archives to the daily task, so the lookup now continues until at least 3 attempts *and*
   `ARCHIVE_LOOKUP_MIN_WINDOW` (20 min) after the actual end. The extra attempts ride in the same batch: no extra quota.

YouTube quota: at most one `videos.list` unit per completion cycle while anything is live (≤ 288 units/day, ~2.9 % of the 10,000/day quota).

## Notifications

- Start reminder = clock vs stored `scheduledStart` (`live_reminder.is_start_reminder_due`), window `[start, start + 1 min)`, evaluated by the existing 1-minute
  dispatcher. No Holodex request, no live confirmation. Wording says "scheduled to go live now" (ja: 配信開始予定時刻です, zh-TW: 預定現在開播).
- Pre-start reminders (1 / 10 / 30 / 60 min) and the topic / creator / per-stream precedence are unchanged.
- The dispatcher re-derives its `streamSchedule` entries exactly when the shared snapshot is newer than the one they came from (`sourceRefreshedAt`),
  instead of on a fixed 15-minute clock, so a stored start is never older than the snapshot.
- Delivery is deduplicated per **(client, stream, reminder kind, scheduled start)** with the existing atomic claim/confirm/release log: overlapping runs and
  retries send once, a failed send is retried inside the window, a rescheduled stream is a new target (the superseded time can never fire), and the legacy
  key (no start time) still blocks so a redeploy cannot re-send.
- One shared timer for all subscribers; there is no per-user or per-stream scheduler and none is needed.

## Known limitations (inherent, not bugs)

- A reschedule or cancellation Holodex has not reported yet is invisible until the next 10-minute snapshot.
- A stream that goes live and ends entirely between two snapshots is never observed live (left to the daily task).
- A **live stream with no scheduledStart** is keyed by its `actualStart`; it is notified only if the dispatcher sees it inside that start's one-minute
  window. This is unchanged behaviour (it was already rare with the old 15-minute derivation) and is rarer with 10-minute snapshots. Widening it is a
  separate product decision.
- A single missed dispatcher minute loses that minute's reminders (the window equals the schedule period). Not changed.
- `GET /recent-streams` still proxies Holodex `/videos` per request. Nothing in the app calls it; it is bounded by the stage throttle (10 rps). Retiring it
  is a separate decision.
