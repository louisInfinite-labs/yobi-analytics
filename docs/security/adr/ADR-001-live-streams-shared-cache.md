# ADR-001 — Shared cache mechanism for `/live-streams` upstream protection

Status: accepted for V1 (roadmap MT-20). Control: SEC-API-005 (P0). Baseline reference: §23.1.

## Context

`/live-streams` is answered from Holodex. Without protection every client request becomes an upstream request, so open
tabs (or a bot) can exhaust the shared upstream dependency and take Live Status down. This is an **availability /
third-party-dependency** risk, not an AWS-cost risk. The control requires a **shared** cache (a per-container cache alone
is not acceptable as the complete design), a configurable refresh window, stale-if-error, a shared 429 cooldown, bounded
timeout/retry and metrics. Strict cross-container single-flight (a distributed lease) is **P1**, not part of V1.

## Decision

Keep one JSON object in the **existing history bucket** (`live-streams/current.json`) as the shared cache, with a small
in-container memory cache (L1) in front of it.

The object holds the last normalized upstream result, the time it was fetched, and the shared cooldown state (cooldown
end, consecutive 429 count). Every API container reads and writes the same object, so the shared cooldown and the
shared freshness window hold across containers.

## Candidates scored (criteria from baseline §23.1)

| Criterion | S3 object (chosen) | DynamoDB item | Scheduled refresher writing the cache |
|---|---|---|---|
| Cross-container consistency | shared, last-writer-wins | shared, conditional writes possible | shared |
| Added latency | one S3 GET on an L1 miss | one DynamoDB read on an L1 miss | one S3 GET on an L1 miss |
| Failure modes | S3 error falls back to L1/stale | table error falls back to L1/stale | refresher failure leaves a stale cache |
| Cost at normal and abuse volume | pennies; bounded because L1 absorbs repeats | pennies | a scheduled invocation 24/7 regardless of viewers |
| New infrastructure / IAM | **none** — the shared Lambda role already reads and writes this bucket | table + IAM (manual) | new Lambda + schedule + IAM |
| Testability | moto | moto | moto + scheduler wiring |
| Rollback | stop reading the key | stop reading the item | remove schedule + Lambda |

The S3 object needs no new resource and no new permission, which matters because Lambda role changes are manual and
separately approved. The scheduled refresher is the strongest decoupling (the API would never call Holodex) but adds a
new always-on component and approval surface; it remains an option for the future notification detector (V2), which
could populate the same object.

## Consequences

- Upstream calls are bounded by the refresh window and the number of warm containers, not by request volume. Strict
  one-refresh-per-window across all containers is the P1 follow-on (a conditional-write lease on the same object).
- Last-writer-wins on the shared object is acceptable: any writer holds a fresh result or a newer cooldown.
- Stale data is served only inside a bounded maximum stale age, with internal stale metadata and logging; it is never
  presented as fresh and carries a `no-store` cache header so downstream caches cannot extend its life.
- Parameters (refresh window, maximum stale age, cooldown base/ceiling, retry cap, attempt timeout) are configuration,
  not code constants, and none is derived from the observed (unverified) Holodex quota.
