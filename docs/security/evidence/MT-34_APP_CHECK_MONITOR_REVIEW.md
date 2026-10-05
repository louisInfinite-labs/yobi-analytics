# App Check monitor-mode review (roadmap MT-34) — procedure and record

Monitor mode **observes and records; it never rejects**. This review decides whether it is safe to flip to `enforce`
(MT-39) and settles the two deployment decisions the baseline leaves open: the App Check token TTL and the reCAPTCHA
Enterprise billing posture. No TTL is frozen by this document.

## What to collect (after the frontend and backend run in monitor mode for an agreed window)

1. **Verification outcomes from the API log group.** Every non-valid request logs one structured line
   `{"securityEvent": "<class>", "route": "<route template>", "mode": "monitor"}` (classes: `attest_missing`,
   `attest_invalid`, `attest_expired`, `attest_unavailable`). A valid token logs nothing.

   ```
   fields @timestamp, securityEvent, route
   | filter ispresent(securityEvent)
   | stats count() by securityEvent, route
   ```

2. **Total request volume** for the same window (the access-log group), to turn counts into rates:

   ```
   stats count() as requests by routeKey, status
   ```

3. **reCAPTCHA Enterprise assessment volume** from the provider console for the window, projected to a month.
4. **Free-allowance headroom.** The provider's free monthly assessment allowance versus the projected volume; an alert
   is planned at about 70 % of the allowance.
5. **JWKS behaviour:** any `attestation: JWKS refresh failed ... using cached keys` lines (grace-period use).

## Success criterion (wording matters)

Monitor mode does not reject anything, so the criterion is **not** "zero legitimate-UI rejections". It is:

> No unexplained App Check verification failures from legitimate production UI traffic.

Every `attest_*` event in the window must be explained (a known direct client, a script, a browser blocking the
attestation script) or attributed to a defect that is then fixed before enforcement.

## Decisions this review records

| Decision | Inputs | Notes |
|---|---|---|
| Token TTL | projected assessment volume, real active-user and session behaviour, the free allowance, the availability impact if the allowance is exhausted, and the security impact of a longer lifetime | A **deployment decision**, not an architecture blocker. No value (including 24 hours) is frozen by the baseline. |
| Billing posture | whether a no-billing hard stop at the allowance is acceptable versus enabling billing | A billing-linked configuration has a flat monthly cost that exceeds the operating-cost target, so this needs an explicit owner choice. |
| Enforcement readiness | the success criterion above | Feeds the MT-39 gate. |

## Record (to be completed by the owner after the window)

```
Monitor window (dates):
Requests observed:
attest_missing / invalid / expired / unavailable counts:
Unexplained legitimate-UI failures (should be none):
Projected monthly assessments vs allowance:
Chosen token TTL:                 (deployment decision)
Chosen billing posture:           (deployment decision)
Ready to enforce (yes/no):
Reviewed by / date:
```
