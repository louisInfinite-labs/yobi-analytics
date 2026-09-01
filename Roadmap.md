# Yobi Analytics Roadmap

## Phase 1 — Local Data Collection Foundation

### 1.1 Project Setup

#### Goal

Set up a minimal, clean Python project that can later be deployed to AWS Lambda.

#### Scope

- Inspect the local Python installation first.
- Define and pin the project Python version.
- Create a local virtual environment.
- Add dependency management.
- Add local environment configuration.
- Add Git ignore rules.
- Define UTF-8 / Unicode support from the beginning.

Recommended project setup:

```text
yobi-analytics/
├── src/
├── tests/
├── .env.example
├── .gitignore
├── requirements.txt
├── README.md
└── Roadmap.md
```

The exact folder structure should remain minimal during Phase 1 and should only expand when required.

#### Unicode / Text Requirements

The project must correctly support:

- Japanese
- Traditional Chinese
- English

All text handling should assume UTF-8 / Unicode.

Examples of valid values:

```text
藍沢エマ
常闇トワ
一ノ瀬うるは
ぶいすぽっ！
ホロライブ
立川
Traditional Chinese text
English text
```

This applies to:

- Python source files
- JSON
- CSV
- terminal output
- logs
- API payloads
- future DynamoDB data
- future dashboard data
- future user input/search

Do not assume creator names or video titles are ASCII-only.

#### Definition of Done

- Project runs locally.
- Python version is fixed.
- Local `.venv` works.
- Dependencies are isolated from global Python.
- `.env` is excluded from Git.
- `.env.example` exists without real secrets.
- Japanese/Chinese/English text can be handled correctly.

#### Out of Scope

- YouTube API implementation
- AWS Lambda
- DynamoDB
- EventBridge
- Analytics
- Dashboard
- Yobi.exe integration

---

### 1.2 Local Python Prototype

#### Goal

Prove that local Python can retrieve public YouTube video statistics.

#### Scope

Use a very small fixed test set:

- One test creator
- A few fixed YouTube video IDs

Retrieve at least:

- `videoId`
- `title`
- `publishedAt`
- `viewCount`

Example flow:

```text
Local Python
→ Fixed Video IDs
→ YouTube Public API
→ Structured Result
→ Terminal Output
```

The implementation should prefer a low-quota API approach and batch multiple video IDs where possible.

#### Error Handling

Handle at least:

- Missing API key
- Invalid API key
- Invalid video ID
- Empty result
- Network failure
- API error
- Malformed response

Do not print secrets.

#### Definition of Done

- Real YouTube public data can be retrieved locally.
- Japanese video titles render correctly.
- `viewCount` can be read.
- Multiple test video IDs can be handled.
- API failures are handled safely.
- No secret appears in source code or logs.

#### Out of Scope

- Automatic video discovery
- Creator Master
- AWS
- Database
- Daily scheduling
- Rankings

---

### 1.3 Creator Master

#### Goal

Separate creator metadata from collection logic.

#### Scope

Introduce a provider-neutral Creator Master structure.

Minimum fields:

```text
creatorId
displayName
organization
branch
groupKey
channelType
lifecycleStage
youtubeChannelId
active
discoveryEnabled
graduatedAt
```

`active` controls whether a creator is tracked at all. `discoveryEnabled` is separate: it controls whether Discovery keeps searching for new uploads, independent of whether the creator's already-known videos keep being tracked for statistics — used for graduated/retired creators whose existing videos should keep collecting snapshots without wasting quota scanning for uploads that will never come.

`graduatedAt` is an optional ISO 8601 date, only meaningful when `lifecycleStage` is `graduated`. It is **sparse by design**: a creator who hasn't graduated omits the key entirely rather than storing a placeholder like `"0000"`. This is deliberately chosen to carry over cleanly to DynamoDB later (2.3) — DynamoDB items don't require a fixed set of attributes, and a Global Secondary Index on a sparse attribute like `graduatedAt` only includes items that actually have it set, so "list graduated creators" naturally excludes everyone else without extra filtering logic. `lifecycleStage` always reflects the creator's **current** status, looked up live — there is no historical tracking of "was this creator active as of some earlier date"; once graduated, all of a creator's data (past and present) is treated as belonging to a graduated creator from that point on.

`organization` is the top-level product label (`hololive` or `vspo`). `branch` is region/language only — `holo_jp`, `holo_en`, `holo_id`, `vspo_jp`, `vspo_en` (the latter two not populated yet) — it deliberately does not encode sub-labels like DEV_IS, mekPark, or staff; that belongs in `groupKey`. `groupKey` is a **list**, not a single value, because a creator can belong to more than one grouping at once — e.g. Shirakami Fubuki is both `"1期生"` and `"ゲーマーズ"` (Hololive Gamers), and a search for either group key must find her. A creator with no applicable grouping (all current `vspo` creators) uses the placeholder `["NO"]` rather than an empty list, so the field is never null/missing.

`channelType` is `member` (an individual talent's own channel), `group` (an official channel for a unit/generation, not one person), or `staff` (an official non-talent channel, e.g. an announcer/PR channel). `lifecycleStage` is `active`, `pre_debut`, `graduated`, or `retired`, and is independent of the collection toggle `active`: a pre-debut unit can be `lifecycleStage: "pre_debut"` while also having `active: true` (it's still tracked, just hasn't formally debuted). These must be stored fields rather than values inferred from display names. APIs, rankings, and the Dashboard must support hierarchical filtering so group/staff/pre-debut channels are not mistaken for active member rankings.

Note the resulting three-way overload of "active(ity)" in this project — worth keeping straight when naming fields/variables: Creator Master's `active` (a boolean collection on/off toggle), `lifecycleStage: "active"` (a talent's real-world career status, one of four string values), and per-video `activityState` (1.5's `Hot`/`Unknown`/`Warm`/`Cold` engagement tier, unrelated to either of the above).

The following shared/group channels are in `creators.json` (verified via the YouTube Data API), all under `organization: "hololive"` — mekPark's pre-debut units are not a separate organization:

| `creatorId` | Actual YouTube channel name | `branch` | `groupKey` | `channelType` | `lifecycleStage` | YouTube Channel ID |
| --- | --- | --- | --- | --- | --- | --- |
| `hololive_dev_is_regloss` | `hololive DEV_IS ReGLOSS` | `holo_jp` | `["ReGLOSS"]` | `group` | `active` | `UC10wVt6hoQiwySRhz7RdOUA` |
| `hololive_dev_is_flow_glow` | `hololive DEV_IS FLOW GLOW` | `holo_jp` | `["FLOWGLOW"]` | `group` | `active` | `UCu2n3qHuOuQIygREMnWeQWg` |
| `achrora` | `ACHRORA - mekPark` | `holo_jp` | `["mekpark"]` | `group` | `pre_debut` | `UChpRPsAeSZn5DistGacR3iA` |
| `unit_b_pre_debut` | `UNIT B (Pre-Debut) - mekPark` | `holo_jp` | `["mekpark"]` | `group` | `pre_debut` | `UC3OH5FKQ3qtl4uRme_vZTgA` |
| `holoan_room` | `holoAN room (ホロアナ)` | `holo_jp` | `["aNnounce"]` | `staff` | `active` | `UCozx5csNhCx1wsVq3SZVkBQ` |

ReGLOSS and FLOW GLOW are two distinct hololive DEV_IS channels with different Channel IDs, not the same channel under two names. `holoAN room`'s `aNnounce` group key comes from the channel's own naming (**AN**nounce + **AN**chor), and it posts as hololive Production's shared official announcer persona rather than one individual talent.

Initial organizations:

```text
hololive
vspo
```

Example (active creator, `graduatedAt` omitted):

```json
{
  "creatorId": "aizawa_ema",
  "displayName": "藍沢エマ",
  "organization": "vspo",
  "branch": "vspo_jp",
  "groupKey": ["NO"],
  "channelType": "member",
  "lifecycleStage": "active",
  "youtubeChannelId": "UC...",
  "active": true,
  "discoveryEnabled": true
}
```

Example (graduated creator):

```json
{
  "creatorId": "gawr_gura",
  "displayName": "Gawr Gura",
  "organization": "hololive",
  "branch": "holo_en",
  "groupKey": ["Myth"],
  "channelType": "member",
  "lifecycleStage": "graduated",
  "graduatedAt": "2025-05-01",
  "youtubeChannelId": "UC...",
  "active": true,
  "discoveryEnabled": false
}
```

Creator data should not be hard-coded directly inside collection logic.

#### Definition of Done

- Creator data is stored separately from Python collection logic.
- Collector can load active creators.
- New creators can be added without changing the collection core.
- Japanese creator names remain intact.
- `graduatedAt` is present only for `graduated` creators (sparse — omitted, not a placeholder, for everyone else) and is a valid ISO 8601 date.
- Every Creator Master entry explicitly stores `organization`, `branch`, `groupKey`, `channelType`, and `lifecycleStage`; neither backend nor Dashboard may infer classification from names.
- The real `creators.json` includes all five shared/group channels from the table above with their verified Channel IDs and classification fields.
- Channel ID uniqueness is maintained — `holoan_room` is one shared staff channel, not duplicated per persona.

#### Out of Scope

- Dashboard creator editing
- Remote creator management
- User-generated creator lists
- Google OAuth subscriptions

---

### 1.4 Video Discovery

#### Goal

Build and maintain the set of videos that should be tracked for a creator — the **Tracking Universe** (Video Master). This is not the same as "the creator's most recent videos" or "the videos with the most views right now".

#### Why This Matters

A video's current `viewCount` alone does not tell us whether it is trending. A video that was quiet for months can suddenly gain a large number of views in a single day because YouTube's recommendation algorithm starts pushing it. To catch that kind of sudden growth, the system must keep tracking a creator's videos regardless of how old they are or how few views they currently have — not just their newest or currently-most-viewed uploads.

YouTube's API only ever reports the current cumulative `viewCount`; it does not expose historical daily values. All historical change is derived by this project from its own stored raw snapshots — a video only starts building history from whichever day it was first added to the Tracking Universe, and view counts from before that day cannot be backfilled.

#### 1.4.1 Uploads Playlist Resolution

- Resolve Channel ID → Uploads Playlist ID using `channels.list`.
- Do not use `search.list` as the primary discovery method. Under the current YouTube quota model it has a separate default daily call bucket, while the cached uploads-playlist path is complete for this use case and costs only 1 general quota unit per `playlistItems.list` call.

#### 1.4.2 Initial Historical Discovery

- Use `playlistItems.list` to page through a creator's uploads.
- Support `nextPageToken` pagination.
- On first-time setup, scan through the creator's available upload history.
- Collect every reachable Video ID.
- Store/upsert the collected IDs into Video Master to build the Tracking Universe.
- Insert/upsert must be safely repeatable without creating duplicates.

`playlistItems.list` returns at most 50 items per page. That is a limit on a single API request/page — it is not a limit on how many videos the system tracks overall.

#### 1.4.3 Incremental Discovery

- After Initial Discovery has completed, only scan the newest uploads each day.
- Compare scanned Video IDs against what is already known in the database.
- New videos are inserted/upserted into Video Master and added to the Tracking Universe.
- Videos that already exist are not recreated.
- Once a known video is reached, pagination toward older pages can stop.

##### Daily New-Upload Quota Contract

Cache each channel's uploads playlist ID after resolution. During local development, incremental discovery runs in two configurable JST windows: `08:00` and `18:00` in `Asia/Tokyo`. The morning run is the single additional check alongside the existing `18:00` collection run. Each reconciliation reads the first uploads-playlist page with `maxResults=50` and only follows `nextPageToken` while every returned Video ID is still unknown; it stops as soon as an already-known ID proves that the scan has rejoined local history. YouTube does not impose a special "new-video day" timezone on this poll: these are application-owned schedule settings chosen for convenient Japanese development and testing.

```text
discoveryUnits = sum(playlist pages read for discovery-enabled channels)
newVideoDetailUnits = ceil(newVideoIdsNotAlreadyInStatisticsRun / 50)
```

Under the current YouTube quota table, `playlistItems.list`, `channels.list`, and `videos.list` each cost 1 general quota unit per call. With the current roster file's 99 discovery-enabled channels, one normal one-page scan costs about **99 units (0.99% of a 10,000-unit daily quota)**; two scans cost about **198 units/day (1.98%)** before any separate new-video detail batches. If 1–50 new IDs in a window need a separate batched `videos.list`, add 1 unit; preferably merge the `18:00` discoveries into the same day's statistics batch so no duplicate detail request is made. Two playlist pages for every enabled channel in one window would cost 198 units, but that should be exceptional after a missed run rather than the steady state. Resolving uploads playlist IDs with batched `channels.list` is onboarding/roster-change work and must not be repeated every day.

All discovery calls and retries use the same Pacific-day quota ledger and hard caps as statistics collection. Persist pages read, new IDs found, estimated/actual units, and the last successful discovery time per channel. A failed channel scan must be retryable independently and must not cause successful channels or known-video statistics batches to run again.

These two reconciliation windows discover uploads cheaply and repair missed push events; they are not a minute-level live notification mechanism. If near-real-time new-upload notification is added later, prefer YouTube PubSubHubbub/WebSub push callbacks and retain the scheduled playlist scans as reconciliation rather than polling every channel every few minutes.

#### 1.4.4 Statistics Collection

- Use `videos.list` against the Tracking Universe.
- Batch Video IDs rather than requesting one at a time.
- Retrieve current public statistics via `part=snippet,statistics`.
- Store the current `viewCount`.

Discovery and Statistics Collection are separate responsibilities: Discovery decides *which videos to track*; Statistics Collection finds out *their current public state*.

#### 1.4.5 Daily Raw Snapshot

- Save a snapshot whenever a tracked video is due under the adaptive schedule: daily for recent/Hot videos, every 2 days for Unknown, every 3 days for Warm, and every 15 days for Cold, plus explicit admin overrides (see 1.5).
- Store `videoId`.
- Store the snapshot time/date.
- Store `viewCount`.
- Snapshots must accumulate history — never overwrite the previous day's snapshot.
- See 1.6 Raw Daily Snapshot Model for the full field list actually stored (`creatorId`, `title`, `publishedAt`, and `organization` in addition to the above).
- This raw data is what later daily / 7-day / 30-day growth analytics is built from.

#### Video Master Schema

Unlike Creator Master (1.3) and Snapshot (1.6), Video Master's fields have so far only been described in prose across several sections. One record, showing both the discovery-identity fields and the Adaptive Tracking Frequency scheduler state (1.5):

```json
{
  "videoId": "dQw4w9WgXcQ",
  "creatorId": "aizawa_ema",
  "title": "...",
  "publishedAt": "2026-08-20T10:00:00Z",

  "activityState": "Warm",
  "lastCheckedAt": "2026-08-30T18:03:14+09:00",
  "lastViewCount": 137682,
  "snapshotCount": 4,
  "quietStreak": 0,
  "lastClassificationReason": "moderate_growth"
}
```

`activityState` is one of `Unknown`/`Hot`/`Warm`/`Cold` (1.5). `lastCheckedAt`/`lastViewCount` are the prior observation `classify_after_observation` compares the next one against — not duplicated per-day history, which lives in Snapshot (1.6) instead. `snapshotCount` is the video's lifetime observation count (used for the Unknown bootstrap gate); `quietStreak` is consecutive quiet observations since the last promotion (used for the demotion gate). `lastClassificationReason` is a short machine-readable tag (e.g. `bootstrap_first_snapshot`, `strong_growth`, `demoted_after_quiet_streak`) recording why the last transition happened, for auditing without needing to recompute it from snapshot history.

A newly discovered video is inserted with only the identity fields; the scheduler-state fields default to `activityState: "Unknown"`, `snapshotCount: 0`, `quietStreak: 0`, `lastCheckedAt`/`lastViewCount` absent — i.e. bootstrap, per 1.5's Bootstrap and State Transitions. A record written before these fields existed parses the same way, as if never yet classified.

#### Scope Boundary

```text
Discovery
→ decide which Video IDs should be tracked

Tracking / Collection
→ fetch how many views those videos have right now

Snapshot
→ store this moment's raw state

Analytics
→ compare snapshots across time to find which video suddenly spiked
```

Discovery, Snapshot, and Analytics must not be merged into a single function/responsibility.

#### Definition of Done

- A Channel ID can be resolved to its Uploads Playlist ID.
- Initial Discovery can page through and collect a creator's historical uploads via `playlistItems.list` + `nextPageToken`.
- Incremental Discovery detects new uploads without rescanning full history, and stops once it reaches an already-known video.
- Video Master insert/upsert is idempotent — rerunning discovery does not create duplicate records.
- Statistics Collection is implemented separately from Discovery and retrieves `viewCount` via batched `videos.list` calls.
- A raw snapshot is stored for a tracked video whenever it is due for collection, without overwriting prior days' data.
- Manual Video ID entry is no longer required.

#### Out of Scope

- Historical ranking
- Google OAuth
- User subscriptions
- Live notification logic
- AI recommendations
- Deciding the tracking frequency for older videos (see 1.5, next)

---

### 1.5 Adaptive Tracking Frequency

#### Goal

Once a video enters the Tracking Universe, decide how often it should be checked from both upload age and observed growth. Preserve useful precision, prevent newly imported old videos from disappearing into a slow tier before their velocity is known, and keep Hololive JP + VSPO JP normal collection within a target of 20% of the default daily quota so capacity remains for additional organizations and clip/translation/Shorts channels.

#### Scope

Age and activity are separate dimensions. Upload age protects every video for its first 30 days; activity determines the schedule afterward:

```text
Recent  (0–30 days old) → every day, regardless of current views
Hot                     → every day
Unknown                 → every 2 days
Warm                    → every 3 days
Cold                    → every 15 days
Admin override          → explicitly selected run, subject to the hard quota cap
```

A video's total `viewCount` does not define activity. Five million lifetime views with +10/day (0.0002%/day) is Cold, while 5,000 lifetime views with +1,000/day (20%/day) is Hot. Classification is purely percent-of-current-views per day — no absolute views/day floor. This is a deliberate simplification: a very small video can cross these thresholds on a trivial absolute gain (e.g. 10 → 15 views is 50%/day), and that is accepted rather than adding a second absolute-value condition. Initial tuning thresholds are:

```text
Hot  → >=2%/day
Warm → >=0.5%/day
Cold → below Hot/Warm thresholds for the required consecutive observations
```

Thresholds are runtime configuration, not permanent constants. Store the measurements and classification reason so they can be tuned without rewriting snapshot history.

#### Bootstrap and State Transitions

- A first cumulative `viewCount` is only a baseline. Every first-time import is `Unknown`, even when it is old and has few total views.
- `Unknown` is checked every 2 days and requires at least three snapshots (two valid comparison intervals) before it may move to *any* other state — `Hot`/`Warm`/`Cold` alike wait for the same minimum evidence, so an early single strong interval does not promote it early. This keeps every state's promotion/demotion decision resting on the same amount of evidence rather than letting `Unknown` jump the queue.
- Once `Unknown` has enough snapshots, it moves directly to whichever state the latest interval supports: `Hot` on strong growth, `Warm` on moderate growth, `Cold` if quiet.
- For an already-classified video (`Hot`/`Warm`/`Cold`), promotion to a faster class may happen immediately on a single strong/moderate interval. Demotion is stricter: exactly 3 consecutive quiet observations (not counting missing/incomplete ones) are required before a video drops one class (`Hot`→`Warm`, `Warm`→`Cold`), to prevent oscillation from a single noisy or quiet data point.
- A video older than 30 days that becomes active again is promoted to Hot or Warm; age never prevents reactivation.
- Missing/incomplete snapshots do not count as quiet observations and cannot demote a video.

#### Stable Daily Rotation

Use independent, stable ID-based rotation keys rather than weekday/month-end triggers:

```text
Unknown → stable_hash(videoId) % 2
Warm    → stable_hash(videoId) % 3
Cold    → stable_hash(videoId) % 15
```

Each day processes the due slice from every pool, so there are no days that collect only recent videos. A Cold video is guaranteed at least one observation in each 15-day circle. Stable rotation spreads work evenly and remains deterministic across restarts.

Discovery (1.4.2/1.4.3) is unaffected by this — it keeps running daily for every discovery-enabled creator, since it is already cheap (roughly 1–2 units/creator/day) and is a separate concern from how often a video's *statistics* get refreshed.

#### Daily Quota Budget and Priority

For a default 10,000-unit daily allowance, keep 2,000 units/day (20%) as the preferred normal-operation target for Hololive JP + VSPO JP. The original scheduled collection and at most two immediate retries for failed batches share a 3,000-unit (30%) immediate-phase cap; eligible deferred retries after all three total immediate attempts may use additional headroom, while the absolute daily hard cap across the entire workflow is 4,000 units (40%). Begin with a planning envelope of roughly 1,700 units for ordinary batched statistics, 100 for discovery/metadata, and dynamically reserve the remaining headroom for a full pass and retries. Treat all values as configurable budgets and verify actual API-console accounting.

Build one deduplicated due set in this priority order:

```text
Recent → Hot → Unknown → Admin override → Warm → due Cold
→ if budget remains, least-recently-checked eligible videos
```

The hard cap always wins. Overflow is carried forward by `nextCheckAt`/`lastCheckedAt`; it must not produce duplicate same-day snapshots.

If even the unconditionally-due tiers (Recent + Hot) alone would exceed the hard cap, drop videos published over a year ago whose recent growth is below 5%/day from today's mandatory set first — they fall back to their normal rotation instead of being force-checked. This protects genuinely fast-moving old videos (which still clear the 5% floor) while giving up on stale ones under quota pressure. 5%/day is an initial provisional value, not a permanent constant.

#### Admin Collection Overrides

Support bounded selectors for one creator or organization: newest N, oldest N, an oldest-first rank range such as 101–500, an inclusive JST publication-date range, or explicit Video IDs. Resolve these selectors against Video Master, using deterministic `(publishedAt, videoId)` ordering, then batch the resulting IDs through `videos.list`. Union them with the normal due set and deduplicate by `videoId`.

Do not implement routine admin selection with `search.list`. The uploads playlist can be completely paginated into Video Master, after which newest/oldest/range selection is local and complete. `playlistItems.list` has pagination but no native oldest/latest-count or publication-date-range filter; `search.list` exposes date bounds but channel results can be limited/incomplete. Provide a dry-run that reports selected count, batches, estimated quota, and videos excluded by validation before making API calls.

#### Implementation Note / Verification Checkpoint

The collector source code is not currently present in this repository checkout, so the following requirements must be verified against the implementation when the source is available. They are requirements, not claims about the current code:

- Calculate `ageDays` once per video per run as a calendar-date difference in `Asia/Tokyo`: convert `publishedAt` to its JST calendar date, then subtract it from the run's JST `snapshotDate`. Do not classify by partially elapsed 24-hour periods. Treat a negative result as invalid data that must be reported.
- Keep age and activity fields separate. `ageDays <= 30` forces daily Recent treatment; older videos use exactly one of Unknown/Hot/Warm/Cold for normal scheduling.
- Scheduling plus admin selectors must produce one final `isDue` decision per video per run.
- Deduplicate the collection input by `videoId`, and allow at most one statistics request result and one snapshot record for the same `(videoId, snapshotDate)`. A same-day retry must be idempotent rather than create another snapshot.
- Add tests for ages `30`/`31`, bootstrap Unknown handling, 2/3/15-day rotations, promotion/demotion hysteresis, incomplete intervals, quota overflow, selector bounds/date inclusivity, duplicate Video IDs, and same-day retries.

#### Definition of Done

- Every newly imported video starts as Unknown; no baseline-only video can become Cold.
- Recent and Hot videos are due daily, Unknown every 2 days, Warm every 3 days, and Cold at least once per 15-day circle.
- Activity thresholds and consecutive-observation rules are configurable and explainable from stored measurements.
- Admin selectors for latest/oldest/rank range/date range are deterministic, bounded, dry-runnable, merged with normal work, and deduplicated.
- The implementation checkpoint above has been verified in source and covered by automated boundary/idempotency tests.
- No single day's statistics-collection workload spikes meaningfully above the daily average, even in a worst-case tier alignment.
- Hololive JP + VSPO JP aims for 2,000 units/20% in normal operation; the original collection and two immediate retries share a 3,000-unit/30% immediate-phase cap, while eligible deferred recovery may use additional headroom up to the 4,000-unit/40% absolute daily hard cap.

#### Out of Scope

- Automatic threshold tuning or ML-based activity classification
- End-user-triggered unrestricted collection; overrides are admin-only and quota-bounded
- Requesting a YouTube API quota increase from Google — this project's use case (bulk statistics harvesting for analytics) falls into a category Google frequently denies; tiering is the reliable lever, not a quota request

---

### 1.6 Raw Daily Snapshot Model

#### Goal

Define the historical raw data format before moving to AWS storage.

#### Scope

Daily snapshots should contain enough data for future analytics.

Recommended fields:

```text
snapshotDate
observedAt
creatorId
videoId
title
publishedAt
viewCount
organization
```

Example:

```json
{
  "snapshotDate": "2026-08-28",
  "observedAt": "2026-08-28T18:00:05+09:00",
  "creatorId": "aizawa_ema",
  "videoId": "abc123",
  "title": "Example Video",
  "publishedAt": "2026-08-25T12:00:00Z",
  "viewCount": 125000,
  "organization": "vspo"
}
```

Future calculations:

```text
daily growth
= current local report-date snapshot - previous local calendar-date snapshot

7d growth
= current local report-date snapshot - local report-date snapshot from 7 calendar days earlier

30d growth
= current local report-date snapshot - local report-date snapshot from 30 calendar days earlier
```

Raw snapshots must be preserved.

Do not only store calculated rankings.

#### Known Issue: Partial Snapshots Are Not Distinguishable From Complete Ones

Since 1.4, when Statistics Collection cannot parse a video's data (e.g. a members-only video with hidden statistics), that video is skipped with a printed warning only — the saved snapshot contains no record that anything was skipped. A partial snapshot currently looks identical to a complete one once saved, which can silently distort later growth calculations (a video missing from one day's snapshot looks the same as "no change" rather than "we don't actually know").

This should be resolved as part of formalizing the snapshot model in 1.6, not before. Two options were weighed:

1. **Log-only summary**: print an end-of-run summary (e.g. "collected 96,200 / 96,262 videos, 62 skipped") without changing the saved snapshot format.
2. **Snapshot-level metadata**: store completeness information alongside the snapshot data itself (e.g. requested count / skipped video IDs), so incompleteness is visible from the data, not just the run log.

**Decision: Option 2 (snapshot-level metadata).** A log line alone isn't queryable by future analytics — a video missing from a day's snapshot would still be indistinguishable from a video that simply wasn't due that day. `main.py` now persists a `SnapshotRunSummary` (`snapshot_store.py`) alongside each day's snapshot file: `requestedCount`, `collectedCount`, and a `skipped` list are written to a companion `{date}.summary.json` file every run, not only when something was skipped — including the worst case where every batch fails and zero videos are collected, since that's the case future analytics needs the record for most. Each skipped video also carries its `reason` (e.g. a YouTube API/network failure vs. a malformed or missing item), not just its ID, so a run's completeness can be checked later without digging through console logs. The console warning line remains for immediate visibility, but the durable record now lives in stored data.

The snapshot file and its run-summary file are written as one recoverable pair (`save_daily_collection`): if the summary write fails after the snapshot write succeeds, the snapshot is rolled back rather than left orphaned, so a retry isn't permanently blocked by a stray file that exclusive-create would otherwise refuse to touch again.

#### Design Note: Snapshot Deliberately Does Not Carry `branch`/`groupKey`/`channelType`/`lifecycleStage`

1.3 later added `branch`, `groupKey`, `channelType`, and `lifecycleStage` to Creator Master. `Snapshot` still only carries `organization`, not these four — this is deliberate, not an oversight:

```json
// Kept lean (current):
{"snapshotDate": "2026-08-31", "creatorId": "shirakami_fubuki", "videoId": "abc123", "viewCount": 125000, "organization": "hololive"}
// vs. denormalized (rejected for now):
{"...": "...", "branch": "holo_jp", "groupKey": ["1期生", "ゲーマーズ"], "channelType": "member", "lifecycleStage": "active"}
```

`branch`, `groupKey`, and `channelType` are effectively permanent facts about a creator — duplicating them into every snapshot record, for every video, every day, forever, is pure repeated storage with no analytical benefit; a `creatorId` lookup against Creator Master is enough. `lifecycleStage` is the one field that genuinely changes over time (`active` → `graduated`), which raised a real question: should a report about a past date reflect the creator's status *as of that date*, or their *current* status looked up live?

**Decision: always use the creator's current `lifecycleStage`, looked up live — no historical tracking.** Once a creator graduates, every report treats all of their data (past and present) as belonging to a `graduated` creator from that point on; nothing preserves "was `active` as of some earlier date." This keeps the model simple and matches how the project actually wants graduation reflected — retroactively, not date-scoped. Do not denormalize any of these four fields into `Snapshot`; all four are resolved via a live `creatorId` lookup against Creator Master, including at query time in 3.4 (Read API).

#### Definition of Done

- Snapshot model is defined.
- Historical data is never overwritten accidentally.
- Retry/idempotency strategy is defined.
- Data is migration-friendly.
- Attributes remain explicit and readable.
- A decision has been made (and implemented) on how partial/incomplete snapshots are represented: snapshot-level metadata, persisted via a per-day run summary (see "Known Issue" above).

#### Out of Scope

- DynamoDB implementation
- Analytics calculations
- Dashboard
- Yobi API

---

## Phase 2 — AWS Collection Pipeline

### 2.1 AWS Account and CLI Setup

#### Goal

Prepare a safe AWS development environment.

#### Scope

- AWS account setup
- Region selection
- AWS CLI installation
- AWS CLI authentication
- IAM setup
- Budget / billing alerts

Recommended region:

```text
ap-northeast-1
```

unless another region is intentionally selected later.

Security rules:

- Never commit AWS credentials.
- Do not hard-code AWS account IDs unless required.
- Use least-privilege IAM.
- Configure cost alerts early.

Example budget alerts:

```text
$1 warning
$5 stronger warning
```

#### Definition of Done

- AWS CLI works locally.
- Authentication works safely.
- IAM permissions are minimal.
- Billing alerts are active.
- No AWS credentials are tracked by Git.

#### Out of Scope

- Lambda deployment
- DynamoDB
- EventBridge
- API Gateway

---

### 2.2 Lambda Manual Deployment

#### Goal

Run the collector without requiring the Windows dev machine to remain powered on.

#### Scope

Initial deployment flow:

```text
Local Python
→ Package / ZIP
→ AWS CLI
→ AWS Lambda
→ Manual Test
→ CloudWatch Logs
```

Do not use EC2 for the daily collector.

Lambda should:

1. Start.
2. Run the collection job.
3. Log a safe summary.
4. Exit.

Do not log secrets.

#### Known Constraint: Lambda's Deployment Package Is Read-Only

The local JSON stores the collector *writes* (`video_master.json`, `snapshots/`) default to writing next to the source code (`Path(__file__).parent`). Lambda's deployment package directory is read-only at runtime — a write there raises `PermissionError`, not just "doesn't persist." A `YOBI_DATA_DIR` environment variable (read once, at import time, by `json_store.DATA_DIR`) overrides that base directory for those two; local development is unaffected (unset by default), while the Lambda deployment sets it to `/tmp`, the only writable path in the Lambda execution environment.

This does not make video/snapshot data durable — `/tmp` is wiped on cold start and isn't shared across invocations. It only lets the real collection job run on Lambda without crashing, so 2.2 can prove out deployment/invocation/logging mechanics. Durable storage is Roadmap 2.3's job (moving to DynamoDB), not this section's.

`creators.json` is deliberately excluded from this override. Nothing ever writes it at runtime — it's a fixed reference dataset — so it stays on the package path (`Path(__file__).parent`, unaffected by `YOBI_DATA_DIR`) in both environments. Lambda's package directory is read-only but still readable, so this works without any bootstrap/copy step. Redirecting it to `/tmp` too was tried and found to be a real bug: nothing copies the packaged file there on cold start, so it would silently load as empty and `main()` would exit 0 having collected nothing, with no error to indicate why.

#### Definition of Done

- Python code can be packaged.
- AWS CLI can deploy/update Lambda.
- Lambda runs successfully.
- Manual invocation works.
- CloudWatch contains useful safe logs.

#### Out of Scope

- GitHub Actions
- Automatic deployment
- Infrastructure-as-code
- Production API

---

### 2.3 DynamoDB Storage

#### Goal

Store daily raw snapshots in AWS.

#### Initial Storage Decision

Use:

```text
AWS DynamoDB
```

#### Why DynamoDB

DynamoDB is chosen initially because:

- Workload is very small.
- Collector runs roughly once per day.
- No MySQL/PostgreSQL server needs to stay online.
- No DB instance needs to be maintained.
- No database OS/port/patching management.
- Fully managed / serverless.
- Good integration with Lambda through AWS SDK / `boto3`.
- On-demand/pay-per-request is suitable for low usage.
- Current access patterns are predictable:
  - creator + date
  - video + date
  - daily snapshots
  - small scheduled batch writes
  - creator/organization + `publishedAt` for bounded newest/oldest/date-range admin selection
  - activity state + `nextCheckAt` for the adaptive due queue

Architecture:

```text
EventBridge
→ Lambda
→ DynamoDB
```

#### DynamoDB Is Not a Compute Server

DynamoDB is only a database service.

It cannot run:

```text
Minecraft Server
Long-running Python process
Application server
Web server process
```

Compute workloads require services such as:

```text
Lambda
EC2
ECS
```

#### DynamoDB Trade-offs

DynamoDB is NoSQL.

Compared with MySQL/PostgreSQL, it is less convenient for:

```text
JOIN
GROUP BY
complex relational analytics
ad-hoc SQL queries
```

If analytics later becomes significantly more relational or exploratory:

```text
DynamoDB
→ Export
→ Transform
→ MySQL / PostgreSQL
```

This migration path should remain possible.

Keep migration-friendly attributes:

```text
creatorId
videoId
snapshotDate
observedAt
viewCount
organization
title
publishedAt
```

Do not encode all meaningful data only inside opaque composite strings.

Phase 2.3 must also persist scheduler state in Video Master (not duplicate it into every raw snapshot): `activityState`, `lastCheckedAt`, `nextCheckAt`, consecutive quiet-observation count, recent velocity measurements, and the last classification reason. Design the table keys/indexes for the two access patterns above; do not rely on a full-table scan for each daily run or admin command.

#### 2.3.1 Local JSON to DynamoDB Migration and Cutover

Historical snapshots accumulated during local development are production seed data and must not be discarded when DynamoDB becomes authoritative. Build a one-time migration command/script as part of Phase 2.3; copying files into Lambda `/tmp` is not migration because `/tmp` is ephemeral and invocation-local.

Migration inputs:

```text
video_master.json
snapshots/*
snapshot run-summary files
explicit source schema/version and JST cutover date
```

Required flow:

1. Freeze local writes after a known successful JST `snapshotDate` and make a read-only backup of the input files.
2. Validate every input before writing: schema/version, required IDs and timestamps, non-negative counts, unique `(videoId, snapshotDate)` keys, snapshot/summary pairing, and referential consistency with Video Master.
3. Provide `--dry-run` that reports valid/invalid records, destination conflicts, per-table write counts, estimated DynamoDB writes, the earliest/latest snapshot dates, and the proposed next collection date.
4. Import/upsert Video Master, immutable snapshots, and run summaries in bounded batches with retry/backoff and a durable migration run ID/checkpoint, so an interrupted import can resume safely.
5. Make replay idempotent: an identical destination record is skipped; a record with the same key but different content is a hard conflict that stops cutover and is never silently overwritten.
6. Rebuild scheduler state deterministically from imported snapshots (or verify imported state against that reconstruction), including `activityState`, `lastCheckedAt`, `nextCheckAt`, recent velocity, and quiet-observation count. Imported videos with insufficient valid intervals remain `Unknown`; they do not reset arbitrarily or become Cold from age/total views.
7. Reconcile source and destination using total and per-date/per-creator counts, skipped/error counts from run summaries, earliest/latest `snapshotDate`, and deterministic checksums or equivalent content verification. Sampling alone is insufficient for final approval.
8. Run the AWS collector in no-write/dry-run mode for the proposed next JST date. Confirm it selects the expected due set, creates no already-imported date, respects the quota cap, and does not rebuild the Tracking Universe as new baselines.
9. Enable EventBridge only after reconciliation passes. The first live AWS write uses the next uncollected JST `snapshotDate`; if there is a genuine date gap, record it as missing/incomplete rather than fabricating a snapshot.
10. Keep the local backup and importer report until at least one successful AWS collection and read-back verification complete. Rollback means disabling EventBridge and retaining DynamoDB/import evidence; never delete or overwrite local history during rollback.

Only one system may be the authoritative writer during cutover. Do not leave the local scheduler and EventBridge writing the same date concurrently. Store a cutover manifest containing migration run ID, source schema/version, source record counts/checksums, last local snapshot date, first intended AWS snapshot date, destination table names/region, and verification result; it must contain no API keys or secrets.

#### Definition of Done

- Lambda can write snapshots to DynamoDB.
- Historical data can be queried back.
- Duplicate daily retries do not corrupt data.
- The local-to-DynamoDB importer supports validation, dry-run, resumable/idempotent replay, conflict detection, and a cutover manifest.
- All local Video Master records, snapshots, and run summaries reconcile against DynamoDB before EventBridge is enabled.
- Scheduler state is reconstructed/verified from imported history, and the first live AWS run continues at the next uncollected JST date without resetting baselines.
- Local rollback data is retained until a successful AWS write and read-back verification complete.
- Snapshot data remains migration-friendly.
- Storage cost/usage is understood.

#### Out of Scope

- MySQL migration
- Heavy relational analytics
- Direct unrestricted Yobi.exe access to DynamoDB

---

### 2.4 EventBridge Snapshot and Discovery Schedules

#### Goal

Automatically collect one view snapshot run every day and reconcile new uploads twice per day.

#### Schedule

```text
Every day at 18:00
Timezone: Asia/Tokyo

Incremental new-upload discovery at 08:00 and 18:00
Timezone: Asia/Tokyo during development
```

`18:00 Asia/Tokyo` is the initial configurable production schedule. It intentionally waits about one hour beyond the currently observed 16:30–17:00 JST public-view-count settling window, so no developer needs to trigger collection manually. The YouTube Data API documents `statistics.viewCount` as the current cumulative count but does not guarantee this observed window as a fixed daily refresh SLA. Therefore:

- Store the schedule as configuration (for example `COLLECTION_TIME_ZONE=Asia/Tokyo`, `COLLECTION_LOCAL_TIME=18:00`), not as hidden business logic.
- Record `scheduledFor`, actual `startedAt`/`completedAt`, and freshness diagnostics for every run.
- Alert when the returned data appears stale or the run starts outside its tolerance window; adjust the configured time only after measured evidence.
- A schedule change affects only when raw data is acquired. It must not rewrite historical `snapshotDate` values or change analytics date boundaries.

Flow:

```text
EventBridge Scheduler
→ Collector Lambda
→ YouTube API
→ DynamoDB
```

No server stays running between executions.

Phase 2.4 is where the Phase 1.4.3 incremental-discovery and Phase 1.5 scheduling specifications become operational. The `08:00` and `18:00` discovery invocations scan newest uploads and idempotently upsert new Video IDs. The `18:00` invocation additionally builds the Recent/Hot/Unknown/Warm/Cold statistics due set, includes newly discovered videos for their initial baseline, merges admin overrides, deduplicates all work, enforces the shared quota ledger/hard cap, and carries overflow forward. A discovered-video event stores at least `videoId`, `creatorId`, `publishedAt`, `discoveredAt`, discovery source, and notification eligibility; duplicate scans must not create duplicate events. The planned README admin commands belong to this implementation checkpoint; they must support `--dry-run` before live collection.

#### Definition of Done

- The statistics collector runs automatically once every day, while incremental discovery runs at the two configured JST windows.
- Daily incremental discovery scans enabled channels, records its estimated/actual quota usage, and inserts newly published videos without rescanning full channel history.
- The adaptive 1/2/3/15-day schedule and bounded admin selectors are implemented as specified in 1.5.
- Per-run quota estimates and actual usage are recorded, and the configured hard cap is enforced.
- Windows dev machine can be powered off.
- Execution appears in CloudWatch.
- Failures are observable.

#### Out of Scope

- Minute-level collection
- High-frequency polling
- Real-time view tracking

---

### 2.5 Reliability and Monitoring

#### Goal

Make the collection pipeline safe and observable.

#### Scope

Handle:

- API/network failure
- YouTube quota/rate-limit errors
- malformed response
- missing creator data
- missing video data
- DynamoDB write failure
- duplicate daily execution
- partial collection failure

Use CloudWatch logs.

Do not log secrets.

#### 2.5.1 Bounded Immediate and Deferred Retry Policy

Retries are per failed creator batch/Video ID set, not a full rerun of successful work. Every attempt consumes quota, including invalid requests, so all attempts reserve from one Pacific-day quota ledger. The original scheduled request and two immediate retries share a 3,000-unit/30% immediate-phase cap; eligible deferred recovery may subsequently use additional headroom, while the entire workflow shares a 4,000-unit/40% absolute daily hard cap. The 2,000-unit/20% value is a planning target, not a stop boundary.

Classify failures before scheduling a retry:

```text
Retryable immediately/deferred:
network interruption, timeout, HTTP 429/rateLimitExceeded,
HTTP 500/502/503/504 and equivalent transient server failures

Stop all YouTube requests until reset:
quotaExceeded, dailyLimitExceeded, 40% absolute daily hard cap reached

Non-retryable until data/config changes:
invalid request/parameter, invalid credentials/permission,
confirmed unavailable/deleted Video ID, malformed local input
```

For a retryable failure:

1. Keep all successful batches and their individual `observedAt` values.
2. A batch gets **three total immediate attempts**, not one initial attempt plus three retries: attempt 1 is the original scheduled request; attempts 2 and 3 are immediate retry 1 and retry 2 using capped exponential backoff with jitter. Persist attempt number and error category. These attempts may exceed the 20% target but may never push immediate-phase projected usage beyond the 30% cap.
3. If total attempt 3 fails, calculate and enqueue a durable quota-adaptive deferred retry (attempt 4+, with a recorded `nextRetryAt`, not a sleeping Lambda invocation). Deferred recovery may use additional headroom beyond the 30% immediate-phase cap, but projected usage across the entire workflow may never exceed the 40% absolute daily hard cap. If the immediate phase actually used less than 30%, deferred recovery starts from that actual usage; the ledger must not be artificially raised to 30%.
4. Before every deferred retry, load the latest retry record and Pacific-day quota ledger from the active durable store: local `retry_state.json`/quota JSON during local development, or DynamoDB in production. Recompute the remaining failed set, projected quota usage, interval, and cutoff eligibility; never rely only on values embedded in an old queue message.
5. Compute `quotaResetAt` as the next midnight in IANA `America/Los_Angeles`, including daylight-saving transitions. It is not UTC midnight: Pacific midnight corresponds to approximately 17:00 JST during PST (UTC−8) and 16:00 JST during PDT (UTC−7).
6. Define `retryCutoffAt = quotaResetAt - RETRY_CUTOFF_BUFFER` (initial buffer: 15 minutes). If the dynamically selected 1/2/3-hour interval cannot start and finish before `retryCutoffAt`, do not replace it with a shorter, more quota-aggressive interval; stop the run and wait for the next normal schedule.
7. On `quotaExceeded`, `dailyLimitExceeded`, or the 40% absolute daily hard cap, cancel all remaining pre-reset YouTube calls immediately. Crossing the 20% preferred target does not by itself block the original run. The immediate phase is bounded by 30%; the deferred phase adapts its interval to projected usage and is bounded by 40%.
8. At final stop, mark the creator/run `partial` or `incomplete`, persist missing IDs/batches and reasons, attempt history, quota used/remaining estimate, `quotaResetAt`, and `stopReason` (`non_retryable`, `quota_exhausted`, `daily_hard_cap`, or `retry_window_closed`). Alert through CloudWatch.
9. The next regular 18:00 JST run starts a new `snapshotDate` and processes the normal due set again. It must not fabricate or retrospectively label the new cumulative count as the missing prior-day count; analytics for that missing date remains unavailable/incomplete.

Use a durable scheduler such as EventBridge Scheduler/SQS-based delayed work for deferred retries. Do not keep a Lambda invocation alive for 1–3 hours. Retry creation and consumption must be idempotent, keyed by at least `(snapshotDate, creatorId, failedBatchId, attemptNumber)`, and stale retry messages from a closed run must be ignored.

#### Quota-Adaptive Interval Decision

Before each deferred attempt, calculate projected usage against the configured YouTube daily quota/bucket limit. With the initial 10,000-unit configuration, 20% is the preferred target, 30% is the immediate-phase cap, and 40% is the absolute daily hard cap shared by the entire workflow:

```text
projectedUnits = usedUnits + reservedUnits + estimatedRetryUnits
projectedQuotaRatio = projectedUnits / quotaLimitUnits

projectedQuotaRatio < 0.30        → retry in 60 minutes
0.30 <= ratio < 0.35              → retry in 120 minutes
0.35 <= ratio < 0.40              → retry in 180 minutes
ratio >= 0.40                     → stop; absolute daily hard cap reached
```

These are initial configurable thresholds (`NORMAL_QUOTA_TARGET_RATIO=0.20`, `IMMEDIATE_PHASE_CAP_RATIO=0.30`, `DAILY_HARD_CAP_RATIO=0.40`, and retry intervals), not permanent code constants. Also stop if `estimatedRetryUnits` does not fit under the hard cap, even when ratio rounding would otherwise permit a retry. If the API uses multiple granular quota buckets, apply the most restrictive relevant remaining bucket as well as the project hard cap.

Persist at least the following state after every attempt and every scheduling decision:

```json
{
  "quotaDatePacific": "2026-09-01",
  "quotaResetAt": "2026-09-02T00:00:00-07:00",
  "quotaLimitUnits": 10000,
  "normalTargetUnits": 2000,
  "immediatePhaseCapUnits": 3000,
  "dailyHardCapUnits": 4000,
  "usedUnits": 2200,
  "reservedUnits": 100,
  "estimatedRetryUnits": 80,
  "projectedUnits": 2380,
  "projectedQuotaRatio": 0.238,
  "creatorId": "aizawa_ema",
  "snapshotDate": "2026-09-01",
  "failedBatchIds": ["batch-07"],
  "attemptNumber": 4,
  "lastAttemptAt": "2026-09-01T20:05:00+09:00",
  "retryIntervalMinutes": 120,
  "nextRetryAt": "2026-09-01T22:05:00+09:00",
  "decisionReason": "recovery_middle_band",
  "status": "scheduled",
  "version": 8
}
```

Immediately before calling YouTube, read this record again and use an atomic conditional update/version check to reserve `estimatedRetryUnits`. If another worker changed the quota ledger, recompute instead of proceeding with stale values. If the current Pacific date differs from `quotaDatePacific` or `now >= quotaResetAt`, expire the old retry without an API call and wait for the regular 18:00 JST run. After a valid response, atomically convert the reservation into actual usage and persist the next decision. This prevents concurrent creator retries from each believing the same quota is available.

#### Definition of Done

- Failures are visible.
- Failed jobs do not silently corrupt data.
- Retries are safe, durable, batch-scoped, idempotent, and never implemented as a sleeping Lambda.
- There are three total immediate attempts (original + two retries) bounded by the 30% immediate-phase cap; eligible deferred recovery may use additional headroom, while the entire workflow is bounded by the 40% absolute daily hard cap and 20% remains the preferred operating target.
- Deferred intervals adapt to total projected quota usage (initially 1/2/3 hours below 30%, at 30–35%, and at 35–40%) and stop at the Pacific reset cutoff or 40% ceiling.
- Retry/quota state is persisted in local JSON or DynamoDB and reloaded immediately before every attempt; atomic reservation/version checks prevent concurrent overspend.
- Pacific quota reset calculations use `America/Los_Angeles` with DST tests, not UTC or a fixed offset.
- Quota-exhaustion errors stop further pre-reset requests immediately.
- An incomplete day remains explicitly incomplete; the next day's cumulative count is never used to invent the missing daily snapshot.
- Duplicate snapshots are prevented.
- Partial failures can be diagnosed.

#### Out of Scope

- Full observability platform
- Pager/on-call
- High-scale monitoring stack

---

## Phase 3 — Analytics and Internal Dashboard

Time-zone delivery is split across this phase: section 3.1 defines local-calendar analytics semantics and test coverage; 3.4 implements IANA validation, daylight-saving conversion, and canonical snapshot mapping in the Read API; 3.5 implements device detection, the searchable selector, and request fields in React; 3.6 isolates cached results by time zone, report date, and period.

### 3.1 View Growth Analytics

#### Goal

Calculate useful metrics from historical snapshots.

#### Scope

Support:

```text
Latest view count
Daily growth
7-day growth
30-day growth
```

Raw snapshots remain the source of truth.

These metrics use the requesting user's **local calendar dates**, not rolling elapsed-hour windows. Accept any valid IANA time zone supported by the deployed time-zone database; do not hardcode an offset or a Tokyo/Hong Kong-only allowlist. For a report date `D`, compare `D` with `D-1`, `D-7`, or `D-30` in that same time zone. The Read Lambda maps those local report dates to the canonical JST collection snapshots internally. The collector still has one schedule and one set of age tiers; a user's reporting time zone never changes collection eligibility or creates another tier.

The collector's configured 18:00 JST execution time and the user's local date boundary are independent contracts. Japan, Hong Kong, London, or any other supported zone continues to roll over at its own local midnight. If the canonical snapshot required for a local `reportDate` has not completed yet, return `pending`/`unavailable` plus the latest completed `lastUpdatedAt`; never shift the user's date boundary, fabricate zero growth, or label an older snapshot as the requested date.

For example, at the same instant it may be September 1 at 00:30 in Tokyo but August 31 at 23:30 in Hong Kong. Tokyo's requested report date is September 1 and its September 1 canonical snapshot remains `pending` until that day's scheduled collection completes; Hong Kong continues to request August 31 and compares it with August 30. Do not force both users onto the same displayed date merely because the latest completed underlying snapshot is currently the same. If a required comparison-date snapshot is missing or incomplete, return an unavailable/incomplete result rather than treating the value as zero.

A separate, more common case: a creator can simply not exist yet in an older, otherwise-complete snapshot — e.g. hololive EN/ID and VSPO EN were only onboarded into Creator/Video Master on 2026-08-31, so their records are absent from every snapshot dated before that (2026-08-29, 2026-08-30, etc.), even though those days' snapshot files themselves are complete and correct for whichever creators existed at the time. This is not a missing/pending day — it is a creator with no history before their onboarding date. A lookup for that creator/date combination must return a clean "no data for this creator on this date" result, not raise a `KeyError`/crash from assuming every currently-known creator has a record in every historical file. Growth calculations spanning a creator's onboarding date must treat the pre-onboarding side as unavailable, not as zero.

A third, distinct case: a `reportDate` before the project's own collection start date (2026-08-29 — no snapshot file exists for any earlier date, for any creator, because nothing was being collected yet) must also return a clean "no data" result — but this is semantically different from `pending`. `pending` means the canonical snapshot for that date will exist once today's/a near-future scheduled collection completes; a pre-collection-start date will never have data, no matter how long the caller waits. Do not conflate the two — surface them as distinct states (e.g. `not_available` vs `pending`) so a client doesn't poll forever for something that will never arrive.

#### Definition of Done

- Metrics are reproducible from raw snapshots.
- Results are deterministic.
- Daily / 7-day / 30-day comparison dates are correct across representative positive-offset, negative-offset, UTC, and daylight-saving IANA zones, including `Asia/Tokyo`, `Asia/Hong_Kong`, and `Europe/London`.
- Historical raw data is never destroyed.
- A creator absent from an older (pre-onboarding) snapshot returns a clean "no data" result rather than crashing, and is not confused with a missing/pending day.
- A `reportDate` before the project's collection start date returns a clean, distinctly-labeled "not available" result (never `pending`, since it will never resolve).

#### Out of Scope

- AI recommendations
- User personalization

---

### 3.2 Creator Trending

#### Goal

Rank videos for an individual creator.

#### Scope

Examples:

```text
Most Viewed
Fastest Growing
Daily Trending
7d Trending
30d Trending
```

Example:

```text
藍沢エマ — 7 Day Trending

1. Video A +180K
2. Video B +92K
3. Video C +61K
```

#### Definition of Done

- Creator-level rankings can be generated.
- Ranking period is clearly defined.
- Results are based on stored snapshots.

#### Out of Scope

- Recommendation AI
- User-specific ranking

---

### 3.3 Organization Trending

#### Goal

Generate rankings across creator organizations.

#### Initial Organizations

```text
Hololive
VSPO
```

Examples:

```text
VSPO Trending Today
Hololive 7-Day Trending
Fastest Growing Videos by Organization
```

#### Definition of Done

- Organization-level rankings can be calculated.
- Creator organization mapping is respected.
- Results are reproducible from raw snapshots.

---

### 3.4 Read API

#### Goal

Expose stored analytics safely to internal clients.

#### Architecture

```text
Dashboard
→ API Gateway
→ Read Lambda
→ DynamoDB
```

The Read Lambda should only read/transform data.

It should not trigger full YouTube collection jobs.

Analytics requests must include:

```text
timeZone=<valid IANA zone, e.g. Europe/London>
reportDate=YYYY-MM-DD
period=1d | 7d | 30d
```

`timeZone` must be an IANA zone name, not a raw numeric UTC offset. The API validates it through Python `zoneinfo.ZoneInfo` against the deployed time-zone database, treats `reportDate` as a calendar date in that zone, maps it to the canonical JST snapshot keys, and performs the comparison without exposing the internal collection schedule to normal users. Pin/package current `tzdata` when the Lambda runtime cannot guarantee the required database. Invalid zones return a clear client error rather than silently falling back to another date.

The normalized response should include `timeZone`, `reportDate`, `comparisonDate`, `period`, `lastUpdatedAt`, completeness status, and the analytics result. Every creator/channel/video result must also carry `organization`, `branch`, `groupKey`, `channelType`, and `lifecycleStage` directly, and the API accepts the same fields as optional filters; the frontend must not infer them from names. `lastUpdatedAt` remains an absolute timestamp so the client can display it in the requested zone.

**Every query parameter is untrusted input from a public URL and must be validated before it touches any parsing/lookup logic** — this is a request handler, not a trusted internal call. `reportDate`, `timeZone`, `period`, and any creator/organization/branch filter values must all be validated up front (format, length, character set, and — for `reportDate` — that it parses to a real calendar date) before anything downstream tries to use them. A value that fails validation returns a clean 4xx-style client error with a generic message; it must never propagate into a date-parsing call, a dict/file lookup keyed by the raw string, or any other place that could raise an unhandled exception and crash the Lambda or leak an internal stack trace. This applies regardless of *why* the value is unusual — a genuine typo, an automated scanner probing the endpoint, or a deliberate attempt to break the parser must all be handled by the same validation path, not treated as different code paths.

#### Definition of Done

- Dashboard can retrieve analytics data.
- DynamoDB implementation details are hidden.
- Response format is normalized.
- Invalid IANA time zones and malformed report dates are rejected safely; daylight-saving transitions use the zone database rather than fixed offsets.
- Local report-date mapping and missing/incomplete comparison snapshots are handled explicitly.
- A request for a creator/date combination older than that creator's onboarding date (e.g. querying an EN/ID/VSPO-EN creator against a JP-only date before they were added to Creator/Video Master) returns a clean "no data" result, not a server error — see 3.1's note on this same distinction (missing creator vs. missing/pending day).
- A request for any `reportDate` before the project's collection start date returns a clean, distinctly-labeled "not available" result — never `pending` — since 3.1 draws that same distinction.
- Every query parameter is validated before use; no malformed, oversized, or adversarial input (wrong format, non-date strings, injection-style payloads, extreme values) can reach parsing/lookup code unvalidated. Tests cover this with deliberately malicious/garbage `reportDate`/`timeZone` values, not just well-formed edge cases, and confirm the API returns a clean client error rather than a 500 or a stack trace.

#### Out of Scope

- Public authentication
- Yobi.exe integration
- Production API security model

---

### 3.5 Internal Web Dashboard

#### Goal

Create a personal/admin dashboard for viewing Yobi Analytics data.

#### Scope

Use **React with TypeScript** for the dashboard frontend. React is the UI library, while TypeScript is the frontend programming language. The dashboard must consume normalized JSON from the Python Read Lambda through API Gateway; it must not import or depend directly on Python collection code.

The complete UI specification for this section is maintained separately in [`dashboard_ui_direction_en.md`](./dashboard_ui_direction_en.md).

For every analytics request, the dashboard detects the device IANA time zone with `Intl.DateTimeFormat().resolvedOptions().timeZone`, provides a searchable IANA time-zone selector, and sends the selected `timeZone`, its local `reportDate`, and `period` to the Read API. Do not model supported zones as a hardcoded TypeScript union. If detection is unavailable, visibly fall back to `UTC` and let the user choose; do not silently assume Tokyo. The UI displays only the localized report/comparison dates and localized last-updated time; the canonical JST snapshot date and collector schedule remain internal.

Classification filters follow `organization → branch → groupKey → channelType → lifecycleStage`. Hololive is the top-level label, with nested JP generations 0–6/Gamers/holoX, DEV_IS/ReGLOSS/FLOW GLOW, mekPark/ACHRORA/UNIT B, and staff/aNnounce options carried as `groupKey`. VSPO uses the same contract and may add nested groupKey later. ACHRORA and UNIT B retain `organization: "hololive"` and are distinguished by branch/groupKey/status rather than a separate top-level label.

Possible dashboard sections:

```text
Latest Snapshot
Daily Growth
7d Growth
30d Growth
Creator Trending
Hololive Trending
VSPO Trending
Last Updated
Collection Status
Errors
```

Planned architecture:

```text
React + TypeScript Static Frontend
→ S3 / CloudFront
→ API Gateway
→ Python Read Lambda
→ DynamoDB
```

A custom domain is not required initially.

AWS-provided URLs are acceptable for development.

#### Definition of Done

- Dashboard can display current stored data.
- Dashboard can display latest update time.
- Dashboard can query analytics without direct DB credentials.
- Dashboard is implemented with React and TypeScript and can be built as static deployment assets.
- Dashboard requests always include a validated IANA `timeZone`, local `reportDate`, and `period`, and changing the selected zone refreshes the date labels and analytics result.
- The selector and request model support valid IANA zones beyond Japan and Hong Kong, including daylight-saving zones such as `Europe/London`.
- The Dashboard, charts, tables, and rankings share one classification filter state and correctly distinguish member/group/staff plus active/pre-debut/graduated/retired; pre-debut channels never enter active-member rankings by mistake.

#### Out of Scope

- Public user accounts
- Production branding
- Paid domain
- Production authentication

---

### 3.6 Local Cache and Last Updated Handling

#### Goal

Reduce perceived latency and handle Lambda cold starts gracefully.

#### Flow

```text
Open Dashboard / Yobi
→ Read local cache
→ Display cached data
→ Background fetch latest AWS data
→ Compare snapshotDate/version
→ Replace cache if newer
```

Cache should store at least:

```text
timeZone
reportDate
comparisonDate
fetchedAt
period
results
```

Cache identity must include at least `(timeZone, reportDate, period)` so Tokyo and Hong Kong calendar-date results cannot overwrite or masquerade as each other.

If the server still only has yesterday's snapshot, the UI should not falsely label it as today's data.

#### Definition of Done

- Cached data can display immediately.
- Latest server data replaces stale cache.
- Last updated time is visible.
- Stale data can be identified.

---

## Phase 4 — Yobi.exe Integration and Remote Control

### 4.1 Yobi Analytics API

#### Goal

Provide normalized analytics data to Yobi.exe.

#### Architecture

```text
Yobi.exe
→ API Gateway
→ Read Lambda
→ DynamoDB
```

Possible future endpoints:

```text
GET /creators/{creatorId}/trending?period=7d
GET /organizations/vspo/trending?period=1d
GET /organizations/hololive/trending?period=30d
```

Yobi.exe must not receive unrestricted AWS credentials.

#### Definition of Done

- Yobi.exe can retrieve normalized analytics.
- AWS storage details remain behind the API.

---

### 4.2 Yobi.exe Analytics Integration

#### Goal

Display analytics inside the desktop application.

#### Scope

Possible UI data:

```text
Creator Trending
Daily Growth
7d Growth
30d Growth
Organization Ranking
Last Updated
```

#### Definition of Done

- Desktop app can display AWS analytics.
- Local cache works.
- No direct unrestricted DynamoDB access exists.

---

### 4.3 Client / Device ID

#### Goal

Give each Yobi installation an independent identity.

#### Design

Generate a random UUID on first run.

Example:

```text
clientId = UUID
```

Store it locally.

Do not use:

```text
Google Account ID
YouTube Account ID
Email Address
```

as the device identity.

#### Definition of Done

- Every installation has a stable anonymous client ID.
- ID survives app restart.
- ID is independent of Google OAuth.

---

### 4.4 Heartbeat / Online Status

#### Goal

Allow the dashboard to estimate which Yobi clients are online.

#### Flow

```text
Yobi.exe
→ POST heartbeat
→ API Gateway
→ Lambda
→ DynamoDB
```

Store:

```text
clientId
lastSeenAt
appVersion
```

Example status rule:

```text
lastSeenAt within 2 minutes
→ ONLINE

older
→ OFFLINE
```

#### Definition of Done

- Dashboard can show approximate online/offline state.
- Google login is not required.

#### Out of Scope

- True real-time presence
- WebSocket implementation

---

### 4.5 Remote Config

#### Goal

Allow dashboard-controlled runtime configuration.

#### Example Uses

```text
Disable notifications for one creator
Reduce notification level
Enable/disable experimental feature
Temporary per-client override
```

Write flow:

```text
Dashboard
→ API Gateway
→ Write Lambda
→ DynamoDB RemoteConfig
```

Read flow:

```text
Yobi.exe
→ API Gateway
→ Read Lambda
→ DynamoDB RemoteConfig
→ Apply runtime settings
```

Do not overwrite secret-oriented local config files such as:

```text
config.local.json
```

Remote runtime config should remain separate.

#### Definition of Done

- Dashboard can change remote settings.
- Yobi can fetch and apply them.
- Local secrets remain separate.

---

### 4.6 Per-Client Notification Overrides

#### Goal

Control notification behavior for a specific Yobi installation.

#### Scope

Example:

```text
clientId A
→ 藍沢エマ notification OFF

clientId B
→ 藍沢エマ notification ON
```

Possible settings:

```text
enabled
notificationLevel
temporaryMute
creatorOverride
notificationTimeZone
deliveryWindows
quietHours
```

During Japanese development, the default notification timezone is `Asia/Tokyo` and the default local delivery windows are `08:00` and `18:00`, corresponding to morning and after-work checks. Before production release, the Dashboard must let each user select any valid IANA timezone and configure these local wall-clock windows.

The selected timezone controls notification grouping and delivery, not upstream YouTube collection ownership. New-video events are collected once into the shared Creator Pool and stored once; the notification dispatcher maps each user's local windows to UTC and sends only events not previously delivered to that client. It must not repeat `playlistItems.list` or `videos.list` per user, because adding users must not multiply YouTube quota consumption. Near-real-time WebSub events may be held for the next selected delivery window unless the user explicitly enables immediate notifications.

#### Definition of Done

- Remote settings can target one anonymous client ID.
- One client's settings do not affect others unintentionally.
- Local delivery windows remain correct across UTC offsets and daylight-saving transitions by using IANA timezone rules.
- A stored new-video event is delivered at most once per client/window unless an explicit repeat-reminder policy says otherwise.
- Adding users does not create duplicate upstream YouTube API collection requests.

---

### 4.7 Offline Cache / Fallback

#### Goal

Keep Yobi usable during temporary network or AWS failure.

#### Behavior

```text
AWS request fails
→ Use last local cache
→ Show last updated time
→ Retry later
```

#### Definition of Done

- Network failure does not make Yobi unusable.
- Cached analytics/config can still load.
- Recovery happens safely.

---

## Phase 5 — Production, Automation and Intelligence

### 5.1 GitHub Actions CI/CD

#### Goal

Automate Lambda deployment after manual deployment becomes stable.

#### Flow

```text
Claude Code
→ Commit
→ Pull Request
→ CodeRabbit
→ Merge main
→ GitHub Actions
→ AWS OIDC
→ Deploy Lambda
```

Prefer AWS OIDC.

Do not store long-lived AWS access keys in GitHub where avoidable.

#### Definition of Done

- Merge to `main` can safely deploy Lambda.
- No long-lived AWS secret is committed.

#### Out of Scope Initially

- Automatic deployment before manual deployment is proven stable.

---

### 5.2 Production AWS Security

#### Goal

Harden AWS services before wider public use.

#### Scope

- IAM least privilege
- API authentication
- rate limiting
- monitoring
- cost alerts
- HTTPS
- secret management
- abuse protection
- logging hygiene

#### Definition of Done

- Public-facing AWS services have appropriate security controls.
- Sensitive credentials are not exposed to clients.

---

### 5.3 Google OAuth Subscription Import

#### Goal

Allow optional import of a user's YouTube subscriptions.

#### Flow

```text
User
→ Google OAuth
→ subscriptions.list
→ User-to-Creator Mapping
```

Google OAuth is optional.

Basic Yobi functionality should not require Google login.

Google identity must not be used as Yobi device identity.

#### Definition of Done

- User can import supported subscriptions.
- OAuth quota usage is understood.
- Google-specific data is separated from anonymous client identity.

---

### 5.4 Shared Creator Pool / Quota Deduplication

#### Goal

Avoid duplicate public-data API requests across multiple users.

#### Concept

```text
User A follows Ema
User B follows Ema
User C follows Ema

↓
One unique Creator record
↓
Collect Ema public data once
↓
Share result across users
```

Architecture:

```text
Users
→ User-to-Creator mappings
→ Unique Creator Pool
→ Shared Public Creator Data
```

#### Definition of Done

- Multiple users following the same creator do not cause duplicate public collection.
- User mappings remain separate from global creator data.

---

### 5.5 Twitch Integration

#### Goal

Add Twitch as another creator platform.

#### Scope

Support:

```text
LIVE
UPCOMING where schedule exists
NONE
Go-live notification
```

Creator model should allow:

```text
Creator
├── YouTube
└── Twitch
```

#### Definition of Done

- A creator can have multiple platform identities.
- Twitch status can be normalized for Yobi.

---

### 5.6 AI Creator Discovery

#### Goal

Help users discover related creators and streamers.

#### Example

```text
VTuber
→ Collaboration Relationship
→ Streamer
→ Twitch Account
```

Possible future features:

- Japanese natural-language creator search
- Alias matching
- Collaboration graph
- Game-based creator discovery
- VTuber → streamer recommendations

#### AI Principle

AI should help interpret/search/rank.

Structured creator/platform/relationship data should remain the source of truth where possible.

#### Definition of Done

- AI can interpret creator-discovery queries.
- Reliable structured data is used for factual account matching.

---

### 5.7 Future SQL Migration

#### Goal

Keep a migration path if analytics eventually becomes too complex for DynamoDB.

#### Possible Flow

```text
DynamoDB
→ Export
→ Transform
→ MySQL / PostgreSQL
```

SQL may become useful for:

```text
JOIN
GROUP BY
Complex relational analytics
Ad-hoc exploration
```

#### Definition of Done

Only migrate when a real requirement exists.

DynamoDB data should remain migration-friendly from the beginning.

---

## Current Priority

Phase 1 (Local Data Collection Foundation, sections 1.1–1.6) is implemented and running locally against the real YouTube API.

The immediate priority is:

> Move collection onto AWS (Phase 2) so it runs on a daily schedule without a local machine staying on.

Initial target creator groups:

```text
Hololive
VSPO
```

Recommended implementation order:

```text
Phase 1
→ Phase 2
→ Phase 3
→ Phase 4
→ Phase 5
```

Implementation must proceed one numbered sub-section at a time.

Example:

```text
Implement 1.1 only.
↓
Test
↓
Commit
↓
Pull Request
↓
CodeRabbit Review
↓
Merge
↓
Then start 1.2
```

Do not implement later numbered sections unless explicitly approved.
