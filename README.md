# Yobi Analytics

Yobi Analytics is a separate Python/AWS data-collection and analytics project for Yobi.

Its purpose is to collect public YouTube video statistics for selected creators, store daily historical snapshots, and later provide analytics such as view growth and trending rankings to both the Yobi Dashboard website and the Yobi desktop application.

The initial target creator groups are:

- Hololive
- VSPO

This repository is intentionally separate from the Unity Yobi application.

---

## What This Project Does

The Python collector will gradually support the following flow:

```text
Creator Master
→ Discover Creator Videos
→ Retrieve Public YouTube Statistics
→ Create Daily Raw Snapshots
→ Store Snapshots in AWS
→ Calculate Analytics
→ Expose Data to the Yobi Dashboard Website and Yobi.exe
```

The core data collected for each video will include information such as:

```text
creatorId
videoId
title
publishedAt
viewCount
snapshotDate
observedAt
organization
```

The project will initially focus on public YouTube data only.

It does not require private YouTube Studio analytics.

---

## Why Historical Snapshots Matter

A single public `viewCount` only tells us the current total number of views.

For example:

```text
2026-08-28
Video A
viewCount = 100,000
```

If the same value is collected again the next day:

```text
2026-08-29
Video A
viewCount = 125,000
```

Yobi Analytics can calculate:

```text
daily growth = +25,000 views
```

By collecting daily snapshots continuously, the project can later calculate:

- latest view count
- daily growth by the user's local calendar date
- 7-day growth
- 30-day growth
- fastest-growing videos
- most-viewed videos
- creator-level trending
- Hololive trending
- VSPO trending

YouTube's API only ever reports the current cumulative `viewCount` — it does not expose how many views a video had on any past date. That history only exists because this project keeps its own daily raw snapshots. A video only starts building history from whichever day it was first added to the Tracking Universe; view counts from before that day cannot be backfilled.

A key motivation for tracking every known video — not just recent or currently-popular ones — is catching videos that were quiet for a long time and then suddenly gain a large number of views in a single day because YouTube's recommendation algorithm starts pushing them.

Raw historical snapshots must be preserved.

The project should not store only calculated rankings.

---

## Video Discovery

Video Discovery is responsible for building and maintaining the set of videos that should be tracked for a creator — the **Tracking Universe** (Video Master). This is a different responsibility from Statistics Collection, and from deciding which videos currently look "trending".

### Initial Discovery / Bootstrap

```text
Creator Master
→ YouTube Channel ID
→ channels.list
→ Uploads Playlist ID
→ playlistItems.list
→ Paginate through the creator's available upload history
→ Collect Video IDs
→ Store / upsert into Video Master
→ Build the Tracking Universe
```

`playlistItems.list` returns at most 50 items per request. That is a limit on a single API call/page — it is not a limit on how many videos the system tracks overall. The first-time bootstrap keeps paging through `nextPageToken` until the creator's available upload history has been scanned.

### Incremental Discovery

Once Initial Discovery has completed for a creator, there is no need to rescan their entire history. Incremental discovery only needs to:

```text
Creator
→ Uploads Playlist
→ Scan the newest uploads
→ Compare against Video IDs already known to Video Master
→ Insert/upsert any new Video ID
→ Add it to the Tracking Universe
```

Once a previously-seen video is reached, pagination toward older pages can stop.

During Japanese local development, this check runs at `08:00` and `18:00` in `Asia/Tokyo`; the morning run is the only additional check alongside the existing evening collection. With the current 99 discovery-enabled channels and one uploads-playlist page per channel, that is about 99 general quota units per window or 198 units/day (1.98% of the default 10,000-unit daily quota), plus at most one batched `videos.list` unit per 1–50 newly discovered IDs when that detail request cannot be merged into an existing statistics batch.

These times are application configuration, not a YouTube-defined timezone. Production notification preferences use each user's selected IANA timezone and local delivery windows, but the shared backend still collects each creator once. It stores and deduplicates new-video events, then delivers them to eligible users at their local windows; it never repeats YouTube API requests per user. Near-real-time delivery should use YouTube WebSub push notifications, with these scheduled scans retained as reconciliation.

### Statistics Collection

Discovery and Statistics Collection are deliberately separate:

- **Discovery** answers: *which videos should we track?*
- **Statistics Collection** answers: *what is the current public state of those videos?*

For every video already in the Tracking Universe:

```text
videos.list
→ batched Video IDs
→ part=snippet,statistics
→ current public statistics, especially viewCount
```

Video IDs should be batched rather than requested one at a time.

### Scope Boundary

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

---

## Tracking Frequency

Collection uses both upload age and observed growth activity. A first-time cumulative `viewCount` is only a baseline: every newly imported video, including an old low-view video, starts as `Unknown` and is never classified as `Cold` from age or total views alone.

```text
Recent (0-30 days old) -> checked every day
Hot                    -> checked every day
Unknown                -> checked every 2 days
Warm                   -> checked every 3 days
Cold                   -> checked every 15 days
Admin override         -> checked on the explicitly requested run
```

An `Unknown` video needs at least three snapshots (two comparison intervals) before it can become `Cold`. Strong growth may promote it to `Hot` immediately; demotion requires 2-3 consecutive quiet observations to avoid status oscillation. `Unknown`, `Warm`, and `Cold` pools use stable ID-based 2-, 3-, and 15-day rotations so part of every pool is processed each day. After required work finishes, unused quota is filled with the least-recently-checked eligible videos, while a hard daily budget prevents quota exhaustion.

See [`Roadmap.md`](./Roadmap.md) section 1.5 for the full design rationale.

### Planned Admin Collection Commands

The following commands define the intended admin CLI contract; they are documentation for the upcoming scheduler/admin implementation and are not a claim that the current checkout already supports them:

```powershell
# Newest 100 known uploads for one creator
python main.py collect --creator aizawa_ema --latest 100

# Oldest 100 known uploads
python main.py collect --creator aizawa_ema --oldest 100

# Positions 101 through 500 in oldest-first order
python main.py collect --creator aizawa_ema --oldest-range 101:500

# Videos published during an inclusive JST calendar-date range
python main.py collect --creator aizawa_ema --published-from 2025-01-01 --published-to 2025-12-31

# Preview selection and estimated API requests without collecting
python main.py collect --creator aizawa_ema --latest 100 --dry-run
```

These selectors query the project's Video Master, sort deterministically by `(publishedAt, videoId)`, and then batch the selected IDs through `videos.list`. They are unioned with the normal due set and deduplicated by `videoId`, so an override never causes a second same-day snapshot. `--latest`, `--oldest`, `--oldest-range`, and the publication-date range are mutually exclusive in one command. Date bounds are inclusive JST calendar dates.

This works once Initial Discovery has populated Video Master. YouTube `playlistItems.list` supports paginating the uploads playlist but does not provide native oldest/latest-count or publication-date-range filters. YouTube `search.list` does offer `publishedAfter` / `publishedBefore`, but channel search can be incomplete and limited; it must not be the normal implementation for these commands. If Video Master may be stale, run/complete Discovery first, then select locally and use `videos.list` for current statistics.

---

## Initial Architecture

The planned initial production architecture is:

```text
EventBridge Scheduler
→ AWS Lambda
→ YouTube Public API
→ DynamoDB
```

The AWS statistics collector will run once per day, while incremental new-upload discovery runs twice per day, initially at:

```text
18:00
Timezone: Asia/Tokyo

New-upload discovery: 08:00, 18:00
Development timezone: Asia/Tokyo
```

This is a configurable operational schedule chosen to run about one hour after the observed 16:30–17:00 JST public-count settling window. YouTube does not document that window as a guaranteed Data API update SLA, so freshness must be monitored and the schedule may be adjusted without changing snapshot or analytics semantics.

The Windows development machine does not need to remain powered on after the collector is deployed to AWS Lambda.

---

## Local Development

Development starts locally before AWS is introduced.

Initial flow:

```text
Local Python
→ Fixed Test Creator
→ Fixed Test Video IDs
→ YouTube Public API
→ Print Structured Results
```

The first local prototype should retrieve at least:

- `videoId`
- `title`
- `publishedAt`
- `viewCount`

Later phases will replace manually entered Video IDs with automatic video discovery from each creator's YouTube Channel ID.

---

## Python Environment

The project should use a fixed Python version that is compatible with:

- Windows 10 local development and testing
- AWS Lambda's Amazon Linux-based execution environment in production
- required Python libraries

Windows-built native dependencies are not guaranteed to run in Lambda's Amazon Linux runtime — package for Lambda accordingly when Phase 2 deployment is implemented.

Project dependencies should be isolated using a local virtual environment.

Example (Git Bash):

```bash
python -m venv .venv
source .venv/Scripts/activate
```

Example (PowerShell):

```powershell
python -m venv .venv
.venv\Scripts\Activate.ps1
```

Do not install project dependencies globally unless there is a specific reason.

Dependencies should be managed through:

```text
requirements.txt
```

The exact Python and dependency versions should be decided during Phase 1.1 after inspecting the local development environment.

---

## Creator Master

Creator metadata should remain separate from collection logic.

Example structure:

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

`active` controls whether a creator is tracked at all. `discoveryEnabled` is separate: it controls whether Discovery keeps searching for new uploads, independent of whether the creator's already-known videos keep being tracked for statistics. This lets a graduated/retired creator's existing videos keep collecting snapshots without wasting quota scanning for uploads that will never come.

A graduated creator also carries `graduatedAt` (an ISO 8601 date), e.g. `"lifecycleStage": "graduated", "graduatedAt": "2025-05-01"`. This field is **sparse by design** — omitted entirely for anyone who hasn't graduated, rather than a placeholder like `"0000"`. `lifecycleStage` always reflects a creator's *current* status via a live lookup; there is no historical tracking of what it was on some earlier date.

Classification must not rely only on `organization` or display names. Creator Master explicitly stores `branch`, `groupKey`, `channelType`, and `lifecycleStage`: `branch` is region/language only (`holo_jp`/`holo_en`/`holo_id`/`vspo_jp`/`vspo_en`) — it does not encode sub-labels like DEV_IS/mekPark/staff. `groupKey` is a **list** rather than a single value, because a creator can belong to more than one grouping at once (e.g. Shirakami Fubuki is both `"1期生"` and `"ゲーマーズ"`); a creator with no applicable grouping uses the placeholder `["NO"]`. `channelType` is `member`/`group`/`staff`; `lifecycleStage` is `active`/`pre_debut`/`graduated`/`retired` and is independent of the API collection toggle `active`.

ReGLOSS and FLOW GLOW are two distinct hololive DEV_IS group channels with different Channel IDs. Although mekPark's ACHRORA and UNIT B remain pre-debut, this project's product taxonomy keeps `organization: "hololive"` instead of introducing a separate organization.

| `creatorId` | Actual YouTube channel name | `branch` | `groupKey` | `channelType`/`lifecycleStage` | YouTube Channel ID |
| --- | --- | --- | --- | --- | --- |
| `hololive_dev_is_regloss` | `hololive DEV_IS ReGLOSS` | `holo_jp` | `["ReGLOSS"]` | `group`/`active` | `UC10wVt6hoQiwySRhz7RdOUA` |
| `hololive_dev_is_flow_glow` | `hololive DEV_IS FLOW GLOW` | `holo_jp` | `["FLOWGLOW"]` | `group`/`active` | `UCu2n3qHuOuQIygREMnWeQWg` |
| `achrora` | `ACHRORA - mekPark` | `holo_jp` | `["mekpark"]` | `group`/`pre_debut` | `UChpRPsAeSZn5DistGacR3iA` |
| `unit_b_pre_debut` | `UNIT B (Pre-Debut) - mekPark` | `holo_jp` | `["mekpark"]` | `group`/`pre_debut` | `UC3OH5FKQ3qtl4uRme_vZTgA` |
| `holoan_room` | `holoAN room (ホロアナ)` | `holo_jp` | `["aNnounce"]` | `staff`/`active` | `UCozx5csNhCx1wsVq3SZVkBQ` |

`holoAN room`'s `aNnounce` group key comes from the channel's own naming (**AN**nounce + **AN**chor); it posts as hololive Production's shared official announcer persona rather than one individual talent.

Initial supported organizations:

```text
hololive
vspo
```

Adding a new creator should not require modifying the main collection logic.

---

## Unicode / UTF-8 Support

The project must support Unicode / UTF-8 from the beginning.

Supported text includes:

- Japanese
- Traditional Chinese
- English

Examples:

```text
藍沢エマ
常闇トワ
一ノ瀬うるは
ぶいすぽっ！
ホロライブ
```

UTF-8 support applies to:

- Python source files
- JSON
- CSV
- terminal output
- logs
- API payloads
- DynamoDB attributes
- future dashboard output
- future Yobi API responses
- future user input/search

Do not assume creator names or video titles are ASCII-only.

Do not perform unnecessary ASCII conversion.

---

## Secrets and Local Configuration

Secrets must never be committed to Git.

Examples of secrets:

- YouTube API keys
- AWS credentials
- private API tokens

Local secrets should use a local environment/config file such as:

```text
.env
```

The real `.env` file must be excluded through `.gitignore`.

Only an example file should be committed:

```text
.env.example
```

Example:

```env
YOUTUBE_API_KEY=
AWS_REGION=ap-northeast-1
```

Never print secret values in logs.

---

## Why DynamoDB

The initial AWS storage choice is DynamoDB.

DynamoDB is suitable for the early Yobi Analytics workload because:

- the workload is very small
- collection initially runs only once per day
- no database server needs to remain online
- no MySQL/PostgreSQL instance needs to be maintained
- no database OS, port, patching, or server maintenance is required
- DynamoDB is fully managed/serverless
- it integrates directly with AWS Lambda through the AWS SDK / `boto3`
- on-demand/pay-per-request usage is suitable for low traffic
- the initial access patterns are predictable

Examples of expected access patterns:

```text
Creator + Date
Video + Date
Creator Daily Snapshots
Small Scheduled Batch Writes
```

DynamoDB is a database service, not a general-purpose compute server.

It cannot replace services such as:

- AWS Lambda
- EC2
- ECS

for running application processes.

### Local History to DynamoDB

Local development history is intended to be preserved when AWS becomes the production writer. This is a controlled one-time cutover, not automatic synchronization and not a copy into Lambda `/tmp`:

```text
Local video_master.json + snapshots/ + run summaries
→ validate and dry-run an idempotent importer
→ import Video Master and immutable historical snapshots into DynamoDB
→ rebuild/verify scheduler state from imported history
→ compare source/destination counts and latest snapshotDate
→ run the AWS collector in dry-run mode
→ enable EventBridge for the next JST collection date
→ DynamoDB continues with the next snapshot; history does not restart
```

Re-running the importer must skip an identical existing `(videoId, snapshotDate)` record and stop on conflicting content instead of overwriting history. Keep the local files as a rollback backup until DynamoDB verification and at least one successful AWS collection have completed. The detailed migration contract and acceptance checks are in [`Roadmap.md`](./Roadmap.md) section 2.3.

---

## DynamoDB Trade-offs

DynamoDB is NoSQL.

It is less convenient than MySQL/PostgreSQL for:

```text
JOIN
GROUP BY
Complex relational analytics
Ad-hoc SQL exploration
```

If Yobi Analytics later requires significantly more relational or exploratory analytics, raw snapshots can be exported and migrated:

```text
DynamoDB
→ Export
→ Transform
→ MySQL / PostgreSQL
```

Snapshot data should therefore remain migration-friendly.

Prefer explicit attributes such as:

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

instead of encoding all meaningful data only inside opaque composite strings.

---

## AWS Lambda

AWS Lambda will run the collection code without requiring a permanently running server.

Conceptually:

```text
18:00 JST (configurable)
→ EventBridge triggers Lambda
→ Lambda retrieves public YouTube statistics
→ Lambda writes snapshots to DynamoDB
→ Lambda finishes
```

Between executions, no collector process needs to remain running.

### Retry Window

For retryable network, timeout, rate-limit, and YouTube 5xx failures, allow **three total immediate attempts** per failed batch: attempt 1 is the original scheduled request, followed by immediate retries 1 and 2 with exponential backoff and jitter. The preferred normal target remains 20%; the original collection and both immediate retries share a 30% immediate-phase cap. If attempt 3 still fails, only those failed batches may enter deferred recovery and use additional headroom up to the 40% absolute daily hard cap; successful batches are never re-requested.

Before every deferred attempt, reload the durable retry state and Pacific-day quota ledger from local JSON or DynamoDB, include used + reserved + estimated retry units, recalculate the interval, and atomically reserve quota. Projected total usage below 30% retries in 1 hour, 30–34.99% in 2 hours, and 35–39.99% in 3 hours; 40% is the absolute daily ceiling shared by the original collection, immediate retries, and deferred recovery. The 30% value caps only the immediate phase; deferred recovery does not pretend that 30% has already been consumed and always uses actual used + reserved + estimated units. Deferred retries also stop at YouTube's next Pacific reset cutoff. If the calculated retry cannot fit before reset or within 40%, close the run as partial/incomplete and wait for the next regular 18:00 JST collection. A `quotaExceeded`/`dailyLimitExceeded` response stops API requests immediately.

Successful partial records remain saved with their own `observedAt`; the run summary records failed IDs/batches, attempts, next retry time, and final stop reason. The next day's run writes its own new `snapshotDate` and must not invent or backfill the missing prior-day view count.

Initial deployment will be manual:

```text
Local Development
→ Local Test
→ Package
→ AWS CLI
→ Lambda
→ Manual Test
→ CloudWatch Logs
```

Automatic GitHub deployment will be added only after the collector is stable.

---

## Future Read API

Neither client — the Web Dashboard nor the Yobi desktop application — should connect directly to DynamoDB with unrestricted AWS credentials.

Future architecture:

```text
Dashboard / Yobi.exe
→ API Gateway
→ Read Lambda
→ DynamoDB
```

Endpoints (request validation and response normalization implemented in `src/read_api.py`; live API Gateway + Lambda deployment remains blocked on AWS console access — see [`Roadmap.md`](./Roadmap.md) 4.1):

```text
GET /creators/{creatorId}/trending?period=7d

GET /organizations/vspo/trending?period=1d

GET /organizations/hololive/trending?period=30d
```

Here, `period=1d|7d|30d` is an analytics comparison window over stored snapshots, not a collection schedule. It never triggers a YouTube API request. The independent collection cadence remains Recent/Hot daily, Unknown every 2 days, Warm every 3 days, and Cold every 15 days.

The API should return normalized analytics data rather than expose DynamoDB implementation details.

Daily, 7-day, and 30-day analytics use the requesting user's local calendar dates, not rolling elapsed-hour windows. The client sends any valid IANA `timeZone`—for example `Asia/Tokyo`, `Asia/Hong_Kong`, or `Europe/London`—and a local `reportDate` (`YYYY-MM-DD`). The Read Lambda validates the zone, including daylight-saving rules, maps that date to the canonical JST snapshot internally, and returns localized `reportDate` / `comparisonDate` values. The collector's 18:00 JST execution time is only an internal acquisition schedule: it never changes a user's local midnight boundary, `reportDate`, or comparison dates and does not create another tracking tier. Before the snapshot needed for a requested local date is available, the API/dashboard must report the latest completed update or an unavailable/pending state rather than silently relabeling an older snapshot as that date.

Every query parameter comes from a public URL and is untrusted: `reportDate`/`timeZone`/filter values must be validated before touching any parsing or lookup code, so malformed or adversarial input returns a clean client error instead of crashing the Lambda or leaking a stack trace. See [`Roadmap.md`](./Roadmap.md) 3.4 for the full validation and "no data" vs. "pending" design.

---

## Future Internal Dashboard

A private/internal web dashboard may be added later for development and analytics monitoring.

The frontend will use **React with TypeScript**. React is the UI library; TypeScript is the frontend programming language.

React was selected for its mature dashboard and charting ecosystem, TypeScript API contracts, and ability to build static assets for S3 / CloudFront while keeping the Python backend separate. See [`dashboard_ui_direction_en.md`](./dashboard_ui_direction_en.md) for the complete dashboard UI specification.

The dashboard detects the device IANA time zone, provides a searchable time-zone selector, and sends the selected `timeZone`, local `reportDate`, and `period` with every analytics request.

The planned first frontend pass lives under `frontend/dashboard` and uses realistic mock JSON shaped like the future Read API response. It establishes the responsive layout and UI states before API integration:

```text
DashboardHeader + classification/date filters
→ Total Views / Daily Gain / Average Growth Rate / Top Performer KPIs
→ GrowthBarChart + contribution ring/ranking
→ concise InsightCards
→ searchable, sortable, paginated VideoStatsTable
```

The shared visual foundation is a calm, modern analytics dashboard with restrained hololive soft-idol or VSPO soft-esports accents. Desktop uses a 12-column grid; tablet and mobile progressively stack controls, cards, charts, and table content. Loading, empty, error, pending-update, stale-data, keyboard/focus, and reduced-motion behavior are part of the frontend plan, not optional polish.

Classification follows the existing Creator Master contract: `organization → branch → groupKey → channelType → lifecycleStage`. The frontend displays human-readable labels, sends stable stored values, clears invalid child selections when a parent changes, and never infers classification from channel names.

Creator group keys are multi-value memberships, not mutually exclusive categories. The UI uses OR within a multi-select dimension and AND across dimensions, so a creator may be found through either `1期生` or `ゲーマーズ`, while `Hololive + JP + 1期生 + 卒業` finds only graduated creators who still retain that generation group key. Graduation changes `lifecycleStage` but never removes the creator's organization, branch, generation, or unit group keys; matching multiple selected group keys does not duplicate the result.

The default implementation workflow does not require a paid external UI generator:

```text
README + Roadmap + dashboard_ui_direction_en.md
→ Codex/Claude Code builds the React + TypeScript draft in frontend/dashboard
→ preview locally with realistic mock response fixtures
→ review and refine layout, chart size, animation, and responsive behavior
→ run the normal TypeScript build, tests, accessibility, and responsive checks
→ connect the approved UI to the Phase 3.4 Read API
```

If free allowance is available, v0 by Vercel or a comparable AI UI tool may optionally generate a visual/code draft before the local review step. No paid AI UI subscription is required or assumed. Generated output is reference code, not an architectural authority. It must not add a backend, database, authentication, API routes, server functions, or changes to the Python collector, DynamoDB model, Lambda, or infrastructure. v0 is an external Vercel tool and is not required for development or at runtime.

This dashboard work belongs to Phase 3.5. It is separate from Phase 2.3, which remains limited to DynamoDB storage plus the local-JSON migration and cutover. No frontend implementation is required to complete Phase 2.3.

Possible dashboard data:

- latest collection status
- latest snapshots
- daily growth
- 7-day growth
- 30-day growth
- creator trending
- Hololive trending
- VSPO trending
- last updated time
- collection errors

Initial dashboard hosting may use AWS-provided URLs.

A custom domain is not required during development.

---

## Future Client Features (Dashboard + Yobi.exe)

The AWS backend features below (Roadmap Phase 4) are shared: they get built once and used by **both** the Web Dashboard and later Yobi versions, not Yobi alone. Each client gets its own independent `clientId`; a feature landing in the Dashboard does not imply Yobi.exe has it, and vice versa — see [`Roadmap.md`](./Roadmap.md) Phase 4 for what's implemented, what's buildable now, and what depends on the separate Yobi.exe (Unity) codebase.

- analytics display
- client/device UUID
- heartbeat / online status
- remote configuration
- per-client notification overrides
- offline cache synchronization
- Twitch live/upcoming schedule tracking and go-live notifications (Phase 5.5)

Google account identity should not be used as either client's device identity.

Google OAuth should remain optional and only be used for features that actually require Google user authorization.

### Web Push Notification Requirements (Dashboard)

The Dashboard's chosen delivery mechanism for per-client notification overrides (Roadmap 4.6) is OS-level Web Push — a native Windows/macOS notification, not an in-page list — implemented with the standard `Notification`/`Push` Web APIs and VAPID (`frontend/dashboard/src/lib/pushNotifications.ts`, `frontend/dashboard/public/sw.js`, `src/push_sender.py`). This is plain web technology: it runs identically on any CPU architecture (Intel or Apple Silicon/ARM) — there is no separate build per architecture, unlike a native app.

Minimum requirements to actually receive a notification:

```text
Windows 10 / 11 — a current version of Chrome, Edge, or Firefox
macOS 13 (Ventura) or later — Safari 16.1+, or a current Chrome/Edge/Firefox
HTTPS (except localhost during development)
The user must explicitly grant the browser's notification permission prompt
```

Safari's Web Push support shipped with Safari 16.1 alongside macOS Ventura; any Mac that can run macOS Ventura as a free software update — not tied to its original factory-installed OS — can get it. Check Apple's own current macOS Ventura compatibility list for the exact supported model list rather than relying on an enumerated one here, which risks going stale as new Mac models ship. Safari on iOS/iPadOS also supports Web Push from 16.4, but only after the site has been added to the Home Screen; this is an iOS-specific limitation that does not apply to macOS or Windows. A browser below these versions is handled as an expected "notifications unavailable" state (`isPushSupported()` in `pushNotifications.ts`), not an error.

---

## API Design Principles

- **Design every public read endpoint around what the frontend actually displays, never around "return everything."** A page can only ever render a bounded number of rows (pagination, or an infinite-scroll batch) — an endpoint that computes or returns an unbounded result "in case the client wants it all" does real work no UI ever needed. `GET /organizations/{organization}/trending` learned this the hard way on 2026-09-05: an unbounded request against real production data (126k+ Video Master items) maxed out a Lambda's full 1024MB memory and still timed out, because the endpoint computed a full ranked list before any page size was ever applied.
- Every list-shaped response takes an explicit, server-enforced maximum `limit` (see `read_api.MAX_LIMIT`) — never an unbounded default.
- A ranking/trending endpoint may approximate: bounding the candidate pool before ranking (most-recently-active first, then a size ceiling) trades a theoretical, unmeasurable loss of perfect exhaustiveness for a request that no longer scales with total catalog size. No real user pages deep enough to notice.
- **Operational discipline, not just tests**: a local test suite (even one exercising tens of thousands of mock rows) cannot reproduce a real Lambda's actual memory ceiling or real production data volume. Any change to trending/ranking computation must be verified against CloudWatch's own `Max Memory Used` and `Duration` for that Lambda after deploying, not just against passing tests.
- Prefer precomputing expensive aggregate/ranked results once (during collection, off the request path) over computing them live on every read — a cache read should always be cheaper than the computation it replaces, and its cost should never scale with catalog size the way the live computation does.

---

## Security Principles

The project should follow these rules:

- Never commit secrets.
- Never log secrets.
- Use least-privilege AWS IAM roles.
- Do not expose unrestricted AWS credentials to Yobi.exe.
- Use HTTPS for future APIs.
- Validate external API responses.
- Add reasonable collection limits.
- Handle retries safely.
- Avoid duplicate daily snapshots.
- Keep raw historical data separate from derived analytics.

---

## Development Workflow

Recommended development workflow:

```text
Implement one Roadmap.md section
→ Test locally
→ Commit
→ Pull Request
→ CodeRabbit Review
→ Fix Issues
→ Merge
→ Start the next roadmap section
```

Implementation should proceed one numbered roadmap section at a time.

For example:

```text
Implement 1.1 only.
Do not implement 1.2 yet.
```

This keeps each change small, reviewable, and easier to debug.

---

## Current Status

Phase 1 (Local Data Collection Foundation) is implemented and running locally against the real YouTube API: Creator Master, Video Discovery, Tiered Tracking Frequency, and the Daily Raw Snapshot Model.

The immediate priority is:

```text
Move collection onto AWS (Phase 2) so it runs on a daily schedule without a local machine staying on.
```

Initial creator groups:

```text
Hololive
VSPO
```

See [`Roadmap.md`](./Roadmap.md) for the implementation plan.
