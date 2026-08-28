# Yobi Analytics

Yobi Analytics is a separate Python/AWS data-collection and analytics project for Yobi.

Its purpose is to collect public YouTube video statistics for selected creators, store daily historical snapshots, and later provide analytics such as view growth and trending rankings to the Yobi desktop application.

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
→ Expose Data to Yobi.exe
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
24-hour growth = +25,000 views
```

By collecting daily snapshots continuously, the project can later calculate:

- latest view count
- 24-hour growth
- 7-day growth
- 30-day growth
- fastest-growing videos
- most-viewed videos
- creator-level trending
- Hololive trending
- VSPO trending

Raw historical snapshots must be preserved.

The project should not store only calculated rankings.

---

## Initial Architecture

The planned initial production architecture is:

```text
EventBridge Scheduler
→ AWS Lambda
→ YouTube Public API
→ DynamoDB
```

The collector will run once per day, initially at:

```text
00:00
Timezone: Asia/Tokyo
```

The Mac development machine does not need to remain powered on after the collector is deployed to AWS Lambda.

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

- macOS local development
- AWS Lambda
- required Python libraries

Project dependencies should be isolated using a local virtual environment.

Example:

```bash
python3 -m venv .venv
source .venv/bin/activate
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
  "youtubeChannelId": "UC...",
  "active": true
}
```

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
立川
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
00:00 JST
→ EventBridge triggers Lambda
→ Lambda retrieves public YouTube statistics
→ Lambda writes snapshots to DynamoDB
→ Lambda finishes
```

Between executions, no collector process needs to remain running.

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

The Yobi desktop application should not connect directly to DynamoDB with unrestricted AWS credentials.

Future architecture:

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

The API should return normalized analytics data rather than expose DynamoDB implementation details.

---

## Future Internal Dashboard

A private/internal web dashboard may be added later for development and analytics monitoring.

Possible dashboard data:

- latest collection status
- latest snapshots
- 24-hour growth
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

## Future Yobi Client Features

Later Yobi versions may use the AWS backend for:

- analytics display
- client/device UUID
- heartbeat / online status
- remote configuration
- per-client notification overrides
- offline cache synchronization

Google account identity should not be used as the Yobi device identity.

Google OAuth should remain optional and only be used for features that actually require Google user authorization.

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
Implement one ROADMAP.md section
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

The project is currently at the documentation/setup stage.

The immediate priority is:

```text
Start collecting historical raw data as early as possible.
```

Initial creator groups:

```text
Hololive
VSPO
```

See [`ROADMAP.md`](./ROADMAP.md) for the implementation plan.