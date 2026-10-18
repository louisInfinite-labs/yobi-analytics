# Creator milestones: bulk read for Live Status (`GET /milestones`)

The Live Status roster shows a small inline note ("Birthday Today", "Debut Today", "Birthday & Debut Today") after a creator name on the creator's
birthday and/or debut anniversary (JST calendar day). It needs every creator's dates, so there is one bulk read and the frontend works the rest out locally.

## Endpoint
`GET /milestones` (existing API Lambda, existing routing) -> `{ "milestones": [{ "creatorId", "birthday" "MM-DD", "debutDate" "YYYY-MM-DD" }, ...] }`,
sorted by `creatorId`, ~110 records, graduated creators included with their original debut date. Source of truth: DynamoDB `YobiCreatorMilestones`
(not modified by this feature). The per-creator route `GET /creators/{creatorId}/milestones` (Oshi Status dialog) is unchanged.

A DynamoDB failure follows the existing convention: `503 {"code": "MILESTONES_UNAVAILABLE"}` with the AWS error text kept in the logs only.

## Where the cost is controlled
1. **Browser HTTP cache** -- a successful response carries `Cache-Control: public, max-age=3600`. A browser holding it does not call the API at all for an hour.
2. **Frontend shared state** -- one in-memory promise/result per page session (`allCreatorMilestones.ts`): every component and remount shares it. A failure
   (including a 404 before the route is deployed) is retried at most every 5 minutes. The data is only requested when the Live Status list mounts.
3. **Warm-Lambda cache** -- `creator_milestones_store.get_all_creator_milestones` keeps the roster in module memory for 1 hour (same pattern as
   `api/livestream_classification.py`). A hit performs no DynamoDB call.
4. **One paginated Scan** on a miss: follows `LastEvaluatedKey` until exhausted, projecting only the three attributes.

Nothing re-reads per second or per tick: "is it today in JST" is computed in the browser from the cached dates, recomputed only when the JST day changes
(one timer aimed at the next JST midnight) or when the tab becomes visible / the window regains focus.

**Limitation (by design, documented):** the Lambda cache is per execution environment, not global. Each cold start and each concurrent environment scans
once for itself, and an idle environment is reclaimed together with its cache. So the cache bounds the Scan rate (about one per environment per hour); it does
not guarantee exactly one. A corrected date can take up to an hour (Lambda) plus an hour (browser) to show.

## DynamoDB read cost
One Scan of ~110 items (~10 KB) is about 3 read units (eventually consistent, 0.5 RCU per 4 KB). On-demand that is well below a cent per million Scans, and the
caches keep the Scans to a handful per hour. No new table, GSI, Lambda, schedule or cache service.

## IAM (prepared, NOT applied)
`terraform/manual-iam/policy-lambda-creator-milestones-read.json` grants the API Lambda role `dynamodb:GetItem` and `dynamodb:Scan` on exactly
`table/YobiCreatorMilestones`. Apply it manually (the CLI user has no IAM access), as with the other policies in that folder.

## Deploying (separate approvals)
1. Add the inline policy above to `yobi-analytics-lambda-role` (console).
2. `terraform apply -target='aws_apigatewayv2_route.routes["GET /milestones"]'` (never a bulk apply: there is known unapplied drift).
3. Deploy the API Lambda package that contains `creator_milestones_store.get_all_creator_milestones`.
Until the route exists the frontend simply shows no indicators (the 404 is treated as "unavailable"; nothing is invented).