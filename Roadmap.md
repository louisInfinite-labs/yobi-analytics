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
└── ROADMAP.md
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
youtubeChannelId
active
```

Initial organizations:

```text
hololive
vspo
```

Example:

```json
{
  "creatorId": "aizawa_ema",
  "displayName": "藍沢エマ",
  "organization": "vspo",
  "youtubeChannelId": "UC...",
  "active": true
}
```

Creator data should not be hard-coded directly inside collection logic.

#### Definition of Done

- Creator data is stored separately from Python collection logic.
- Collector can load active creators.
- New creators can be added without changing the collection core.
- Japanese creator names remain intact.

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
- Avoid using the expensive Search API (`search.list`) as the primary discovery method.

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

#### 1.4.4 Statistics Collection

- Use `videos.list` against the Tracking Universe.
- Batch Video IDs rather than requesting one at a time.
- Retrieve current public statistics via `part=snippet,statistics`.
- Store the current `viewCount`.

Discovery and Statistics Collection are separate responsibilities: Discovery decides *which videos to track*; Statistics Collection finds out *their current public state*.

#### 1.4.5 Daily Raw Snapshot

- Save a snapshot of each tracked video's public statistics every day.
- Store `videoId`.
- Store the snapshot time/date.
- Store `viewCount`.
- Snapshots must accumulate history — never overwrite the previous day's snapshot.
- This raw data is what later 24h / 7d / 30d growth analytics is built from.

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
- A daily raw snapshot is stored per tracked video without overwriting prior days' data.
- Manual Video ID entry is no longer required.

#### Out of Scope

- Historical ranking
- Google OAuth
- User subscriptions
- Live notification logic
- AI recommendations
- Deciding the tracking frequency for older videos (see 1.5, next)

---

### 1.5 Tiered Tracking Frequency

#### Goal

Once a video enters the Tracking Universe, how often should it keep being checked? Keep same-day precision on videos that are actually likely to move day-to-day, while cutting daily quota usage enough to comfortably support scaling to more organizations (Hololive EN/ID, and beyond) without approaching the 10,000-unit daily cap.

#### Scope

Assign every tracked video to an age tier based on `publishedAt` at check time:

```text
Recent  (0–30 days old)   → checked every day
Medium  (31–180 days old) → checked once every 7 days
Old     (180+ days old)   → checked once every 30 days
```

Videos rotate through their tier's cycle using a **stable ID-based rotation key** (e.g. a hash of `videoId`, or its position modulo the cycle length) — **not** a calendar-based trigger such as "every Sunday" or "on the last day of the month". Calendar-based triggers can collide (e.g. a month-end that falls on the weekly trigger day), spiking that day's workload; an ID-based rotation splits each tier's pool into equal slices ahead of time, so every day's workload is roughly the same regardless of the date.

Discovery (1.4.2/1.4.3) is unaffected by this — it keeps running daily for every active creator, since it is already cheap (roughly 1–2 units/creator/day) and is a separate concern from how often a video's *statistics* get refreshed.

#### Definition of Done

- Every tracked video is assigned to exactly one age tier (recent/medium/old) based on `publishedAt`, using an ID-based rotation key rather than a calendar-based trigger.
- Recent videos (0–30 days) get a fresh snapshot every day; medium and old videos get one at least once per their tier's cycle (7 / 30 days).
- No single day's statistics-collection workload spikes meaningfully above the daily average, even in a worst-case tier alignment.
- Daily quota usage stays well within the 10,000-unit budget at current + planned scale (VSPO + Hololive JP/EN/ID).

#### Out of Scope

- Per-organization/region scheduling (e.g. staggering by JP/EN) — superseded by the age-based tiering above
- Dynamically promoting an old video back to a faster tier based on renewed activity — tier is purely a function of video age for now
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
  "observedAt": "2026-08-28T00:00:05+09:00",
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
24h growth
= current snapshot - previous-day snapshot

7d growth
= current snapshot - snapshot from 7 days earlier

30d growth
= current snapshot - snapshot from 30 days earlier
```

Raw snapshots must be preserved.

Do not only store calculated rankings.

#### Known Issue: Partial Snapshots Are Not Distinguishable From Complete Ones

Since 1.4, when Statistics Collection cannot parse a video's data (e.g. a members-only video with hidden statistics), that video is skipped with a printed warning only — the saved snapshot contains no record that anything was skipped. A partial snapshot currently looks identical to a complete one once saved, which can silently distort later growth calculations (a video missing from one day's snapshot looks the same as "no change" rather than "we don't actually know").

This should be resolved as part of formalizing the snapshot model in 1.6, not before. Two options to choose between:

1. **Log-only summary**: print an end-of-run summary (e.g. "collected 96,200 / 96,262 videos, 62 skipped") without changing the saved snapshot format.
2. **Snapshot-level metadata**: store completeness information alongside the snapshot data itself (e.g. requested count / skipped video IDs), so incompleteness is visible from the data, not just the run log.

#### Definition of Done

- Snapshot model is defined.
- Historical data is never overwritten accidentally.
- Retry/idempotency strategy is defined.
- Data is migration-friendly.
- Attributes remain explicit and readable.
- A decision has been made (and implemented) on how partial/incomplete snapshots are represented (see "Known Issue" above).

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

Run the collector without requiring the Mac to remain powered on.

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

#### Definition of Done

- Lambda can write snapshots to DynamoDB.
- Historical data can be queried back.
- Duplicate daily retries do not corrupt data.
- Snapshot data remains migration-friendly.
- Storage cost/usage is understood.

#### Out of Scope

- MySQL migration
- Heavy relational analytics
- Direct unrestricted Yobi.exe access to DynamoDB

---

### 2.4 EventBridge Daily Schedule

#### Goal

Automatically collect snapshots every day.

#### Schedule

```text
Every day at 00:00
Timezone: Asia/Tokyo
```

Flow:

```text
EventBridge Scheduler
→ Collector Lambda
→ YouTube API
→ DynamoDB
```

No server stays running between executions.

#### Definition of Done

- Collector runs automatically every day.
- Mac can be powered off.
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

#### Definition of Done

- Failures are visible.
- Failed jobs do not silently corrupt data.
- Retries are safe.
- Duplicate snapshots are prevented.
- Partial failures can be diagnosed.

#### Out of Scope

- Full observability platform
- Pager/on-call
- High-scale monitoring stack

---

## Phase 3 — Analytics and Internal Dashboard

### 3.1 View Growth Analytics

#### Goal

Calculate useful metrics from historical snapshots.

#### Scope

Support:

```text
Latest view count
24-hour growth
7-day growth
30-day growth
```

Raw snapshots remain the source of truth.

#### Definition of Done

- Metrics are reproducible from raw snapshots.
- Results are deterministic.
- Historical raw data is never destroyed.

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
24h Trending
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

#### Definition of Done

- Dashboard can retrieve analytics data.
- DynamoDB implementation details are hidden.
- Response format is normalized.

#### Out of Scope

- Public authentication
- Yobi.exe integration
- Production API security model

---

### 3.5 Internal Web Dashboard

#### Goal

Create a personal/admin dashboard for viewing Yobi Analytics data.

#### Scope

Possible dashboard sections:

```text
Latest Snapshot
24h Growth
7d Growth
30d Growth
Creator Trending
Hololive Trending
VSPO Trending
Last Updated
Collection Status
Errors
```

Possible architecture:

```text
CloudFront / Static Frontend
→ API Gateway
→ Read Lambda
→ DynamoDB
```

A custom domain is not required initially.

AWS-provided URLs are acceptable for development.

#### Definition of Done

- Dashboard can display current stored data.
- Dashboard can display latest update time.
- Dashboard can query analytics without direct DB credentials.

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
snapshotDate
fetchedAt
period
results
```

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
GET /organizations/vspo/trending?period=24h
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
24h Growth
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
```

#### Definition of Done

- Remote settings can target one anonymous client ID.
- One client's settings do not affect others unintentionally.

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

The immediate priority is:

> Start collecting historical raw data as early as possible.

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