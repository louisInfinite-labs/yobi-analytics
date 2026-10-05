# Yobi Analytics — V1 Security Baseline

| | |
|---|---|
| Status | **Frozen for V1 owner review — documentation only.** This document implements nothing. Implementation is sequenced in `docs/plans/V1_SECURITY_P0_ROADMAP.md`. This public version states required end states and implementation status only; it intentionally omits resource identifiers, route inventories and itemized pre-launch weaknesses (§3.3). Control IDs, priorities and owner decisions are unchanged from the frozen design. |
| Date of audit | 2026-10-05 (audit basis: the repository state on that date) |
| Revision | **rev 3 (2026-10-05)** — owner-approved priority review applied (launch scope narrowed; some controls re-prioritized); builds on rev 2 (V1 audience/hosting/cost framing, SEC-API-BOT-001, WAF/CloudFront deferred) |
| Architecture status | **SECURITY ARCHITECTURE: FROZEN FOR V1 OWNER REVIEW. OWNER ARCHITECTURE BLOCKERS: NONE.** Remaining values (Firebase project ID/number/app ID/site/hostname, App Check TTL and billing posture, cache TTL, stale age, retry/cooldown values, limiter and cache/coalescing implementations) are implementation/deployment parameters or ADR decisions and do not reopen the baseline. |
| Method | Read-only repository inspection. **No AWS command was run**, so every live-AWS fact below is marked `UNVERIFIED-LIVE` unless Terraform/code/docs in the repo prove it. |
| Reference frameworks | OWASP ASVS 5.0 (target **Level 2**, applicability-mapped), OWASP API Security Top 10 (2023), AWS security best practices for a serverless HTTP-API architecture |
| Scope | Public HTTP API (API Gateway HTTP API → Lambda), the React dashboard, the S3/DynamoDB data plane, the CI/dev toolchain. **Out of scope for V1: Yobi.exe / the Unity desktop client** (owner decision, UD-1 resolved); the only supported production client is the Firebase-hosted web frontend. |

---

## V1 assumptions and risk framing (normative — rev 2)

These assumptions are inputs to every priority decision below. If any of them changes, the affected priorities must be re-evaluated (§40 exception process applies to deviations).

| # | Assumption | Consequence for this baseline |
|---|---|---|
| A1 | **V1 audience ≈ 500 users in a limited community.** | Capacity, throttle and cost sizing target this audience, not the open internet at scale. Per-user security (accounts, fraud) is out of scope. |
| A2 | **Initial frontend production host is Firebase Hosting** (static assets over a CDN). The API stays on API Gateway + Lambda in AWS; the browser calls it cross-origin. | Header/CSP/CORS policy is designed for the Firebase production origin (§11, §16). Firebase Hosting is **not** an API edge: it does not put CloudFront/WAF in front of the AWS API. **The Firebase-hosted web frontend is the only supported production client; Yobi.exe is out of V1 scope (UD-1 resolved for V1).** |
| A3 | **Normal legitimate V1 traffic is expected to have negligible AWS cost and is not a cost-optimization or security problem** (owner assumption; see *Cost sanity* below: this baseline's own estimate is a few dollars/month — small in absolute terms but a meaningful share of the $5/month operating-cost target — to be verified with access logs and Cost Explorer). | No control in this baseline exists to make *legitimate* traffic cheaper. Controls are justified only by abnormal, automated, abusive or malicious traffic, or by correctness/availability. Budget-threshold sizing is a separate open question. |
| A4 | **Cost protection targets abnormal traffic that amplifies AWS usage** (floods, scraping, cache-bypass, public write-route item creation). | §23's worst-case model is an *abuse* model, not a forecast. |
| A5 | **Holodex request amplification is an availability / third-party-dependency exhaustion risk, not an AWS cost risk.** | Reclassified in T-04, §23 and SEC-API-005: the harm is losing Live Status (and any other Holodex-backed feature) when the shared upstream key's rate limit is exhausted — by legitimate traffic as well as by abuse. The only known limit value is an *observed* one (UD-4); it is not treated as a verified fixed provider limit. |
| A6 | **AWS WAF / CloudFront are not P0 for V1.** They stay **deferred/conditional** until the real threat or traffic profile justifies their fixed monthly cost and architectural complexity (§19, §21 triggers). | SEC-AWS-005 becomes a trigger-based re-evaluation record (P1); SEC-AWS-006 (implementation) is P2 and conditional. |
| A7 | **CORS is not an authorization or bot-protection mechanism.** It is restricted to the Firebase production origin(s) only as browser-compatibility hygiene. | §11 states this explicitly; no control or test treats CORS as protection against curl, scripts or scrapers. |
| A8 | **Owner requirement SEC-API-BOT-001:** direct API clients that do not present a valid application attestation **and** a valid application session are rejected; frontend interaction telemetry is never proof of humanity; request patterns inconsistent with legitimate UI behavior are detected and throttled; repeated automated requests are blocked or throttled **regardless of intent**. Five layers: (1) Firebase App Check, (2) short-lived Yobi anonymous session, (3) per-session / per-IP endpoint-specific rate limiting, (4) behavioral anomaly scoring, (5) API Gateway route throttling. **V1 launch layers: (1) App Check enforcement + (5) route throttling. Layers (2) session, (3) per-session/IP limiter and (4) scoring ship after launch (P1 / P1 / P2); all five do NOT ship at launch.** The umbrella principles bind from day one: unattested direct clients are rejected; frontend telemetry is never proof of humanity; no allow/deny exception is based on stated intent. | Reverses the earlier draft position that unattested direct calls to public read routes are simply "allowed" (§9, §10, §24). Adds SEC-API-BOT-001…005. Raises a local-development/CI compatibility question (§Open questions); it raises **no** desktop-client question — Yobi.exe is out of V1 scope (UD-1). Honest limits are stated in §24 and SEC-API-BOT-001. |
| A9 | **$5/month is the current operating-cost target. It is NOT an automatic security kill-switch threshold** (owner decision, rev 3): `operating cost target != automatic attack cutoff`. | Security controls must not intentionally shut down legitimate production traffic merely because normal usage approaches the target. Budget alarm and emergency-stop thresholds are selected later from measured legitimate baseline spend, reasonable normal-growth headroom, abnormal-cost amplification detection and the emergency-response policy; **no new dollar thresholds are set here.** |

### Legitimate-traffic sizing (derivation; assumptions to be validated with access logs, SEC-AWS-001)

**Symbols.** U = community size = 500 (A1). c = fraction of users with the dashboard open in a busy hour (assumption 10–20 %). **N = U·c = 50–100 open tabs** (design range); N_max = U = 500 (every user online, one tab each — a ceiling, not an expectation). T_ls = 60 s `/live-streams` poll (`liveStreamsStore.ts`); T_hb = 60 s client liveness request. v = interactions per tab per minute that load creator data (assumption 0.2, i.e. one per 5 minutes); k = data requests per interaction (assumption 4: recent, ranking, oshi-status + one more). I = requests per tab at page load (assumption 8: session mint, live-streams, heartbeat, remote-config, three creator reads, topics). N_sync = tabs acting inside one synchronized window of w seconds.

| # | Quantity | Formula | N = 50 | N = 100 | N_max = 500 |
|---|---|---|---|---|---|
| 1 | **Average polling request rate** | R_poll = N·(1/T_ls + 1/T_hb) = N·(1/60 + 1/60) = **N/30** | 1.67 rps | 3.33 rps | **16.7 rps** (full-community steady polling, no interaction — a ceiling, not an expectation) |
| 2 | **Expected normal interactive traffic** | R_int = N·v·k/60 = N·0.2·4/60 = 0.0133·N | 0.67 rps | 1.33 rps | 6.7 rps |
| 2′ | Normal total | R_norm = R_poll + R_int = 0.0467·N | **2.3 rps** | **4.7 rps** | 23.3 rps |
| 3 | **Synchronized burst** (requests arriving inside the window) | B = N_sync·I; average rate inside the window R_burst = N_sync·I / w | see cases below | | |

Synchronized-burst cases (illustrative; parameters are assumptions): **(a)** "stream starts" push wave: N_sync = 100, I = 8, w = 10 s → B = 800 requests, R_burst = **80 rps**; **(b)** whole community at once: N_sync = 500, I = 8, w = 30 s → B = 4,000, R_burst = **133 rps**; **(c)** poll-timer alignment after an outage, deploy or device wake: N_sync = 100 tabs × 2 polling requests, w = 5 s → B = 200, R_burst = **40 rps**. Concurrency check for (a): 80 rps × ≈0.3 s ≈ 24 concurrent executions, within a reserved-concurrency ceiling sized for the load (SEC-AWS-002).

**Token-bucket consequence (average vs burst are different quantities).** A route with steady rate r and burst capacity b serves at most **b + r·w** requests in a window of w seconds. An illustrative default-sized bucket (r = 10, b = 20) therefore serves 20 + 10·10 = 120 of 800 (15 %) in case (a), 20 + 10·30 = 320 of 4,000 (8 %) in case (b) and 20 + 10·5 = 70 of 200 (35 %) in case (c): **under synchronization a default-sized bucket would answer most legitimate requests with 429** (the frontend retries twice with jitter, which recovers only part). The remedies are jitter on client polls/loads and a burst capacity sized to a wave (§20) — **not** a higher steady rate.

**Holodex upstream volume (limit-agnostic).** The client-side rate at the Yobi API is R_ls = N/T_ls = N/60 (N = 50–100 → 0.83–1.67 requests/s). The security requirement is **not** that Yobi knows Holodex's exact limit; it is that **client/API request volume must not map 1:1 to Holodex upstream requests**. Define the **upstream amplification ratio = Holodex upstream calls ÷ Yobi `/live-streams` requests**. Without protection it is 1 (every client request becomes an upstream request, so upstream volume grows with N). With a shared cache and coalescing (SEC-API-005) the upstream call rate depends on the **refresh window and the number of refresh operations, not on N**: with a refresh window of T_r seconds and at most one refresh per window, upstream calls ≤ 1/T_r per second whatever N is (illustration only, not a design input: T_r = 30 s → ≤ 0.033 calls/s while 100 tabs produce 1.67 requests/s, ratio ≈ 0.02). The target is a ratio **far below 1 during normal multi-client operation**; no numeric SLA is fixed before metrics exist.

**Holodex rate-limit evidence (observed only; operational tuning input, UD-4).** During this audit a Holodex 429 response stated "Maximum 80 reqs per 2 minutes" once, on the **`/videos`** endpoint (the audit's own read-only queries) — **not** on `/users/live`, the endpoint Yobi's `/live-streams` uses. Holodex's public API documentation page, fetched for this pass, states **no rate limit or quota** (it only says an API key should be sent and that `/users/live` is cheaper than `/live`). The figure is therefore **observed evidence only, not an authoritative or permanent quota**: scope (per key, per IP, per endpoint), permanence and burst behavior are unknown. **No architecture or control depends on it**; it is an input for tuning the refresh window after launch (§29, SEC-API-005). The exact provider quota is `UNVERIFIED` and **not a V1 security-architecture blocker**.

**Cost sanity (A3, with a caveat).** Monthly requests M = R_norm,avg × 2.59 M s, where R_norm,avg = 0.0467 · N_avg and N_avg is the *time-averaged* number of open tabs over the whole day (assumption ≈ 20, much lower than the busy-hour 50–100): R_norm,avg ≈ 0.93 rps → ≈ 80 k requests/day → **M ≈ 2.4 M requests/month**. At approximate list prices (API Gateway HTTP API ≈ $1.00–1.29 per million in the deployment region — verify; a 12-month free tier may apply) that is roughly **$2.4–3.1/month** for API Gateway; Lambda stays inside its always-free allowance at this volume (≈ 0.1 GB-s per request → ≈ 0.24 M GB-s vs 0.4 M free). So legitimate traffic is **small in absolute terms but a meaningful share of the current $5/month operating-cost target**. This does not change the design stance (legitimate traffic is not optimized, A3). It matters for two reasons: (1) budget alarm and emergency-stop thresholds must **not** be derived from the $5 target (A9) — they are selected later from measured baseline spend, normal-growth headroom, abnormal-amplification detection and the emergency-response policy; and (2) normal usage approaching the target must never by itself shut down production traffic. Both are tracked as an open question (§Open questions) and as input to SEC-AWS-003/004.

**Re-evaluation outcome (rev 2 → rev 3).** *Rev 2:* P0 → P1: SEC-API-004, SEC-AWS-002, SEC-AWS-005 (re-scoped); P1 → P2 (conditional): SEC-AWS-006; SEC-API-BOT-001/002/003 added as P0 (BOT-004 P1, BOT-005 P2). *Rev 3 (owner-approved priority review):* **P0 → P1:** SEC-API-002, SEC-API-BOT-003, SEC-DEP-001, SEC-TEST-002; **P0 → P2:** SEC-OPS-002; **launch scope narrowed** for SEC-API-001, SEC-API-003, SEC-API-005, SEC-API-BOT-001, SEC-FE-002, SEC-AWS-004, SEC-TEST-001 and SEC-OPS-001 (what was deferred is recorded in the *Deferred-scope register* at the head of Appendix A and carried by existing controls or by a P1 follow-on of the same ID). **No control was added or removed.** Control counts are not restated here; they are derived from the Priority field of every catalog entry (Appendix A header and Final summary), so no summary number can drift from the catalog. Rationale for keeping App Check at P0 despite the small audience: it is the owner's stated requirement, application-layer (no fixed AWS cost, no CloudFront/WAF), and the primary V1 direct-client barrier; it ships staged (monitor → enforce) and enforcement is not gated on any desktop client (UD-1: Yobi.exe out of V1 scope).

### Reconfirmed baseline (final consistency pass)

| Statement | Status |
|---|---|
| **Firebase Hosting is the initial frontend host** (A2); the AWS API is called cross-origin and is *not* fronted by Firebase | Confirmed |
| **V1 audience ≈ 500 community users** (A1) | Confirmed |
| **Normal legitimate traffic cost is not the security design driver** (A3) — with the budget-headroom caveat above | Confirmed |
| **Abuse / malicious amplification is the cost-security concern** (A4); Holodex exhaustion is an availability / third-party risk (A5) | Confirmed |
| **AWS WAF / CloudFront are not P0** (A6): deferred, conditional on the §19 triggers; SEC-AWS-006 is P2 | Confirmed |

### Pending deployment inputs (no architecture blocker remains)

UD-1, UD-3, UD-4 and UD-5 are resolved (below) and the **architecture** of UD-2 is resolved. What remains are **deployment inputs** — values that exist only in the owner's Firebase/AWS accounts. They are not architecture questions and none is fabricated here.

| ID | Pending deployment input | Needed by | Needed to close |
|---|---|---|---|
| UD-2 (**architecture resolved; deployment values pending**) | Firebase project ID; **project number** (App Check JWT `iss`/`aud` use the number, not the ID); web app ID (pinned as the token `sub`); hosting site ID(s); production hostname(s) and any custom domain; reCAPTCHA Enterprise site-key ID; chosen App Check token TTL; reCAPTCHA billing posture (no-billing hard cap vs billing) — **both are deployment decisions, not architecture blockers**. **Not present in any tracked file.** | Final CORS list (SEC-AWS-009), CSP origins (SEC-FE-003), header verification (SEC-FE-002), App Check verification pins and configuration (SEC-API-BOT-002) | Owner supplies the values at implementation time |

### Resolved owner decisions

**UD-1 — Yobi.exe / Unity desktop client**

```
RESOLVED FOR V1:
Yobi.exe is not part of V1 production scope.
Web security controls may assume the supported production client is the Firebase-hosted web frontend.
```

Consequences (normative for this baseline):
- **No App Check compatibility design for Yobi.exe** is made or implied anywhere in this baseline.
- **No desktop-client exception path** exists in V1 (no credentialed bypass, no separate native API surface, no §40 exception for it).
- **Firebase App Check enforcement for the web frontend is not weakened** for the sake of Yobi.exe: SEC-API-BOT-001/002 (and BOT-003 when it ships) are designed and enforced for the web client only, with no carve-outs for native clients.
- **Yobi.exe is not part of the V1 production security gate** (§38): no gate item, simulation or test depends on it; a client that is not the Firebase-hosted web frontend is an unsupported client and is rejected by the same rules as any direct client.
- Decisions that earlier waited on a desktop client are no longer gated by it: retiring or guarding unused Holodex-backed routes (SEC-API-011) and tightening identifier formats (SEC-API-001) need only consider the web frontend.
- **If Yobi.exe is revived later, desktop attestation/authentication is a separate future security design task** (not designed, estimated or pre-approved here); this baseline must then be revised through §40/the normal review, not bent to fit.

**UD-2 — Firebase identity, production origins, App Check provider: ARCHITECTURE RESOLVED — DEPLOYMENT VALUES PENDING**

*Architecture decisions resolved (this baseline):*
- **Provider:** Firebase App Check with **reCAPTCHA Enterprise** (score-based, invisible); reCAPTCHA v3 is documented as still supported but **not recommended for new integrations** and is a fallback only (§29.7a). The backend contract is **provider-independent**: both providers yield the same Firebase App Check JWT, so a later provider change touches only the frontend initializer and Firebase console configuration, never the backend contract.
- **Origins:** production CORS allowlist = the exact Firebase production origin(s) only; local-development and preview/staging policies are separate and never inherit production trust (§11).
- **Request contract and response semantics:** `X-Firebase-AppCheck` verified in the Lambda; missing/invalid/expired → 403; verification infrastructure unavailable with no trustworthy cached keys → 503; valid → continue to session validation (§13.1, SEC-API-BOT-002).
- **Backend pins** the *production* Firebase project number (issuer/audience) and web app ID (subject); debug tokens belong only to a separate non-production project/app, so a leaked debug token cannot produce tokens the production API accepts (§11, SEC-API-BOT-002).
- **Cost posture:** the App Check **billing posture and the final token TTL are deployment decisions, not unresolved architecture blockers** (owner decision, rev 3). They are decided from actual assessment volume, real active-user/session behavior, the provider's free allowance, the availability impact if the allowance is exhausted, and the security impact of a longer token lifetime (§29.7a). A billing-linked configuration costs a flat $8/month above 10,000 assessments, which would exceed the current $5/month operating-cost target (A9).
- **App Check limitation retained:** a valid token proves the request obtained valid app attestation; it does **not** prove a human is operating the browser.

*Deployment-specific values still required (implementation-time inputs, **not fabricated here**):* Firebase project ID · project number · web app ID · hosting site ID(s) · production hostname(s)/custom domain · reCAPTCHA Enterprise site-key ID · App Check token TTL · billing posture. Current repository evidence: **all unknown** (no Firebase artifacts are tracked).

**UD-5 — attestation-unavailable behavior: RESOLVED (policy); numeric parameters deferred**
- Valid cached signing keys available → continue verification.
- Key refresh fails temporarily → keep using still-trusted cached keys within a **bounded grace period**.
- Cold cache and verification keys unavailable → **fail closed with 503** (`ATTESTATION_UNAVAILABLE`). **Never fail open.**
- Official evidence: Firebase's custom-backend guidance says the signing keys rotate and **may be cached for up to 6 hours** (a ceiling for the refresh interval). Neither the key-rotation overlap nor any grace period is documented, so the **grace-period duration is left as an implementation parameter** (it must be finite, configurable, logged when used, and not exceed a bound chosen with the owner at S3b); no number is fixed here.

**UD-3 — GitHub repository visibility: RESOLVED**

```
RESOLVED:
The production source repository is public on GitHub.
```

- **Eligible, per GitHub's own documentation** (*GitHub security features* overview, fetched for this pass): secret scanning, push protection and code scanning (CodeQL) are listed as "available for public repositories by default"; Dependabot alerts, Dependabot security updates, Dependabot version updates and the dependency graph are available on all plans. The paid licences (GitHub Secret Protection, GitHub Code Security) are what *private* repositories need. **Consequence: no purchase of GitHub Advanced Security (or either paid licence) is needed solely to obtain the public-repository capabilities this baseline uses.**
- **Eligible is not enabled.** This pass did not inspect repository settings, so the enablement of every feature is **UNVERIFIED** (table in §18.1). Nothing in this document claims a feature is on.
- **Public means world-readable.** Every tracked file, branch, pull request and the full Git history are visible to anyone; the secret policy in §17 is tightened accordingly, and scanning/push protection are defense-in-depth only.
- A change of repository visibility to private **re-opens** this decision (paid licences would then be required for the same capabilities).

**UD-4 — Holodex upstream dependency: RESOLVED FOR ARCHITECTURE**

```
UD-4 STATUS:
RESOLVED FOR ARCHITECTURE

Exact Holodex provider quota:
UNVERIFIED
Not a V1 security architecture blocker.
```

- **Requirement reframed.** Not "Yobi must know Holodex's exact rate limit" but **"Yobi must prevent frontend/API request volume from mapping 1:1 to Holodex upstream requests."** The architecture stays safe if Holodex later changes its quota.
- **Classification:** Holodex is a **free external dependency**. The threat is **availability / third-party-dependency exhaustion**, **not primarily an AWS-cost risk**. Abusive client traffic may still consume Yobi AWS resources, but that is handled by the abuse controls (SEC-API-003, SEC-API-BOT-*), not by this one.
- **Architecture decision (resolved) — protection model for `/live-streams`:** `client requests → Yobi API → shared cache / request coalescing (strict cross-container single-flight is a P1 follow-on) → Holodex only when a refresh is actually required`, with bounded refresh frequency, bounded stale-if-error, a shared cooldown on upstream 429, bounded timeouts and bounded retries — specified in SEC-API-005 and §23.1. Requirements are stated without any provider-specific number.
- **Provider tuning input (not architecture):** the exact Holodex quota, its scope and any burst behavior remain `UNVERIFIED`. The only evidence is one observed 429 on `/videos` (80 requests / 2 minutes); Holodex's public documentation fetched for this pass states no limit. The refresh window and thresholds are **configurable parameters tuned from the metrics in §23.1** after launch.
- **Removed dependency:** SEC-API-005 no longer depends on an authoritative quota; no P0 control waits on UD-4.









### Owner-approved decisions (rev 3)

- **Priorities:** P0 → P1: SEC-API-002, SEC-API-BOT-003, SEC-DEP-001, SEC-TEST-002; P0 → P2: SEC-OPS-002; narrowed P0 launch scope for SEC-API-001, SEC-API-003, SEC-API-005, SEC-API-BOT-001, SEC-FE-002, SEC-AWS-004, SEC-TEST-001, SEC-OPS-001. Final split derived from the catalog: see Appendix A header.
- **App Check is P0** and is the primary V1 direct-client barrier. **App Check billing posture and final TTL are DEPLOYMENT DECISIONS, not unresolved security-architecture blockers**; 24 hours is **not** frozen as the production TTL.
- **Strict cross-container single-flight / distributed lease is P1**, not a V1 launch blocker. A purely per-container cache is still **not acceptable as the complete final design**: the V1 implementation includes a shared/coordinated cache layer.
- **BOT-003 (anonymous session) is P1** and ships with the per-session/per-IP limiter (BOT-004). **Residual V1 risk: a holder of a valid App Check token is bounded primarily by route throttling until BOT-003/BOT-004 ship.**
- **$5/month is an operating-cost target, not an automatic security hard ceiling** (A9).

**How to read this document.** Section 3 summarizes the architecture (it deliberately does not itemize the pre-launch state, see §3.3). Sections 4–28 define policy. Sections 29–40 define tooling, testing and gates. Section 41 is the implementation roadmap. Control IDs (`SEC-*`) are stable and are the only thing other documents/tests should reference. Priorities: **P0** required before production · **P1** required shortly after production · **P2** defense-in-depth.

**ASVS note.** ASVS 5.0 chapter names are used for mapping (§36 table). Individual requirement numbers are intentionally *not* quoted here: they must be mapped against the official ASVS 5.0 text in task S1 so that nothing is mis-cited. Where an ASVS chapter does not apply to Yobi it is marked **N/A with a reason**, not silently dropped.

---

## 1. Security objectives

1. **Confidentiality of secrets and per-client data.** YouTube/Holodex/VAPID/admin secrets never reach the browser, logs, or the repository. A client's stored data (remote config, push subscription, notification preference) is readable/writable only by the holder of that client's credential, or by the admin.
2. **Integrity of the analytics read model.** No public caller can alter creator data, rankings, history, or another client's settings.
3. **Availability without runaway cost.** Abnormal, automated or hostile traffic cannot take the product down or drive AWS spend into abnormal amplification, and exhaustion of a third-party dependency (Holodex) cannot silently take Live Status down. Normal V1 traffic (≈ 500 users) is assumed to cost a small amount and is not itself a design driver. **The current monthly figure of $5 is an operating-cost target, not an automatic security cutoff (A9)**; cost-driven emergency thresholds are chosen later from measured data (an existing cost-based emergency-stop mechanism is documented in the repository's operations notes).
4. **Minimum data to the browser.** The frontend receives only what is required to render the UI.
5. **Verifiability.** Every security requirement maps to at least one automated or manual verification method, and every discovered vulnerability leaves a permanent regression test.

## 2. Security non-goals

- **Hiding API JSON from the person using the app.** See the principle below — this is explicitly *not* a goal.
- Protecting against a malicious owner of their own browser/device (they can read anything their browser receives).
- Defending against a nation-state or a compromised AWS root account; the root/IAM boundary is a separate operational control (Roadmap Phase 5).
- Anti-DDoS at network scale (L3/L4). We rely on AWS-native absorption and cost containment, not on out-of-band scrubbing.
- User accounts / login. Yobi is deliberately anonymous (Roadmap 4.3/4.4: random `clientId`, no Google login). Authentication below means *client-credential* and *admin-key* checks, not identity.
- Making `GET` data endpoints private. They are public read-only by design.
- **Yobi.exe / the Unity desktop client (owner decision, UD-1 resolved for V1).** No attestation compatibility, exception path or gate item is designed for it; if it is revived it is a separate future security design task.

### The browser / API principle (normative)

> Any data required by browser JavaScript cannot be kept secret from the owner of that browser.
>
> Therefore the requirement is **not** "users must never see API JSON."
>
> The frontend receives only the minimum data required to render the UI. Backend-only fields, infrastructure metadata, internal debug information, secrets, unnecessary upstream responses and sensitive implementation details must never be sent to the browser.
>
> Direct API access must still be subject to validation, authorization where applicable, throttling, abuse controls and cost controls.
>
> **CORS is not an authentication or authorization boundary.**
>
> **Unattested direct clients are rejected (SEC-API-BOT-001).** Attestation raises the cost of automation; it is not proof of a human, and frontend interaction telemetry is never proof of humanity.

Consequences used throughout this document: (a) "someone called the API with curl" is not a vulnerability by itself *for public data* — but by policy such a client is **rejected** unless it presents a valid application attestation and session (SEC-API-BOT-001), and even a client that does is throttled; (b) the *cost and abuse behaviour of a direct call* is the thing we engineer and test; (c) CORS settings are a browser-compatibility/hygiene control only.

---

## 3. Architecture summary (public-safe)

This section describes the architecture at the level needed to understand the controls. It deliberately contains **no** resource identifiers, route inventory, configuration values or itemized weaknesses: the repository is public, so an itemized pre-launch state would function as an attack-surface map (§3.3).

### 3.1 Architecture

```
Browser (single-page web app served by Firebase Hosting, the only supported production client;
         Yobi.exe is out of V1 scope)
        │  HTTPS (cross-origin)
        ▼
API Gateway HTTP API  (public entry point; route throttling, access logging, CORS)
        │  proxy integration
        ▼
API Lambda  (validation, attestation checks, read/write handlers)
        │ reads                         │ reads/writes                │ outbound
        ▼                               ▼                             ▼
S3 (rankings, history, manifest)   DynamoDB (client records,        Holodex v2 API (shared key;
                                   catalog and operational tables)    volume decoupled by a shared cache)

Scheduled, not public: EventBridge Scheduler → collection / history / ranking pipeline and the notification dispatcher.
A cost-based emergency-stop mechanism exists and is reconciled with the owner policy under SEC-AWS-003.
```

### 3.2 Components in scope

- **Frontend:** a React/Vite single-page app on Firebase Hosting (A2); it calls the API cross-origin and holds no secret (§8, §17).
- **API:** an API Gateway HTTP API in front of a Lambda handler. Non-public routes use two credential mechanisms: a per-client secret (stored only as a hash on the server) and an admin key. Both must be compared in constant time and fail closed (§10).
- **Data plane:** S3 and DynamoDB, with the API role limited to what the API needs (SEC-AWS-008).
- **Upstream:** Holodex (shared key) and the YouTube data API; upstream responses are untrusted and normalized (§15, TB-5).
- **Tooling:** the repository on GitHub (public), PR CI with least-privilege permissions, and the test/scan tooling in §29–§34.

### 3.3 Pre-launch state is not itemized here

This baseline specifies the **required end state** and the controls that reach it. It does not publish an inventory of present routes, configuration values or weaknesses. Each control in Appendix A states its required end state in the *Requirement* field and an implementation **status** only. Implementation progress is tracked in the implementation roadmap (`docs/plans/V1_SECURITY_P0_ROADMAP.md`) and is verified at the pre-production gate (§38). Nothing in this document claims a protection that has not been verified.

### 3.4 Audit limits

Live AWS configuration (IAM policies, account quotas, capacity settings, budgets, monitoring state), the hosting setup and the actual enablement of GitHub security features were **not** queried while writing this baseline. They are tracked as open questions and as `UNVERIFIED-LIVE` / `UNVERIFIED` where a control depends on them.

---

## 4. Trust boundaries

| # | Boundary | Crossing data | Trust rule |
|---|---|---|---|
| TB-1 | Internet → API Gateway | Any HTTP request | **Untrusted.** Every field, header, method, size and rate is hostile until validated/limited. |
| TB-2 | API Gateway → API Lambda | Proxy event | Treat `event` as untrusted input; `routeKey` is trusted only because API Gateway generated it. |
| TB-3 | Browser JS ↔ API | JSON | Browser is **fully attacker-controlled** (the visitor owns it). Nothing in it is a secret. |
| TB-4 | API Lambda → S3 / DynamoDB | SDK calls | Trusted data plane; cost and blast-radius boundary (IAM role). |
| TB-5 | API Lambda → Holodex | Outbound HTTPS | Third-party, rate-limited, **untrusted response** (API10 — unsafe consumption): validate/normalize, never forward raw. |
| TB-6 | Scheduler/pipeline → data plane | Internal | Trusted principals; no public input reaches collection (Roadmap 5.4). |
| TB-7 | Admin operator → API | `X-Admin-Key` | Shared secret; compromise = write access to remote config. |
| TB-8 | Developer machine / CI → AWS & repo | CLI, Actions | Supply-chain boundary; secrets, artifacts, workflow permissions. |
| TB-9 | Push service ↔ Lambda | Web Push to allow-listed hosts | Outbound only to allow-listed endpoints. |

## 5. Asset classification

| Asset | Class | Why | Where |
|---|---|---|---|
| YouTube API key, Holodex key, VAPID private key, admin key | **Secret (critical)** | Quota theft, push impersonation, config write | Secrets Manager; local `.env` (ignored) |
| Per-client secret (raw) | Secret (high) | Authorizes client-scoped reads/writes | Browser `localStorage` (only copy); server stores SHA-256 |
| Per-client secret hash, push subscription (endpoint + keys), notification preference | **Personal-ish (medium)** | Push endpoint enables sending notifications to that device | DynamoDB client tables |
| `clientId` | Pseudonymous identifier (low-medium) | Random UUID, no account link | Browser, DynamoDB |
| Creator catalog, rankings, history | Public data (integrity-critical) | Product value; derived from public YouTube data | S3, DynamoDB |
| Terraform state / IAM policy documents | Sensitive configuration | Reveals infrastructure topology and access policy; **because the repository is public, tracked infrastructure files are world-readable** — treat them as public, never add credentials or account-specific secrets, and keep state/plans out of Git | Local state (git-ignored), repo (policy docs, **public**) |
| Lambda artifacts / SBOM | Integrity-critical | Deployed code provenance | S3 artifact bucket |
| AWS spend headroom | **Availability / operating-cost asset** | The $5 monthly figure is an operating-cost target, not a security hard ceiling (A9); legitimate traffic must not be shut down merely for approaching it | Budgets |
| CloudWatch logs | Sensitive operational data | May contain identifiers/errors | CloudWatch |


## 6. Threat model

STRIDE-oriented, mapped to OWASP API Top 10 (2023) and to controls. The *V1 treatment* column states how each threat is addressed, not the pre-launch state.

| ID | Threat | API Top 10 | V1 treatment | Controls |
|---|---|---|---|---|
| T-01 | Direct API use / endpoint enumeration / scraping of public analytics | API9, API6 | Public data confidentiality is not at issue; abnormal volume is. Addressed before launch by attestation, throttling and caching. | SEC-API-BOT-001…005, SEC-API-003, SEC-API-009, SEC-API-011, SEC-AWS-005 (triggers) |
| T-02 | Burst or sustained **abusive** request flood drives Lambda/API Gateway/S3 cost (legitimate V1 traffic is assumed negligible, A3) | API4 | Addressed before launch by attestation, route throttling, alarms and a reconciled emergency-response policy (§23 abuse model). | SEC-API-003, SEC-API-BOT-004, SEC-AWS-004, SEC-AWS-003, SEC-AWS-002 |
| T-03 | Cache-bypass query variation (unique query strings) | API4 | Addressed by response caching and normalized query handling. | SEC-API-009, SEC-AWS-006 |
| T-04 | **Third-party dependency exhaustion (availability, not AWS cost):** `/live-streams` → Holodex per request lets client volume map 1:1 onto upstream volume, so open tabs (or a bot) can exhaust whatever upstream limit exists → Live Status unavailable. The exact provider limit is unverified and not needed to define the control | API4, API10 | Addressed by the P0 `/live-streams` upstream-protection control (shared cache, stale-if-error, shared 429 cooldown, bounded timeouts/retries, metrics); target upstream amplification ratio far below 1. | **SEC-API-005**, SEC-API-003, SEC-API-BOT-004 |
| T-05 | S3-heavy repeated reads of large ranking objects | API4 | Bounded by throttling and S3-read caching. | SEC-API-009, SEC-API-003 |
| T-06 | Public write flood creates unbounded data-store items with unbounded identifier/version length | API4, API6 | Addressed by field bounds, attestation, throttling and storage-growth bounds. | **SEC-API-001, SEC-API-004**, SEC-AWS-007, SEC-DATA-001 |
| T-07 | Oversized/malformed body, query or headers cause 500s, memory pressure, log inflation | API4, API8 | Addressed by validation and explicit size caps. | SEC-API-001, SEC-API-002, SEC-API-006 |
| T-08 | Guess/steal a `clientId` to read/modify another client's data (BOLA) | API1, API2 | Mitigated for client-scoped routes by the per-client secret; residual risk recorded (SEC-API-013). | SEC-API-013 (accepted-risk record), SEC-TEST-001 |
| T-09 | Admin key brute force, replay or leak | API2, API5 | Mitigated by constant-time, fail-closed key checks; attempt limiting, rotation and key-handling rules are required. | SEC-API-008, SEC-DEP-002 |
| T-10 | Secret exposure through bundle, logs, repo or error text | API8 | Addressed by the bundle secret gate, repository secret scanning and logging hygiene. | **SEC-FE-001**, SEC-DEP-002, SEC-LOG-001 |
| T-11 | XSS through upstream strings (titles, thumbnail URLs) | API8 | Addressed by safe rendering, URL allowlisting and CSP as a second layer. | SEC-FE-003, SEC-FE-006, SEC-FE-008 |
| T-12 | Injection (DynamoDB expression, S3 key/path manipulation, header injection) | API8 | Addressed by parameterized access, roster-checked identifiers and regression tests. | SEC-API-001, SEC-TEST-001 |
| T-13 | SSRF via user-supplied push endpoint | API7 | Mitigated by an https-only host allowlist with redirects disabled; regression-tested. | SEC-TEST-001 (regression), SEC-FE-007 |
| T-14 | Information leakage through errors, headers, upstream bodies | API8 | Addressed by the error contract, echo truncation and response-header requirements. | SEC-API-006, SEC-API-007 |
| T-15 | Dependency / supply-chain compromise (pip, npm, GitHub Actions) | API10 (indirect) | Addressed by dependency scanning, workflow hardening and Dependabot. | SEC-DEP-001, SEC-DEP-003, SEC-DEP-004 |
| T-16 | CI/CD or deploy-artifact tampering | — | Addressed by least-privilege CI permissions, no deploy from CI and artifact verification. | SEC-DEP-004, SEC-OPS-001 |
| T-17 | **Self-DoS through an automatic cost cutoff**: abnormal cost amplification — or ordinary growth toward the operating target — trips the existing budget-triggered emergency stop and turns the whole API off | API4 | Addressed by reconciling the legacy automatic cost cutoff with the owner policy before launch (SEC-AWS-003) and a documented recovery procedure. | **SEC-AWS-003**, SEC-AWS-006 |
| T-18 | Over-privileged shared Lambda role → compromise of the public API gives write access to the data plane | API5, API8 | Addressed by role separation (SEC-AWS-008). | SEC-AWS-008 |
| T-19 | Route/inventory drift (forgotten, retired or undocumented endpoints) | API9 | Addressed by a route-inventory contract and meta-tests. | SEC-TEST-001, SEC-API-010, SEC-API-011 |
| T-20 | Blind spots: no access logs, no alarms, unlimited log retention | API8 | Addressed by access logging, alarms and log retention. | **SEC-AWS-001, SEC-AWS-004**, SEC-AWS-012 |
| T-21 | Clickjacking, MIME sniffing, referrer leakage, mixed content | API8 | Addressed by the hosting header baseline and CSP. | **SEC-FE-002**, SEC-FE-003, SEC-API-007 |
| T-22 | Malformed/hostile Holodex or YouTube response (unsafe consumption) | API10 | Addressed by the normalization layer, which treats upstream data as untrusted. | SEC-TEST-001, SEC-API-005 |
| T-23 | **Automated/direct clients and token farming:** scripts, scrapers or headless browsers using the API without the UI; attackers replaying, sharing or farming App Check tokens and sessions; forging "human-like" telemetry | API2, API4, API6 | Addressed at launch by App Check enforcement and route throttling; the session, per-session/IP limiter and scoring layers follow. | **SEC-API-BOT-001…005**, SEC-API-003 |

## 7. Public API exposure policy

1. **Every public route is explicitly inventoried** (method, path, auth class, validation schema, cost profile). The inventory is generated from Terraform `api_routes` and compared in a test with `api_handler._ROUTES` and the OpenAPI contract (SEC-API-010, SEC-TEST-001).
2. **Default-deny for new routes:** a route cannot be added to `api_routes` without a matching security-contract test and a cost-profile entry (§23). Retired routes keep answering `410` until removal is a conscious, tested decision.
3. **Read routes are public and read-only**, with allowlisted fields, filters, sort keys, periods and page sizes (Roadmap Phase 6). No client-controlled table/index/key names, no free-form queries.
4. **Write routes** are limited to client self-service (own `clientId` + credential) and admin; each has a body-size cap and a per-source rate budget (SEC-API-002/004).
5. **Unused expensive routes are retired or guarded** (SEC-API-011).
6. **Admin routes** are never reachable without `X-Admin-Key`, and have their own, stricter rate limit (SEC-API-008).
7. **At V1 launch every route except retired-410 and CORS preflight requires a valid App Check token** (SEC-API-BOT-001/002); once SEC-API-BOT-003 ships (P1) a valid Yobi session is also required; a new route cannot be exempt without an approved exception (§40).

## 8. Frontend data-minimization policy

1. The browser receives only fields the UI renders or needs to compute what it renders. A new response field needs a justification in the PR ("which component reads it").
2. Never in a browser response: secrets, infrastructure identifiers (ARNs, table/bucket names), stack traces, raw upstream responses (Holodex/YouTube), internal flags, other clients' identifiers.
3. A **response-allowlist contract test** per public read route asserts the exact key set (SEC-FE-004). Adding a field fails the test until the contract is updated deliberately.
4. The frontend never needs a secret: `VITE_*` variables are public by construction. A build-artifact scan must prove no key-shaped string is in `dist/` (SEC-FE-001).
5. Per-client data (remote config, push subscription) is returned only to the credential holder.
6. Honest limit: this reduces *exposure and data-theft value*; it does not make visible data private.

## 9. Direct API access policy

- **Public analytics remain public data, but V1 does not serve anonymous direct clients (SEC-API-BOT-001).** At **V1 launch** every API route requires a valid **Firebase App Check token**, except: retired-route `410` responses (cheap, no data) and CORS preflight (answered by API Gateway). A request without a valid token is rejected **before any S3/DynamoDB/Holodex work**, with only cheap in-memory/crypto checks (`403`, §13.1). **Once the short-lived Yobi anonymous session ships (SEC-API-BOT-003, P1), a valid session is also required** and `POST /session` requires only a valid App Check token.
- A request that *does* present valid credentials is still subject to validation (§12), authorization where applicable (§10), per-session/per-IP endpoint limits (SEC-API-BOT-004), behavioral scoring (SEC-API-BOT-005) and route throttles (§20). A valid token proves only that the request came from an attested app instance — **not** that a human is present.
- **Not controls** (never used as the basis of an allow/deny decision): `Origin`/`Referer`/CORS, `User-Agent`, and any **frontend-sent interaction telemetry** (mouse, timing, focus, "human-looking" signals). Telemetry is attacker-controlled and is never proof of humanity.
- **Honest limits:** App Check on the web proves "an app instance passed the configured provider check", not intent; a determined actor can drive the real web app in a headless/farmed browser and obtain valid tokens. That is why layers 3–5 exist and why repeated automated requests are limited **regardless of intent** (including well-meaning scrapers — there is no allowlist-by-intent).
- Direct *authenticated* abuse is bounded by: per-session/IP limits → route throttles → reserved concurrency → alarms → the emergency-response procedure (SEC-AWS-003).
- Conditional (deferred, P2): an edge layer (CloudFront cache + WAF rate rules) and/or disabling the default `execute-api` endpoint behind a custom domain (SEC-AWS-006, SEC-AWS-015). Not part of V1 (A6); it would not make the API private either.

## 10. Authentication and authorization policy

| Class | Routes | Mechanism | Policy |
|---|---|---|---|
| Public read | analytics read routes, live status, catalog routes | none | Rate/size/cost-bounded only |
| Public liveness | client liveness (heartbeat/status) routes | none | Low sensitivity by design; must be size/rate bounded (SEC-API-001/004) |
| Client-bootstrap | client credential issuance route | none, first-claimant-wins | Accepted risk, documented (SEC-API-013); abuse-bounded (SEC-API-004) |
| Client-scoped | client configuration, push-subscription and notification-preference routes | `X-Client-Secret` (256-bit, SHA-256 at rest, constant-time compare) | A route is client-scoped by default if it touches `clientId` data |
| Admin | admin configuration and statistics routes | `X-Admin-Key` (constant-time, fail-closed) | Own throttle, key-rotation procedure (SEC-API-008); never persisted in the browser |

**Application attestation layer (SEC-API-BOT-001/002 at launch; BOT-003 later) sits *in front of* every class above.** Order of checks per request: (1) route known; (2) **App Check token valid** (signature, issuer, audience/app ID, expiry; keys from the cached JWKS — no per-request network call); (3) **Yobi session valid** (HMAC signature, expiry, version) — *active only once SEC-API-BOT-003 ships (P1); not part of the V1 launch*; (4) per-session/per-IP budget (SEC-API-BOT-004); (5) route-class credential (`X-Client-Secret` / `X-Admin-Key`) where the class requires it; (6) input validation; (7) data-plane work. Steps 2–3 are cryptographic checks that never touch the data plane. Step 4's state mechanism is an **open design decision** (SEC-API-BOT-004 evaluation criteria); whichever mechanism is chosen must keep the cost of a *rejected* request bounded and quantified. The session is anonymous and independent of `clientId`; it **does not replace** `X-Client-Secret` or `X-Admin-Key`.

Rules: no authorization decision may rely on CORS, Origin, User-Agent, frontend telemetry, or a client-supplied identity claim. Authorization is enforced server-side per route and covered by a negative test (missing, wrong, malformed, other-client credential) in the route's security-contract test.

## 11. CORS and origin policy

- **Launch requirement:** the production CORS policy is restricted to the production origin(s) (SEC-AWS-009). No cookies or ambient credentials are used, so even a permissive policy would not enable credentialed cross-site abuse; restricting it is hygiene, not protection.
- **Origin / Referer / User-Agent headers are not authentication signals.** They are client-controlled and trivially forged by any non-browser client; they may be used for logging or diagnostics only and never for an allow/deny, limit or trust decision.
- **CORS is not an authorization mechanism and not a bot-protection mechanism.** It is enforced only by browsers. `curl`, scripts, scrapers, other servers and any non-browser client ignore it entirely, and an attacker's own browser can be configured to ignore it. It protects nothing about admin routes, client-scoped routes, scraping, or cost; those rely on attestation + session (SEC-API-BOT-*), credentials (§10), validation (§12), throttles (§20), caching (§23) and monitoring (§25). Do **not** count CORS as a mitigation for T-01/T-02/T-23. Why still restrict it: so a *third-party web page* cannot casually make a visitor's browser call the API (hygiene — credentials are never attached automatically, so this is not a fix) and so the policy is explicit and reviewable.
- **`*` is not used as the production browser origin policy.** A wildcard would be acceptable only for a route deliberately designed as public-for-any-origin *and* with the security impact documented; **no V1 route is designed that way** (every route requires attestation + session, §9).

**Per-environment policy**

| Environment | Allowed browser origins on the API | Notes |
|---|---|---|
| **Production** | **Only the exact Firebase production origin(s)**: scheme + host (+ port if non-default), no path, no wildcard — e.g. `https://<SITE_ID>.web.app` and `https://<SITE_ID>.firebaseapp.com` (Firebase serves the live channel on both default domains, per Firebase Hosting documentation) plus any custom domain attached to the site; *or only the single canonical one* if the other is redirected away. **The concrete hostnames are not in the repo (UD-2 deployment value).** The set must equal the domain list of the production reCAPTCHA key (§29.7a): an origin not in both lists is not a production origin. Allowed request headers: `content-type, x-admin-key, x-client-secret, x-firebase-appcheck, x-yobi-session`. | Verified by a config test: no `*`, no `localhost`/`127.0.0.1`, no preview-channel origin in the production configuration (SEC-AWS-009). |
| **Local development** | **Explicitly approved list only**, `http://localhost:5173` (Vite dev server; `frontend/dashboard/playwright.config.ts`) talking to the **local handler server** `http://127.0.0.1:8787` (`scripts/local_api_server.py`, attestation mode `off`, never deployable to production). | Local origins are **never** added to the production API's CORS or to the production reCAPTCHA key (Firebase documentation: never add `localhost` to a key deployed to production). Local App Check, if exercised, uses the debug provider against a **non-production** Firebase project (§29.7a). |
| **Preview / staging** | **None defined — future policy.** If later introduced: every preview/staging origin is listed explicitly (no `*.web.app` wildcard), has its **own** App Check app/key and domain list, **does not inherit production trust**, and may call the production API **only** if that is explicitly approved and recorded under §40. | Firebase documentation states preview-channel URLs (`PROJECT_ID--CHANNEL_ID-RANDOM_HASH.web.app`) are public (unguessable but anyone with the URL can load them) and use the project's **real backend resources**; therefore a preview build must be configured with a non-production API base URL and its origin stays out of production CORS and out of the production reCAPTCHA key. |

- Methods stay as listed above; the two new request headers are required by SEC-API-BOT-002/003 and are added when those ship (SEC-AWS-009, P1).
- Tests: preflight returns only the allowlisted methods/headers; a foreign origin gets no `Access-Control-Allow-Origin` and the production Firebase origin does; the origin-list test asserts the three prohibitions above; a test asserts no code path reads `Origin`, `Referer` or `User-Agent` for an allow/deny decision (logging only).

## 12. Input / schema validation

- **Rule:** validate at the edge of the Lambda, before any S3/DynamoDB/Holodex work, using explicit allowlists (enum, regex, length, range). Reject, never coerce silently.
- **Identifiers:** `clientId` (UUID v4 regex), `creatorId` (`^[a-z0-9_]{1,64}$`, then roster membership), `videoId` (`^[A-Za-z0-9_-]{11}$`), config `key` (bounded charset/length), `appVersion` (bounded charset/length) (SEC-API-001).
- **Bodies:** hard byte cap (proposal: 8 KiB for client routes; an explicit, documented cap for the admin remote-config value) enforced before parsing; nesting-depth cap; reject unknown top-level fields on typed routes (SEC-API-002).
- **Queries:** reject unknown query parameters on read routes (prevents cache-key blow-up and probing), keep the existing `limit` caps and add an `offset` ceiling (SEC-API-001).
- **Contract:** an OpenAPI 3 document is the single machine-readable schema; Schemathesis and ZAP consume it (SEC-API-010, SEC-TEST-004).
- **HTTP level:** unexpected methods must be refused by API Gateway; a test asserts that no route answers a method it does not declare.

## 13. Output and error-data leakage

- Error contract: `{"error": "<safe message>", "code": "<STABLE_CODE>"}`; 5xx never include exception text, paths, table/bucket names or upstream bodies.
- 4xx messages may echo input only after truncation (cap echo at 64 chars) and never reflect into headers (SEC-API-006).
- Exception logging (`print(repr(exc))`) is server-side only and must not include request bodies, secrets, or push endpoints (SEC-LOG-001).
- Response headers: explicit `Cache-Control`, `X-Content-Type-Options: nosniff` on API responses (SEC-API-007). Strip server/proxy banners if a CDN is added.
- Distinguish **domain conditions** (404 `HISTORICAL_DATA_UNAVAILABLE`, 410 `ENDPOINT_RETIRED`) from **infrastructure failures** (500/503). Real 5xx is never hidden (covered by contract tests).

### 13.1 Response semantics for the bot-protection layers

All bodies are `{"error": "<generic text>", "code": "<STABLE_CODE>"}`; the text never names which sub-check failed beyond the code (no oracle), and **the session-related rows apply once SEC-API-BOT-003 ships (P1); at V1 launch the App Check, rate-limit and backend-failure rows are live**; responses carry the CORS headers so the browser can read them (for gateway-generated responses — 429, 413 — **verify** that API Gateway adds them).

| Condition | HTTP | `code` | Frontend behavior (at most one recovery attempt per request; never a loop) | Event class logged |
|---|---|---|---|---|
| App Check token **missing** | **403** | `APP_ATTESTATION_REQUIRED` | initialise/obtain an App Check token, retry once | `attest_missing` |
| App Check token **present but invalid** (bad signature, wrong issuer/audience/app, wrong algorithm/type, malformed, unknown key) | **403** | `ATTESTATION_INVALID` | force-refresh the App Check token, retry once, then show the error state | `attest_invalid` |
| App Check token **expired** (valid signature, past `exp`) | **403** | `ATTESTATION_EXPIRED` | force-refresh the App Check token, retry once, then show the error state | `attest_expired` |
| Yobi session **missing** | 401 | `SESSION_REQUIRED` | mint a session once, retry once | `session_missing` |
| Yobi session **invalid** (tampered, bad signature, unknown key/version, wrong audience) | 403 | `SESSION_INVALID` | discard it, mint a new one once, retry once | `session_invalid` |
| Yobi session **expired** (valid signature, past `exp` + allowed skew) | 401 | `SESSION_EXPIRED` | mint a new session once, retry once | `session_expired` |
| **Rate limit exceeded** by the application limiter (layer 3) or a scoring throttle (layer 4) | 429 | `RATE_LIMITED` + `Retry-After` | honor `Retry-After`, then the existing ≤ 2 retries with jitter, then the error state; **never mint new sessions to evade the limit** | `rate_limited` (with class) |
| **API Gateway throttle** (layer 5) | 429 | gateway-generated body (no Yobi code; not controllable) | same as above — the frontend treats every 429 identically | gateway metric |
| **Attestation infrastructure unavailable** (signing keys unreachable **and** no trustworthy cached keys — cold cache, or beyond the bounded grace period; **never fail open**, UD-5 policy) | 503 | `ATTESTATION_UNAVAILABLE` | exponential backoff; **not** an auth failure — no token refresh | backend failure |
| **Session signing key unreadable** | 503 | `SESSION_UNAVAILABLE` | exponential backoff | backend failure |
| **Genuine backend failure** (S3/DynamoDB/Holodex/unexpected exception) | 500 generic `Internal server error`, or the existing 503 codes (`RANKING_NOT_READY`, `HOLODEX_UNAVAILABLE`) | existing | error state; existing handling | backend failure |
| Known domain conditions | 404 `HISTORICAL_DATA_UNAVAILABLE`, 410 `ENDPOINT_RETIRED` | existing | existing empty/retired handling | — |

Rules: (1) **Precedence:** route known → attestation → session → limiter → route-class credential → validation → work. For the **App Check layer every failure is 403** (missing, invalid, expired — it attests the *app*, it is not a credential challenge); for the **session layer** absence and expiry are **401** and presence-but-invalid is **403**. A valid App Check token continues to session validation; a valid session continues to the limiter. (2) **No auth-layer 5xx from client input:** any verification/parse exception on client-supplied tokens is treated as invalid (403), never as a 500. (3) **No masking:** a genuine backend failure is never reported as 401/403/429, and an auth/limit rejection is never reported as 5xx. (4) A failure of the *limiter's own state* must not become a 429 for legitimate users: its failure mode (fail-open with alarm vs fail-closed) is an evaluation criterion of SEC-API-BOT-004; if fail-closed, the response is a **503** (a genuine failure), never 429. (5) Scoring-based throttles use the same `RATE_LIMITED` code — there is no distinct "you are flagged" signal. (6) Retired-route 410 and CORS preflight need no credentials. (7) Every row has a contract test (SEC-TEST-001) and a frontend handling test (single retry, no loop).

## 14. XSS protection

- Policy: ban `dangerouslySetInnerHTML`, `innerHTML`, `eval`, `new Function`, `document.write` via lint rule + grep gate (SEC-FE-008); external image sources limited to `https` and an allowlisted host set (SEC-FE-006); CSP as defense in depth (SEC-FE-003); `rel="noopener noreferrer"` on every `target="_blank"`.
- Service worker: treat the push payload as untrusted; a notification click may only open same-origin URLs (SEC-FE-007).
- Tests: render payloads such as `<img src=x onerror=…>` and `javascript:` URLs as titles/URLs and assert they stay inert text or are dropped.

## 15. Injection protection

- DynamoDB: only SDK-parameterized key/attribute values; no string-built `FilterExpression`; no client-controlled attribute/index names.
- S3: keys are built only from validated, roster-checked `creatorId` and server-side dates, never from raw user input. A path-manipulation test (`../`, `%2e%2e`, NUL, very long ids, unicode confusables) must fail validation before any S3 call.
- Headers: no user input is written into response headers.
- Upstream: normalize Holodex/YouTube data through typed parsers; reject unknown shapes.
- Logging: no log injection — strip control characters from echoed ids.
- No shell/eval/untrusted deserialization (pickle/yaml) — enforced by lint/grep gate.

## 16. Security headers and CSP

Applies to the **static hosting layer = Firebase Hosting (A2)**. The policy below is the specification for it. Firebase Hosting serves HTTPS and a global CDN for the static bundle; the browser calls the AWS API **directly and cross-origin**, so API response headers are a separate concern (SEC-API-007).

**Baseline (SEC-FE-002).** **P0 launch subset:** frame protection (`frame-ancestors 'none'` in CSP once present, `X-Frame-Options: DENY` meanwhile), `X-Content-Type-Options: nosniff`, **verified** HSTS behavior (check what Firebase already sends; set explicitly only if missing or weaker), `no-cache`/revalidation for `index.html`, and an appropriate cache policy for the service worker `sw.js`. **P1 (carried by SEC-FE-003):** `Referrer-Policy`, `Permissions-Policy` and long-lived immutable caching of hashed assets. Set in `firebase.json` → `hosting.headers` (do not rely on defaults; verify with a header scan):

| Header | Value |
|---|---|
| `Strict-Transport-Security` | `max-age=31536000; includeSubDomains` |
| `X-Content-Type-Options` | `nosniff` |
| `Referrer-Policy` *(P1)* | `strict-origin-when-cross-origin` |
| `Permissions-Policy` *(P1)* | deny camera, microphone, geolocation, payment by default |
| Frame protection | `frame-ancestors 'none'` in CSP, `X-Frame-Options: DENY` as fallback |

**Caching headers (same file):** `index.html` and **`sw.js`** `no-cache`/revalidate so a security fix or service-worker change reaches users promptly (**P0**); content-hashed build assets (`/assets/**`) `public, max-age=31536000, immutable` (P1, an optimization).

**CSP (SEC-FE-003, P1; ship `Content-Security-Policy-Report-Only` first, then enforce):**
`default-src 'self'; script-src 'self'` **plus the exact script/connect/frame origins required by Firebase App Check and its provider (reCAPTCHA) — to be derived from the real network log at implementation, not guessed here**; `style-src 'self' 'unsafe-inline'` (antd/CSS-in-JS — tighten with nonces/hashes if feasible); `img-src 'self' data: https://i.ytimg.com https://yt3.ggpht.com` (+ any avatar host seen in real usage); **`connect-src 'self' <production API origin>`** (the exact value is supplied at implementation; update if a custom API domain is introduced) plus the Firebase/App Check endpoints; `frame-src https://www.youtube.com https://www.youtube-nocookie.com` plus the reCAPTCHA frame origin if the provider needs it; `worker-src 'self'`; `base-uri 'none'; object-src 'none'; form-action 'self'`.

**Firebase specifics to verify at implementation (not assumed here):** which security headers Firebase adds by default (notably HSTS); that the SPA rewrite (`** → /index.html`) is acceptable (unknown paths then return the app shell with 200, which must not mask `sw.js`/asset 404s); that preview channels are not used against the production API (CORS excludes them); and that App Check **debug tokens** are never present in a production build.

## 17. Secrets management

- Single source of truth: a managed secret store (AWS Secrets Manager or SSM Parameter Store, per the existing convention); any change of store follows an ordered, reviewed migration procedure.
- **Public-repository rule (normative, UD-3).** The source repository is **public**. The following **must never be committed** — to any branch, fork, pull request, issue, comment, gist, workflow file, script, test fixture, Terraform file or documentation, ever:
  - AWS credentials (access keys, session tokens) and anything that mints them;
  - Firebase private credentials, **service-account keys** and Admin SDK credentials;
  - the Holodex API secret (treated as private), the YouTube API key, the VAPID private key, the admin API key;
  - **App Check debug tokens**;
  - **Yobi session-signing secrets** (and any other signing/encryption key);
  - `.env` / `.env.local` secrets and any file derived from them;
  - production tokens of any kind.
  (Values that are *public by design* — e.g. a Firebase web-app configuration or a reCAPTCHA site key — are not secrets, but are committed only deliberately and allow-listed by exact value in the bundle scan; confirm their classification against Firebase documentation at implementation.)
- **GitHub secret scanning and push protection are defense-in-depth. They do not make a committed secret safe**: they cover supported patterns only, can be bypassed by a user with write access, and a secret in a public repository may be copied within seconds. The control is *not committing*; detection is only the backstop.
- **If a real secret reaches Git (any branch, PR, fork, or history): rotate/revoke it FIRST; then remediate the repository history only if necessary.** Deleting the file or reverting the commit is **not** remediation — the value stays in history, in clones and forks, in pull-request refs and in GitHub's cached views. GitHub's own guidance: revoke/rotate first (which "may be sufficient"); history rewriting (`git filter-repo` with its sensitive-data removal option) is an additional, optional step that still leaves clones/forks/cached views, which may need a GitHub Support request. Procedure lives in the incident runbook (SEC-OPS-001); evidence of rotation is recorded.
- No secret in: Terraform plaintext variables, Lambda env values, `VITE_*`, Git history, logs, error responses, CI logs.
- Local dev: `.env` / `.env.local` / VAPID files are git-ignored (verified); developers and AI tooling must not read or print them (house rule).
- Any frontend code path that could read a secret-bearing build variable is removed, and a build-artifact scan guards the class (SEC-FE-001).
- Rotation: documented procedure and cadence per secret (admin key, VAPID, Holodex, YouTube, session-signing key); admin-key rotation must not require a deploy (SEC-API-008).
- Detection: GitHub secret scanning + push protection at the repository level (SEC-DEP-002; enablement UNVERIFIED), plus the bundle scan (SEC-FE-001).

## 18. Dependency / supply-chain security

- Backend: pinned `requirements.txt`; add `pip-audit` (SEC-DEP-001); consider hash-pinning at artifact-build time (P2). Lambda packaging already excludes dev-only packages (`pytest`, `moto`).
- Frontend: `package-lock.json` + `npm ci` ✔; add an `npm audit --omit=dev` gate (SEC-DEP-001).
- GitHub Actions: least-privilege `permissions` ✔; pin third-party actions to commit SHAs and let Dependabot propose action updates (SEC-DEP-004, P2). Because the repository is public, workflows must never combine a `pull_request_target` trigger with checkout/execution of pull-request code, and must never expose secrets to fork pull requests (current `pr-ci.yml` uses `pull_request` with `contents: read` and no secrets ✔).
- Dependabot: dependency graph + alerts + **security updates** are the baseline (SEC-DEP-005). **Version updates are not enabled indiscriminately** (at most a narrow, grouped scope such as GitHub Actions); no auto-merge; every Dependabot PR must pass the project's focused tests and the normal PR/review workflow before merge.
- Artifact provenance: comparing the build record's SHA-256 with the deployed `CodeSha256` is already practiced manually; keep it as a pre-production gate (SEC-OPS-001).

### 18.1 GitHub security baseline for a public repository (UD-3 resolved)

Authority: GitHub documentation (*GitHub security features*, *About secret scanning*, *About push protection*, *About code scanning*, *About Dependabot security updates*, *Removing sensitive data from a repository*), fetched for this pass. Where a detail page did not state public-repository terms, the *security features* overview is the authority and the gap is noted. **Nothing below says a feature is enabled; every enablement is `UNVERIFIED` until someone checks the repository settings and records the evidence (SEC-DEP-002/003/005, §38).**

| Capability | AVAILABLE / ELIGIBLE (public repository) | ACTUALLY ENABLED | Notes and caveats |
|---|---|---|---|
| Secret scanning (alerts) | Yes — "available for public repositories by default"; GitHub states it runs automatically for free across the entire Git history on all branches | **UNVERIFIED** | Partner-program secrets are reported to the *provider*, not shown as repository alerts, so they do not replace repository alerts. Non-provider (generic) patterns and validity checks exist; whether they apply without extra enablement was not established. |
| Push protection | Yes — "available for public repositories by default"; the *user-level* setting is on by default for pushes to public repositories | **UNVERIFIED** (repository level) | User-level protection does not raise an alert when bypassed unless repository-level protection is also enabled; the baseline requires the **repository-level** setting. Pattern-based: unsupported secret formats are not blocked; a user with write access can bypass with a reason. |
| Code scanning (CodeQL) | Yes — "available for public repositories by default" (a Code Security licence is for private repositories) | **UNVERIFIED** | Two setup modes — *default setup* (configured in repository settings) and *advanced setup* (a workflow file). Which one is used is a later implementation decision (S2); **no workflow is created by this document.** Actions-minute and language-support terms were not established by the pages fetched — confirm at implementation. |
| Dependency graph | Yes — all plans | **UNVERIFIED** | Prerequisite for alerts and security updates. |
| Dependabot alerts | Yes — all plans | **UNVERIFIED** | Baseline supply-chain control. |
| Dependabot security updates | Yes — all plans; requires the dependency graph and alerts; opens pull requests only for dependencies in a manifest or lock file | **UNVERIFIED** | Opens PRs; merging stays manual and behind the normal PR checks. |
| Dependabot version updates | Yes — all plans | **Not part of the baseline** (except an optional narrow scope, e.g. GitHub Actions) | Not enabled indiscriminately. |
| Paid GitHub security licences (Secret Protection / Code Security) | **Not required** for the capabilities above on a public repository | n/a | If the repository becomes private this changes (UD-3 note). |

Target V1 baseline: GitHub secret scanning, push protection (repository level), Dependabot alerts (+ dependency graph), Dependabot security updates where appropriate, and CodeQL code scanning for Python and JavaScript/TypeScript. First action when implementing: **read the repository's Settings → Code security page and record the actual state** of each row.

## 19. AWS edge protection

**V1 decision: Option A — no CloudFront and no AWS WAF.** (A6; owner-confirmed framing: WAF/CloudFront are not P0 for V1.)

Facts that drive the decision: (1) the API is an API Gateway **HTTP** API, which cannot host a WAF web ACL directly — WAF would require **CloudFront in front** (or a move to REST API); (2) Firebase Hosting (A2) is a CDN for the *static bundle only* — it does not front the AWS API, so adopting it adds no edge protection for the API and no WAF; (3) the audience is ≈ 500 users in a limited community and normal traffic cost is negligible (A1, A3); (4) WAF adds a fixed monthly cost (**verify current AWS pricing**) that exceeds the current $5/month operating-cost target and CloudFront adds architectural complexity (cache keys, origin headers, invalidation, a second URL to protect).

What V1 relies on instead (small, application-layer controls): **Firebase App Check enforcement (SEC-API-BOT-001/002; the session SEC-API-BOT-003 and per-session/IP limits SEC-API-BOT-004 follow at P1)**, abuse-oriented route throttles (SEC-API-003), strict validation and size caps (SEC-API-001; 002 at P1), shared caching (SEC-API-005; 009 at P1), reserved concurrency, access logs + minimum alarms (SEC-AWS-001/004), and an emergency stop with a tested reset and deliberately-chosen thresholds (SEC-AWS-003). Note the limit of this stack: all of it executes *inside* API Gateway/Lambda, so a flood of unattested requests is still billed per request at the gateway and for a minimal Lambda invocation until rejected — which is why the gateway throttle and the tested emergency-response procedure remain the outer backstop.

**Re-evaluation triggers (SEC-AWS-005, P1 — record these thresholds, then watch them in the access logs):** adopt Option B (CloudFront + WAF) only if **any** of the following is observed or becomes true:
1. Abusive/automated traffic is *measured* in access logs — for example a small set of source IPs accounts for a large share of requests (initial draft threshold: > 50 % of daily requests from ≤ 5 IPs, or ≥ 10 % of requests are 4xx/429 for a week) — and the application-layer controls are not containing it.
2. The emergency stop or a 40 % budget alert is triggered by non-legitimate traffic.
3. A cache layer is needed that Lambda-side caching cannot provide (e.g. Holodex exhaustion persists after SEC-API-005).
4. Active audience grows well beyond the limited community (initial draft threshold: > ~5,000 active users) or the API is exposed to a public audience.
5. An attacker adapts around per-session/route throttles (e.g. distributed low-rate sources, farmed attestation tokens) in a way only per-IP edge rules address.

When triggered: Option B = CloudFront (cache policy, response-headers policy, optional origin-header check) + WAF rate-based rules and managed rule groups in **Count** mode first, **Block** after a false-positive review. Option C (move to REST API) remains **rejected**: migration cost and behavior changes outweigh the benefit. Implementation is SEC-AWS-006 (**P2, conditional**).

## 20. API Gateway throttling

- **Launch requirement:** a single stage-wide default shared by all routes and callers is not sufficient — one abusive client could consume the whole budget and starve legitimate users, and (see *Legitimate-traffic sizing*) a modest synchronized wave of legitimate tabs could exceed a default-sized bucket. Per-route differentiation is required (SEC-API-003).
- **Two different parameters, sized by two different formulas.** API Gateway throttling is a token bucket: `rate` (steady-state **average** requests/second) and `burst` (bucket capacity). In a window of w seconds a route serves at most **burst + rate·w** requests.
  - **Rate (average-based).** `rate_route = ceil(h_r · R_avg(route))`, where `R_avg(route) = N_design · f_route` (f_route = requests per tab per second on that route; N_design = 100) and `h_r = 2` (headroom for non-uniform load); it is then **capped by the abuse ceiling** for that route (for write/admin routes the abuse ceiling is the binding value). `rate` bounds *sustained* abuse: abusive volume over time T ≤ burst + rate·T.
  - **Burst (wave-based).** `burst_route = max(b_floor, ceil(N_sync·q_route − rate_route·w))`, where q_route = requests per tab on that route in one synchronized event, `w` = acceptance window (10 s without client jitter, 30 s with ±jitter on polls/loads) and `b_floor` ≈ 5. `burst` bounds one *wave* and refills only at `rate`, so a generous burst is a bounded, one-time exposure — it does not raise the sustained abuse ceiling.
- **Worked example (illustrative; N_design = 100, N_sync = 100, h_r = 2; final numbers come from access logs in S4):**

| Route class | f_route (req/s per tab) | R_avg | rate = ⌈2·R_avg⌉ (capped by abuse ceiling) | q | burst, w = 10 s (no jitter) | burst, w = 30 s (jitter) |
|---|---|---|---|---|---|---|
| `GET /live-streams` | 1/60 | 1.67 | 4 | 1 | max(5, 100 − 40) = **60** | max(5, 100 − 120) = **5** |
| client liveness route | 1/60 | 1.67 | 4 | 1 | **60** | **5** |
| creator reads (each of `recent`, `ranking`, `oshi-status`) | 0.2/60 | 0.33 | 1 | 1 | 100 − 10 = **90** | 100 − 30 = **70** |
| session issuance route (20 min TTL) | 1/1200 | 0.083 | 1 | 1 | **90** | **70** |
| client credential issuance route (launch wave N_sync = 50) | ≈ 0 | ≈ 0.014 | 1 (abuse ceiling) | 1 | 50 − 10 = **40** | 50 − 30 = **20** |
| admin routes | operator only | ≈ 0 | 1 (abuse ceiling) | 1 | floor **5** | floor **5** |

- Unlisted routes keep the stage default as a safety net. Per-route buckets are independent; the aggregate ceiling is the sum of route rates, **bounded in execution by reserved concurrency** (SEC-AWS-002) and by the kill switch (SEC-AWS-003).
- **Client-side requirement that makes small bursts sufficient:** jitter (±20–30 %) on the 60 s polls and a randomized delay on page-load requests, so a push-triggered or timer-aligned wave spreads over `w ≈ 30 s` (SEC-API-003 implementation candidate; a frontend change).
- Honest limits: gateway throttling is **a per-account/region token bucket, best-effort, not per-client**; usage plans/API keys are not authentication and are not a cost ceiling (Roadmap 5.3). Never treat a quota as a hard budget.
- The frontend must tolerate 429 (it already retries twice with jitter, then shows an error state; §13.1).

## 21. AWS WAF strategy

- **V1: not adopted (deferred/conditional, A6).** AWS WAF cannot attach to the current HTTP API; it would need CloudFront (§19). The fixed monthly cost and the added architecture are not justified by a ≈ 500-user community with negligible normal traffic. This is a recorded decision, not an omission.
- **Entry criteria:** the §19 triggers (SEC-AWS-005). Until one fires, WAF work is out of scope for P0 and P1.
- **If adopted later (SEC-AWS-006, P2 conditional):** (1) a rate-based rule per IP for the whole distribution and a stricter one for write/admin paths; (2) AWS managed *Common* and *Known bad inputs* rule groups in **Count** mode first, **Block** only after a measured false-positive review; (3) a body-size constraint rule; (4) no Bot Control until justified (cost); (5) WAF logging to CloudWatch/S3 with short retention.
- WAF is defense-in-depth for abuse (T-01/T-02/T-06/T-23); it never replaces application validation, attestation or throttles, and it does nothing for Holodex exhaustion (T-04).

## 22. Lambda concurrency / blast-radius controls

- API Lambda: a reserved concurrency value. Choose it from the legitimate load (R_norm ≈ 2.3–4.7 rps at N = 50–100; 16.7 rps full-community polling; synchronized-burst concurrency ≈ N_sync-rate × duration, e.g. 80 rps × 0.3 s ≈ 24 — see *Legitimate-traffic sizing*) with headroom, and from the abuse ceiling, not from "what AWS allows". Verify the live account quota and that unreserved concurrency stays sufficient for the collector/history-worker/reducer (SEC-AWS-002, P1).
- Timeouts: a long default timeout is unsuitable for a read API; set a route-appropriate timeout (≤ 10–15 s) so a stuck downstream cannot pin concurrency (SEC-AWS-002).
- Per-invocation resource budget: maximum downstream calls per request (§23), enforced in code.
- Separate roles (read-only API vs pipeline) so an abused or compromised API cannot write S3/DynamoDB (SEC-AWS-008).
- Kill switch: an existing cost-based emergency-stop mechanism must be verified, have a documented reset runbook and be tested periodically (SEC-AWS-003).

## 23. S3 / DynamoDB cost-amplification controls (abuse model)

**Scope (A3/A4/A5):** normal V1 traffic is assumed negligible in cost and is *not* optimized here. This section models **abnormal** traffic, and separately flags the one route whose amplification is an **availability** problem (Holodex). **Per-endpoint cost profile — required for every public route before it ships.** Template: max request rate · burst · max downstream calls/request · max DynamoDB reads/writes · max S3 reads (+bytes) · max Lambda duration · max Lambda concurrency · max response size · pagination cap · cacheability · **amplification factor** (downstream cost ÷ gateway cost).

Cost profiles are produced for every public route at implementation (S3/S4) and asserted by tests. Two classes of route matter most: (i) **Holodex-backed routes**, whose amplification is an **availability / third-party-exhaustion** risk rather than an AWS-cost risk (§23.1, SEC-API-005, SEC-API-011); and (ii) **S3-backed read routes**, where cost scales with object size and request volume and is bounded by caching and throttling (SEC-API-009, SEC-API-003). Public write routes are bounded by field limits, attestation, throttling and storage-growth limits (SEC-API-001/004, SEC-AWS-007, SEC-DATA-001).

**Abuse model (a model of hostile sustained traffic, not a forecast of normal use).** At implementation, compute the cost of a sustained flood at the configured route rates from current list prices; the point of the model is that an unprotected sustained flood can consume a month's operating-cost target within days. That is why a small set of layered controls (App Check rejection, abuse-oriented throttles, validation/size caps, shared caching, alarms, a tested and deliberately-thresholded emergency stop; session and per-session/IP limits later) is required, and why API Gateway quotas alone are not a budget. It is *not* a reason to engineer for legitimate traffic cost, and it is *not* by itself a reason to adopt CloudFront/WAF (§19 triggers).

Controls: container-memory TTL cache for S3-backed read results and for `/live-streams` (SEC-API-005/009); `Cache-Control` for CDN/browser reuse; DynamoDB on-demand **max throughput** caps on public-write tables (SEC-AWS-007); TTL/retention for heartbeat and orphan credential rows (SEC-DATA-001); response-size and pagination caps asserted in tests.

### 23.1 `/live-streams` upstream protection model (UD-4 resolved for architecture)

**Classification.** Holodex is a free external dependency. The main threat is **availability / third-party-dependency exhaustion**, not AWS cost. The requirement is **decoupling**, not knowledge of a quota: Yobi must prevent frontend/API request volume from mapping 1:1 to Holodex upstream requests, and must stay safe if Holodex changes its quota.

```
client requests (any number of tabs / bots)
        ↓
Yobi API  (/live-streams)
        ↓
shared cache  +  request coalescing (single-flight)
        ↓
Holodex — only when a refresh is actually required
```

Example of the required behavior: 100 tabs poll `/live-streams` → the API receives 100 requests → most or all read the same cached Yobi result → **at most one refresh operation per refresh window is the target** (at launch bounded by roughly one per warm container; strict cross-container single-flight is a P1 follow-on). The 60-second frontend polling interval may remain a frontend behavior; it does **not** imply one Holodex request per tab per minute.

| Aspect | Requirement (no provider number, no final value) |
|---|---|
| **Shared cache** | **Required at launch (P0).** The `/live-streams` result is held in a cache that every API container can read. A per-container cache may be a first layer (L1) but is **not acceptable as the complete final design** (it bounds upstream calls only by the number of warm containers). The shared/coordinated cache mechanism is an **implementation decision** (ADR in S4 scored against: cross-container consistency, added latency, failure modes, cost at normal and abuse volume, new infrastructure/IAM needing approval, testability, rollback) — candidates include a shared store, a shared store with a conditional-write lease, a scheduled refresher that writes the cache so request handling never calls Holodex, or a hybrid; **none is selected here**. |
| **Request coalescing / single-flight** | **Launch (P0):** concurrent requests inside a container share one in-flight refresh, and the shared cache bounds duplicated refreshes across containers (at most about one per warm container per window); a failed or timed-out refresh releases its claim so the next window can retry (no deadlock). **Strict cross-container single-flight (exactly one refresh per window across all containers, via a distributed lease) is P1 — not a V1 launch blocker**; adopt it if the §23.1 metrics (coalesced-request count, upstream amplification ratio) show duplicated refreshes. |
| **Bounded refresh frequency** | A refresh happens at most once per refresh window; the window is a **configurable parameter**, selected from: the observed frontend freshness requirement, Holodex behavior, observed 429s, V1 traffic, and the acceptable Live Status delay. It is **not** derived from, or hard-coded to, the observed `80 requests / 2 minutes` figure. |
| **Fresh hit** | Cache within its fresh window → serve it; no upstream call. |
| **Stale-if-error (preferred V1 direction)** | Fresh cached result available → serve it. Cache expired but recently cached data exists **and** Holodex temporarily fails (timeout, 5xx, 429) → serve **bounded stale** data, with **internal stale metadata and logging** (the public response contract is not widened without a data-minimization review; if the frontend needs a staleness indicator that is a separate decision). No usable cached data and Holodex unavailable → the explicit upstream-unavailable response (existing `503 HOLODEX_UNAVAILABLE`). **Stale data is never silently presented as fresh**: responses served stale carry cache headers that prevent downstream caches from extending their life. The **maximum stale age is an implementation parameter** (no existing product requirement defines it; chosen with the owner from the acceptable Live Status delay — beyond it a "live" stream may already have ended). |
| **Upstream 429** | Holodex 429 → **do not retry per incoming client request** → enter a **shared cooldown/backoff state** (honoring `Retry-After` if Holodex sends one, otherwise exponential backoff with jitter up to a configured maximum) → serve eligible cached/stale data where the stale policy permits, otherwise the explicit 503 → **log and count the throttle event**. During cooldown **no upstream calls are made**; when it ends, **one coalesced probe** refresh is attempted. A bot calling `/live-streams` in a loop therefore causes **no** repeated Holodex attempts. |
| **Upstream timeout** | A bounded per-attempt timeout shorter than the route timeout, so a stuck upstream cannot pin Lambda concurrency; a timeout counts as an upstream error and follows the same stale/backoff path. |
| **Retries and backoff** | Retries, if any, happen **inside the single refresh operation**, never per client request; capped attempts (a configurable small number, possibly zero), **exponential backoff with jitter**, a hard total deadline, and a ceiling on cooldown growth — **no unbounded retry loop anywhere**. |
| **Other Holodex-backed routes** | Any other Holodex-backed route that stays live is retired or given the same treatment (SEC-API-011). |

**Metrics required before tuning** (emitted from the API; no numeric thresholds are fixed until real data exists):

| Metric | Purpose |
|---|---|
| `/live-streams` client request count | denominator of the amplification ratio |
| cache hit count / cache miss count | cache effectiveness |
| upstream Holodex call count | numerator of the amplification ratio |
| upstream 429 count | throttle events (also alarmed on repetition) |
| upstream timeout/error count | dependency health |
| coalesced-request count | proves single-flight works |
| stale-response count (and stale age) | how often/long stale data is served |
| refresh latency | detects a slow upstream before it pins concurrency |
| cooldown entries/durations | backoff behavior |

**Upstream amplification ratio = Holodex upstream calls ÷ Yobi `/live-streams` requests.** Target: **far below 1 during normal multi-client operation** — deliberately not a fabricated numeric SLA. The refresh window, stale bound, cooldown limits and retry cap are tuned from these metrics after launch.

**Architecture decision vs provider tuning input.** The architecture (decoupling, shared cache, single-flight, bounded refresh, stale-if-error, shared cooldown, bounded retries, metrics) is **decided**. The exact Holodex provider quota is a **tuning input** and stays `UNVERIFIED` without blocking V1.

## 24. Scraping / bot / abuse protection

**Policy (SEC-API-BOT-001):** direct API clients that do not present a valid application attestation (and, once SEC-API-BOT-003 ships, a valid application session) are rejected — **at V1 launch the enforced layers are App Check and route throttling only; layers 2–4 ship after launch;** frontend interaction telemetry is never proof of humanity; request patterns inconsistent with legitimate UI behavior are detected and throttled; repeated automated requests are blocked or throttled **regardless of intent**.

**Five layers** (each independently testable; none is sufficient alone):

| # | Layer | What it establishes | What it does *not* establish | Control |
|---|---|---|---|---|
| 1 | **Firebase App Check** (provider-attested token, verified in the Lambda against cached JWKS) | The request came from an app instance of *this* Firebase app that passed the configured provider check | A human; that the instance is not scripted/farmed; intent | SEC-API-BOT-002 (P0) |
| 2 | **Short-lived Yobi anonymous session** (backend-minted after a valid App Check token; HMAC-signed; ≈ 15–30 min; anonymous; independent of `clientId`) | A bounded, rate-limitable identity to attach budgets to; forces automation to keep obtaining attestation | Identity of a person; resistance to a client that keeps re-minting | SEC-API-BOT-003 (**P1** — ships later with BOT-004) |
| 3 | **Per-session / per-IP, endpoint-specific rate limiting** | A hard budget per credential and per source for each route class, tuned to what the UI can actually do (e.g. the UI polls `/live-streams` once per 60 s) | Anything about distributed low-rate sources behind many IPs | SEC-API-BOT-004 (P1) |
| 4 | **Behavioral anomaly scoring** (server-side signals only, explainable, log-only first) | Patterns the UI cannot produce: creator-ID walks, offset walking, rates above UI maximums, many sessions per IP / many IPs per token, unique-query ratio, 4xx ratio, missing bootstrap sequence | Anything from frontend telemetry (never an input of trust) | SEC-API-BOT-005 (P2) |
| 5 | **API Gateway route throttling** | The outer rate ceiling per route (and the emergency-response procedure behind it) | Per-client fairness | SEC-API-003 (P0) |

Rules:
- **Telemetry is never proof of humanity.** The frontend may send no "interaction" signal that any backend decision treats as trust. (If ever collected for UX analytics it is data, not authorization, and must not appear in a rejection/allow path — enforced by a code-review check and a test that no auth/limit code path reads such fields.)
- **No intent-based exceptions.** A well-meaning scraper that exceeds the UI-consistent budget is throttled like any other automated client; legitimate integrations get a documented, separately credentialed route if they are ever needed (out of V1 scope).
- Rejection is cheap and early with **explicit response semantics (§13.1)**: App Check missing `403 APP_ATTESTATION_REQUIRED`, invalid `403 ATTESTATION_INVALID`, expired `403 ATTESTATION_EXPIRED`; missing session `401 SESSION_REQUIRED`, invalid `403 SESSION_INVALID`, expired `401 SESSION_EXPIRED`; over-budget `429 RATE_LIMITED` + `Retry-After`; attestation/session infrastructure failure `503 ATTESTATION_UNAVAILABLE`/`SESSION_UNAVAILABLE`; genuine backend failure stays 500/503 with its existing codes and is never reported as an auth or rate-limit response. All rejections happen **before** any S3/DynamoDB/Holodex call.
- Throttle/deny actions from scoring are **temporary** (TTL), logged with the reason class, and start in **log-only** mode for at least two weeks of real traffic before they act (false-positive risk: shared NAT in a community, mobile roaming).
- Layer 1 is deliberately *not* treated as a hard bot wall: a farmed token is possible, which is why layers 3–5 exist and why the abuse-response procedure (alarms, emergency stop) remains the outer backstop. **Residual V1 risk until BOT-003/BOT-004 ship: a holder of a valid App Check token is bounded primarily by route throttling.**
- Public analytics stay public; unmetered anonymous scraping is not allowed.
- Detection signals to log and alarm on: single-IP request share, 401/403 ratio by reason, session-mint rate per IP, unique-query-string ratio, 429 volume (SEC-LOG-001).
- No CAPTCHA/Bot Control product beyond what the App Check provider itself does (cost, UX); revisit with the §19 triggers.
- **Conditional, free, supplementary IP intelligence (V1 option; default OFF).** Two signals may feed the layer-4 score or tighten layer-3 budgets within bounds: (i) **GeoIP country classification** against the expected audience region(s), and (ii) **VPN / proxy / hosting-provider reputation**. They are a *supplementary defense only*: **not proof of humanity, not a gate, not a replacement for App Check, session and rate limiting**, and **never the sole basis of a block** (no automatic country bans; legitimate users travel, use VPNs, sit behind mobile carriers or a shared NAT). Constraints: free sources only for V1; lookups must be **offline/in-process** on the request path (no per-request third-party API call — latency, availability, cost and sending users' IPs to a third party); license/attribution/update obligations and the free-tier terms of any source must be reviewed before use (no vendor is endorsed here); minimal IP retention (keyed hash with TTL) and a privacy disclosure decision; log-only first. Adoption condition: the BOT-005 log-only review shows abuse concentrated in datacenter/VPN ranges or unexpected regions *and* a free source passes the license/privacy/cost review. Specified inside SEC-API-BOT-005; evaluated in §29.7b.

## 25. Logging and security monitoring

- API Gateway **access logs** (JSON: requestId, time, route, status, latency, integration error, sourceIp, user-agent hash; **no query-string values that carry identifiers, no headers**) to a CloudWatch log group with explicit retention (SEC-AWS-001, P0).
- Lambda log groups managed in Terraform with retention (e.g. 30 days) (SEC-AWS-012).
- Structured security events from the handler: admin-key failure, client-secret failure, validation-rejection class, throttled/oversized request, retired-route hit, emergency-stop events (SEC-LOG-001).
- Log hygiene: no secrets, bodies, push endpoints or full `clientId`; truncated/hashed identifiers (SEC-LOG-001).
- Access to logs is itself privileged (CloudWatch IAM).

## 26. Alerting

**Minimum launch alarms (SEC-AWS-004, P0):** API Gateway 5xx rate, API Lambda errors, and an API 429/throttling signal — delivered through the existing SNS/email path. **P1 (carried by SEC-AWS-011):** duration p95 near timeout, concurrent executions ≥ 80 % of reserved, DynamoDB throttles/system errors, per-IP concentration, admin-auth failures, Holodex error rate, S3 request anomaly, Cost Anomaly Detection. Billing thresholds are chosen later per A9 (the $5 operating target is not an automatic cutoff). Each alarm has an owner action in the runbook.

## 27. Incident handling

Runbook (SEC-OPS-001, minimal P0 version): (1) **Contain** — emergency stop or tighten route throttles; (2) **Assess** — access logs by IP/route/status, CloudWatch metrics, Cost Explorer; (3) **Block/limit** — WAF/CloudFront rule if present, otherwise throttle or disable the route; (4) **Rotate** — admin key / client-credential reset / Holodex key as applicable (documented; the admin key needs no deploy); (5) **Recover** — reset concurrency, verify health; (6) **Learn** — add a permanent regression test and, if needed, update this baseline. Note the T-17 trade-off: the kill switch protects the budget at the cost of availability.

## 28. Rollback requirements

- Every security change ships as a revertible unit: Terraform change (reviewed plan, previous state recoverable), Lambda artifact (previous artifact retained and its `CodeSha256` recorded — practice already exists), frontend build (previous build retained).
- Gateway/route-throttle changes roll back by re-applying the previous Terraform commit; WAF rules start in Count mode so enforcement is a separate, reversible step.
- A security change is not "done" until its rollback command has been written down next to its apply command.
- No security change may require deleting data; DynamoDB deletion protection and S3 versioning stay on.


## 29. Development security tooling

**Principle:** adopt a tool only if it covers a named threat on the *actual* Yobi stack, runs in CI at an acceptable cost, and has an owner for its findings. Nothing here is installed by this document. Each entry below is a recommendation for the corresponding S-task (§41).

Fields per tool: **Purpose · Threats covered · Where it runs · Dev/CI/pre-prod/prod · Cost · Maintenance burden · False-positive risk · Decision · Reason.**

### 29.1 Backend

**pytest** (already in use, 8.4.2)
- Purpose: unit/contract/negative tests, including the future `security` marker suite.
- Threats covered: all code-level controls (T-06…T-14, T-22) via regression tests.
- Where it runs: developer machine, CI.
- Dev/CI/pre-prod/prod: Dev ✔ · CI ✔ · pre-prod ✔ · prod ✘.
- Cost: free. Maintenance: low. False positives: none (tests are explicit).
- **Required.**
- Reason: foundation. Add a `security` marker and make PR CI always run it (SEC-CI-001); fix any test-collection errors so the full suite is trustworthy locally (SEC-TEST-005).

**pytest-cov** (coverage.py plugin)
- Purpose: measure line and **branch** coverage; per-module thresholds for security-critical modules.
- Threats covered: indirect — exposes untested security branches (auth/validation fallbacks).
- Where it runs: dev, CI (nightly full-suite; PR on security-critical modules).
- Dev ✔ · CI ✔ · pre-prod ✔ · prod ✘.
- Cost: free; adds ~10–30 % test time. Maintenance: low. False positives: none (but coverage ≠ security).
- **Required (P1).**
- Reason: coverage is not yet measured; §36 requires branch coverage on security-critical modules and a measured baseline before any threshold is set.

**pip-audit**
- Purpose: check pinned Python dependencies against known-vulnerability advisories.
- Threats covered: T-15 (vulnerable dependency).
- Where it runs: CI (PR + nightly), dev on demand.
- Dev ✔ · CI ✔ · pre-prod ✔ · prod ✘.
- Cost: free. Maintenance: low–medium (triage). False positives: low–medium (advisory in an unused code path).
- **Required (P1)** as a non-flaky gate on High/Critical (informational for the rest); a **one-time manual run** with zero unresolved High/Critical is part of the §38 pre-production gate.
- Reason: pinned dependencies must also be scanned; runtime deps include `boto3`, `pywebpush`, `google-api-python-client`, `pyarrow`.

**CodeQL (Python)**
- Purpose: semantic static analysis (injection, unsafe deserialization, path traversal, hard-coded secrets, SSRF patterns).
- Threats covered: T-07, T-10, T-12, T-13 (as regression net).
- Where it runs: GitHub code scanning (default setup in repository settings, or an advanced-setup workflow — decided in S2; none is created now).
- Dev ✘ (optional CLI) · CI/GitHub ✔ · pre-prod ✔ · prod ✘.
- Cost: **no licence cost — code scanning is available for public repositories by default (GitHub documentation; the repository is public, UD-3)**. Enablement `UNVERIFIED`; Actions-minute terms to confirm at implementation. Maintenance: low–medium. False positives: medium.
- **Required (P1)** — no longer conditional on cost.
- Reason: the codebase is small and hand-validated; CodeQL adds an independent check on exactly the input-handling code (`api_handler.py`, `read_api.py`, stores).

### 29.2 Frontend

**Vitest** (already in use, 4.1.x)
- Purpose: unit/component/contract tests, including response-allowlist and XSS-inert-render tests.
- Threats covered: T-10, T-11, T-14 (frontend side).
- Where it runs: dev, CI.
- Dev ✔ · CI ✔ · pre-prod ✔ · prod ✘. Cost: free. Maintenance: low. False positives: none.
- **Required.** Reason: foundation; new security tests must be added to the explicit CI list (or tagged) so they run.

**@vitest/coverage-v8**
- Purpose: line/branch coverage for the frontend, with thresholds on security-relevant modules (`apiClient`, `creatorRegistry`, data mappers).
- Threats covered: indirect (untested error/validation branches).
- Where it runs: dev, CI (nightly; PR on touched security modules).
- Dev ✔ · CI ✔ · pre-prod ✔ · prod ✘. Cost: free (+ run time). Maintenance: low. False positives: none.
- **Required (P1).** Reason: V8 coverage needs no instrumentation plugin and matches the existing Vitest/Vite stack. Verify the matching Vitest 4 version at adoption.

**npm audit** (`--omit=dev`)
- Purpose: known-vulnerability check of production frontend dependencies.
- Threats covered: T-15.
- Where it runs: CI (PR + nightly).
- Dev ✔ · CI ✔ · pre-prod ✔ · prod ✘. Cost: free. Maintenance: medium (transitive noise). False positives: medium (dev-only/unused paths).
- **Required (P1)** as a gate on High/Critical in production dependencies (advisory otherwise); a **one-time manual run** is part of the §38 pre-production gate.
- Reason: React/antd/recharts/gridstack are third-party code running in every visitor's browser.

**CodeQL (JavaScript/TypeScript)**
- Purpose: DOM-XSS, prototype pollution, insecure randomness, URL redirection patterns.
- Threats covered: T-11, T-10.
- Where it runs: GitHub code scanning (same setup decision as above). Dev ✘ · CI/GitHub ✔ · pre-prod ✔ · prod ✘.
- Cost: no licence cost for a public repository (as above); enablement `UNVERIFIED`. Maintenance: low–medium. False positives: medium.
- **Required (P1)** — no longer conditional on cost.
- Reason: this is a regression net as the UI grows. Pair with the lint ban (SEC-FE-008).

### 29.3 Secret scanning

**GitHub secret scanning + push protection (repository level)**
- Purpose: detect committed credentials (provider-pattern secrets) and block them at push time.
- Threats covered: T-10.
- Where it runs: GitHub-side. Dev ✘ · CI ✘ (service) · pre-prod ✔ (confirm enabled) · prod ✘.
- Cost: **no licence cost for a public repository** (GitHub documentation; UD-3). Enablement `UNVERIFIED`. Maintenance: very low. False positives: low.
- **Required (P0)** — verify and record the repository-level settings, and keep the alert queue empty before production.
- Reason: closest-to-zero effort backstop for the highest-impact failure (a leaked YouTube/Holodex/admin/VAPID/session-signing secret). **It is defense-in-depth only: it does not make a committed secret safe (§17).**

**Gitleaks**
- Purpose: regex/entropy secret scanner for the working tree and full history; custom rules (e.g. this repo's secret-name patterns).
- Threats covered: T-10.
- Where it runs: pre-commit (optional) and CI.
- Dev ✔ (optional) · CI ✔ · pre-prod ✔ · prod ✘. Cost: free. Maintenance: low–medium (allowlist upkeep). False positives: medium.
- **Deferred.** Reason: duplicative while GitHub secret scanning and push protection are available (public repository). Adopt only if GitHub's features prove insufficient (e.g. a needed pattern is not covered), or for a one-time full-history pass before production.

### 29.4 API fuzzing

**Schemathesis**
- Purpose: property-based and negative testing generated from an OpenAPI schema (finds 500s, schema violations, validation holes, response-contract drift).
- Threats covered: T-07, T-12, T-14, T-19, T-22.
- Where it runs: against the **local handler server** (`scripts/local_api_server.py`) or a staging stack; never production.
- Dev ✔ · CI ✔ (nightly, small example budget) · pre-prod ✔ · prod ✘. Cost: free. Maintenance: medium (the OpenAPI contract must be kept in sync). False positives: low–medium (first runs report real contract gaps).
- **Required (P1) once an OpenAPI contract exists.** Prerequisite: SEC-API-010 (the contract must be authored and kept honest by a route-inventory test).
- Reason: the API is small, validation is hand-written, and "no 500 on any input" is exactly the property Schemathesis is built to check.

### 29.5 Dynamic web/API security

**OWASP ZAP Automation Framework**
- Purpose: DAST — baseline passive scan of the SPA + API-scan from OpenAPI; optional active scan on an isolated target.
- Threats covered: T-11, T-14, T-21, T-07 (headers, reflection, information disclosure).
- Where it runs: Docker against local dev server / staging.
- Dev ✔ (manual) · CI ✔ (nightly baseline) · pre-prod ✔ (active) · prod ✘ (passive, single-pass, authorized only).
- Cost: free. Maintenance: medium (scan plans, alert triage). False positives: medium (baseline) – high (active).
- **Required (P1) for passive baseline + API scan; active scan only pre-prod on isolated env; production active scan Rejected.**
- Reason: verifies the *deployed header/CSP posture* and error-leakage behavior that unit tests cannot see.

### 29.6 Load / abuse simulation

**k6**
- Purpose: scripted load/abuse with thresholds and abort conditions (burst, sustained, cache-bypass, concurrent flood).
- Threats covered: T-02, T-03, T-04, T-05, T-06 (cost-amplification behavior).
- Where it runs: local server (capacity/cache behavior) and an approved staging stack (gateway/Lambda/WAF behavior).
- Dev ✔ (local) · CI ✘ (not per PR) · pre-prod ✔ (staging) · prod ✘ (separate explicit authorization only, §39).
- Cost: free tool; AWS cost only on staging (bounded by §35 limits). Maintenance: medium. False positives: low (results are numbers vs thresholds).
- **Required (P2) for local abuse simulation; Deferred for gateway/WAF validation until a staging stack exists.**
- Reason: gateway throttles, concurrency and WAF are AWS behaviors that a local server cannot reproduce; do not fake confidence from a local run.

### 29.7 AWS security controls

**API Gateway throttling**
- Purpose: bound request rate (stage default + per-route).
- Threats covered: T-01, T-02, T-06.
- Where it runs: AWS (Terraform `default_route_settings` / `route_settings`).
- Dev ✘ · CI (Terraform structure test) ✔ · pre-prod ✔ · prod ✔. Cost: free. Maintenance: low. False positives: legitimate bursts get 429 (frontend retries).
- **Required (P0, scoped).** Reason: a single global default can be both too loose for abuse on write/admin/Holodex routes and, at the extreme, too tight for the whole community online at once; route-level values must be sized from the legitimate peak (A1) with headroom.

**AWS WAF — rate-based rules**
- Purpose: per-IP request-rate limits.
- Threats covered: T-01, T-02, T-06, T-09.
- Where it runs: AWS, **requires CloudFront** (HTTP API cannot host a web ACL).
- Dev ✘ · CI ✘ · pre-prod ✔ (Count mode) · prod ✔ if adopted. Cost: fixed monthly web-ACL + rule + per-request fees — **above the current $5/month operating-cost target** (verify pricing). Maintenance: medium. False positives: shared-IP users (NAT) may be limited.
- **Deferred (conditional on the §19 triggers / SEC-AWS-005).** Reason: the only per-IP control available, but V1 (≈ 500 users, negligible normal traffic) does not justify the fixed cost and CloudFront complexity (Roadmap 5.3: paid WAF only when exposure justifies it).

**AWS managed WAF rule groups**
- Purpose: generic exploit signatures (common attacks, known-bad inputs).
- Threats covered: T-07, T-11, T-12 (defense in depth).
- Where it runs: AWS, with CloudFront. Pre-prod ✔ (Count) · prod ✔ if adopted. Cost: rule-group fees + per-request (see above). Maintenance: low–medium. False positives: medium (Count first).
- **Deferred** (same triggers). Reason: Yobi's input surface is tiny and strictly validated; the marginal benefit is low relative to cost until abuse is observed.

**Lambda reserved concurrency**
- Purpose: hard ceiling on parallel API executions (cost and downstream protection) and isolation from pipeline Lambdas.
- Threats covered: T-02, T-04, T-17 (kill switch uses it).
- Where it runs: AWS. CI ✔ (Terraform structure test) · prod ✔. Cost: free. Maintenance: low. False positives: legitimate load above the ceiling is throttled (429).
- **Required** — verify live quota headroom and write down the value's derivation (SEC-AWS-002, P1).

**CloudWatch alarms (+ access logs, metric filters)**
- Purpose: detection and the trigger for human/automated response.
- Threats covered: T-20 and detection for all.
- Where it runs: AWS (Terraform). CI ✔ (structure test) · prod ✔. Cost: small per alarm/log GB (verify). Maintenance: low–medium. False positives: tunable thresholds.
- **Required (P0 minimum set; P1 extended).**

**AWS Budgets / Cost Anomaly Detection**
- Purpose: cost visibility and emergency containment (existing: budget → SNS → emergency stop; its trigger thresholds are to be re-selected — the $5 figure is an operating-cost target, not an automatic security cutoff, A9).
- Threats covered: T-02, T-17.
- Where it runs: AWS. Prod ✔. Cost: first budgets free; anomaly detection free (verify). Maintenance: low. False positives: low.
- **Required** — verify the existing budget live; **Cost Anomaly Detection P1.** Reason: Budgets lag by hours and are not a hard cap (documented), so anomaly detection and alarms add earlier signal.

### 29.7a Application attestation (SEC-API-BOT-001) — Firebase App Check provider evaluation

Sources: Firebase documentation (App Check overview; reCAPTCHA v3 and reCAPTCHA Enterprise provider pages for web; debug-provider page; custom-backend verification page; Hosting preview-channel page) and Google's reCAPTCHA billing page (last updated 2026-09-30), fetched during this pass. Where a page did not state a number it is marked "not stated"; nothing is filled from memory. **Pricing and quota terms change — re-verify before enabling.**

**Provider: reCAPTCHA Enterprise — RECOMMENDED for Yobi V1**
- **Bot/abuse resistance:** score-based risk analysis (0.0 = high risk … 1.0 = legitimate); Firebase states Enterprise has "more security features and fraud signals than reCAPTCHA v3"; app risk threshold configurable (default 0.5). It attests a browser interaction; it is **not** proof of a human.
- **User friction:** none expected — invisible, score-based; the key must be created with the checkbox challenge **unselected**.
- **Invisible/background operation:** yes; the SDK must be told to auto-refresh (`isTokenAutoRefreshEnabled: true`) and refreshes at about half the token TTL.
- **Quota:** each token refresh triggers one assessment; App Check also has per-project request quotas that normal usage does not typically deplete; the reCAPTCHA free allowance is counted **per organization** across all its projects/sites.
- **Free allowance:** **10,000 assessments per calendar month** (Google billing page; Firebase page: "up to 10,000 assessments per month at no cost"). No billing account is required for this allowance.
- **Paid cost:** beyond 10,000/month billing must be enabled: **$8 flat for 10,001–100,000 assessments per month, then $1.00 per 1,000** (Google billing page). Without billing, requests above the limit fail with a `429 Resource Exhausted` quota error — i.e. **new App Check tokens cannot be minted and the web app is rejected by an enforcing backend until the month rolls over** (an availability failure that fails closed). **Note:** $8 would exceed the current $5/month operating-cost target — the billing posture is a deployment decision (A9, UD-2), not an architecture blocker.
- **False-positive risk:** medium-low; privacy tools, shared/low-reputation networks or unusual browsers can score low. Mitigated by monitor-first rollout. On the Spark plan only four score levels exist (0.1, 0.3, 0.7, 0.9); linking a billing account enables all 11 levels and custom thresholds (Firebase page) — but linking billing also enables the paid tier above 10,000 assessments.
- **Configuration complexity:** medium — enable the reCAPTCHA Enterprise API in Google Cloud, create a web key listing **each production domain** (Firebase: never add `localhost` to a production key; max 250 domains), register the web app in App Check, initialise the SDK with `ReCaptchaEnterpriseProvider`, watch metrics before enforcing.
- **Firebase App Check integration:** first-class and the officially recommended provider for new integrations; token TTL default **1 hour**, configurable 30 minutes–7 days.
- **Local development support:** the debug provider (App Check treats requests from `localhost` as invalid otherwise).
- **Debug-token workflow:** set `self.FIREBASE_APPCHECK_DEBUG_TOKEN = true` before initialisation, copy the generated token from the browser console, register it under Firebase console → App Check → Manage debug tokens; CI uses a token created in the console and held in the CI secret store. Firebase: keep the token private, never commit it to a public repository, never ship it in production builds, delete it immediately if compromised.
- **Production suitability for Yobi V1:** **suitable** — invisible, no fixed cost while ≤ 10,000 assessments/month, officially recommended — **conditional** on (a) a long App Check TTL (below), (b) an explicit billing posture decision, and (c) monitor-mode measurement of real assessment counts.

**Provider: reCAPTCHA v3 — NOT RECOMMENDED for a new integration (fallback only)**
- **Bot/abuse resistance:** score-based (0.0–1.0), default threshold 0.5; fewer fraud signals than Enterprise per Firebase.
- **User friction:** none (invisible; never presents a challenge).
- **Invisible/background operation:** yes.
- **Quota:** Firebase's v3 page gives no numbers ("shorter TTLs and frequent re-attestation deplete your quota faster").
- **Free allowance:** **not stated** on the Firebase v3 page; Google's billing page describes the 10,000/month allowance for reCAPTCHA keys generally — whether legacy v3 keys are metered identically is **unverified**.
- **Paid cost:** **not stated** for v3 on the Firebase page; assume the Google billing page terms if the key is Cloud-managed — **unverified**.
- **False-positive risk:** similar score-threshold behavior; fewer signals may mean weaker discrimination.
- **Configuration complexity:** lower on paper (site key + secret registered in Firebase), but reCAPTCHA keys now live in Google Cloud — **unverified** for new projects.
- **Firebase App Check integration:** `ReCaptchaV3Provider`; still documented, but Firebase says "You should use reCAPTCHA Enterprise for new integrations, and we strongly recommend that developers of apps using reCAPTCHA v3 upgrade when possible." The App Check overview page, as retrieved in this pass, listed only reCAPTCHA Enterprise for web — availability of v3 for a **new** project is therefore treated as **unverified** and not relied upon. Token TTL default 1 day (30 min–7 days).
- **Local development support:** debug provider (same).
- **Debug-token workflow:** same as above.
- **Production suitability for Yobi V1:** **not chosen**; keep only as a contingency if Enterprise were unusable. A custom attestation provider also exists in the Web SDK but is **rejected** for V1 (maintenance burden; not evaluated further).

**Decision (priority order from the owner's criteria):** (1) sufficient protection for V1 — both give invisible score-based attestation; Enterprise has more signals; (2) low/no fixed cost — Enterprise is free ≤ 10,000 assessments/month; (3) low friction — both invisible; (4) reliable Firebase support — Enterprise is the documented recommendation; (5) maintainability — one provider, one backend contract; (6) upgrade path — **both providers produce the same Firebase App Check JWT**, so the backend contract (`X-Firebase-AppCheck`, §13.1 semantics, pins on project number/app ID) does not change if the provider changes. **Decision: reCAPTCHA Enterprise.**

**Assessment budget (must stay under 10,000/month at $0).** Per open tab, tokens refresh about every TTL/2, i.e. **2/TTL_hours assessments per tab-hour**; each page load may also need a fresh token (ρ = fraction of loads that do — **unverified whether the Web SDK reuses a persisted token across loads; measure in monitor mode**). Monthly assessments A ≈ 30 × (L·ρ + H_tab · 2 / TTL_h), where H_tab = tab-hours per day (≈ 480 for N_avg = 20 tabs, *Legitimate-traffic sizing*) and L = page loads per day (assumption 200):

| App Check TTL | Refresh assessments / month (H_tab = 480) | + page loads if ρ = 1 (L = 200 → 6,000) | vs 10,000 |
|---|---|---|---|
| 1 h (Enterprise default) | 28,800 | 34,800 | **exceeds** |
| 12 h | 2,400 | 8,400 | under |
| 24 h | 1,200 | 7,200 | under |
| 7 d (maximum) | ≈ 171 | ≈ 6,171 | under |

Consequence: the **default 1-hour TTL would exceed the free allowance** with ordinary use, so the **final TTL is a deployment decision** — **24 hours is not frozen**. It is chosen (within Firebase's 30 min–7 d range) from: **actual assessment volume** measured in monitor mode; **real active-user/session behavior** (page loads, concurrent tabs, whether the SDK reuses a persisted token across loads); the **provider's free allowance** (10,000/month); the **availability impact if the allowance is exhausted** (no billing: new tokens cannot be minted and an enforcing backend rejects the app until the month rolls over); and the **security impact of a longer token lifetime** (a stolen or farmed token stays valid longer — bounded at V1 primarily by route throttling, and later by the session and per-session/IP limits). Also: **no limited-use token exchanges** (each is an extra assessment) and an alert at ~70 % of the allowance. **Billing posture (no billing = hard stop at 10,000 and fail closed, vs billing = $8 flat above 10,000) is likewise a deployment decision.** Neither is an unresolved security-architecture blocker.

**Verification path:** see SEC-API-BOT-002 (official procedure: `RS256`/`JWT`, issuer/audience from the project **number**, JWKS at `firebaseappcheck.googleapis.com/v1/jwks`, cache ≤ 6 h). Dev/CI: debug provider against a **separate non-production Firebase project/app** with fixture-signed tokens for backend tests; production forbids debug tokens. Cost/maintenance/false-positive notes per provider are above.

### 29.7b IP intelligence (conditional, free, supplementary)

**GeoIP country classification + VPN/proxy reputation (free sources only)**
- Purpose: add two weak, explainable inputs to behavioral scoring (SEC-API-BOT-005) and, within bounds, to per-source budgets (SEC-API-BOT-004).
- Threats covered: T-23, T-01 (abuse from datacenter/VPN/unexpected regions) — partially; **not** proof of humanity.
- Where it runs: inside the API Lambda from an **offline database/list** (artifact-bundled or fetched on a schedule); no per-request external call.
- Dev/CI/pre-prod/prod: Dev ✔ (fixture) · CI ✔ (fixture) · pre-prod ✔ log-only · prod ✔ only if the adoption condition is met, log-only first.
- Cost: free sources only (V1); costs are artifact size/cold start, an update process and a license/terms review — **verify before selecting**. Candidate classes (not endorsed): an offline country-level GeoIP database; a community-maintained datacenter/VPN IP list or a free-tier reputation service used only for offline refresh.
- Maintenance: medium (periodic data refresh, license compliance). False-positive risk: **high** for VPN/proxy and country signals (travelers, privacy-conscious users, carrier-grade NAT, shared community NAT) — hence supplementary and never sole-basis.
- **Deferred / conditional** (default OFF; part of SEC-API-BOT-005, not a separate control).
- Reason: free, offline and explainable, but weak and false-positive-prone; adopt only when logs show it would help, and never as a substitute for attestation, session or rate limiting. Geo-match/IP-reputation features of WAF are unavailable while WAF is deferred.

### 29.8 Other tools considered

| Tool | Decision | Reason |
|---|---|---|
| Dependabot (dependency graph + alerts + **security updates**; version updates only in a narrow scope) | **Required (P1)** | Available on all plans (public repository); covers T-15 for pip and npm; version updates are **not** enabled indiscriminately; no auto-merge; every PR passes the focused tests and normal review. |
| oxlint (already used) | **Keep** | Extend with the XSS-sink ban (SEC-FE-008). |
| Playwright (already used for e2e) | **Keep / P2 use** | Can assert response headers and CSP violations against the local server. |
| Bandit / Semgrep | **Deferred** | Overlaps CodeQL; adds false positives and upkeep for a small codebase. Revisit if CodeQL is unavailable. |
| Terraform security linters (tfsec/Checkov) | **Deferred** | Terraform surface is small; the repo's own structure tests plus review are sufficient for now. |

## 30. Static analysis

- CodeQL for Python and JavaScript/TypeScript on PRs to `develop` and on a weekly schedule (SEC-DEP-003, P1; no licence cost for a public repository; setup mode decided in S2).
- `oxlint` already gates the frontend; add rules/patterns banning HTML sinks, `eval`/`new Function`, `target="_blank"` without `rel` (SEC-FE-008).
- Python: keep type/lint conventions; add a grep/AST gate for `pickle`, `yaml.load`, `shell=True`, `eval/exec`, `os.system`, and for any `print(` of request bodies/secrets in `src/api` (SEC-LOG-001).
- Terraform: structure tests (existing style: `tests/test_terraform_*`) assert security-relevant settings (throttles present, reserved concurrency set, public-access-block, log retention) so config drift fails a test.
- Findings policy: High/Critical must be fixed or have an approved exception (§40) before merge; others are triaged within the P1 window.

## 31. Dependency vulnerability scanning

- `pip-audit -r requirements.txt` and `npm audit --omit=dev` in PR CI; fail on High/Critical with an available fix; otherwise warn (SEC-DEP-001, **P1**). Until that gate exists, a **one-time manual run** with zero unresolved High/Critical is required by the §38 gate, and Dependabot alerts (SEC-DEP-005) run in parallel.
- Nightly full run (including transitive and dev dependencies) posting a summary; Dependabot alerts and security-update PRs (SEC-DEP-005) — merged only after the focused tests and normal review.
- Known-unfixable advisories require an entry in the exception register (§40) with an expiry date.
- Lambda artifact rebuild is required after any runtime-dependency security update; the previous artifact is retained (rollback, §28).

## 32. Secret scanning

- GitHub secret scanning + push protection enabled **at the repository level** and recorded (SEC-DEP-002, P0; eligible because the repository is public, enablement `UNVERIFIED` today).
- A **build-artifact scan** of `frontend/dashboard/dist` fails CI if any key-shaped string or any `VITE_*KEY|SECRET|TOKEN` reference is present (SEC-FE-001, P0). This is a Yobi-specific control because Vite inlines `VITE_*` values.
- One-time full-history check before production — confirm zero open secret-scanning alerts (GitHub scans the whole history of a public repository) **and** a local pattern pass (`git log -p`, or Gitleaks if adopted); every hit is **rotated first**, history rewriting only if still necessary (§17); results recorded (SEC-DEP-002).
- Local hygiene: `.env`, `.env.local`, VAPID files stay git-ignored (verified today); developers/AI tooling must not read or print them.
- **The repository is public:** a committed secret is exposed the moment it is pushed; no scanner changes that (§17). Intentionally public client identifiers (Firebase web config, reCAPTCHA site key) are allow-listed by exact value in the bundle scan.

## 33. API fuzzing

- Prerequisite: OpenAPI 3 contract for the 18 live routes (SEC-API-010), kept honest by a test that fails when `api_routes`, `_ROUTES` and the contract diverge.
- Schemathesis runs against the **local handler server** with fixture data: stateful/negative modes, response-schema conformance, "no 5xx" and "no stack trace" checks; bounded examples per PR-nightly run (SEC-TEST-004, P1).
- Fuzz targets beyond HTTP: hand-written `parse_*` functions get property tests (Hypothesis, if adopted later — **Deferred**, no new dependency now) for "never raises anything but `ClientError`".
- Every crash/500 found becomes a permanent regression test (§36).
- Never run against production; against staging only with §35 limits.

## 34. DAST

- ZAP Automation Framework plans checked into the security branch: (1) **baseline** passive scan of the built SPA served locally; (2) **API scan** driven by the OpenAPI contract against the local handler server; (3) optional **active** scan on an isolated copy (pre-production only).
- Verifies: security headers/CSP (once hosting exists), cookie-less behavior, reflected content in 4xx messages, error-body leakage, CORS behavior, directory/route exposure.
- Findings feed the same triage as static analysis; accepted risks go to the exception register.
- Production: passive single-pass observation only, with explicit authorization (§39). **Active scanning of production is rejected.**

## 35. Load / abuse simulation

### 35.1 Rules

1. **Default targets:** `localhost` (handler server) → isolated test environment → explicitly approved staging. **Production is never a default target.**
2. No production load/attack simulation without a **separate, explicit, written authorization** naming scenario, window, volume and abort conditions (§39).
3. Every run has: a request budget, a duration cap, an abort-on-threshold rule, and a named person watching the cost/alarm dashboards.
4. Local runs validate *application* behavior (validation, caching, bounded work). They cannot validate API Gateway throttling, Lambda concurrency, or WAF — those require a staging stack and must be reported as `UNVERIFIED` until then.

### 35.2 Volume tiers and impact limits (apply to the matrix below)

| Tier | Volume | Allowed environments | Max AWS impact |
|---|---|---|---|
| V0 | 1 request | local, staging, production (authorized) | negligible |
| V1 | ≤ 100 requests, ≤ 2 rps | local, staging, production (authorized, daytime JST, emergency-stop/reset procedure ready) | < $0.01 |
| V2 | ≤ 5,000 requests, ≤ 20 rps, ≤ 5 min | local, staging only | staging ≤ $0.50 per run |
| V3 | ≤ 50,000 requests, ≤ 100 rps, ≤ 10 min | local, isolated staging only | staging ≤ $2 per run; abort if any budget alarm fires |
| V4 | beyond V3 | **not permitted** under this baseline | — |

Global abort conditions: any 5xx rate > 5 % outside the scenario's expectation; Lambda concurrency at reserved limit for > 60 s; DynamoDB throttle events; budget alarm at 20 %; any sign of impact on the scheduled pipeline.

### 35.3 Attack / abuse simulation matrix

Environments: **LOCAL** = `scripts/local_api_server.py` with fixture data; **STAGING** = a future approved non-production stack (does not exist yet); **PROD** = production, only where marked and authorized.

**SIM-01 — Direct API access without the UI**
- Scenario: call every public route with curl/script, no browser, no `Origin`.
- Target: all public routes. Environment: LOCAL, STAGING, PROD (V0–V1).
- Tool: curl / Python `requests` / Schemathesis. Volume: V1.
- Expected protection: public read routes answer normally; client/admin routes refuse without credentials.
- Expected result: 200 for public reads; 403 for protected routes; no data beyond the documented contract.
- Max AWS impact: < $0.01.
- Pass: contract-conformant responses; no auth bypass. Fail: any protected route succeeds without a credential, or any field outside the contract.
- Safe for production testing: **YES** (authorized, ≤ 50 requests).

**SIM-02 — Endpoint enumeration**
- Scenario: probe undeclared paths/methods, trailing slashes, case variants, `/admin/*`, `/.git`, `/openapi.json`.
- Target: gateway + handler. Environment: LOCAL, STAGING, PROD (V1).
- Tool: ZAP spider + custom wordlist, ffuf-style script. Volume: V1.
- Expected protection: unknown routes return gateway 404; retired routes 410; no framework/banner leakage.
- Expected result: 404/410/403 only, uniform bodies, no stack traces or server banners.
- Max AWS impact: < $0.01.
- Pass: no undeclared route reachable; retired routes still 410. Fail: any 5xx, any route not in the inventory answering 2xx.
- Safe for production testing: **YES** (≤ 100 requests, authorized).

**SIM-03 — Scraping**
- Scenario: crawl all creators × all read routes with realistic paging at a human-hostile but modest rate.
- Target: `/creators/{id}/videos/*`, `/oshi-status`, `/live-streams`. Environment: LOCAL, STAGING.
- Tool: k6 scenario. Volume: V2.
- Expected protection: route throttles and caching bound S3/Lambda work; scraper gets 429 beyond budget.
- Expected result: 200 within budget, 429 beyond; S3 GET count ≪ request count once caching exists.
- Max AWS impact: staging ≤ $0.50.
- Pass: S3 GETs per request ≤ cache-miss ratio target; no Lambda throttling of other routes. Fail: linear S3/Lambda growth with scraper requests.
- Safe for production testing: **NO**.

**SIM-04 — Burst request traffic**
- Scenario: 200 requests in 2 s to one cheap route.
- Target: `GET /topics` and `GET /creators/{id}/videos/recent`. Environment: STAGING (LOCAL for handler timing only).
- Tool: k6. Volume: V2.
- Expected protection: gateway burst limit, then 429; Lambda not saturated.
- Expected result: first ≈ burst-limit requests 200, remainder 429 with CORS headers intact.
- Max AWS impact: ≤ $0.10.
- Pass: 429s observed at the configured burst; no 5xx. Fail: 5xx, or throttling absent (all 200).
- Safe for production testing: **NO**.

**SIM-05 — Sustained high request rate**
- Scenario: 20 rps for 5 min mixed read routes.
- Target: all read routes. Environment: STAGING.
- Tool: k6. Volume: V2.
- Expected protection: stage/route throttle holds the rate at the configured limit; reserved concurrency never exceeds its value.
- Expected result: steady-state 2xx at ≤ configured rps, rest 429.
- Max AWS impact: ≤ $0.50.
- Pass: served rate ≤ limit; concurrency ≤ reserved; no budget alarm. Fail: served rate above limit, alarm fires.
- Safe for production testing: **NO**.

**SIM-06 — Repeated expensive endpoint requests**
- Scenario: hammer the Holodex-backed routes.
- Target: Holodex-backed routes. Environment: LOCAL with a stubbed Holodex (count calls); STAGING with Holodex stub.
- Tool: k6 + request counter on the stub. Volume: V2.
- Expected protection: shared cache + coalescing: upstream refreshes bounded by the refresh window and independent of request count (≈ one per warm container per window at launch; exactly one across containers once strict single-flight, P1, ships); zero upstream calls during an upstream cooldown; bounded retries.
- Expected result: upstream amplification ratio ≪ 1 (upstream calls depend on the refresh window, not on request volume); a simulated upstream 429 starts a shared cooldown during which requests are answered from cache/stale data or an explicit 503, with no upstream calls.
- Max AWS impact: ≤ $0.50; **zero real Holodex calls** (stub only).
- Pass: upstream calls per refresh window ≤ the configured bound independent of request count; none during cooldown; no unbounded retry loop. Fail: upstream calls ∝ request count, or any retry loop.
- Safe for production testing: **NO** (would burn the real Holodex quota).

**SIM-07 — Invalid creator IDs**
- Scenario: unknown, over-long (129+ chars), unicode, empty, path-like IDs on every `{creatorId}` route.
- Target: ranking/recent/oshi-status. Environment: LOCAL, STAGING, PROD (V1).
- Tool: Schemathesis + fixed list. Volume: V1.
- Expected protection: validation rejects before any S3/DynamoDB call.
- Expected result: 400/404 with safe message; **zero S3/Dynamo calls** (asserted by spies locally).
- Max AWS impact: < $0.01.
- Pass: all 4xx, zero data-plane calls, no id reflected unbounded. Fail: any 5xx or data-plane call.
- Safe for production testing: **YES** (≤ 50 requests).

**SIM-08 — Malformed JSON**
- Scenario: invalid JSON, wrong content type, base64 garbage, `NaN`, deeply nested, non-object bodies on every write route.
- Target: write routes. Environment: LOCAL, STAGING, PROD (V1, rejected requests write nothing).
- Tool: Schemathesis + fixed corpus. Volume: V1.
- Expected protection: `_json_body` clean 400; no write occurs.
- Expected result: 400 `Request body is not valid JSON` family; zero DynamoDB writes.
- Max AWS impact: < $0.01.
- Pass: all 400, no 5xx, no writes. Fail: 5xx or any persisted item.
- Safe for production testing: **YES** (≤ 30 requests).

**SIM-09 — Oversized query/body**
- Scenario: 8 KiB–6 MiB bodies, 8 KiB+ query strings, 100+ KB headers, very long ids.
- Target: write routes, all query-accepting routes. Environment: LOCAL, STAGING.
- Tool: k6/curl. Volume: V1–V2.
- Expected protection: gateway payload limit + application byte cap (SEC-API-002) + id length caps.
- Expected result: 413/400 (gateway or app); never a 500; Lambda duration stays small.
- Max AWS impact: ≤ $0.10.
- Pass: rejection before parse/storage; p95 duration unchanged. Fail: 500, or work proportional to body size.
- Safe for production testing: **NO** (large payloads incur cost; do V1-small only if authorized).

**SIM-10 — Unexpected HTTP methods**
- Scenario: `PATCH`, `HEAD`, `TRACE`, `OPTIONS` with odd headers, `GET` with body, `POST` on read routes.
- Target: all routes. Environment: LOCAL, STAGING, PROD (V1).
- Tool: ZAP / curl. Volume: V1.
- Expected protection: only declared method+route pairs are served.
- Expected result: 404/405/403 consistently; CORS preflight limited to allowlisted methods/headers.
- Max AWS impact: < $0.01.
- Pass: no undeclared pair returns 2xx. Fail: any 5xx or undeclared 2xx.
- Safe for production testing: **YES** (≤ 50 requests).

**SIM-11 — Query-string abuse**
- Scenario: duplicated params, array syntax, unknown params, enum case/whitespace variants, huge `limit`/`offset`, negative numbers, scientific notation.
- Target: read routes. Environment: LOCAL, STAGING.
- Tool: Schemathesis + fixed corpus. Volume: V1–V2.
- Expected protection: strict parsing; unknown params rejected (SEC-API-001); caps enforced.
- Expected result: 400 for invalid, capped result for valid-but-large; response size ≤ documented cap.
- Max AWS impact: ≤ $0.10.
- Pass: no 5xx; response size bounded; unknown params rejected. Fail: oversized response or 5xx.
- Safe for production testing: **NO**.

**SIM-12 — Cache-bypass query variation**
- Scenario: append unique random params to defeat caches (`?x=<uuid>`).
- Target: cacheable read routes. Environment: STAGING (and LOCAL for the in-Lambda cache).
- Tool: k6. Volume: V2.
- Expected protection: unknown params rejected (so variation yields 400 cheaply) and/or normalized into the cache key.
- Expected result: unique-param requests do not each trigger an S3 GET.
- Max AWS impact: ≤ $0.50.
- Pass: S3 GETs do not scale with unique params. Fail: one S3 GET per unique query string.
- Safe for production testing: **NO**.

**SIM-13 — XSS payloads**
- Scenario: payloads in ids, query values, push-subscription fields, config values, and in *upstream-shaped* titles/URLs fed to the UI.
- Target: API echo paths + frontend rendering. Environment: LOCAL (UI via Playwright/Vitest), STAGING.
- Tool: ZAP baseline + Vitest/Playwright render tests. Volume: V1.
- Expected protection: React text rendering; no sinks; (later) CSP; image/URL allowlist.
- Expected result: payload appears as inert text or is dropped; no script execution; no CSP violation.
- Max AWS impact: none (local).
- Pass: zero executions. Fail: any DOM execution.
- Safe for production testing: **NO** (stored XSS would require writes; local only).

**SIM-14 — Injection payloads**
- Scenario: NoSQL/expression, S3-key, header-injection (`\r\n`), template, and command payloads in every string input.
- Target: all inputs. Environment: LOCAL, STAGING.
- Tool: Schemathesis + fixed corpus. Volume: V1–V2.
- Expected protection: allowlist validation; parameterized SDK calls.
- Expected result: 400; no injected header; no unexpected data-plane access (spies).
- Max AWS impact: ≤ $0.10.
- Pass: all rejected or stored/echoed inert. Fail: any behavior change, 5xx, or header split.
- Safe for production testing: **NO**.

**SIM-15 — Path manipulation**
- Scenario: `../`, `%2e%2e%2f`, double-encoding, NUL, overlong UTF-8 in `{creatorId}`, `{videoId}`, `{clientId}`.
- Target: path-parameter routes. Environment: LOCAL, STAGING, PROD (V1).
- Tool: fixed corpus. Volume: V1.
- Expected protection: id regex rejects before key construction; S3 key built only from roster-checked ids.
- Expected result: 400/404; spies show **no S3 key outside** `video-ranking/…/creator=<roster id>.json`.
- Max AWS impact: < $0.01.
- Pass: no out-of-pattern S3/DynamoDB key ever requested. Fail: any request for an unexpected key.
- Safe for production testing: **YES** (≤ 50 requests).

**SIM-16 — Concurrent request flooding**
- Scenario: 500 simultaneous connections to mixed routes.
- Target: all read routes. Environment: STAGING.
- Tool: k6 (`constant-vus`). Volume: V3.
- Expected protection: gateway throttle + reserved concurrency; excess gets 429, not 5xx; pipeline Lambdas unaffected.
- Expected result: bounded executions; 429 for the rest.
- Max AWS impact: staging ≤ $2.
- Pass: concurrent executions ≤ reserved; zero impact on other Lambdas; no 5xx. Fail: 5xx storm or collector starvation.
- Safe for production testing: **NO**.

**SIM-17 — Backend/downstream amplification**
- Scenario: measure downstream calls per inbound request for every route (the cost-profile check).
- Target: all routes. Environment: LOCAL with call spies, STAGING with metrics.
- Tool: pytest spies + k6. Volume: V2.
- Expected protection: documented per-route maxima (§23) enforced.
- Expected result: observed downstream calls ≤ documented maxima.
- Max AWS impact: ≤ $0.50.
- Pass: every route within its cost-profile row. Fail: any route exceeds its documented amplification.
- Safe for production testing: **NO**.

**SIM-18 — Repeated S3/DynamoDB-heavy requests**
- Scenario: repeated large-catalog creator reads (large catalogs) and `videos/{id}/growth` probes.
- Target: S3-backed and DynamoDB-backed reads. Environment: STAGING (LOCAL for compute time).
- Tool: k6. Volume: V2.
- Expected protection: caching; response/pagination caps; throttles.
- Expected result: bytes read per request ≤ cap; cache hit ratio ≥ target after warm-up.
- Max AWS impact: ≤ $0.50.
- Pass: S3 bytes/request bounded; DynamoDB reads ≤ documented. Fail: unbounded growth with catalog size.
- Safe for production testing: **NO**.

**SIM-19 — Rate-limit bypass attempts**
- Scenario: rotate `X-Forwarded-For`, user agents and header casing; many `clientId`s; HTTP/1.1 vs HTTP/2; distributed low-rate sources.
- Target: throttles / (future) WAF rules. Environment: STAGING.
- Tool: k6 / script. Volume: V2.
- Expected protection: throttling is not keyed on spoofable headers (gateway bucket; WAF keyed on the real source IP).
- Expected result: header rotation has no effect on the limit.
- Max AWS impact: ≤ $0.50.
- Pass: limit unchanged under header rotation. Fail: limit evaded by spoofable header or per-`clientId` multiplication.
- Safe for production testing: **NO**.

**SIM-20 — Generic 500/503 handling**
- Scenario: force dependency failures with fault injection (S3 error, DynamoDB error, Holodex 429/500/garbage, secret unreadable).
- Target: handler error paths. Environment: LOCAL (moto/stubs), STAGING.
- Tool: pytest + fault-injection stubs. Volume: V0–V1.
- Expected protection: generic 5xx bodies, correct stable codes, no stack/exception text, nothing hidden (a real failure stays 5xx).
- Expected result: 500 `Internal server error`; 503 `HOLODEX_UNAVAILABLE`/`RANKING_NOT_READY`; 404 `HISTORICAL_DATA_UNAVAILABLE` only for the known set.
- Max AWS impact: none (local).
- Pass: bodies match contract; zero internals. Fail: any leaked exception text or masked failure.
- Safe for production testing: **NO** (fault injection is local/staging only; PROD observation of naturally occurring errors is allowed).

**SIM-21 — Information leakage through errors**
- Scenario: trigger each error class and diff responses/headers for internals (paths, ARNs, table names, versions, stack frames, upstream bodies).
- Target: all routes. Environment: LOCAL, STAGING, PROD (V1).
- Tool: ZAP API scan + response-diff script. Volume: V1.
- Expected protection: error contract (§13); minimal headers.
- Expected result: no internals in any body or header.
- Max AWS impact: < $0.01.
- Pass: zero leakage patterns matched. Fail: any ARN/path/stack/upstream text.
- Safe for production testing: **YES** (≤ 100 requests, authorized).

**SIM-22 — Bot-like request patterns**
- Scenario: fixed-interval polling, identical UA, no cache validators, sequential ID walks, headless-browser replays.
- Target: all read routes. Environment: STAGING.
- Tool: k6 scripts replaying patterns. Volume: V2.
- Expected protection: throttles + cache; detection signals logged (SEC-LOG-001).
- Expected result: pattern shows up in access-log analytics and triggers the P1 alarm thresholds.
- Max AWS impact: ≤ $0.50.
- Pass: the pattern is visible in logs/alarms and cost stays bounded. Fail: invisible or unbounded.
- Safe for production testing: **NO**.

**SIM-23 — Public write flood (new-client creation)**
- Scenario: the public write routes with unique random identifiers.
- Target: public write routes. Environment: LOCAL, STAGING (against a throwaway table).
- Tool: k6. Volume: V2.
- Expected protection: id format/length caps, per-route throttle, DynamoDB on-demand max-throughput, TTL on heartbeat rows (SEC-API-001/004, SEC-AWS-007, SEC-DATA-001).
- Expected result: items created ≤ the documented per-window cap; 429 beyond; table growth bounded.
- Max AWS impact: staging ≤ $0.50 (throwaway table deleted afterwards).
- Pass: item growth ≤ cap; alarm raised. Fail: unbounded item creation.
- Safe for production testing: **NO** (would create real production items).

**SIM-24 — Direct client without attestation or session**
- Scenario: call every route with no tokens, a missing App Check header, a missing session header, malformed tokens, wrong-audience/issuer/expired/not-yet-valid tokens, unsigned (`alg: none`) and wrong-algorithm tokens, and a valid session with no App Check token and vice versa (session cases apply once SEC-API-BOT-003 ships).
- Target: all routes except retired-410 and preflight. Environment: LOCAL (fixture-signed tokens, mode `enforce`), STAGING, PROD (V1, authorized).
- Tool: pytest + curl corpus. Volume: V1.
- Expected protection: rejection before any data-plane/upstream call.
- Expected result (§13.1): `403 APP_ATTESTATION_REQUIRED` (missing), `403 ATTESTATION_INVALID` (invalid), `403 ATTESTATION_EXPIRED` (expired), `401 SESSION_REQUIRED` (missing), `403 SESSION_INVALID` (invalid), `401 SESSION_EXPIRED` (expired); zero S3/DynamoDB/Holodex calls (spies); never a 5xx.
- Max AWS impact: < $0.01.
- Pass: every unattested/invalid-credential request rejected with the stable code, zero data-plane calls, no 5xx, no information beyond the code. Fail: any 2xx, any data-plane call, any verification exception surfacing as 5xx.
- Safe for production testing: **YES** (≤ 50 requests, authorized; unattested requests write nothing).

**SIM-25 — Token replay, theft and cross-use**
- Scenario: replay a valid session after expiry; use session A with App Check token B; share one App Check token across many sessions/IPs; use a session after signing-key rotation; clock-skew edges.
- Target: session and attested routes. Environment: LOCAL, STAGING.
- Tool: pytest + k6. Volume: V1–V2.
- Expected protection: expiry enforced with a small skew allowance; key-rotation supports two active keys; many-sessions-per-token and many-IPs-per-session are scored (SEC-API-BOT-005) and limited (SEC-API-BOT-004).
- Expected result: expired → `SESSION_EXPIRED` (frontend refreshes once); cross-use rejected or counted; rotation without an outage.
- Max AWS impact: ≤ $0.10.
- Pass: no accepted expired/forged session; rotation drill succeeds. Fail: any accepted forged/expired session.
- Safe for production testing: **NO**.

**SIM-26 — Headless-browser / farmed-token automation**
- Scenario: a real browser driven by script obtains valid App Check tokens and sessions, then performs UI-inconsistent patterns (rapid creator walk, offset walking, 20 req/min on `/live-streams`).
- Target: attested routes. Environment: STAGING (LOCAL with fixture tokens for the limiter logic).
- Tool: Playwright + k6. Volume: V2.
- Expected protection: layers 3–5 throttle/deny despite valid credentials; scoring flags UI-inconsistent patterns.
- Expected result: 429 beyond endpoint budgets; scoring events logged; temporary throttle applied after the log-only period.
- Max AWS impact: ≤ $0.50.
- Pass: served rate ≤ per-session budget; anomaly events visible. Fail: valid-token client exceeds UI-consistent budgets unthrottled.
- Safe for production testing: **NO**.

**SIM-27 — Session-mint flood**
- Scenario: hammer `POST /session` with a valid token, and with invalid tokens, from one IP and from many.
- Target: `POST /session`. Environment: LOCAL, STAGING.
- Tool: k6. Volume: V2.
- Expected protection: invalid tokens rejected by crypto-only checks (no DB); valid-token minting limited per IP and per App Check token; mint rate alarmed.
- Expected result: bounded sessions per window; `429 RATE_LIMITED` beyond; requests with invalid tokens are rejected by cryptographic checks with no data-plane work; limiter-state growth stays within the BOT-004 bound (R3/R4).
- Max AWS impact: ≤ $0.20.
- Pass: session creation ≤ cap; rejected requests cost no data-plane calls. Fail: unbounded minting or per-rejection DB writes.
- Safe for production testing: **NO**.

**SIM-28 — Forged "human" telemetry**
- Scenario: send crafted interaction-telemetry fields/headers (mouse paths, timings, "isHuman" flags) alongside unattested and attested requests.
- Target: all routes. Environment: LOCAL, STAGING, PROD (V0–V1).
- Tool: curl corpus + pytest. Volume: V1.
- Expected protection: telemetry is ignored by every allow/deny path.
- Expected result: unattested stays rejected; attested stays within the same budgets; no behavior change from any telemetry field.
- Max AWS impact: < $0.01.
- Pass: identical results with and without the fields. Fail: any decision changes because of client-supplied telemetry.
- Safe for production testing: **YES** (≤ 20 requests, authorized).

### 35.4 Matrix coverage rule

Every row above maps to at least one control (§Appendix A) and one automated test; a scenario that cannot be automated is a manual verification step recorded in the pre-production checklist (§38). A scenario marked `UNVERIFIED` (for example SIM-04/05/16/19 before a staging stack exists) blocks the corresponding control from being marked Verified.


## 36. Security coverage requirements

Overall line coverage is **not** the definition of "secure". Security coverage is defined by the four rules below; ordinary code-coverage targets are separate and secondary.

### 36.1 Security coverage rules (normative)

1. **100 % of security requirements are mapped to at least one verification method.** Every `SEC-*` control carries a *Verification* field naming a test, scan, alarm or manual check; **at V1 launch this rule is met by the control catalog in this document** (Appendix A). A machine-readable control register (for example `security/controls.yaml`) checked by a test that fails when a control has no verification, an unknown priority, or a referenced test that does not exist follows as **SEC-TEST-002 (P1)**.
2. **Public API routes are covered by negative/abuse/security-contract tests in two phases.** **V1 launch scope (P0, SEC-TEST-001):** a route inventory/meta-test that enumerates routes from Terraform `api_routes` and `_ROUTES` and fails on any unclassified route; **App Check negative tests across all applicable public routes**; authentication/authorization negative tests where applicable (admin key, client secret); and proof that **no route bypasses the V1 security boundary**. **P1 follow-on (same control):** the complete six-category matrix per route — (a) auth negative, (b) input-validation negative, (c) size/limit/pagination cap, (d) error-contract, (e) method-enumeration, (f) cost-profile assertion.
3. **Every security-critical branch has three tests:** a *positive* test (legitimate input passes), a *negative* test (invalid input/credential is rejected), and a *bypass attempt* (a crafted input that tries to slip past the check — e.g. header casing, unicode, encoding, duplicate params).
4. **Every security regression adds a permanent automated regression test** in the same PR as the fix, tagged `security` so it always runs (SEC-CI-001). A vulnerability fix without a test is not accepted.

### 36.2 Security-critical modules (stronger coverage expectations)

Backend: `api/api_handler.py` (auth, dispatch, error mapping), `api/read_api.py` (`parse_*`, error mapping, no-result handling), `api/heartbeat_api.py`, `api/remote_config_api.py`, `api/client_credential_api.py`, `stores/client_credential_store.py`, `notifications/push_sender.py` (subscription validation, SSRF allowlist), `ops/config.py` (secret resolution), `tracking/creator_master.py` (eligibility predicates, unavailable set).
Frontend: `shared/api/apiClient.ts`, `entities/creator/data/creatorRegistry.ts`, the `features/*/data/*.ts` mappers, `public/sw.js`.

### 36.3 Recommended numeric targets (starting values — **measure the baseline first**, then ratchet up and never lower)

| Scope | Line | Branch | Notes |
|---|---|---|---|
| Backend overall | ≥ 80 % | ≥ 70 % | Baseline unknown (measured first) — S1 measures, then fixes the numbers. |
| Frontend overall | ≥ 70 % | ≥ 60 % | Same. |
| New/changed code (diff coverage) | ≥ 90 % | ≥ 80 % | Enforced per PR once tooling exists. |
| **Security-critical modules (36.2)** | **≥ 95 %** | **≥ 90 %** | Every `if`/`except` in auth, validation and error mapping is reached by a test; uncovered security branches need a written justification. |
| Public routes with security-contract tests | **100 % of the route inventory** with App Check + auth negatives at launch; full six-category matrix P1 | n/a | Rule 2. |
| Security controls with a verification method | **100 %** | n/a | Rule 1. |

### 36.4 Framework mapping

**OWASP ASVS 5.0 — chapter applicability (target Level 2).** Chapter names per ASVS 5.0; requirement-level mapping is a task for S1 against the official text.

| ASVS 5.0 chapter | Applies to Yobi? | Mapping / reason | Controls |
|---|---|---|---|
| V1 Encoding and Sanitization | **Yes** | React text rendering, JSON output encoding, log encoding | SEC-FE-006, SEC-FE-008, SEC-LOG-001 |
| V2 Validation and Business Logic | **Yes (core)** | Allowlist validation, size caps, **anti-automation of unauthenticated flows (attestation, session, per-client limits, scoring)** | SEC-API-001/002/004, SEC-API-BOT-001…005 |
| V3 Web Frontend Security | **Yes** | CSP, headers, third-party content, no secrets in bundle, storage use | SEC-FE-001…008 |
| V4 API and Web Service | **Yes (core)** | Route inventory, schema, method restrictions, error contract | SEC-API-*, SEC-TEST-001 |
| V5 File Handling | **N/A** | No user file upload/download; S3 is server-side only (revisit if uploads appear) | — |
| V6 Authentication | **Partial** | No user accounts by design; authenticators are the admin key, the client credential, and the **application attestation + anonymous session** (device/app authentication, not user identity) | SEC-API-008, SEC-API-013, SEC-API-BOT-002/003 |
| V7 Session Management | **Partial (rev 2)** | No cookies or server-side user sessions; a **short-lived anonymous API session token** is introduced by SEC-API-BOT-003 (expiry, signing-key rotation, no identity, rate-limit anchor) | SEC-API-BOT-003 |
| V8 Authorization | **Yes** | Client-scoped and admin function-level authorization; BOLA on `clientId` routes | SEC-TEST-001, SEC-API-013 |
| V9 Self-contained Tokens | **N/A** | No JWT/bearer tokens issued | — |
| V10 OAuth and OIDC | **N/A** | No OAuth/OIDC flows | — |
| V11 Cryptography | **Partial** | Secret generation (`secrets`), SHA-256 of 256-bit random secrets, AWS-managed encryption at rest, TLS by platform; no custom crypto | SEC-API-013, SEC-AWS-010 |
| V12 Secure Communication | **Yes** | TLS everywhere, HSTS, TLS-only S3 policy | SEC-FE-002, SEC-AWS-010 |
| V13 Configuration | **Yes** | Secrets management, throttles/concurrency, build/dependency hygiene | SEC-DEP-*, SEC-AWS-* |
| V14 Data Protection | **Yes** | Data classification, minimization, push-subscription handling, retention | SEC-FE-004, SEC-DATA-* |
| V15 Secure Coding and Architecture | **Yes** | Trust boundaries, dependency/supply-chain, safe handling of upstream data | §4, SEC-DEP-*, SEC-API-005 |
| V16 Security Logging and Error Handling | **Yes** | Access logs, security events, error contract, no sensitive data in logs | SEC-AWS-001, SEC-LOG-001, SEC-API-006 |
| V17 WebRTC | **N/A** | No WebRTC | — |

**OWASP API Security Top 10 (2023).**

| Item | Relevance to Yobi | Controls |
|---|---|---|
| API1 Broken Object Level Authorization | Only `clientId`-scoped routes; mitigated by client secret | SEC-TEST-001, SEC-API-013 |
| API2 Broken Authentication | Admin key, client credential issuance (first-claimant), **attestation/session handling** | SEC-API-008, SEC-API-013, SEC-API-BOT-002/003 |
| API3 Broken Object Property Level Authorization | Over-exposed response fields; opaque remote-config value | SEC-FE-004, SEC-API-002 |
| API4 Unrestricted Resource Consumption | **Abuse-driven cost** and **Holodex exhaustion** (legitimate traffic cost is assumed negligible, A3) | SEC-API-003/004/005/009, SEC-API-BOT-004, SEC-AWS-002/004/007 |
| API5 Broken Function Level Authorization | Admin vs public routes | SEC-TEST-001, SEC-API-008 |
| API6 Unrestricted Access to Sensitive Business Flows | Credential/heartbeat/session creation floods; automated scraping | SEC-API-004, SEC-API-BOT-001…005 |
| API7 Server Side Request Forgery | Push endpoint (allowlisted) | SEC-TEST-001 (regression) |
| API8 Security Misconfiguration | Headers, CORS, logging, IAM, retention | SEC-FE-002, SEC-API-007, SEC-AWS-* |
| API9 Improper Inventory Management | Retired/legacy routes, no OpenAPI | SEC-API-010, SEC-API-011, SEC-TEST-001 |
| API10 Unsafe Consumption of APIs | Holodex/YouTube responses | SEC-API-005, SEC-TEST-001 |

## 37. CI security gates

Current CI (`pr-ci.yml`) runs explicit file lists only. Proposed layers (none implemented by this document):

| Layer | When | Checks | Blocking? | Controls |
|---|---|---|---|---|
| **Per-commit fast** (pre-commit hook / local, optional) | before commit | lint, typecheck on touched files, secret-pattern check on staged diff, route-inventory test | Local advisory | SEC-DEP-002, SEC-TEST-001 |
| **PR checks** (required) | every PR to `develop` | existing focused tests + **`security`-marked suite always runs** (SEC-CI-001); frontend **dist secret scan** (SEC-FE-001); Terraform structure tests (throttles, concurrency, log retention); **route inventory meta-test + App Check/auth negative tests** (SEC-TEST-001, launch scope). *Post-launch (P1) additions:* `pip-audit`/`npm audit` gates (SEC-DEP-001), traceability check (SEC-TEST-002), the complete route matrix, diff-coverage on security-critical modules | **Yes** | SEC-CI-001, SEC-FE-001, SEC-TEST-001 |
| **PR checks** (informational → blocking later) | every PR | CodeQL; coverage report with thresholds on security-critical modules | Advisory first, blocking after baseline | SEC-DEP-003, SEC-TEST-003 |
| **Nightly / deeper** | scheduled | full backend + frontend suites with coverage; Schemathesis against local handler server; ZAP baseline + API scan; full dependency audit (incl. transitive/dev); Dependabot PRs | Opens issues; breaks a status badge | SEC-CI-002, SEC-TEST-004/006 |
| **Pre-production** | before any production release | all P0 controls verified with evidence; ZAP active scan on isolated stack; staging abuse simulations SIM-04/05/16/19/23 (if a staging stack exists, else recorded as risk); one-time history secret scan; header/CSP verification on the real host | **Yes (release gate)** | §38 |
| **Manual security verification** | pre-production and after major change | IAM review (live policies vs repo records), budget/kill-switch drill, secret rotation drill, alarm test-fire, access-log review | Sign-off recorded | SEC-AWS-003/004, SEC-OPS-001 |

Rules: a failing blocking gate cannot be merged around without an approved exception (§40). The workflow keeps `permissions: contents: read` and `persist-credentials: false`; new security jobs inherit that and never receive AWS credentials (CI performs no deploys).

## 38. Pre-production security gates

Production release requires **all** of the following, each with recorded evidence (log, report, screenshot, or commit):

1. Every **P0** control in Appendix A is `Verified` (or has an approved, unexpired exception).
2. `security`-marked backend and frontend suites pass; the route inventory meta-test passes with App Check/auth negative tests on every applicable route and proof that no route bypasses the V1 security boundary (the traceability check and full route matrix are P1).
3. A **one-time manual** `pip-audit` and `npm audit --omit=dev` run: zero unresolved High/Critical (the CI gate, SEC-DEP-001, is P1).
4. GitHub secret scanning + push protection **confirmed enabled at the repository level** (evidence recorded — currently `UNVERIFIED`), Dependabot alerts/security updates and CodeQL confirmed enabled or an approved exception, **zero open secret-scanning alerts**, and the full-history check clean (every hit rotated first).
5. Frontend `dist/` contains no secret-shaped strings or `VITE_*KEY|SECRET|TOKEN` references; unused secret-reading frontend code removed.
6. Abuse-oriented throttles (write, admin, Holodex-backed routes), the `/live-streams` upstream protection (shared cache, coalescing, bounded refresh, stale-if-error, 429/timeout handling), and the cost profile for every public route are in Terraform/code and covered by tests; throttle values are justified against the legitimate peak (A1). (Live quota verification, SEC-AWS-002, is P1.)
7. API Gateway access logs and the **minimum launch alarms** (API 5xx, Lambda errors, 429/throttling signal) are live; an alarm was test-fired and reached the owner.
8. Kill switch drilled: emergency stop triggers, **reset runbook executed**, API restored.
9. The V1 edge decision (no CloudFront/WAF) and its re-evaluation triggers (SEC-AWS-005, P1) are recorded in this baseline; if CloudFront/WAF is later adopted, WAF must have run in Count mode with a reviewed false-positive report.
10. The **P0 header subset** (frame protection, `nosniff`, verified HSTS, `index.html` no-cache, service-worker cache policy) is verified on the real **Firebase Hosting** site with a header scan; CSP at least in Report-Only (P1); production CORS lists only the Firebase production origin(s) and the attestation headers.
11. Live IAM policies exported and reviewed; a written statement of the API role's actual permissions exists.
12. Rollback commands recorded next to each apply command; previous Lambda artifact and frontend build retained.
13. Abuse simulations that can run locally have passed; simulations that need a staging stack are either passed or listed as accepted risk with the cost ceiling that bounds them.
14. Open exceptions reviewed; none expired.
15. **App Check is in `enforce` mode in production** (monitor-only is not acceptable at launch); the attestation-mode setting is covered by a config/Terraform structure test that fails if production is not `enforce`; SIM-24 (App Check cases) and SIM-28 pass against the production-like stack. (The session signing-key rotation drill and session cases apply when SEC-API-BOT-003 ships.)

## 39. Production attack-test restrictions

1. **Default:** attack, fuzz, DAST-active and load tests run on `localhost`, an isolated test environment, or an explicitly approved staging environment. **Never on production by default.**
2. A production test needs a **separate, explicit, written authorization** from the owner naming: scenario ID (§35.3), exact target routes, time window (JST daytime, owner present), maximum request count and rate (≤ V1 unless explicitly stated), source IP(s), abort conditions, and the person watching dashboards.
3. Hard limits even when authorized: ≤ 100 requests per scenario, ≤ 2 rps, single source IP, read-only routes plus rejected-before-write negative cases; **no** flood/concurrency/cache-bypass/scraping/write-creation tests; **no** fault injection; **no** testing of Holodex-backed routes beyond V0 (shared upstream quota).
4. The emergency-stop/reset procedure must be ready and the alarm state checked before starting; any abort condition ends the run immediately.
5. Findings from production observation are reproduced on local/staging before fixes are written.
6. A production test never uses real client credentials, the admin key, or another person's `clientId`.
7. Logs of the test (requests sent, times, source IP) are kept so the activity can be distinguished from a real attack in access logs.

## 40. Security exception process

1. **Register:** every exception is an entry in `security/exceptions.yaml` (SEC-OPS-003) with: control ID, what is not met, reason, compensating control, risk owner, approver, date approved, **expiry date (max 90 days; P0 exceptions max 30 days)**, link to the follow-up task.
2. **Who approves:** the product owner; a P0 exception additionally requires a written note on what the worst case costs (money, data, availability).
3. **CI enforcement:** a test fails when an exception is expired or references a non-existent control; an exception cannot silently convert a P0 into "done".
4. **Scanner suppressions** (CodeQL/audit false positives) are exceptions too: inline suppression requires a comment with the exception ID.
5. **Review cadence:** exceptions reviewed monthly and at every pre-production gate.
6. **No exception** is allowed for: committed secrets, disabled authentication on a protected route, removal of the kill switch, production attack testing without §39 authorization, or — for V1 — any desktop-client / unsupported-client exception path (UD-1 resolved: the Firebase-hosted web frontend is the only supported client).

## 41. Security implementation roadmap

Order is derived from the audit: first make security *measurable* (tests, scanners), then close the cheapest/highest-risk gaps that need no AWS change (validation, caching), then the AWS changes (each needs separate explicit approval, plan review and rollback command), then the heavier verification tools. Each task is narrow, ends in a verification gate, and keeps graduated/product logic untouched.

| Task | Name | Scope (narrow) | Controls | Verification gate | AWS change? |
|---|---|---|---|---|---|
| **S1** | Security baseline test infrastructure | `security` pytest marker; route-inventory + security-contract scaffolding (Terraform routes vs `_ROUTES`); control register + traceability check; pytest-cov/vitest-coverage **measurement only** (no thresholds yet); fix any test-collection errors; add security tests to PR CI | SEC-TEST-001/002/003/005, SEC-CI-001 | Meta-tests run in CI; baseline coverage numbers recorded; 100 % routes enumerated | No |
| **S2** | Scanning gates | `pip-audit`, `npm audit`, dist secret scan, **read and record the repository's actual GitHub security settings**, then enable/confirm secret scanning + push protection, Dependabot alerts/security updates and CodeQL (default vs advanced setup decided here) | SEC-DEP-001/002/003/005, SEC-FE-001 | Gates visible in PR CI; seeded fake secret in a test branch is caught | No |
| **S3** | API input/output hardening | Identifier regexes + length caps (clientId, appVersion, key, creatorId, videoId), unknown-param rejection, body-size cap, offset ceiling, error-echo truncation, API response headers; negative/bypass tests per route | SEC-API-001/002/006/007, SEC-TEST-001 | Route security-contract suite green; Schemathesis-style corpus rejected with 4xx and zero data-plane calls | No (backend deploy later) |
| **S3b** | Application attestation (App Check) | Firebase project + App Check (reCAPTCHA Enterprise, web) setup; in-Lambda App Check verification (cached JWKS) behind a `YOBI_ATTESTATION_MODE=off|monitor|enforce` setting; frontend token acquisition + one-shot refresh on `ATTESTATION_*` codes; stable rejection codes (§13.1); CORS header addition (`x-firebase-appcheck`); TTL and billing posture decided as **deployment decisions** from monitor-mode data; **monitor → enforce rollout** (web frontend only) | SEC-API-BOT-001/002 | SIM-24 (App Check cases)/SIM-28 pass locally with fixture tokens; monitor-mode logs show zero legitimate-UI rejections over an agreed window; production config structure test asserts `enforce` | Firebase console + **API Gateway CORS `allow_headers` change** + backend deploy; **separate approvals** |
| **S4** | Abuse guards and Holodex protection | Abuse-oriented throttles for write/admin/Holodex-backed routes sized above the legitimate peak; `/live-streams` upstream protection — shared cache, bounded refresh, stale-if-error, shared 429 cooldown, bounded timeouts/retries, metrics (availability; strict cross-container single-flight is P1); S3-read cache; retire/guard unused Holodex-backed routes; cost-profile table asserted by tests; API access logging | SEC-API-003/005/009/011, SEC-AWS-001 | Terraform structure tests; spy tests show upstream calls depend on the refresh window, not on request rate (amplification ratio ≪ 1), and none during cooldown; SIM-06/12/17/18 pass locally | **Yes** (separate approvals: plan → apply) |
| **S4b** | Session, per-session/IP limits and anomaly scoring | **Limiter ADR first** (score candidates C0–C4 against the BOT-004 criteria; no mechanism pre-selected); the short-lived Yobi anonymous session (BOT-003: mint/verify, signing-key rotation, `x-yobi-session` header, one-shot refresh) together with the chosen limiter and UI-derived average/burst budgets from real logs; behavioral scoring in log-only mode (+ optional offline IP intelligence), then temporary throttles; scoring signals are server-side only | SEC-API-BOT-003/004/005 | ADR recorded; SIM-23/25/26/27 pass; session key-rotation drill; two weeks of log-only scoring reviewed for false positives before any enforcement | New signing secret (Secrets Manager) + CORS header + possibly a table, per the chosen mechanism → **separate approvals** |
| **S5** | Monitoring, alarms and kill-switch drill | Minimum launch alarms (API 5xx, Lambda errors, 429/throttling signal; the extended alarms are P1 under SEC-AWS-011), Lambda log retention, security-event logging, emergency-stop reset runbook + drill + threshold-selection policy (the $5 target is not an automatic cutoff), incident runbook, live quota/concurrency verification | SEC-AWS-002/003/004/012, SEC-LOG-001, SEC-OPS-001 | Alarm test-fire received; kill switch triggered and reset successfully; runbook committed; quota evidence recorded | **Yes** |
| **S6** | Frontend hardening (Firebase Hosting) | `firebase.json` headers (baseline + caching), CSP Report-Only, removal of unused secret-reading code, operator-UI exposure review, image-host allowlist, XSS-sink lint ban, SW payload hardening, response-allowlist contract tests | SEC-FE-001/002/003/004/005/006/007/008 | Header scan on the real Firebase site; XSS-inert render tests; CSP report-only shows no unexpected violations | Firebase config (not AWS) |
| **S7** | CORS restriction and edge re-evaluation triggers | Restrict API CORS to the Firebase production origin(s) (+ attestation headers); record the §19 triggers and the monitoring that watches them; **CloudFront/WAF stay deferred** (implementation only if a trigger fires) | SEC-AWS-005 (triggers), SEC-AWS-009; SEC-AWS-006/015 conditional | Preflight tests; origin-list test (no `*`/localhost); triggers documented and wired to log metrics | **Yes** (API Gateway CORS change) |
| **S8** | IAM least privilege and data retention | Read-only API role, S3 TLS-only policy, DynamoDB max-throughput caps, TTL/retention for heartbeat/orphan credentials, IAM policy capture, S3 lifecycle | SEC-AWS-007/008/010/013/014, SEC-DATA-001/002 | Live policy export reviewed; role-split smoke test; throttled-write test on a throwaway table | **Yes** |
| **S9** | OpenAPI contract and API fuzzing | Author OpenAPI for the live routes + inventory test; Schemathesis against the local handler server; nightly job | SEC-API-010, SEC-TEST-004 | Contract/route parity test; Schemathesis run with zero 5xx / zero schema violations | No |
| **S10** | ZAP DAST | Baseline + API scan automation plans against local SPA/API; active scan on isolated stack | SEC-TEST-006 | ZAP reports triaged; no unaccepted Medium+ findings | No (isolated stack optional) |
| **S11** | k6 abuse simulation | Local abuse simulation scripts (SIM-03/06/09/11/12/18/22/23); staging runs only if a stack exists | SEC-TEST-007 | Results within §35.2 limits; `UNVERIFIED` items listed | Staging only |
| **S12** | Pre-production security review | Walk §38 checklist; admin-key rotation drill; exception register review | SEC-OPS-002 (P2)/003, SEC-API-008, SEC-API-013 | Signed pre-production checklist | No |


---

## Appendix A — Security control catalog

Status values: `Not started` · `Partial` (some enforcement exists today) · `Exists (verify live)` (declared in repo/docs but live state not queried) · `Verified` (evidence recorded — none yet).
"Current state" fields give the implementation **status** only; detailed pre-launch observations are intentionally not published (public repository). The *Requirement* field defines the required end state.

**Control count (derived by counting each entry's Priority field; checked against the Final summary lists): P0 = 14 · P1 = 34 · P2 = 13 · total = 61.**

**Deferred-scope register (rev 3).** A narrowed P0 control keeps its ID and its launch priority; what was deferred is carried by an existing control or is a P1 follow-on of the *same* ID (tracked in the roadmap, not an extra control, and not counted separately):

| P0 control (launch scope) | Deferred scope | Carried by |
|---|---|---|
| SEC-API-001 | unknown-query-parameter rejection on read routes | SEC-API-009 (P1) |
| SEC-API-003 | complete tuned per-route throttle matrix | P1 follow-on of SEC-API-003 (per-session/IP budgets: SEC-API-BOT-004) |
| SEC-API-005 | strict cross-container single-flight / distributed lease | P1 follow-on of SEC-API-005 |
| SEC-API-BOT-001 | layers 2–4: session, per-session/IP limiter, behavioral scoring | SEC-API-BOT-003 (P1), SEC-API-BOT-004 (P1), SEC-API-BOT-005 (P2) |
| SEC-FE-002 | `Referrer-Policy`, `Permissions-Policy`, immutable asset caching | SEC-FE-003 (P1) |
| SEC-AWS-004 | duration, concurrency and DynamoDB-throttle alarms | SEC-AWS-011 (P1) |
| SEC-TEST-001 | complete six-category route matrix | P1 follow-on of SEC-TEST-001 |
| SEC-OPS-001 | nothing — intentionally not expanded into an operations manual | — |

### A.1 API controls

#### SEC-API-001
- **ID:** SEC-API-001 — Strict identifier and field bounds (V1 launch scope)
- **Threat:** T-06, T-07, T-12 (unbounded identifiers/keys on public write routes, path/injection payloads)
- **Current state:** Partial. Pre-launch detail is intentionally not published in this public document; the Requirement defines the required end state.
- **Requirement:** **P0 launch scope:** (1) a charset+length allowlist for every identifier (clientId UUID v4; creatorId `^[a-z0-9_]{1,64}$` + roster; videoId 11-char YouTube charset; config key and appVersion bounded); (2) **field bounds on every public write route** so no unbounded string reaches the data store; (3) an **`offset` ceiling**; (4) validation runs **before any data-plane or upstream call**. **Moved to P1:** rejecting unknown query parameters on read routes is carried by SEC-API-009 (cache-key normalization).
- **Implementation candidate:** extend the existing `parse_*` functions (no new dependency); a single shared `identifiers` helper.
- **Verification:** per-route negative + bypass tests for the launch scope (unicode, encodings, duplicate params, over-length); spy tests asserting zero S3/DynamoDB/Holodex calls on rejection.
- **Attack simulation:** SIM-07, SIM-14, SIM-15, SIM-23 (SIM-11 query-string abuse is carried by SEC-API-009).
- **Monitoring:** validation-rejection counter by reason class (SEC-LOG-001).
- **Pass criteria:** all malformed identifiers/fields → 4xx with a safe message; zero data-plane calls; no 5xx.
- **Priority:** P0 (narrowed in rev 3) · **Status:** Partial

#### SEC-API-002
- **ID:** SEC-API-002 — Request body and field size caps
- **Threat:** T-06, T-07 (memory/cost/log inflation; unbounded stored values)
- **Current state:** Not started. Pre-launch detail is intentionally not published in this public document; the Requirement defines the required end state.
- **Requirement:** reject bodies above an explicit byte cap before parsing (client routes: proposal 8 KiB); cap nesting depth and string lengths; the admin remote-config value has its own documented cap; reject unknown top-level fields on typed routes. (Field bounds on the public write routes are already in SEC-API-001; this control is the generic backstop.)
- **Implementation candidate:** size check on `event["body"]` (and base64-decoded length) at the top of `_json_body`.
- **Verification:** boundary tests (cap−1, cap, cap+1), base64-inflation test, deep-nesting test.
- **Attack simulation:** SIM-08, SIM-09.
- **Monitoring:** oversized-request counter (SEC-LOG-001).
- **Pass criteria:** over-cap → 4xx before parse, no write, constant small duration.
- **Priority:** P1 (downgraded in rev 3: public write-route field bounds are in SEC-API-001, API Gateway enforces its own payload limit, the large opaque value is admin-only, and unauthenticated callers are rejected by App Check first) · **Status:** Not started

#### SEC-API-003
- **ID:** SEC-API-003 — Abuse-oriented route throttling (layer 5): minimum launch configuration; average rate and burst sized separately
- **Threat:** T-01, T-02, T-05, T-06, T-23 (abusive volume; the outer ceiling behind App Check and later the session/per-client limits; also legitimate synchronized-wave availability)
- **Current state:** Partial. Pre-launch detail is intentionally not published in this public document; the Requirement defines the required end state.
- **Requirement:** **P0 launch scope:** the minimum per-route configuration needed for (a) the **public write routes** (client liveness, client credential issuance and, when it ships, session issuance), (b) the **admin routes**, (c) the **Holodex-backed routes** (`/live-streams` and any other Holodex-backed route that stays live) and (d) any route that **materially affects shared availability** (e.g. creator-read routes if the sizing shows they can starve others). For each, **`rate` and `burst` are two separately derived values** (§20): `rate = ⌈h_r·R_avg⌉` capped by the abuse ceiling (sustained average); `burst = max(b_floor, ⌈N_sync·q − rate·w⌉)` (one wave). Not "lowest possible": legitimate users must see no 429 at normal peak or in a jittered synchronized wave; values are recorded with their inputs. **P1 follow-on (same control, after launch):** the **complete tuned per-route matrix** for every route from measured access logs (per-session/IP budgets are SEC-API-BOT-004).
- **Implementation candidate:** Terraform `aws_apigatewayv2_stage.route_settings` for the launch route set; client jitter on polls/page-load requests (frontend); values revisited from access logs after launch (SEC-AWS-001).
- **Verification:** Terraform structure test asserting the launch route set has explicit `rate` **and** `burst` within documented formula-derived ranges; a test that the polling clients apply jitter; staging burst/sustained simulations (SIM-04/05) when a stage exists.
- **Attack simulation:** SIM-03, SIM-04, SIM-05, SIM-16, SIM-19.
- **Monitoring:** `Throttle`/429 count alarm (SEC-AWS-004); 429 share during known waves.
- **Pass criteria:** sustained served rate ≤ configured `rate` on the launch routes; a synchronized wave of N_sync tabs (jittered) is fully served; excess abuse gets 429; legitimate-peak simulation sees no 429.
- **Priority:** P0 (narrowed in rev 3; P1 follow-on for the complete matrix) · **Status:** Partial

#### SEC-API-004
- **ID:** SEC-API-004 — Growth bounds on public write routes
- **Threat:** T-06 (unbounded data-store item creation via public write routes)
- **Current state:** Not started. Pre-launch detail is intentionally not published in this public document; the Requirement defines the required end state.
- **Requirement:** item growth per window is bounded by App Check (SEC-API-BOT-001/002; the session, BOT-003, later), per-session/IP limits (SEC-API-BOT-004, P1), the write-route throttle (SEC-API-003) and — for the residual — DynamoDB max-throughput and TTL (SEC-AWS-007, SEC-DATA-001); growth is alarmed.
- **Implementation candidate:** on-demand max throughput + TTL; optional per-IP rule only if a §19 trigger fires.
- **Verification:** throwaway-table flood test (SIM-23); structure tests for capacity settings.
- **Attack simulation:** SIM-23, SIM-27.
- **Monitoring:** DynamoDB consumed-write alarm; new-item rate metric.
- **Pass criteria:** items created per window ≤ documented cap; alarm fires above it.
- **Priority:** P1 (downgraded in rev 2: abuse-only, the P0 front-line controls are BOT-001/002 and API-001/003) · **Status:** Not started

#### SEC-API-005
- **ID:** SEC-API-005 — `/live-streams` upstream protection (availability / third-party exhaustion): shared cache, stale-if-error, shared 429 cooldown, bounded timeouts/retries, metrics
- **Threat:** T-04 (client volume maps 1:1 onto Holodex upstream volume, so open tabs or a bot can exhaust the shared upstream dependency and take Live Status down). **Classified as an availability / third-party-dependency risk, not an AWS cost risk (A5).** The exact Holodex quota is unverified and is **not** needed by this control; the only evidence is one observed 429 on `/videos`.
- **Current state:** Not started. Pre-launch detail is intentionally not published in this public document; the Requirement defines the required end state.
- **Requirement:** implement the §23.1 model. **P0 launch scope:** (1) a **shared/coordinated cache layer** readable by every container — a purely per-container cache is **not acceptable as the complete final design** (it may serve as an L1 in front); mechanism chosen by ADR; (2) a **configurable refresh window** (chosen from freshness need, Holodex behavior, observed 429s, V1 traffic and acceptable Live Status delay — never hard-coded to the observed figure); (3) **stale-if-error**: fresh → serve; expired + recent data + temporary failure → serve **bounded stale** with internal stale metadata/logging; no usable data → explicit `503 HOLODEX_UNAVAILABLE`; stale never presented as fresh; the max stale age is a parameter; (4) a **shared 429 cooldown/backoff** (honor `Retry-After`, else exponential backoff with jitter, capped; serve eligible cached/stale data; log and count the event; one probe on exit) and **no per-client upstream retries**; (5) **bounded timeouts** (shorter than the route timeout) and **bounded retries** only inside the single refresh operation (capped, exponential backoff with jitter, hard deadline, no unbounded loop); (6) the **§23.1 metrics**, including the upstream amplification ratio (target far below 1 in normal multi-client operation). **P1 follow-on (same control, after launch): strict cross-container single-flight / distributed lease** (exactly one refresh per window across all containers) — **not a V1 launch blocker**; launch coalescing is within-container plus the shared cache bound (§23.1).
- **Implementation candidate:** decided by an ADR in S4 against the §23.1 criteria (shared store; shared store + lease; scheduled refresher; hybrid) — none pre-selected, but the chosen design must include a shared/coordinated layer; the existing single Holodex client wrapper is the only place upstream calls are made.
- **Verification:** unit/integration tests with a counting, fault-injecting Holodex stub: multi-container-like concurrent requests → upstream calls bounded by the refresh window, not by request count; fresh hit; stale-if-error; no-data → 503; 429 → cooldown with zero upstream calls and a single probe at exit; timeout path; retry cap and backoff schedule with an injected clock; a bot-loop test (thousands of requests → bounded upstream calls); a test that the refresh window comes from configuration and no provider-limit constant exists in code.
- **Attack simulation:** SIM-06, SIM-17.
- **Monitoring:** the §23.1 metrics (client requests, cache hits/misses, upstream calls, upstream 429s, timeouts/errors, coalesced requests, stale responses, refresh latency, cooldowns) and the amplification ratio; alarm on repeated upstream 429s and on a rising ratio.
- **Pass criteria:** upstream amplification ratio far below 1 under multi-client load; upstream calls independent of inbound request rate and zero during cooldown; no data fabricated and stale never reported as fresh; real failures still 503; no unbounded retry loop; passes with **any** provider quota (no dependency on UD-4).
- **Priority:** P0 (narrowed in rev 3; strict single-flight is a P1 follow-on) · **Status:** Not started

#### SEC-API-006
- **ID:** SEC-API-006 — Error contract and echo truncation
- **Threat:** T-14, T-07
- **Current state:** Partial. Pre-launch detail is intentionally not published in this public document; the Requirement defines the required end state.
- **Requirement:** stable `{error, code}` contract; echo truncated to 64 chars and stripped of control characters; no exception text in any 5xx; domain 404/410 codes documented.
- **Implementation candidate:** small `safe_echo()` helper used by `parse_*` messages.
- **Verification:** contract test per error class; leakage regex test over all error bodies.
- **Attack simulation:** SIM-14, SIM-20, SIM-21.
- **Monitoring:** 5xx rate alarm.
- **Pass criteria:** no internals in any body; echo ≤ 64 chars.
- **Priority:** P1 · **Status:** Partial

#### SEC-API-007
- **ID:** SEC-API-007 — API response headers
- **Threat:** T-14, T-21, T-03
- **Current state:** Not started. Pre-launch detail is intentionally not published in this public document; the Requirement defines the required end state.
- **Requirement:** every response carries `X-Content-Type-Options: nosniff` and an explicit `Cache-Control` (public short TTL for cacheable reads; `no-store` for client-scoped/admin/write responses).
- **Implementation candidate:** extend `_json_response`.
- **Verification:** header assertions across all routes; ZAP API scan.
- **Attack simulation:** SIM-21.
- **Monitoring:** none (static).
- **Pass criteria:** headers present on 2xx/4xx/5xx for all routes.
- **Priority:** P1 · **Status:** Not started

#### SEC-API-008
- **ID:** SEC-API-008 — Admin route protection and key rotation
- **Threat:** T-09
- **Current state:** Partial. Pre-launch detail is intentionally not published in this public document; the Requirement defines the required end state.
- **Requirement:** admin routes have the lowest throttle (and a WAF per-IP rule if adopted); failures are logged as security events; documented rotation procedure that needs no deploy; admin key never persisted in the browser (currently true).
- **Implementation candidate:** route throttle + `SEC-LOG-001` events + runbook.
- **Verification:** auth negative tests (missing, wrong, non-ASCII, duplicate header casing); rotation drill in S12.
- **Attack simulation:** SIM-01, SIM-19.
- **Monitoring:** admin-auth-failure alarm.
- **Pass criteria:** brute-force rate bounded; rotation completes without deploy.
- **Priority:** P1 · **Status:** Partial

#### SEC-API-009
- **ID:** SEC-API-009 — Caching for S3-backed read routes
- **Threat:** T-03, T-05, T-02
- **Current state:** Not started. Pre-launch detail is intentionally not published in this public document; the Requirement defines the required end state.
- **Requirement:** container-level TTL cache of parsed ranking objects (keyed by creator+date), bounded size; `Cache-Control` so a CDN/browser can reuse; normalized query keys so variation cannot defeat the cache; **and unknown query parameters are rejected on read routes** (moved here from SEC-API-001).
- **Implementation candidate:** small bounded LRU in `S3VideoRankingStore` reads.
- **Verification:** counting-S3 spy tests (GETs ≤ 1 per TTL per creator); memory-bound test.
- **Attack simulation:** SIM-03, SIM-12, SIM-18.
- **Monitoring:** S3 GET count; cache hit ratio.
- **Pass criteria:** S3 GETs do not scale with request count or unique query strings.
- **Priority:** P1 · **Status:** Not started

#### SEC-API-010
- **ID:** SEC-API-010 — OpenAPI contract and route inventory
- **Threat:** T-19 (undocumented routes), enables fuzzing/DAST
- **Current state:** Not started. Pre-launch detail is intentionally not published in this public document; the Requirement defines the required end state.
- **Requirement:** an OpenAPI 3 contract for the 18 live routes with auth class, schemas, limits and error codes; a test that fails if Terraform routes, `_ROUTES` and the contract differ.
- **Implementation candidate:** hand-written YAML checked into the repo (no code generation dependency).
- **Verification:** parity test; Schemathesis consumes it.
- **Attack simulation:** SIM-02.
- **Monitoring:** n/a.
- **Pass criteria:** parity test green; contract validates as OpenAPI 3.
- **Priority:** P1 · **Status:** Not started

#### SEC-API-011
- **ID:** SEC-API-011 — Retire or guard unused Holodex-backed routes
- **Threat:** T-01, T-04 (an unused public route that triggers upstream requests)
- **Current state:** Not started. Pre-launch detail is intentionally not published in this public document; the Requirement defines the required end state.
- **Requirement:** either retire it to `410` (consistent with the retired-route pattern) or give it the SEC-API-005 treatment; decision recorded.
- **Implementation candidate:** move it to the retired-route handling (keeps the route key, avoids route deletion).
- **Verification:** retired-route test; frontend grep gate.
- **Attack simulation:** SIM-02, SIM-06.
- **Monitoring:** retired-route hit counter.
- **Pass criteria:** no Holodex call from this route.
- **Priority:** P1 · **Status:** Not started

#### SEC-API-012
- **ID:** SEC-API-012 — Method and route enumeration regression tests
- **Threat:** T-19, T-01
- **Current state:** Not started. Pre-launch detail is intentionally not published in this public document; the Requirement defines the required end state.
- **Requirement:** a test asserts no route answers an undeclared method and retired routes return 410.
- **Implementation candidate:** table-driven test over Terraform routes × methods against the handler.
- **Verification:** the test itself; ZAP spider.
- **Attack simulation:** SIM-02, SIM-10.
- **Monitoring:** n/a.
- **Pass criteria:** zero undeclared 2xx.
- **Priority:** P2 · **Status:** Not started

#### SEC-API-013
- **ID:** SEC-API-013 — Client-credential model: accepted-risk record and regression
- **Threat:** T-08
- **Current state:** Partial. Pre-launch detail is intentionally not published in this public document; the Requirement defines the required end state.
- **Requirement:** write the accepted-risk record (what it protects, what it does not), keep regression tests for credential checks, revisit if per-client data becomes more sensitive.
- **Implementation candidate:** documentation + tests only.
- **Verification:** existing tests in `tests/api/test_client_credential_api.py` + cross-client negative tests.
- **Attack simulation:** SIM-01.
- **Monitoring:** client-secret-failure counter.
- **Pass criteria:** no client route succeeds with another client's secret.
- **Priority:** P2 · **Status:** Partial

#### SEC-API-BOT-001
- **ID:** SEC-API-BOT-001 — Direct clients must present application attestation; anti-automation requirement (owner-stated umbrella; V1 launch layers = App Check enforcement + route throttling)
- **Threat:** T-01, T-02, T-06, T-23 (scripted/direct clients, scraping, farmed tokens, automated flows)
- **Current state:** Not started. No claim is made that any layer is implemented; the Requirement defines the V1 end state.
- **Requirement:** *(normative principles — bind from day one)* (a) direct API clients that do not present a valid **application attestation** are rejected (and, once SEC-API-BOT-003 ships, also a valid **application session**); (b) **frontend interaction telemetry is never treated as proof of humanity** — no allow/deny/limit decision may read client-supplied "human-ness" signals; (c) the backend detects and throttles request patterns inconsistent with legitimate UI behavior (layers 3–4, after launch); (d) repeated automated requests are blocked or throttled **regardless of intent** (**no allow/deny exception is based on stated intent**). **V1 launch scope (P0): layer 1 Firebase App Check enforcement (SEC-API-BOT-002) + layer 5 API route throttling (SEC-API-003).** Layers 2–4 — the short-lived Yobi anonymous session (SEC-API-BOT-003, P1), per-session/per-IP limiting (SEC-API-BOT-004, P1) and behavioral scoring (SEC-API-BOT-005, P2) — **ship after launch; this baseline does not claim that all five layers ship at V1 launch.** Honest limit: attestation ≠ human; farmed tokens are possible; **residual V1 risk: a holder of a valid App Check token is bounded primarily by route throttling until BOT-003/BOT-004 ship.** Response semantics: §13.1.
- **Implementation candidate:** in-handler checks ordered per §10 (cheap crypto first, no data-plane work on rejection); `YOBI_ATTESTATION_MODE=off|monitor|enforce` (`off` only for the local server; production must be `enforce`, asserted by a structure test); stable rejection codes; monitor-first rollout.
- **Verification:** route security-contract tests (SEC-TEST-001, launch scope) include, for every applicable route, the missing/invalid/expired App Check negatives with spy proof of zero data-plane calls; a code-review/AST test that no auth or limiter code reads telemetry-like fields; production-mode config test.
- **Attack simulation:** SIM-24, SIM-28 at launch (SIM-25/26/27 apply when the later layers ship); plus SIM-03/05/22/23.
- **Monitoring:** 403 rate by reason code; attested-but-throttled rate; alarm on a sudden rejection spike (possible legitimate-user breakage).
- **Pass criteria:** zero 2xx for any request without a valid App Check token on a non-exempt route; zero data-plane calls on rejection; responses match §13.1; legitimate-UI flows see zero rejections in the monitor window; `enforce` live at launch (web frontend is the only supported client).
- **Scope note (UD-1, resolved for V1):** the only supported production client is the Firebase-hosted web frontend; Yobi.exe is out of V1 scope, so enforcement has **no desktop-client carve-out, exception path or compatibility design**, and Yobi.exe is not part of this control's verification or of the V1 production gate.
- **Priority:** P0 (rescoped in rev 3) · **Status:** Not started

#### SEC-API-BOT-002
- **ID:** SEC-API-BOT-002 — Firebase App Check verification (layer 1; reCAPTCHA Enterprise provider)
- **Threat:** T-01, T-23
- **Current state:** Not started. No Firebase/App Check deployment values exist in the repository (UD-2); they are supplied at implementation.
- **Requirement:** (1) The dashboard obtains App Check tokens with the **reCAPTCHA Enterprise** provider (auto-refresh explicitly enabled) and sends them in **`X-Firebase-AppCheck`** (the header Firebase's custom-backend guidance recommends). (2) The Lambda verifies, per Firebase's documented procedure: signature against the keys at `https://firebaseappcheck.googleapis.com/v1/jwks`; header algorithm `RS256` and type `JWT`; issuer `https://firebaseappcheck.googleapis.com/<PROJECT_NUMBER>`; audience containing `projects/<PROJECT_NUMBER>`; `exp` not passed; and — stricter than the optional step in the docs — **subject equals the pinned production web app ID**. The **production project number and app ID are pinned**; tokens from any other project/app (including a development project) are invalid. (3) **Response contract (§13.1):** missing token → `403 APP_ATTESTATION_REQUIRED`; invalid → `403 ATTESTATION_INVALID`; expired → `403 ATTESTATION_EXPIRED`; verification infrastructure unavailable with no trustworthy cached keys → `503 ATTESTATION_UNAVAILABLE`; valid → continue to session validation. (4) **Key cache / failure behavior (UD-5 policy):** cached signing keys with a refresh interval no longer than the documented 6-hour caching ceiling; refresh failure → keep using still-trusted cached keys inside a **bounded grace period** (duration = implementation parameter, not fixed here); cold cache and keys unavailable → fail closed 503; **never fail open**; no per-request network call on the hot path. (5) **No replay protection in V1:** Firebase documents replay protection (`consume` / limited-use tokens) as a beta feature for the Node.js Admin SDK that adds latency and needs an extra service-account role; the Yobi backend is Python, so single-use tokens are not part of V1 — replay exposure is bounded by the short Yobi session, session-mint limits (SEC-API-BOT-003/004) and route throttles. (6) **Debug tokens are accepted only for a separate non-production Firebase project/app**, never by the production verifier (the pins in (2) enforce this). (7) **App Check limitation (normative):** a valid token proves the request obtained valid app attestation; it does **not** prove a human is operating the browser and is never described or used as complete bot prevention. (8) **Primary V1 direct-client barrier**; its TTL and billing posture are **deployment decisions** (§29.7a), not architecture blockers.
- **Implementation candidate:** either the Firebase Admin SDK for Python (`app_check.verify_token`, documented as the simplest path) or manual JWT verification (PyJWT/`cryptography`) with a JWKS cache — chosen at S3b on artifact size, cold-start cost and the pins in (2); the frontend adds the Firebase JS SDK (App Check) — bundle-size impact to be measured; any new dependency is covered by SEC-DEP-001 and lockfile review. App Check token TTL is chosen to keep reCAPTCHA Enterprise assessments inside the no-cost allowance (§29.7a).
- **Verification:** unit tests with a test signing key and a fake JWKS: valid; expired; wrong audience/issuer/subject; `alg: none`; wrong algorithm; wrong `typ`; unknown `kid`; JWKS refresh/rotation; refresh-failure-within-grace; cold-cache-unavailable (503, never 2xx); grace-expired (503); bypass attempts (header casing, duplicate headers, whitespace); a test that a token from a different project number or app ID is rejected; a test that no debug-token configuration can be enabled in a production configuration.
- **Attack simulation:** SIM-24, SIM-25, SIM-26.
- **Monitoring:** verification-failure reason counters; JWKS refresh failures and grace-period usage; **reCAPTCHA Enterprise assessment usage with an alert at ~70 % of the 10,000/month no-cost allowance**; provider quota/429 errors.
- **Pass criteria:** every invalid/missing/expired token rejected with the stable code and zero data-plane calls; infrastructure outage never yields a 2xx; JWKS rotation without outage; monthly assessments stay under the allowance in monitor mode before enforcement.
- **Priority:** P0 · **Status:** Not started

#### SEC-API-BOT-003
- **ID:** SEC-API-BOT-003 — Short-lived Yobi anonymous session (layer 2)
- **Threat:** T-23, T-06 (gives a bounded, rate-limitable identity; forces automation to keep obtaining attestation)
- **Current state:** Not started.
- **Requirement:** `POST /session` (requires a valid App Check token; single-use/limited-use tokens are not part of V1, see SEC-API-BOT-002) returns a signed session `{sid, iat, exp}` valid ≈ 15–30 minutes, anonymous, **independent of `clientId`** and not bound to IP (mobile roaming), carrying a version for key rotation; signing key in Secrets Manager with two active keys during rotation; sent in `X-Yobi-Session`; the frontend recovers once per request on `SESSION_REQUIRED`/`SESSION_EXPIRED`/`SESSION_INVALID` (mint, retry once) and never loops, with the exact codes/statuses of §13.1; session mint is rate-limited per IP and per App Check token; every non-exempt route verifies the session with crypto only. The session does **not** replace `X-Client-Secret` or `X-Admin-Key`.
- **Implementation candidate:** HMAC-SHA256 token (or HS256 JWT) in the same handler; a new session-signing secret in the managed secret store (created per the existing convention, separate approval).
- **Verification:** tests for signature, expiry/skew, wrong version/key, tampering, truncated/oversized token, key-rotation overlap, clock-edge cases; the frontend refresh-once test; cost test (rejection performs zero DynamoDB/S3 calls).
- **Attack simulation:** SIM-24, SIM-25, SIM-27.
- **Monitoring:** mint rate per IP; sessions per App Check token; expiry/refresh ratios.
- **Pass criteria:** no forged/expired/tampered session accepted; rotation drill succeeds without user-visible outage; mint bounded.
- **Priority:** P1 (downgraded in rev 3: ships together with the per-session/per-IP limiter, SEC-API-BOT-004, in S4b; **residual V1 risk until then: a holder of a valid App Check token is bounded primarily by route throttling**) · **Status:** Not started

#### SEC-API-BOT-004
- **ID:** SEC-API-BOT-004 — Per-session / per-IP, endpoint-specific rate limiting (layer 3) — **security requirement and evaluation criteria; mechanism intentionally undecided**
- **Threat:** T-02, T-04, T-06, T-23 (a valid but farmed credential, or one noisy source, consuming the shared budget and starving legitimate users)
- **Current state:** Not started.
- **Requirement:** *(mechanism-independent; R1–R8)*
  - **R1** Budgets per **route class**, per session and per source IP; source IP is `requestContext.http.sourceIp` only — never a client-supplied forwarding header.
  - **R2** Budgets are derived from what the UI can actually do and expressed as an **average rate and a burst** separately (§20 formulas); draft numbers are validated against real access logs before enforcement; a jittered synchronized wave of legitimate tabs must not be limited.
  - **R3** The limiter's own state is **bounded**: an attacker cannot grow it without limit by inventing session/IP keys (cardinality cap, TTL/eviction).
  - **R4** The cost of a **rejected** request is bounded and quantified (no unbounded data-plane write per rejection); the cost of an accepted request is quantified at normal and abuse volumes.
  - **R5** Behavior under **multiple concurrent containers** and cold starts is specified (a stated accuracy bound, e.g. never more than a factor k above the budget).
  - **R6** A declared **failure mode** when the limiter's state is unavailable (fail-open with alarm vs fail-closed) with response semantics per §13.1 (fail-closed ⇒ 503, never 429).
  - **R7** Privacy: raw IPs are not retained beyond the TTL (keyed hash preferred); retention stated.
  - **R8** Observable: per-class accepted/limited counters and top-talker concentration; deterministic and unit-testable with an injected clock; feature-flagged with a monitor (log-only) phase before enforcement; reversible without a deploy where possible.
- **Implementation candidate:** **none selected.** An ADR in S4b scores candidates C0–C4 (below) against the evaluation criteria; implementation starts only after that ADR.
- **Evaluation criteria (to be scored in S4b before any implementation; each candidate is rated on each row):** accuracy under concurrency (R5) · cost per accepted and per rejected request at normal and abuse volume (R4) · added latency (p95 budget, e.g. ≤ 20 ms) · failure modes and blast radius of state loss (R6) · cold-start/state-loss behavior · state-growth bounds and poisoning resistance (R3) · operational complexity and new infrastructure/IAM that would need separate approval · testability (R8) · rollback · fit with the V1 audience and the operating-cost target.
- **Candidates to evaluate (none selected):** C0 no per-client limiter (rely on layers 1, 2, 5 and monitoring — record the residual risk); C1 process-local state only; C2 a shared external state store (DynamoDB or another service); C3 a hybrid of C1 and C2; C4 gateway-native/edge controls only (route throttling; WAF deferred). The choice is recorded as an ADR with the scored criteria.
- **Verification:** deterministic-clock unit tests per class; bypass attempts (header spoofing, session rotation, IP rotation within budget, many sessions from one IP); a spy test that rejection incurs no unbounded data-plane work (R4); the selected design's failure-mode test (R6).
- **Attack simulation:** SIM-05, SIM-19, SIM-23, SIM-26, SIM-27.
- **Monitoring:** per-class 429 counts; top-talker concentration; limiter-state size/failure alarms (once a mechanism exists).
- **Pass criteria:** a valid-token client cannot exceed UI-consistent budgets; legitimate-UI and jittered-wave simulations see no 429; the ADR exists before code.
- **Priority:** P1 (ships together with BOT-003; until then a holder of a valid App Check token is bounded primarily by route throttling, SEC-API-003) · **Status:** Not started

#### SEC-API-BOT-005
- **ID:** SEC-API-BOT-005 — Behavioral anomaly scoring (layer 4)
- **Threat:** T-23, T-01 (UI-inconsistent patterns from credentialed clients)
- **Current state:** Not started.
- **Requirement:** a deterministic, explainable, **server-side-only** scorer over signals such as: creator-ID walks (distinct creators per session per window), offset walking beyond UI depth, request rates above UI maxima, many sessions per IP / many IPs per App Check token or session, unique-query-string ratio, 4xx ratio, and a missing bootstrap sequence. **Frontend telemetry is never an input.** Actions are temporary (TTL), logged with a reason class, and start in **log-only** mode for ≥ 2 weeks of real traffic before throttling/blocking; no permanent bans. **Optional supplementary signal (conditional, default OFF, free sources only): GeoIP country classification and VPN/proxy reputation — a weighted input to the score, never a gate, never the sole basis for a block, not proof of humanity (§24, §29.7b).**
- **Implementation candidate:** deterministic scorer + structured security events (SEC-LOG-001); its state mechanism shares the open SEC-API-BOT-004 evaluation (no mechanism chosen yet); optional offline IP-intelligence lookup per §29.7b.
- **Verification:** replay fixtures of legitimate UI sessions (must score below threshold) and scripted patterns (must score above); false-positive review before enforcement; test that no telemetry-like field is read.
- **Attack simulation:** SIM-22, SIM-26, SIM-28.
- **Monitoring:** score distribution; actions taken; false-positive reports.
- **Pass criteria:** legitimate fixtures never flagged; scripted fixtures flagged; no decision depends on client telemetry.
- **Priority:** P2 · **Status:** Not started

### A.2 Frontend controls

#### SEC-FE-001
- **ID:** SEC-FE-001 — No secrets in the frontend bundle (build gate)
- **Threat:** T-10
- **Current state:** Partial. Pre-launch detail is intentionally not published in this public document; the Requirement defines the required end state.
- **Requirement:** CI fails if `dist/` contains key-shaped strings or any `VITE_*KEY|SECRET|TOKEN` reference; no `VITE_` variable may carry a secret.
- **Implementation candidate:** a small Node/grep script run after `vite build` in CI.
- **Verification:** seeded-secret negative test (the gate must fail on a fake key); gate passes on a clean build.
- **Attack simulation:** n/a (static gate).
- **Monitoring:** n/a.
- **Pass criteria:** gate fails on seeded fake secret, passes clean.
- **Priority:** P0 · **Status:** Partial

#### SEC-FE-002
- **ID:** SEC-FE-002 — Baseline security headers on Firebase Hosting (P0 launch subset)
- **Threat:** T-21
- **Current state:** Not started. The owner states the production host is Firebase Hosting; deployment values are supplied at implementation (UD-2).
- **Requirement:** **P0 launch scope:** frame protection (`frame-ancestors 'none'` via CSP when present, `X-Frame-Options: DENY` meanwhile), `X-Content-Type-Options: nosniff`, **verified** HSTS behavior (confirm what Firebase already sends; set explicitly only if missing/weaker), `no-cache`/revalidation for `index.html`, and an appropriate cache policy for the service worker `sw.js` — set in `firebase.json` and verified on the live site. **Moved to P1 (carried by SEC-FE-003):** `Referrer-Policy`, `Permissions-Policy`, and long-lived immutable caching of hashed assets.
- **Implementation candidate:** `firebase.json` → `hosting.headers`.
- **Verification:** header scan (ZAP baseline / curl assertions) against the live Firebase site before release; a repo test that parses `firebase.json` and asserts the launch-subset keys.
- **Attack simulation:** SIM-21 (headers).
- **Monitoring:** n/a.
- **Pass criteria:** the launch-subset headers are present on `index.html` and static assets; `sw.js` and `index.html` are revalidated.
- **Priority:** P0 (narrowed in rev 3) · **Status:** Not started

#### SEC-FE-003
- **ID:** SEC-FE-003 — Content Security Policy and the remaining baseline headers for Firebase Hosting (Report-Only → enforce)
- **Threat:** T-11, T-21
- **Current state:** Not started. Pre-launch detail is intentionally not published in this public document; the Requirement defines the required end state.
- **Requirement:** CSP per §16 including the exact Firebase/App Check/**reCAPTCHA Enterprise** origins derived from a real network log (not guessed); `connect-src` includes the API origin; Report-Only first, enforce after a clean observation window. **Also carries the baseline headers moved out of SEC-FE-002:** `Referrer-Policy`, `Permissions-Policy` and immutable long-lived caching of hashed assets.
- **Implementation candidate:** `firebase.json` headers + `report-to` into a log sink.
- **Verification:** Playwright check for violations on main flows (including App Check token acquisition); ZAP baseline; header scan for the added headers.
- **Attack simulation:** SIM-13, SIM-21.
- **Monitoring:** CSP violation reports.
- **Pass criteria:** zero unexpected violations over the observation window; the added headers present.
- **Priority:** P1 · **Status:** Not started

#### SEC-FE-004
- **ID:** SEC-FE-004 — Response-allowlist (data-minimization) contract tests
- **Threat:** T-14, API3
- **Current state:** Not started. Pre-launch detail is intentionally not published in this public document; the Requirement defines the required end state.
- **Requirement:** per public read route a test asserts the exact response key set and that the frontend consumes each field (or the field is removed).
- **Implementation candidate:** backend contract tests + frontend DTO type-vs-usage check.
- **Verification:** the tests; reviewed with each response change.
- **Attack simulation:** SIM-21.
- **Monitoring:** n/a.
- **Pass criteria:** adding an unreviewed field fails CI.
- **Priority:** P1 · **Status:** Not started

#### SEC-FE-005
- **ID:** SEC-FE-005 — Remove unused secret-reading frontend code; review operator-UI exposure
- **Threat:** T-10, T-09
- **Current state:** Not started. Pre-launch detail is intentionally not published in this public document; the Requirement defines the required end state.
- **Requirement:** remove unused frontend code that reads secret-bearing build variables; decide whether operator-only UI belongs in the production bundle (move behind a separate build or tool).
- **Implementation candidate:** delete the code; build flag for operator-only UI.
- **Verification:** SEC-FE-001 gate; bundle inspection.
- **Attack simulation:** SIM-02.
- **Monitoring:** n/a.
- **Pass criteria:** no secret-bearing build-variable reference; operator-UI exposure decision recorded.
- **Priority:** P1 · **Status:** Not started

#### SEC-FE-006
- **ID:** SEC-FE-006 — External image/URL allowlist
- **Threat:** T-11 (tracking pixels, mixed content, `javascript:` URLs)
- **Current state:** Not started. Pre-launch detail is intentionally not published in this public document; the Requirement defines the required end state.
- **Requirement:** only `https` URLs from an allowlisted host set are rendered; others fall back to a placeholder.
- **Implementation candidate:** one `safeImageUrl()` helper used by image components.
- **Verification:** unit tests with hostile URLs (`javascript:`, `data:`, `http:`, foreign host).
- **Attack simulation:** SIM-13.
- **Monitoring:** n/a.
- **Pass criteria:** hostile URLs never reach the DOM.
- **Priority:** P1 · **Status:** Not started

#### SEC-FE-007
- **ID:** SEC-FE-007 — Service-worker push payload hardening
- **Threat:** T-11, T-13 (indirect)
- **Current state:** Partial. Pre-launch detail is intentionally not published in this public document; the Requirement defines the required end state.
- **Requirement:** treat payload as untrusted; click may open only same-origin URLs; bounded title/body lengths.
- **Implementation candidate:** small validation in `sw.js` plus a unit test harness.
- **Verification:** service-worker unit tests with hostile payloads.
- **Attack simulation:** SIM-13.
- **Monitoring:** n/a.
- **Pass criteria:** no cross-origin navigation from a notification.
- **Priority:** P2 · **Status:** Partial

#### SEC-FE-008
- **ID:** SEC-FE-008 — Lint/grep ban on XSS sinks
- **Threat:** T-11
- **Current state:** Partial. Pre-launch detail is intentionally not published in this public document; the Requirement defines the required end state.
- **Requirement:** CI fails on `dangerouslySetInnerHTML`, `innerHTML`, `eval`, `new Function`, `document.write`, and `target="_blank"` without `rel="noopener noreferrer"`.
- **Implementation candidate:** oxlint rules and/or a grep gate.
- **Verification:** a seeded-violation test.
- **Attack simulation:** SIM-13.
- **Monitoring:** n/a.
- **Pass criteria:** seeded violation fails CI.
- **Priority:** P2 · **Status:** Partial


### A.3 AWS controls

#### SEC-AWS-001
- **ID:** SEC-AWS-001 — API Gateway access logging
- **Threat:** T-20 (no forensic trail, no abuse detection)
- **Current state:** Not started. Pre-launch detail is intentionally not published in this public document; the Requirement defines the required end state.
- **Requirement:** JSON access logs (requestId, time, route, status, latency, integrationError, sourceIp, user-agent hash; no headers, no identifier-bearing query values) into a CloudWatch log group with explicit retention (e.g. 30 days).
- **Implementation candidate:** Terraform `access_log_settings` + `aws_cloudwatch_log_group`.
- **Verification:** Terraform structure test; one real request visible in the log; no secret/identifier in the sample.
- **Attack simulation:** SIM-22 (pattern visible in logs).
- **Monitoring:** log-based metric filters feed SEC-AWS-004/011.
- **Pass criteria:** every request logged; retention set; no sensitive fields.
- **Priority:** P0 · **Status:** Not started

#### SEC-AWS-002
- **ID:** SEC-AWS-002 — Concurrency, quota and timeout validation
- **Threat:** T-02, T-04, T-17
- **Current state:** Exists (verify live). Pre-launch detail is intentionally not published in this public document; the Requirement defines the required end state.
- **Requirement:** confirm the account concurrency quota and that unreserved headroom remains for the collector/history-worker/reducer; write down the derivation of the API reserved value from the legitimate peak and the abuse ceiling; reduce the API timeout to a route-appropriate value (≤ 10–15 s).
- **Implementation candidate:** read-only AWS describe calls (approved individually) + Terraform edit.
- **Verification:** structure test asserting reserved concurrency and timeout; recorded quota evidence.
- **Attack simulation:** SIM-05, SIM-16.
- **Monitoring:** concurrent-executions alarm at ≥ 80 % of reserved.
- **Pass criteria:** pipeline Lambdas never starved; documented derivation exists.
- **Priority:** P1 (downgraded in rev 2) · **Status:** Exists (verify live)

#### SEC-AWS-003
- **ID:** SEC-AWS-003 — Emergency stop: verification, reset runbook and threshold policy
- **Threat:** T-17 (an automatic cost cutoff turning abnormal cost — or ordinary growth — into a forced outage), T-02
- **Current state:** Exists (verify live). An existing cost-based emergency-stop mechanism must be verified live. **Owner decision (A9): $5/month is the operating-cost target, not an automatic security kill-switch threshold; the existing automatic trigger is a legacy setting that must be reconciled with this policy before launch.**
- **Requirement:** verify the live state; write the reset runbook (how to restore the API, when it is safe); drill the stop-and-reset cycle; keep the deployed handler in sync with the repository copy; and **record the threshold-selection policy**: budget-alarm and emergency-stop thresholds are chosen later from **measured legitimate baseline spend, reasonable normal-growth headroom, abnormal-cost amplification detection and the emergency-response policy**, so security controls do **not** intentionally shut down legitimate production traffic merely because normal usage approaches the $5 operating target (`operating cost target != automatic attack cutoff`). **No new dollar thresholds are set by this baseline.**
- **Implementation candidate:** runbook + drill; threshold re-selection as a later, data-driven task; optional alarm→SNS path (S5).
- **Verification:** recorded drill (trigger → API throttled → reset → API healthy); the runbook states who may trigger/reset and how the thresholds were derived once they are chosen.
- **Attack simulation:** none against production; the drill is a controlled test.
- **Monitoring:** emergency-stop invocation alarm.
- **Pass criteria:** reset executed successfully within the runbook's stated time; threshold policy recorded; no automatic stop is armed at a value that ordinary expected usage can reach.
- **Priority:** P0 · **Status:** Exists (verify live)

#### SEC-AWS-004
- **ID:** SEC-AWS-004 — Minimum launch CloudWatch alarms
- **Threat:** T-20, T-02
- **Current state:** Not started. Pre-launch detail is intentionally not published in this public document; the Requirement defines the required end state.
- **Requirement:** **P0 launch scope:** exactly three alarms — **API 5xx**, **Lambda errors**, and an **API 429/throttling signal** — delivered to the existing SNS/email path. **Moved to P1 (carried by SEC-AWS-011):** duration p95 near timeout, concurrent executions ≥ 80 % of reserved, DynamoDB throttles/system errors.
- **Implementation candidate:** Terraform `aws_cloudwatch_metric_alarm` (small, fixed set).
- **Verification:** structure test; one alarm test-fired and received.
- **Attack simulation:** SIM-04, SIM-05, SIM-16 (alarms fire in staging).
- **Monitoring:** this *is* the monitoring layer.
- **Pass criteria:** each of the three alarms exists with an owner action; test-fire received.
- **Priority:** P0 (narrowed in rev 3) · **Status:** Not started

#### SEC-AWS-005
- **ID:** SEC-AWS-005 — Edge re-evaluation triggers (CloudFront/WAF deferred for V1)
- **Threat:** T-01, T-02, T-03, T-23 (only if application-layer controls prove insufficient)
- **Current state:** Partial. The V1 decision (Option A, §19) is recorded in this baseline.
- **Requirement:** keep the §19 trigger thresholds as monitored metrics (source-IP concentration, 4xx/429 ratio, emergency-stop/budget alerts, Holodex exhaustion after caching, audience size) and review them monthly and at the pre-production gate; if any fires, open an ADR with costed numbers before adopting Option B.
- **Implementation candidate:** log-derived metrics (SEC-AWS-001/011) + a short ADR template.
- **Verification:** the metrics exist and are reviewed; the pre-production checklist cites the decision.
- **Attack simulation:** SIM-22 (pattern visible in logs).
- **Monitoring:** the trigger metrics themselves.
- **Pass criteria:** thresholds recorded and measurable; no unreviewed trigger.
- **Priority:** P1 (downgraded from a P0 decision in rev 2) · **Status:** Partial

#### SEC-AWS-006
- **ID:** SEC-AWS-006 — Edge layer implementation (conditional, only if a §19 trigger fires)
- **Threat:** T-01, T-02, T-03, T-05, T-06, T-23
- **Current state:** Not started; deliberately deferred for V1 (A6).
- **Requirement:** only after a trigger and an approved ADR: CloudFront with cache policy for read routes, response-headers policy, optional origin-header check; WAF per-IP rate rules and managed rule groups in Count mode, then Block.
- **Implementation candidate:** Terraform CloudFront + WAF.
- **Verification:** Count-mode review; SIM-12/19 on staging; header scan.
- **Attack simulation:** SIM-03, SIM-12, SIM-19.
- **Monitoring:** WAF sampled requests/blocked-count metrics.
- **Pass criteria:** cache hit ratio target met; no legitimate-traffic blocks in the Count review.
- **Priority:** P2 (conditional; downgraded from P1 in rev 2) · **Status:** Not started

#### SEC-AWS-007
- **ID:** SEC-AWS-007 — DynamoDB on-demand maximum throughput
- **Threat:** T-06
- **Current state:** Not started. Pre-launch detail is intentionally not published in this public document; the Requirement defines the required end state.
- **Requirement:** set on-demand max throughput on public-write tables and size it from the §23 profile.
- **Implementation candidate:** Terraform `on_demand_throughput` (verify provider support at implementation).
- **Verification:** structure test; throttled-write behavior on a throwaway table.
- **Attack simulation:** SIM-23.
- **Monitoring:** DynamoDB `ThrottledRequests` alarm.
- **Pass criteria:** writes beyond the cap are throttled and alarmed; legitimate traffic unaffected.
- **Priority:** P1 · **Status:** Not started

#### SEC-AWS-008
- **ID:** SEC-AWS-008 — Least-privilege role split for the API Lambda
- **Threat:** T-18
- **Current state:** Partial. Pre-launch detail is intentionally not published in this public document; the Requirement defines the required end state.
- **Requirement:** a dedicated read-only role for the API Lambda (needs only: S3 read of rankings/history prefixes, DynamoDB read on VideoMaster/Snapshots plus the exact write actions the client/admin routes require on their own tables, Secrets Manager read of admin/Holodex secrets), pipeline roles separate.
- **Implementation candidate:** IAM policy documents managed per the existing convention, with the policy JSON recorded in the repository.
- **Verification:** policy review against code paths; smoke test of every route after the switch; deny-test (API role cannot write rankings).
- **Attack simulation:** n/a (design control).
- **Monitoring:** CloudTrail access-denied alarm (P2).
- **Pass criteria:** API role cannot write S3 rankings or pipeline tables; all routes still pass.
- **Priority:** P1 · **Status:** Partial

#### SEC-AWS-009
- **ID:** SEC-AWS-009 — Restrict CORS to the exact Firebase production origin(s)
- **Threat:** T-21 (hygiene only — **CORS is not authorization or bot protection**; `Origin`/`Referer`/`User-Agent` are not authentication signals)
- **Current state:** Partial. Pre-launch detail is intentionally not published in this public document; the Requirement defines the required end state.
- **Requirement:** the production API allows only the **exact Firebase production origin(s)** (§11 table) and the headers `content-type, x-admin-key, x-client-secret, x-firebase-appcheck, x-yobi-session`; no `*`, no `localhost`/`127.0.0.1`, no preview-channel origin; the set equals the production reCAPTCHA key's domain list; local development uses the local handler server; preview/staging origins are future, explicit and separate.
- **Implementation candidate:** Terraform CORS configuration, applied once the production hostname(s) are supplied.
- **Verification:** preflight tests; origin-list test (no `*`/localhost/preview); test that no code path reads `Origin`/`Referer`/`User-Agent` for a decision; browser check from the production origin.
- **Attack simulation:** SIM-10 (preflight).
- **Monitoring:** n/a (optionally log rejected-origin preflights for diagnostics only).
- **Pass criteria:** foreign origin gets no CORS grant; the Firebase production origin works; no test or document treats CORS as protection against scripts.
- **Priority:** P1 · **Status:** Partial

#### SEC-AWS-010
- **ID:** SEC-AWS-010 — S3 TLS-only bucket policy
- **Threat:** T-10 (data in transit), V12
- **Current state:** Partial. Pre-launch detail is intentionally not published in this public document; the Requirement defines the required end state.
- **Requirement:** deny non-TLS requests on both buckets.
- **Implementation candidate:** `aws_s3_bucket_policy` (must not collide with manually managed IAM policies).
- **Verification:** structure test; a non-TLS request is denied (staging bucket or policy simulator).
- **Attack simulation:** n/a.
- **Monitoring:** n/a.
- **Pass criteria:** non-TLS denied; all Lambdas unaffected.
- **Priority:** P1 · **Status:** Partial

#### SEC-AWS-011
- **ID:** SEC-AWS-011 — Cost Anomaly Detection and extended alarms
- **Threat:** T-02, T-17
- **Current state:** Not started. `UNVERIFIED-LIVE`.
- **Requirement:** enable cost anomaly detection (service-level) with the existing notification path; add per-IP concentration, admin-auth-failure, Holodex error-rate and S3 request alarms from access logs; **and the alarms moved out of SEC-AWS-004:** duration p95 near timeout, concurrent executions ≥ 80 % of reserved, DynamoDB throttles/system errors. Anomaly and budget alert thresholds are chosen per A9 (the $5 operating target is not an automatic cutoff).
- **Implementation candidate:** console/Terraform for anomaly monitor; log metric filters.
- **Verification:** alarm test-fires; anomaly monitor visible.
- **Attack simulation:** SIM-22.
- **Monitoring:** n/a (this is monitoring).
- **Pass criteria:** each signal has an alarm and an owner action.
- **Priority:** P1 · **Status:** Not started

#### SEC-AWS-012
- **ID:** SEC-AWS-012 — Lambda log-group retention
- **Threat:** T-20 (cost, privacy)
- **Current state:** Not started. Pre-launch detail is intentionally not published in this public document; the Requirement defines the required end state.
- **Requirement:** manage the Lambda log groups in Terraform with retention (e.g. 30 days).
- **Implementation candidate:** `aws_cloudwatch_log_group` per function (import existing groups first to avoid recreation).
- **Verification:** structure test.
- **Attack simulation:** n/a.
- **Monitoring:** log storage size.
- **Pass criteria:** retention set on all app Lambda log groups.
- **Priority:** P1 · **Status:** Not started

#### SEC-AWS-013
- **ID:** SEC-AWS-013 — Capture manual IAM and detect drift
- **Threat:** T-18, T-20
- **Current state:** Partial. Pre-launch detail is intentionally not published in this public document; the Requirement defines the required end state.
- **Requirement:** export live policies into the repo (read-only) and diff periodically.
- **Implementation candidate:** scripted read-only export, reviewed by a human.
- **Verification:** diff report at each pre-production gate.
- **Attack simulation:** n/a.
- **Monitoring:** n/a.
- **Pass criteria:** repo copy equals live policy at gate time.
- **Priority:** P2 · **Status:** Partial

#### SEC-AWS-014
- **ID:** SEC-AWS-014 — S3 lifecycle for noncurrent versions
- **Threat:** cost/retention hygiene
- **Current state:** Not started. Pre-launch detail is intentionally not published in this public document; the Requirement defines the required end state.
- **Requirement:** expire noncurrent versions after a defined period on high-churn prefixes.
- **Implementation candidate:** `aws_s3_bucket_lifecycle_configuration`.
- **Verification:** structure test.
- **Attack simulation:** n/a.
- **Monitoring:** bucket size metric.
- **Pass criteria:** rule present; current objects unaffected.
- **Priority:** P2 · **Status:** Not started

#### SEC-AWS-015
- **ID:** SEC-AWS-015 — Custom domain and default-endpoint lock
- **Threat:** T-01 (unmetered paths when an edge layer exists)
- **Current state:** Not started. Pre-launch detail is intentionally not published in this public document; the Requirement defines the required end state.
- **Requirement:** if an edge layer is adopted, put the API behind a custom domain, disable the default endpoint, or require an origin secret header verified in the Lambda.
- **Implementation candidate:** Terraform custom domain + `disable_execute_api_endpoint`.
- **Verification:** direct default-URL call fails; edge path works.
- **Attack simulation:** SIM-01.
- **Monitoring:** direct-endpoint hit counter.
- **Pass criteria:** no traffic bypasses the edge layer.
- **Priority:** P2 · **Status:** Not started

### A.4 Data and logging controls

#### SEC-DATA-001
- **ID:** SEC-DATA-001 — TTL/retention for heartbeat rows and orphan credentials
- **Threat:** T-06 (unbounded growth)
- **Current state:** Not started. Pre-launch detail is intentionally not published in this public document; the Requirement defines the required end state.
- **Requirement:** TTL on heartbeat rows; an expiry rule for credentials never used again (carefully — a credential row must outlive an active client).
- **Implementation candidate:** DynamoDB TTL attribute + backfill of TTL on existing rows (separate approved write).
- **Verification:** unit tests for TTL attribute; structure test.
- **Attack simulation:** SIM-23.
- **Monitoring:** table item count/size.
- **Pass criteria:** stale rows expire; active clients unaffected.
- **Priority:** P1 · **Status:** Not started

#### SEC-DATA-002
- **ID:** SEC-DATA-002 — Per-client data classification and retention statement
- **Threat:** privacy (push subscription endpoint, preferences)
- **Current state:** Partial. Pre-launch detail is intentionally not published in this public document; the Requirement defines the required end state.
- **Requirement:** short statement of what is stored per client, retention and deletion path; verify the delete route removes the subscription.
- **Implementation candidate:** documentation + test.
- **Verification:** delete-route test.
- **Attack simulation:** n/a.
- **Monitoring:** n/a.
- **Pass criteria:** statement exists; delete test green.
- **Priority:** P2 · **Status:** Partial

#### SEC-LOG-001
- **ID:** SEC-LOG-001 — Security events and log hygiene
- **Threat:** T-10, T-14, T-20
- **Current state:** Partial. Pre-launch detail is intentionally not published in this public document; the Requirement defines the required end state.
- **Requirement:** structured, low-cardinality security events (admin-auth failure, client-secret failure, validation-rejection class, oversized, throttled, retired-route hit); never log bodies, secrets, push endpoints or full `clientId`.
- **Implementation candidate:** tiny `security_event()` helper; log-content test.
- **Verification:** tests assert events fire and sensitive values never appear in captured logs.
- **Attack simulation:** SIM-08, SIM-14, SIM-22.
- **Monitoring:** metric filters on these events.
- **Pass criteria:** every rejection class emits one event; zero sensitive fields in logs.
- **Priority:** P1 · **Status:** Partial

### A.5 Dependency, test and CI controls

#### SEC-DEP-001
- **ID:** SEC-DEP-001 — Dependency vulnerability gates
- **Threat:** T-15
- **Current state:** Not started. Pre-launch detail is intentionally not published in this public document; the Requirement defines the required end state.
- **Requirement:** `pip-audit` and `npm audit --omit=dev` in PR CI (block on High/Critical with fix available) and nightly full audit.
- **Implementation candidate:** two CI steps; documented triage.
- **Verification:** a known-vulnerable pin in a throwaway branch fails the gate.
- **Attack simulation:** n/a.
- **Monitoring:** nightly summary.
- **Pass criteria:** zero unresolved High/Critical.
- **Priority:** P1 (downgraded in rev 3: Dependabot alerts, SEC-DEP-005, cover the same ground; a **one-time manual audit** with zero unresolved High/Critical remains in the §38 pre-production gate) · **Status:** Not started

#### SEC-DEP-002
- **ID:** SEC-DEP-002 — Secret scanning, push protection and the public-repository secret policy
- **Threat:** T-10
- **Current state:** Partial. The repository is **public** (UD-3 resolved), so GitHub secret scanning and push protection are **eligible at no licence cost**; **enablement is UNVERIFIED** (repository settings not inspected).
- **Requirement:** (1) the §17 public-repository rule — AWS credentials, Firebase private credentials/service-account keys, the Holodex secret, App Check debug tokens, Yobi session-signing secrets, `.env` secrets and production tokens **may never be committed**; (2) secret scanning **and repository-level push protection** are enabled and the actual state recorded as evidence (user-level push protection alone is insufficient: bypasses raise no alert without repository-level protection); (3) scanning/push protection are **defense-in-depth, not remediation** — a detected or suspected leak triggers **rotate/revoke first, then history remediation only if necessary**; deleting the file is never sufficient; (4) a full-history check before production (zero open alerts + a local pattern pass); (5) alerts are triaged promptly and none is closed without a recorded reason.
- **Implementation candidate:** repository settings (owner action) + the leaked-secret procedure in the incident runbook (SEC-OPS-001) + one-time history check; Gitleaks only if GitHub's coverage proves insufficient.
- **Verification:** recorded settings evidence (screenshot or settings export); a **non-functional canary** string of a supported provider pattern, used only on a throwaway branch/fork under the owner's control and removed immediately, is blocked or flagged (never a real credential; confirm beforehand that the string is non-functional); a tabletop run of the leaked-secret procedure.
- **Attack simulation:** n/a.
- **Monitoring:** GitHub secret-scanning alerts and bypass notifications.
- **Pass criteria:** repository-level protection confirmed enabled; zero open alerts; history check clean or every hit rotated; procedure rehearsed.
- **Priority:** P0 · **Status:** Partial

#### SEC-DEP-003
- **ID:** SEC-DEP-003 — CodeQL code scanning (Python + JavaScript/TypeScript)
- **Threat:** T-07, T-11, T-12
- **Current state:** Not started. The repository is **public**, so code scanning is **eligible at no licence cost**; enablement **UNVERIFIED**.
- **Requirement:** CodeQL code scanning enabled for Python and JavaScript/TypeScript on PRs to `develop` and on a schedule; High/Critical alerts handled per §30; alert suppressions are exceptions (§40). The choice between **default setup** (repository settings) and **advanced setup** (a workflow file) is decided in the implementation task (S2) — **this document creates or modifies no workflow**.
- **Implementation candidate:** GitHub default setup first; an advanced workflow only if default setup cannot cover a needed configuration.
- **Verification:** the scan runs and reports on a PR; a seeded vulnerable snippet in a throwaway branch is detected.
- **Attack simulation:** n/a.
- **Monitoring:** code-scanning alerts.
- **Pass criteria:** no unresolved High/Critical alerts; setup mode and enablement recorded.
- **Priority:** P1 · **Status:** Not started

#### SEC-DEP-004
- **ID:** SEC-DEP-004 — Pin GitHub Actions by SHA; narrow Dependabot version updates for Actions
- **Threat:** T-15, T-16
- **Current state:** Partial. Pre-launch detail is intentionally not published in this public document; the Requirement defines the required end state.
- **Requirement:** pin third-party actions to commit SHAs; allow Dependabot **version updates scoped to GitHub Actions only** to propose bumps; never use `pull_request_target` with PR code checkout; no secrets for fork PRs (public repository).
- **Implementation candidate:** edit workflow + a minimal Dependabot configuration limited to the `github-actions` ecosystem.
- **Verification:** CI still passes after pinning; a workflow lint/grep gate rejects `pull_request_target` + checkout.
- **Attack simulation:** n/a.
- **Monitoring:** Dependabot PRs.
- **Pass criteria:** all actions pinned by SHA; no forbidden trigger pattern.
- **Priority:** P2 · **Status:** Partial

#### SEC-DEP-005
- **ID:** SEC-DEP-005 — Dependency graph, Dependabot alerts and security updates (version updates limited)
- **Threat:** T-15
- **Current state:** Not started. The repository is **public**, so the dependency graph, Dependabot alerts and security updates are **eligible on all plans**; enablement **UNVERIFIED**.
- **Requirement:** enable the dependency graph, Dependabot alerts and — where appropriate — Dependabot security updates for `requirements.txt` and `frontend/dashboard`; **no indiscriminate automatic version upgrades** (version updates only in a narrow, grouped scope if at all); **no auto-merge**; every Dependabot pull request must pass the project's focused tests and the normal PR/review workflow, and a runtime-dependency update triggers the Lambda artifact rebuild/rollback practice (§31).
- **Implementation candidate:** repository settings; `.github/dependabot.yml` only if grouping/limits are needed.
- **Verification:** first security-update PR opens, runs CI and is reviewed before merge; alert queue visible.
- **Attack simulation:** n/a.
- **Monitoring:** Dependabot alert and PR queue.
- **Pass criteria:** alerts triaged within the P1 window; no Dependabot change merged without green focused tests and review.
- **Priority:** P1 · **Status:** Not started

#### SEC-TEST-001
- **ID:** SEC-TEST-001 — Route security-contract tests (launch scope: inventory, App Check and auth negatives, no boundary bypass)
- **Threat:** T-06…T-14, T-19, T-22
- **Current state:** Partial. Pre-launch detail is intentionally not published in this public document; the Requirement defines the required end state.
- **Requirement:** **P0 launch scope (§36.1 rule 2):** (1) a **route inventory / meta-test** that enumerates routes from Terraform and `_ROUTES` and fails on any unclassified route; (2) **App Check negative tests across all applicable public routes** (missing, invalid, expired token); (3) **authentication/authorization negative tests where applicable** (admin key, client secret, other-client credential); (4) **proof that no route bypasses the V1 security boundary**. **P1 follow-on (same control, after launch):** the **complete six-category route matrix** — auth, input-validation, size/limit/pagination, error-contract, method-enumeration and cost-profile tests per route.
- **Implementation candidate:** table-driven pytest suite generated from the route inventory.
- **Verification:** the meta-test.
- **Attack simulation:** SIM-01, SIM-02, SIM-24 (full SIM-07…SIM-15, SIM-20, SIM-21 coverage arrives with the P1 matrix).
- **Monitoring:** n/a.
- **Pass criteria:** 100 % of the route inventory covered by the launch-scope tests; zero failing; no route can be reached without the boundary checks.
- **Priority:** P0 (narrowed in rev 3; P1 follow-on for the full matrix) · **Status:** Partial

#### SEC-TEST-002
- **ID:** SEC-TEST-002 — Control register and traceability check
- **Threat:** process risk (requirements without verification)
- **Current state:** Not started. Pre-launch detail is intentionally not published in this public document; the Requirement defines the required end state.
- **Requirement:** machine-readable control register with verification references; a test that fails on unmapped controls, bad priorities or missing referenced tests.
- **Implementation candidate:** `security/controls.yaml` + a small pytest check.
- **Verification:** the check, with a seeded unmapped control failing.
- **Attack simulation:** n/a.
- **Monitoring:** n/a.
- **Pass criteria:** 100 % controls mapped.
- **Priority:** P1 (downgraded in rev 3: at launch the catalog's Verification fields in this document satisfy the mapping rule; the machine-checked register follows) · **Status:** Not started

#### SEC-TEST-003
- **ID:** SEC-TEST-003 — Coverage tooling and thresholds
- **Threat:** untested security branches
- **Current state:** Not started. Pre-launch detail is intentionally not published in this public document; the Requirement defines the required end state.
- **Requirement:** measure line+branch coverage (pytest-cov, @vitest/coverage-v8); record baseline; thresholds per §36.3, with stronger thresholds on security-critical modules.
- **Implementation candidate:** CI nightly full coverage; PR diff-coverage on security-critical modules.
- **Verification:** reports published; thresholds enforced after baseline.
- **Attack simulation:** n/a.
- **Monitoring:** coverage trend.
- **Pass criteria:** targets met; ratchet never lowered.
- **Priority:** P1 · **Status:** Not started

#### SEC-TEST-004
- **ID:** SEC-TEST-004 — Schemathesis API fuzzing
- **Threat:** T-07, T-12, T-14, T-22
- **Current state:** Not started. Pre-launch detail is intentionally not published in this public document; the Requirement defines the required end state.
- **Requirement:** nightly Schemathesis against the local handler server with fixture data.
- **Implementation candidate:** CI nightly job; reports as artifacts.
- **Verification:** zero 5xx, zero schema violations; every crash becomes a regression test.
- **Attack simulation:** SIM-08, SIM-11, SIM-14, SIM-15.
- **Monitoring:** nightly result badge.
- **Pass criteria:** green nightly for 14 days.
- **Priority:** P1 · **Status:** Not started

#### SEC-TEST-005
- **ID:** SEC-TEST-005 — Make the suite collect and run on every supported platform
- **Threat:** process risk (full suite not trustworthy locally)
- **Current state:** Not started. Pre-launch detail is intentionally not published in this public document; the Requirement defines the required end state.
- **Requirement:** explicit `encoding="utf-8"` in test file reads so full-suite coverage numbers are real on the dev machine.
- **Implementation candidate:** one-line fixes in affected tests.
- **Verification:** `pytest --collect-only` has zero errors.
- **Attack simulation:** n/a.
- **Monitoring:** n/a.
- **Pass criteria:** zero collection errors on Windows and Linux.
- **Priority:** P1 · **Status:** Not started

#### SEC-TEST-006
- **ID:** SEC-TEST-006 — ZAP baseline and API scan
- **Threat:** T-11, T-14, T-21
- **Current state:** Not started. Pre-launch detail is intentionally not published in this public document; the Requirement defines the required end state.
- **Requirement:** ZAP Automation Framework plans for SPA baseline and OpenAPI API scan against local/staging; active scan only on isolated pre-production.
- **Implementation candidate:** Docker-based plans on the security branch; nightly baseline.
- **Verification:** triaged reports; accepted findings in the exception register.
- **Attack simulation:** SIM-02, SIM-13, SIM-21.
- **Monitoring:** nightly result.
- **Pass criteria:** no unaccepted Medium+ findings.
- **Priority:** P1 · **Status:** Not started

#### SEC-TEST-007
- **ID:** SEC-TEST-007 — k6 local abuse simulation
- **Threat:** T-02…T-06
- **Current state:** Not started. Pre-launch detail is intentionally not published in this public document; the Requirement defines the required end state.
- **Requirement:** k6 scripts for SIM-03/06/09/11/12/18/22/23 against the local server (and staging when available) with thresholds and abort conditions per §35.2.
- **Implementation candidate:** scripts + a README of limits on the security branch.
- **Verification:** results within limits; `UNVERIFIED` items listed.
- **Attack simulation:** the scripts are the simulations.
- **Monitoring:** run reports.
- **Pass criteria:** thresholds met locally; staging gaps documented.
- **Priority:** P2 · **Status:** Not started

#### SEC-CI-001
- **ID:** SEC-CI-001 — Security suite always runs in PR CI
- **Threat:** T-19 and every regression (CI runs explicit file lists)
- **Current state:** Partial. Pre-launch detail is intentionally not published in this public document; the Requirement defines the required end state.
- **Requirement:** a `security` pytest marker and a Vitest tag/dir that PR CI always runs in addition to the lists; adding a security test cannot be forgotten.
- **Implementation candidate:** `-m security` step; frontend security directory included explicitly.
- **Verification:** a deliberately failing security test fails the PR check.
- **Attack simulation:** n/a.
- **Monitoring:** CI status.
- **Pass criteria:** every `security`-marked test runs on every PR touching code.
- **Priority:** P0 · **Status:** Partial

#### SEC-CI-002
- **ID:** SEC-CI-002 — Nightly deeper-checks workflow
- **Threat:** T-15, T-07, T-11
- **Current state:** Not started. Pre-launch detail is intentionally not published in this public document; the Requirement defines the required end state.
- **Requirement:** scheduled workflow: full suites with coverage, Schemathesis, ZAP baseline, full audits.
- **Implementation candidate:** `schedule:` workflow with read-only permissions.
- **Verification:** runs green for 14 days; failures open an issue.
- **Attack simulation:** SIM-08, SIM-11, SIM-14, SIM-15.
- **Monitoring:** workflow status.
- **Pass criteria:** stable nightly signal.
- **Priority:** P1 · **Status:** Not started

### A.6 Operations controls

#### SEC-OPS-001
- **ID:** SEC-OPS-001 — Minimal incident runbook: emergency stop/reset, leaked-secret response, rollback pointer
- **Threat:** T-16, T-17, T-10 (slow or wrong response)
- **Current state:** Partial. Pre-launch detail is intentionally not published in this public document; the Requirement defines the required end state.
- **Requirement:** **P0 launch scope, deliberately minimal — three items only:** (1) the **emergency stop/reset procedure** (how to restore the API, when it is safe; consistent with SEC-AWS-003); (2) the **leaked-secret response procedure** (rotate/revoke first, then remediate history only if necessary — §17); (3) a **rollback pointer/process** (previous Lambda artifact + `CodeSha256`, previous frontend build, Terraform commit). **Not to be expanded into a large operations manual.**
- **Implementation candidate:** a short `docs/security/INCIDENT_RUNBOOK.md` on the security branch (one to two pages).
- **Verification:** tabletop walk-through of the three items; the kill-switch drill (SEC-AWS-003).
- **Attack simulation:** n/a.
- **Monitoring:** n/a.
- **Pass criteria:** each of the three procedures exists and was exercised once.
- **Priority:** P0 (minimized in rev 3) · **Status:** Partial

#### SEC-OPS-002
- **ID:** SEC-OPS-002 — Production test authorization procedure
- **Threat:** self-inflicted outage/cost from testing
- **Current state:** Not started. Pre-launch detail is intentionally not published in this public document; the Requirement defines the required end state.
- **Requirement:** §39 adopted as a procedure with an authorization template and a test log.
- **Implementation candidate:** template file + checklist.
- **Verification:** first production observation (if any) follows the template.
- **Attack simulation:** n/a.
- **Monitoring:** test log.
- **Pass criteria:** no production test without a recorded authorization.
- **Priority:** P2 (downgraded in rev 3: the rule already lives in §39 and no production testing is planned) · **Status:** Not started

#### SEC-OPS-003
- **ID:** SEC-OPS-003 — Exception register and expiry enforcement
- **Threat:** process risk (silent, permanent exceptions)
- **Current state:** Not started. Pre-launch detail is intentionally not published in this public document; the Requirement defines the required end state.
- **Requirement:** §40 register + a test failing on expired/unknown entries.
- **Implementation candidate:** `security/exceptions.yaml` + pytest check.
- **Verification:** seeded expired exception fails CI.
- **Attack simulation:** n/a.
- **Monitoring:** monthly review.
- **Pass criteria:** no expired exceptions.
- **Priority:** P1 · **Status:** Not started

---

## Final summary

**SECURITY ARCHITECTURE: FROZEN FOR V1 OWNER REVIEW.**
**OWNER ARCHITECTURE BLOCKERS: NONE.**
Implementation/deployment parameters and ADR decisions that do **not** reopen the baseline: Firebase project ID, project number, web app ID, hosting site, production hostname; App Check TTL and billing posture; cache TTL, stale age, retry/cooldown values; limiter implementation; cache/coalescing implementation.

**SECURITY POSTURE (V1 TARGET):**
Yobi V1 is a small, serverless, anonymous, read-mostly product for ≈ 500 community users. This baseline defines the target posture and the controls required to reach it; it deliberately does not publish an itemized list of pre-launch weaknesses (the repository is public). Owner priorities: application attestation (App Check) and route throttling at launch; `/live-streams` upstream protection (availability / third-party risk, **not AWS cost**); observability (access logs, alarms); frontend hardening on Firebase Hosting; least-privilege and data-retention work; and a reconciled, deliberately-thresholded emergency-response policy ($5/month is an operating-cost target, not an automatic security cutoff). **Normal V1 traffic cost is assumed negligible by the owner and is not a design driver (this baseline's own estimate: a few dollars/month, a meaningful share of the $5 budget — tracked as an open question); WAF/CloudFront are deferred with explicit re-evaluation triggers (§19).** Live AWS state was not queried (see open questions).

**CONTROL COUNTS (derived from the Priority field of the 61-entry catalog in Appendix A; nothing else in this document restates them):** see the three lists below, whose headings are checked against the catalog.

**P0 BEFORE PRODUCTION (14):**
SEC-API-001 identifier & public-write-route field bounds, `offset` ceiling, validate before downstream calls (launch scope) · SEC-API-003 minimum launch route throttling for write/admin/Holodex-backed/availability-critical routes, average rate and burst sized separately (layer 5) · SEC-API-005 `/live-streams` upstream protection: shared cache, configurable refresh, stale-if-error, shared 429 cooldown, bounded timeouts/retries, metrics (availability; strict single-flight = P1 follow-on) · SEC-API-BOT-001 direct clients need attestation — V1 launch layers = App Check enforcement + route throttling (umbrella principles bind from day one) · SEC-API-BOT-002 Firebase App Check verification** · SEC-FE-001 no-secrets-in-bundle build gate · SEC-FE-002 launch header subset on Firebase Hosting: frame protection, `nosniff`, verified HSTS, `index.html`/`sw.js` cache policy · SEC-AWS-001 API access logging · SEC-AWS-003 kill-switch verification + reset runbook · SEC-AWS-004 minimum launch alarms: API 5xx, Lambda errors, 429/throttling signal · SEC-DEP-002 secret scanning + push protection · SEC-TEST-001 route inventory meta-test + App Check/auth negative tests + no-bypass proof (launch scope; full matrix = P1 follow-on) · SEC-CI-001 security suite always runs in PR CI · SEC-OPS-001 minimal runbook: emergency stop/reset, leaked-secret response, rollback pointer
*Rev 3 owner-approved changes:* P0 → P1: SEC-API-002, SEC-API-BOT-003, SEC-DEP-001, SEC-TEST-002; P0 → P2: SEC-OPS-002; launch scope narrowed for SEC-API-001, -003, -005, BOT-001, SEC-FE-002, SEC-AWS-004, SEC-TEST-001, SEC-OPS-001 (deferred scope: Deferred-scope register, Appendix A). *CloudFront/WAF:* not P0; SEC-AWS-006 is P2 conditional. *Strict cross-container single-flight:* P1 follow-on of SEC-API-005.

**P1 (34):**
SEC-API-002 body & field size caps (generic backstop) · SEC-API-004 growth bounds on public write routes · SEC-API-006 error contract/echo truncation · SEC-API-007 API response headers · SEC-API-008 admin brute-force limit + key rotation · SEC-API-009 S3-read caching + unknown-query-parameter rejection · SEC-API-010 OpenAPI + inventory test · SEC-API-011 retire/guard unused Holodex-backed routes · SEC-API-BOT-003 short-lived Yobi anonymous session (ships with BOT-004) · SEC-API-BOT-004 per-session/per-IP endpoint-specific rate limiting** · SEC-FE-003 CSP (Report-Only → enforce) + remaining baseline headers · SEC-FE-004 response-allowlist contract tests · SEC-FE-005 remove unused secret-reading frontend code / operator-UI exposure review · SEC-FE-006 image/URL allowlist · SEC-AWS-002 concurrency/quota/timeout validation · SEC-AWS-005 edge re-evaluation triggers · SEC-AWS-007 DynamoDB max throughput · SEC-AWS-008 least-privilege role split · SEC-AWS-009 CORS to the Firebase production origin(s) · SEC-AWS-010 S3 TLS-only policy · SEC-AWS-011 Cost Anomaly Detection + extended alarms (duration, concurrency, DynamoDB throttles, …) · SEC-AWS-012 Lambda log retention · SEC-DATA-001 TTL/retention for heartbeat & orphan credentials · SEC-LOG-001 security events + log hygiene · SEC-DEP-001 dependency vulnerability CI gates (a one-time manual audit stays in the §38 gate) · SEC-DEP-003 CodeQL · SEC-DEP-005 dependency graph + Dependabot alerts/security updates (version updates limited) · SEC-TEST-002 control register + traceability check · SEC-TEST-003 coverage tooling & thresholds · SEC-TEST-004 Schemathesis · SEC-TEST-005 Windows-safe test collection · SEC-TEST-006 ZAP baseline/API scan · SEC-CI-002 nightly deeper checks · SEC-OPS-003 exception register.

**P2 (13):**
SEC-API-012 method/route enumeration regression · SEC-API-013 client-credential accepted-risk record · SEC-API-BOT-005 behavioral anomaly scoring (log-only first)** · SEC-FE-007 service-worker payload hardening · SEC-FE-008 XSS-sink lint ban · SEC-AWS-006 edge layer implementation (conditional) · SEC-AWS-013 IAM capture/drift detection · SEC-AWS-014 S3 noncurrent-version lifecycle · SEC-AWS-015 custom domain + default-endpoint lock · SEC-DATA-002 per-client data retention statement · SEC-DEP-004 Actions SHA pinning · SEC-TEST-007 k6 local abuse simulation. · SEC-OPS-002 production-test authorization procedure

**TOOLS RECOMMENDED:**
pytest (existing) · pytest-cov · pip-audit · CodeQL (Python + JS/TS; no licence cost, public repository) · Vitest (existing) · @vitest/coverage-v8 · npm audit · GitHub secret scanning + push protection · Dependabot · **Firebase App Check (web provider) with in-Lambda JWT verification (PyJWT candidate)** · Schemathesis (after OpenAPI) · OWASP ZAP (passive baseline + API scan; active on isolated env only) · k6 (local; staging when it exists) · API Gateway route throttling · Lambda reserved concurrency · CloudWatch alarms/access logs · AWS Budgets (+ Cost Anomaly Detection).

**TOOLS REJECTED / DEFERRED:**
Deferred: **AWS WAF rate-based rules, AWS managed WAF rule groups and CloudFront (not P0; conditional on the §19 triggers)** · Gitleaks (only if GitHub scanning is unavailable, or for a one-time history scan) · CAPTCHA/Bot Control products beyond the App Check provider · **conditional free IP intelligence (GeoIP country + VPN/proxy reputation; default OFF, part of SEC-API-BOT-005)** · Bandit/Semgrep (overlap CodeQL) · tfsec/Checkov (small Terraform surface) · Hypothesis (no new dependency now) · k6 against the AWS gateway until a staging stack exists. Rejected: **a desktop-client (Yobi.exe) App Check design or exception path in V1 (out of scope, UD-1)** · **using frontend interaction telemetry as proof of humanity or as any allow/deny input** · treating CORS, Origin or User-Agent as bot protection or authorization · ZAP active scan or any load/fuzz/attack run against production by default · moving to API Gateway REST API just to obtain WAF · treating usage plans/API keys as authentication or a cost ceiling.

**SECURITY TEST STACK:**
pytest `security` marker suite (route security-contract tests (launch: route inventory, App Check and auth negatives, no-bypass proof; session negatives when BOT-003 ships; the full six-category matrix is a P1 follow-on), parse_* negative/bypass tests, error-contract/leakage tests, cost-profile spy tests, limiter tests with an injected clock, "no telemetry read in auth paths" AST test) + Vitest (allowlist contract, XSS-inert render, safe-URL, `apiClient` error mapping, token-refresh-once) + Terraform/config structure tests (throttles, concurrency, log retention, public-access-block, attestation mode = `enforce` in production, CORS origin list) + `firebase.json` header test + control register/traceability + route-inventory/OpenAPI parity + coverage (pytest-cov branch, @vitest/coverage-v8) with stronger thresholds on security-critical modules + Schemathesis (nightly) + ZAP baseline/API scan (nightly) + dependency audits and CodeQL.

**ATTACK SIMULATION STACK:**
Local handler server (`scripts/local_api_server.py`, fixture-signed tokens, mode `enforce` for the attestation tests) with counting spies/stubs for S3, DynamoDB and Holodex → k6 scripts (SIM-03/06/09/11/12/17/18/22/23/26/27) → Schemathesis/ZAP for malformed/injection/path/method/header scenarios → pytest/curl corpora for SIM-24/25/28 → Playwright-driven headless-browser scenario (SIM-26) → (future, approved) isolated staging stack for gateway throttle, concurrency, write-flood and token-farming simulations (SIM-04/05/16/19/23/26) → production: only the authorized V0–V1 observational scenarios in §35.3 marked **YES** (SIM-01/02/07/08/10/15/21/24/28), under §39.

**REMAINING WORK (not a gap inventory):**
Implementation status of every control is tracked in `docs/plans/V1_SECURITY_P0_ROADMAP.md` and verified at the pre-production gate (§38). The baseline does not publish itemized pre-launch gaps (public repository). *Deliberately not gaps for V1:* no WAF/CloudFront (deferred with triggers), and legitimate-traffic cost (assumed negligible).

**RESOLVED FOR V1 (UD-1):** Yobi.exe is not part of V1 production scope. Web security controls may assume the supported production client is the Firebase-hosted web frontend. (No desktop App Check design, no desktop exception path, no weakening of web enforcement, not part of the V1 production gate; revival = separate future security design task.)

**UD STATUS (all closed for architecture):** UD-1 resolved for V1 (Yobi.exe out of scope) · UD-3 resolved (public repository) · **UD-4 RESOLVED FOR ARCHITECTURE** (exact Holodex quota `UNVERIFIED`, a tuning input, **not** a V1 security-architecture blocker) · UD-5 resolved as policy (grace duration = implementation parameter) · **UD-2 ARCHITECTURE RESOLVED — DEPLOYMENT VALUES PENDING** (Firebase project ID, project number, web app ID, hosting site ID, production hostname, App Check TTL and billing posture are deployment inputs, not architecture questions; none fabricated). **No unresolved dependency blocks the security architecture.**

**OPEN QUESTIONS:**
1. **Firebase deployment inputs (UD-2: architecture resolved, deployment values pending):** the exact Firebase project ID, **project number**, web app ID, hosting site ID(s), production hostname(s)/custom domain, reCAPTCHA Enterprise site-key ID, the chosen App Check TTL and the billing posture (no billing = hard stop at 10,000 assessments/month vs billing = $8 flat above it, which would exceed the $5/month operating target) — both **deployment decisions**, not architecture blockers; 24 h is not frozen.
2. **Yobi.exe (UD-1): RESOLVED FOR V1** — out of V1 production scope; the supported client is the Firebase-hosted web frontend; no desktop attestation design or exception path; revival is a separate future security design task. (No longer gates route retirement or identifier-format tightening.)
3. **Enforcement rollout:** how long should monitor mode run, and what is the acceptable experience for users whose browsers block the attestation script (privacy tools)? Should `POST /session` failure show a distinct UI state?
4. **Fail mode (UD-5): policy resolved** — cached keys → continue; refresh failure → bounded grace on trusted cached keys; cold cache + keys unavailable → 503 fail closed; never fail open. **Open parameter:** the grace-period duration (no official figure; the documented key-caching ceiling is 6 hours).
5. **Limiter design (open, SEC-API-BOT-004):** no mechanism is chosen. Which of the candidates C0–C4 (including "no per-client limiter") the owner is willing to evaluate, what accuracy/cost/failure-mode trade-off is acceptable, and what values of N_design, N_sync, v, k and I should size the budgets?
5b. **Operating target vs emergency thresholds (A9):** $5/month is an operating-cost target, not an automatic security cutoff. Later, select budget-alarm and emergency-stop thresholds from measured legitimate baseline spend (≈ $2.4–3.1/month API Gateway at N_avg ≈ 20 tabs is only this baseline's estimate, before free-tier effects), normal-growth headroom, abnormal-amplification detection and the emergency-response policy — and make sure ordinary use approaching the target cannot trigger the emergency stop. No new dollar figures are set in this baseline.
5c. **Holodex (UD-4): RESOLVED FOR ARCHITECTURE.** The exact provider quota stays `UNVERIFIED` (one observed 429 on `/videos`; no limit in Holodex's public documentation) and is only a tuning input. Open at implementation: the refresh window, maximum stale age, cooldown ceiling and retry cap (parameters chosen from the §23.1 metrics and the acceptable Live Status delay).
6. **GitHub (UD-3): RESOLVED** — the repository is public; secret scanning, push protection, CodeQL and Dependabot are eligible at no licence cost. Open (implementation-time): the *actual* enablement state of each (UNVERIFIED) and the CodeQL default-vs-advanced setup choice.
7. May the owner approve a short list of **read-only** AWS commands (one at a time) to verify live state: account Lambda concurrency quota, live IAM policy of the API Lambda role, current budget/anomaly-monitor state, DynamoDB capacity, API stage settings?
8. Is a separate staging stack (or second account) acceptable for gateway/token-farming simulations? If not, those scenarios stay `UNVERIFIED` and the risk is recorded.
9. Should operator-only UI stay in the production bundle, or be moved out of it? Must admin routes also require App Check + session (draft: yes)?
10. Acceptable retention for heartbeat rows and unused credentials?
11. Should the hard-coded list of creators with an unavailable historical source become data-driven (a creator-master field + codegen) — and when?
12. Who owns alarm response and kill-switch reset, and what is the acceptable time-to-restore after an emergency stop? (Relevant because attestation/limits reduce, but do not remove, the chance of a budget-driven stop.)
13. Local development and CI: is attestation mode `off` (local server only) plus fixture-signed tokens acceptable, with App Check debug tokens forbidden in production builds?

**IMPLEMENTATION ORDER:**
S1 — Security baseline test infrastructure
S2 — Scanning gates (dependency, secret, dist-secret, CodeQL, Dependabot)
S3 — API input/output hardening
S3b — Application attestation: Firebase App Check enforcement (SEC-API-BOT-001/002; monitor → enforce; TTL and billing posture decided as deployment decisions; **AWS CORS-header change; separate approvals**)
S4 — Abuse guards and Holodex protection (minimum launch throttles, `/live-streams` shared cache/stale-if-error/429 cooldown, access logs; **AWS change**)
S4b — Yobi anonymous session + per-session/IP limits + anomaly scoring (SEC-API-BOT-003/004/005; limiter ADR first; log-only scoring first; **new signing secret; separate approvals**)
S5 — Monitoring, minimum launch alarms and emergency-stop drill/threshold policy (**AWS change**)
S6 — Frontend hardening on Firebase Hosting (headers, CSP Report-Only, dead-client removal, allowlist tests)
S7 — CORS restriction and edge re-evaluation triggers (WAF/CloudFront deferred; **AWS change**)
S8 — IAM least privilege and data retention (**AWS change**)
S9 — OpenAPI contract and API fuzzing (Schemathesis)
S10 — ZAP DAST
S11 — k6 abuse simulation
S12 — Pre-production security review (enforce-mode gate, key-rotation drill)

*End of document.*
