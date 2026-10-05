# V1 Security P0 Implementation Roadmap (corrected)

PLANNING ARTIFACT ONLY. Derived from the frozen `docs/security/V1_SECURITY_BASELINE.md`, which this document does not modify. Technical coverage is accepted: P0 controls covered 14 / 14. No security control is added and the frozen architecture is not redesigned; this revision only corrects execution order and scope. No microtask below is authorized by this document.

## Global workflow rules

1. This roadmap does NOT authorize sequential execution.
2. Only ONE microtask may be executed, and only when the owner explicitly assigns it.
3. After each microtask: stop; report changed files / tests / status; wait for the next owner instruction.
4. Branch base is dependency-driven. If a task depends on changes that exist only on an unmerged feature branch, branch from that feature branch. If all dependencies are already in develop, use the appropriate develop baseline.
5. Never automatically rebase, merge, cherry-pick, stash, reset, switch worktrees, or otherwise alter the established workflow.
6. Commit / push / PR always require explicit authorization.
7. Every AWS write command must be shown first and separately approved.
8. Firebase and GitHub setting changes also require explicit approval.
9. `.worktrees/` is unrelated and must never be touched.
10. Derived rule: MT-19 (read-only emergency-stop verification) precedes every AWS-write microtask.
11. Derived rule: before any actual implementation, the current Git state is inspected read-only.

## PRE-0 (removed as a blocker)

PRE-0 is no longer a prerequisite and is not a microtask. No pre-existing work blocks any microtask. MT-01 is tests-only and adds only a new test file and a `pytest.ini` marker. Before any microtask is assigned, the current Git state is inspected read-only and the branch base is chosen dependency-driven (global rule 4).

## Recommended dependency order (not an execution authorization)

- Phase A -- Local foundations: MT-01 -> MT-02 -> MT-03 -> MT-04 -> MT-05 -> MT-06 -> MT-07
- Phase B -- GitHub public-repository protection: MT-09 -> MT-10 -> MT-11
- Phase C -- Establish current AWS safety state (precedes every AWS write): MT-19
- Phase D -- AWS observability: MT-12 -> MT-13 -> MT-16 -> MT-17
- Phase E -- Traffic protection (sized from real access-log evidence): MT-14 -> MT-15 -> MT-18
- Phase F -- /live-streams upstream protection: MT-20 -> MT-21 -> MT-22 -> MT-23A -> MT-23B -> MT-24
- Phase G -- Emergency-stop policy alignment (AWS cost domain, independent of Firebase): MT-35 -> MT-36 -> MT-38 -> MT-37
- Phase H -- App Check backend preparation: MT-25 -> MT-26 -> MT-27 -> MT-28
- Phase I -- Firebase production preparation: MT-29 -> MT-08 -> MT-30 -> MT-31 -> MT-32A -> MT-32B -> MT-33
- Phase J -- Monitor and enforce: MT-34 -> MT-39
- Phase K -- Final gate: MT-40

EVIDENCE GATE E-1 sits between MT-16 and the final stage of MT-14: legitimate access-log evidence must exist before final `rate` and `burst` are set.

---

## Phase A -- Local foundations

### MT-01
ID: MT-01
TITLE: Route inventory/classification meta-test + `security` marker
P0 CONTROL(S): SEC-TEST-001 (launch scope, part 1)
PURPOSE: create the single source of truth that classifies every route (exempt / attested / admin / client-scoped / retired). App Check enforcement, throttling and negative tests all depend on it.
LAYER: backend tests only
LIKELY FILES / CONFIG: new `tests/security/test_route_inventory.py`; `pytest.ini` (marker registration); reuses the parsing in `tests/test_api_gateway_routes.py`.
EXTERNAL WRITE: none
OWNER APPROVAL REQUIRED: Explicit owner assignment of this microtask; commit/PR authorization only
DEPENDENCIES: none (all dependencies are already in develop; first recommended security microtask)
FOCUSED VERIFICATION: `pytest -m security tests/security/test_route_inventory.py -q` plus the existing route test
DONE WHEN: the test fails on any Terraform/`_ROUTES` route that is unclassified, and passes today.

### MT-02
ID: MT-02
TITLE: Always run `-m security` in backend PR CI
P0 CONTROL(S): SEC-CI-001 (backend half)
PURPOSE: security tests cannot be forgotten, since CI runs explicit file lists only.
LAYER: CI
LIKELY FILES / CONFIG: `.github/workflows/pr-ci.yml` (backend job step)
EXTERNAL WRITE: none (repo file only; no GitHub settings change)
OWNER APPROVAL REQUIRED: Explicit owner assignment of this microtask; commit/PR authorization; owner reviews the workflow diff
DEPENDENCIES: MT-01
FOCUSED VERIFICATION: YAML parse; a PR run shows the security step executed and `pr-required-check` still green
DONE WHEN: a deliberately failing `security` test (on a throwaway branch) fails the PR check.

### MT-03
ID: MT-03
TITLE: Identifier and public-write-route field bounds
P0 CONTROL(S): SEC-API-001
PURPOSE: enforce bounded identifier and field validation on the public write routes before launch.
LAYER: backend
LIKELY FILES / CONFIG: `src/api/heartbeat_api.py`, `remote_config_api.py`, `client_credential_api.py`, `read_api.py` (`parse_*`), shared identifier helper; `tests/api/test_heartbeat_api.py`, `test_client_credential_api.py`, `test_remote_config_api.py`
EXTERNAL WRITE: none
OWNER APPROVAL REQUIRED: Explicit owner assignment of this microtask; commit/PR only. Open question for the owner: is `clientId` strictly UUID v4 in the web frontend? (`client_id.ts` should confirm.)
DEPENDENCIES: MT-01 (for the security marker)
FOCUSED VERIFICATION: the three API test files plus `tests/api/test_api_handler.py`; negative and bypass cases (unicode, over-length, encodings)
DONE WHEN: all malformed identifiers/fields return 4xx with safe messages and zero store calls (spy-proven). Ships through its own normal backend release path, not through MT-24.

### MT-04
ID: MT-04
TITLE: `offset` ceiling and validate-before-downstream proof
P0 CONTROL(S): SEC-API-001
PURPOSE: bound pagination and prove invalid input never reaches S3/DynamoDB/Holodex.
LAYER: backend
LIKELY FILES / CONFIG: `src/api/read_api.py` (`parse_offset`), `tests/api/test_home_oshi_videos_api.py`, `tests/api/test_read_api.py`
EXTERNAL WRITE: none
OWNER APPROVAL REQUIRED: Explicit owner assignment of this microtask; commit/PR only
DEPENDENCIES: MT-03
FOCUSED VERIFICATION: those test files plus the new spy tests
DONE WHEN: the ceiling is enforced on every paginated route and the spy tests show zero downstream calls on rejection. Ships through its own normal backend release path, not through MT-24.

### MT-05
ID: MT-05
TITLE: Auth/authorization negative tests on protected routes
P0 CONTROL(S): SEC-TEST-001 (launch scope, part 3)
PURPOSE: lock in the existing admin-key and client-secret behavior on every applicable route (missing, wrong, other-client, non-ASCII).
LAYER: backend tests
LIKELY FILES / CONFIG: new `tests/security/test_route_auth_negatives.py`; reads the MT-01 classification
EXTERNAL WRITE: none
OWNER APPROVAL REQUIRED: Explicit owner assignment of this microtask; commit/PR only
DEPENDENCIES: MT-01
FOCUSED VERIFICATION: `pytest -m security tests/security/test_route_auth_negatives.py -q`
DONE WHEN: every admin and client-scoped route has the negatives, enforced by the meta-test.

### MT-06
ID: MT-06
TITLE: Frontend bundle secret-scan script
P0 CONTROL(S): SEC-FE-001
PURPOSE: fail the build if `dist/` contains key-shaped strings or `VITE_*KEY|SECRET|TOKEN` references. It needs an exact-value allowlist mechanism for intentionally public Firebase config, starting empty.
LAYER: frontend tooling
LIKELY FILES / CONFIG: new `frontend/dashboard/scripts/check-bundle-secrets.*`; unit tests beside it
EXTERNAL WRITE: none
OWNER APPROVAL REQUIRED: Explicit owner assignment of this microtask; commit/PR only
DEPENDENCIES: none
FOCUSED VERIFICATION: vitest on the script (clean dist passes, seeded fake key fails); a run against a real local `vite build`
DONE WHEN: both cases behave correctly. Removal of unused secret-reading frontend code is SEC-FE-005 (P1) and out of scope.

### MT-07
ID: MT-07
TITLE: Wire the bundle gate and frontend security tests into frontend CI
P0 CONTROL(S): SEC-FE-001, SEC-CI-001 (frontend half)
PURPOSE: the gate and frontend security tests run on every PR.
LAYER: CI
LIKELY FILES / CONFIG: `.github/workflows/pr-ci.yml` (frontend job), `frontend/dashboard/package.json` script
EXTERNAL WRITE: none
OWNER APPROVAL REQUIRED: Explicit owner assignment of this microtask; commit/PR; owner reviews the workflow diff
DEPENDENCIES: MT-02, MT-06
FOCUSED VERIFICATION: PR run executes build, then gate, then security tests
DONE WHEN: a seeded secret in a throwaway branch fails CI.

---

## Phase B -- GitHub public-repository protection

### MT-09
ID: MT-09
TITLE: Record the actual GitHub security settings (read-only)
P0 CONTROL(S): SEC-DEP-002
PURPOSE: replace every UNVERIFIED with evidence.
LAYER: GitHub
LIKELY FILES / CONFIG: evidence note (location agreed at the time); `gh api` read calls or owner screenshots
EXTERNAL WRITE: none
OWNER APPROVAL REQUIRED: Explicit owner assignment of this microtask; each read command shown first
DEPENDENCIES: none
FOCUSED VERIFICATION: n/a
DONE WHEN: the state of secret scanning, push protection, Dependabot and CodeQL is recorded.
REAL ACCESS: GitHub (read)

### MT-10
ID: MT-10
TITLE: Enable repository-level secret scanning + push protection
P0 CONTROL(S): SEC-DEP-002
PURPOSE: the public-repository backstop. Defense-in-depth only.
LAYER: GitHub settings
LIKELY FILES / CONFIG: repository Settings -> Advanced Security (owner can do this in the UI)
EXTERNAL WRITE: YES (GitHub settings)
OWNER APPROVAL REQUIRED: Explicit owner assignment of this microtask; explicit approval of the GitHub setting change
DEPENDENCIES: MT-09
FOCUSED VERIFICATION: settings re-read; optional non-functional canary on a throwaway branch under owner control
DONE WHEN: both enabled at repository level, with evidence.
REAL ACCESS: GitHub (write)

### MT-11
ID: MT-11
TITLE: Full-history secret check
P0 CONTROL(S): SEC-DEP-002
PURPOSE: confirm no secret ever reached the public history. Rotate first if any hit.
LAYER: repo/GitHub read
LIKELY FILES / CONFIG: local `git log -p` pattern pass; open-alert count via `gh`
EXTERNAL WRITE: none
OWNER APPROVAL REQUIRED: Explicit owner assignment of this microtask; each command shown first
DEPENDENCIES: MT-10
FOCUSED VERIFICATION: n/a
DONE WHEN: zero open alerts and a clean pattern pass, or each hit rotated.
REAL ACCESS: GitHub (read)

---

## Phase C -- Establish current AWS safety state (precedes every AWS write)

### MT-19
ID: MT-19
TITLE: Verify the live emergency stop (read-only)
P0 CONTROL(S): SEC-AWS-003
PURPOSE: establish the facts before any production AWS security change: the budget actions and thresholds and the deployed handler versus the repository copy. The existing automatic emergency-stop configuration must be understood before production AWS configuration is changed.
LAYER: AWS read + docs
LIKELY FILES / CONFIG: the repository's emergency-stop operations note; AWS describe commands shown first
EXTERNAL WRITE: none
OWNER APPROVAL REQUIRED: Explicit owner assignment of this microtask; each read command shown first
DEPENDENCIES: none (gates every AWS-write microtask)
FOCUSED VERIFICATION: n/a
DONE WHEN: current state, including the existing automatic trigger setting, is recorded.
REAL ACCESS: AWS (read)

---

## Phase D -- AWS observability

### MT-12
ID: MT-12
TITLE: Terraform code for API access logging
P0 CONTROL(S): SEC-AWS-001
PURPOSE: forensic trail and the evidence source for sizing every numeric parameter.
LAYER: Terraform (code only)
LIKELY FILES / CONFIG: `terraform/api_gateway.tf` (stage `access_log_settings`, log group, retention); structure test beside `tests/test_terraform_lambda_env_structure.py`
EXTERNAL WRITE: none
OWNER APPROVAL REQUIRED: Explicit owner assignment of this microtask; commit/PR only
DEPENDENCIES: none
FOCUSED VERIFICATION: structure test (no headers, no identifier-bearing query values, retention set); `terraform fmt -check`
DONE WHEN: the test passes.

### MT-13
ID: MT-13
TITLE: Terraform code for the three launch alarm categories + dedicated alarm topic
P0 CONTROL(S): SEC-AWS-004
PURPOSE: alarm coverage for API 5xx, Lambda errors and API 429/throttling, to email via a new topic, never the emergency-stop topic. Only the three categories are required; the number of CloudWatch alarm resources is whatever the Lambda/API structure needs.
LAYER: Terraform (code only)
LIKELY FILES / CONFIG: new `terraform/monitoring.tf`; structure test
EXTERNAL WRITE: none
OWNER APPROVAL REQUIRED: Explicit owner assignment of this microtask; commit/PR only
DEPENDENCIES: none
FOCUSED VERIFICATION: structure test asserts that each of the three categories (API 5xx, Lambda errors, API 429/throttling) is covered by at least one alarm, that a dedicated alarm SNS topic exists, and that no alarm targets the emergency-stop SNS topic. It does not assert an exact alarm-resource count.
DONE WHEN: the test passes and the alarm topic is separate from the emergency-stop topic.

### MT-16
ID: MT-16
TITLE: Plan/apply access logging and verify a sample log line
P0 CONTROL(S): SEC-AWS-001
PURPOSE: turn on MT-12.
LAYER: AWS
LIKELY FILES / CONFIG: `terraform plan` with limited scope, then `apply` (commands shown first)
EXTERNAL WRITE: YES (AWS)
OWNER APPROVAL REQUIRED: Explicit owner assignment of this microtask; each AWS command shown first and separately approved
DEPENDENCIES: MT-12, MT-19
FOCUSED VERIFICATION: read-only log query shows the expected JSON fields and no sensitive fields
DONE WHEN: logs flow with retention set; rollback command recorded. IAM prerequisite: confirm log-delivery permissions before applying.
REAL ACCESS: AWS

### MT-17
ID: MT-17
TITLE: Apply alarms, owner confirms the email subscription, test-fire one alarm
P0 CONTROL(S): SEC-AWS-004
PURPOSE: the three alarm categories live and proven to reach the owner.
LAYER: AWS
LIKELY FILES / CONFIG: plan/apply of MT-13; email confirmation by the owner
EXTERNAL WRITE: YES (AWS)
OWNER APPROVAL REQUIRED: Explicit owner assignment of this microtask; each AWS command shown first and separately approved
DEPENDENCIES: MT-13, MT-19
FOCUSED VERIFICATION: alarm test-fire received by email
DONE WHEN: all three categories are covered by live alarms and the test-fire was received. IAM prerequisite: confirm SNS/CloudWatch permissions before applying.
REAL ACCESS: AWS

---

## Phase E -- Traffic protection (sized from real access-log evidence)

### MT-14
ID: MT-14
TITLE: Launch route throttles: structure first, final values from access-log evidence
P0 CONTROL(S): SEC-API-003
PURPOSE: `route_settings` for the write, admin, Holodex-backed and availability-critical routes with rate and burst capacity as separate parameters, using the baseline formulas and recording the inputs. Stage 1 (structure, variables, no final values) may be assigned before evidence exists. Stage 2 (final `rate` and `burst`) is blocked on EVIDENCE GATE E-1: a read-only review of legitimate request evidence from the MT-16 access logs, after enough traffic has accumulated (window and sufficiency judged by the owner). No final value is invented in this roadmap.
LAYER: Terraform (code only) + read-only log evidence review
LIKELY FILES / CONFIG: `terraform/api_gateway.tf`; structure test checking explicit `rate` and `burst` per launch route, using MT-01's classification; log-evidence note
EXTERNAL WRITE: none (log reads are AWS reads, each command shown first)
OWNER APPROVAL REQUIRED: Explicit owner assignment of this microtask; commit/PR; owner confirms N_design and N_sync and accepts the evidence at gate E-1
DEPENDENCIES: MT-01, MT-16, gate E-1 (owner-accepted legitimate access-log evidence)
FOCUSED VERIFICATION: structure test, formula-range assertions, `terraform fmt -check`
DONE WHEN: stage 1: the structure test passes. Stage 2: final rate and burst are recorded with the evidence they derive from. Values stay revisable (the full matrix is a P1 follow-on).
REAL ACCESS: AWS (read, for the evidence review)

### MT-15
ID: MT-15
TITLE: Frontend jitter on periodic/background polling only
P0 CONTROL(S): SEC-API-003
PURPOSE: spread synchronized periodic waves without making the UI feel slower. Jitter applies to periodic polling, background refreshes and repeating heartbeat/poll timers where appropriate. It must NOT intentionally delay the initial critical page load, an explicit user-triggered fetch, or a navigation-triggered immediate data load.
LAYER: frontend
LIKELY FILES / CONFIG: `frontend/dashboard/src/shared/api/liveStreamsStore.ts`, `hooks/useHeartbeat.ts`, their tests
EXTERNAL WRITE: none
OWNER APPROVAL REQUIRED: Explicit owner assignment of this microtask; commit/PR only
DEPENDENCIES: MT-14 (jitter window is sized against the chosen burst capacity)
FOCUSED VERIFICATION: vitest on both with a mocked clock and randomness: timers are jittered within bounds; initial load, user-triggered and navigation-triggered fetches fire with no added delay
DONE WHEN: periodic/background intervals are jittered within bounds, immediate fetches are provably undelayed, and the existing tests still pass.

### MT-18
ID: MT-18
TITLE: Apply launch route throttles
P0 CONTROL(S): SEC-API-003
PURPOSE: turn on MT-14's final values.
LAYER: AWS
LIKELY FILES / CONFIG: plan/apply
EXTERNAL WRITE: YES (AWS)
OWNER APPROVAL REQUIRED: Explicit owner assignment of this microtask; each AWS command shown first and separately approved
DEPENDENCIES: MT-14, MT-15, MT-16, MT-17, MT-19
FOCUSED VERIFICATION: plan shows only route settings; light probe and a log check
DONE WHEN: settings are live and the rollback command is recorded.
REAL ACCESS: AWS

---

## Phase F -- /live-streams upstream protection

### MT-20
ID: MT-20
TITLE: ADR: shared-cache mechanism
P0 CONTROL(S): SEC-API-005
PURPOSE: score the candidates against the section 23.1 criteria. The result must include a shared/coordinated layer, with no strict lease required.
LAYER: documentation
LIKELY FILES / CONFIG: a short ADR file; the shared Lambda role already has S3 read/write on the history bucket, so an S3-object cache may need no IAM change (verify)
EXTERNAL WRITE: none
OWNER APPROVAL REQUIRED: Explicit owner assignment of this microtask; owner chooses the mechanism
DEPENDENCIES: none
FOCUSED VERIFICATION: n/a
DONE WHEN: the mechanism is chosen and recorded.

### MT-21
ID: MT-21
TITLE: Upstream-protection policy core
P0 CONTROL(S): SEC-API-005
PURPOSE: refresh window (configurable), stale-if-error, shared 429 cooldown, no per-client retries, bounded timeout and retries. Pure logic with an injected clock and a fake store.
LAYER: backend
LIKELY FILES / CONFIG: new module near `src/api/holodex_client.py`; tests with a counting fault-injecting Holodex stub
EXTERNAL WRITE: none
OWNER APPROVAL REQUIRED: Explicit owner assignment of this microtask; commit/PR only
DEPENDENCIES: MT-20
FOCUSED VERIFICATION: new unit tests, `tests/api/test_holodex_client.py`, the live-streams tests in `tests/api/test_read_api.py`
DONE WHEN: a bot-loop test shows bounded upstream calls, and a 429 gives a cooldown with zero calls plus one probe.

### MT-22
ID: MT-22
TITLE: Shared-store adapter, wiring and metrics
P0 CONTROL(S): SEC-API-005
PURPOSE: connect the policy core to the chosen store and emit the section 23.1 metrics, including the amplification ratio, as structured logs.
LAYER: backend
LIKELY FILES / CONFIG: `src/api/read_api.py` (`get_live_streams`), adapter module, moto-based tests
EXTERNAL WRITE: none
OWNER APPROVAL REQUIRED: Explicit owner assignment of this microtask; commit/PR only
DEPENDENCIES: MT-21
FOCUSED VERIFICATION: the adapter tests plus the live-streams tests
DONE WHEN: multi-container-like concurrent requests give bounded upstream calls and all metrics are emitted.

### MT-23A
ID: MT-23A
TITLE: Terraform/env/IAM code for the `/live-streams` cache parameters
P0 CONTROL(S): SEC-API-005
PURPOSE: the refresh window, stale age, cooldown ceiling and retry cap as environment configuration, as repository code only. Identify any IAM change the chosen store needs, but do not apply it.
LAYER: Terraform (code only)
LIKELY FILES / CONFIG: `terraform/lambda.tf` env, `terraform/variables.tf`; structure test beside `tests/test_terraform_lambda_env_structure.py`
EXTERNAL WRITE: none (repository/Terraform code only; no AWS write)
OWNER APPROVAL REQUIRED: Explicit owner assignment of this microtask; commit/PR; owner picks the parameter values
DEPENDENCIES: MT-20, MT-22
FOCUSED VERIFICATION: focused structure tests for the env vars; `terraform fmt -check`; a written list of required IAM changes (not applied)
DONE WHEN: tests and fmt pass and the IAM needs are identified.

### MT-23B
ID: MT-23B
TITLE: Approved Terraform plan/apply for the `/live-streams` cache parameters
P0 CONTROL(S): SEC-API-005
PURPOSE: apply MT-23A to production.
LAYER: AWS
LIKELY FILES / CONFIG: `terraform plan` then `apply`, exact commands shown first
EXTERNAL WRITE: YES (AWS)
OWNER APPROVAL REQUIRED: Explicit owner assignment of this microtask; exact commands shown first and separately approved; stop if unrelated Terraform drift appears
DEPENDENCIES: MT-23A, MT-19
FOCUSED VERIFICATION: plan shows only the intended env changes; read-only re-inspection after apply
DONE WHEN: parameters are applied and the rollback command is recorded. IAM prerequisite: confirm whether the chosen store needs new permissions before applying.
REAL ACCESS: AWS

### MT-24
ID: MT-24
TITLE: Deploy checkpoint: `/live-streams` protection only
P0 CONTROL(S): SEC-API-005
PURPOSE: ship only the SEC-API-005 `/live-streams` protection stack (MT-21/MT-22) and its required configuration, using the established artifact deploy flow. Do not bundle MT-03/MT-04 input-validation changes; they follow their own backend release path. Goal: a small rollback surface, clear cause/effect and easy production verification.
LAYER: AWS deploy
LIKELY FILES / CONFIG: existing `scripts/deploy` flow; each AWS command shown first
EXTERNAL WRITE: YES (AWS)
OWNER APPROVAL REQUIRED: Explicit owner assignment of this microtask; each step (upload, each Lambda update) shown first and separately approved
DEPENDENCIES: MT-22, MT-23B, MT-19
FOCUSED VERIFICATION: read-only `/live-streams` calls, log-derived amplification ratio, `CodeSha256` match
DONE WHEN: the ratio is far below 1 under repeated calls and the rollback artifact is recorded.
REAL ACCESS: AWS

---

## Phase G -- Emergency-stop policy alignment (AWS cost domain, independent of Firebase)

### MT-35
ID: MT-35
TITLE: Reconcile the legacy automatic emergency stop with the frozen policy
P0 CONTROL(S): SEC-AWS-003
PURPOSE: the existing automatic trigger conflicts with the owner policy ("$5 is an operating target, not an automatic security cutoff"). Use AWS evidence only (MT-19 facts, MT-16 access logs, actual AWS usage and Cost Explorer) to gather the measured baseline, present the options without numbers, and have the owner choose. This is a separate cost domain from Firebase App Check assessment volume and billing. No threshold is chosen in this roadmap.
LAYER: analysis + decision
LIKELY FILES / CONFIG: MT-19 facts, MT-16 logs, Cost Explorer (read)
EXTERNAL WRITE: none
OWNER APPROVAL REQUIRED: Explicit owner assignment of this microtask; the owner records the decision
DEPENDENCIES: MT-19, MT-16
FOCUSED VERIFICATION: n/a
DONE WHEN: the owner records the decision (and any interim stance).
REAL ACCESS: AWS (read)

### MT-36
ID: MT-36
TITLE: Apply the chosen emergency-stop threshold policy
P0 CONTROL(S): SEC-AWS-003
PURPOSE: make the live setting match the frozen policy.
LAYER: AWS
LIKELY FILES / CONFIG: budget/SNS change, commands shown first
EXTERNAL WRITE: YES (AWS)
OWNER APPROVAL REQUIRED: Explicit owner assignment of this microtask; each AWS command shown first and separately approved
DEPENDENCIES: MT-35, MT-19
FOCUSED VERIFICATION: read-only re-inspection
DONE WHEN: live setting equals the decision; the old setting is recorded for rollback. IAM prerequisite: confirm budget/IAM permissions before applying.
REAL ACCESS: AWS

### MT-38
ID: MT-38
TITLE: Minimal incident runbook (drafted before the drill)
P0 CONTROL(S): SEC-OPS-001
PURPOSE: three items only: emergency stop/reset, leaked-secret response, rollback pointer. It must exist before the emergency mechanism is intentionally exercised. If the drill exposes gaps, this runbook is updated afterwards as a docs-only follow-up.
LAYER: documentation
LIKELY FILES / CONFIG: `docs/security/INCIDENT_RUNBOOK.md`, one to two pages
EXTERNAL WRITE: none
OWNER APPROVAL REQUIRED: Explicit owner assignment of this microtask; commit/PR only
DEPENDENCIES: MT-11, MT-19, MT-24, MT-36
FOCUSED VERIFICATION: tabletop walk-through
DONE WHEN: all three procedures are written against the applied policy and reviewed by tabletop walk-through.

### MT-37
ID: MT-37
TITLE: Controlled emergency-stop/reset drill using the runbook
P0 CONTROL(S): SEC-AWS-003, SEC-OPS-001
PURPOSE: trigger, observe the throttle, reset, confirm healthy, following the MT-38 runbook. Gaps found are recorded and the runbook is updated later.
LAYER: AWS (controlled maintenance window)
LIKELY FILES / CONFIG: the concurrency commands, shown first, with a rollback
EXTERNAL WRITE: YES (brief production API throttle)
OWNER APPROVAL REQUIRED: Explicit owner assignment of this microtask; each AWS command shown first and separately approved; owner chooses the window
DEPENDENCIES: MT-36, MT-38, MT-19
FOCUSED VERIFICATION: API healthy after reset
DONE WHEN: reset completed within the stated time and any runbook gaps are recorded.
REAL ACCESS: AWS

---

## Phase H -- App Check backend preparation

### MT-25
ID: MT-25
TITLE: Attestation verification module
P0 CONTROL(S): SEC-API-BOT-002
PURPOSE: pure RS256/JWT verification with pinned project number and app ID, JWKS cache with a bounded grace parameter, fail-closed 503 and a mode setting.
LAYER: backend
LIKELY FILES / CONFIG: new `src/api/attestation.py`; `requirements.txt` only if the PyJWT route is chosen
EXTERNAL WRITE: none
OWNER APPROVAL REQUIRED: Explicit owner assignment of this microtask; commit/PR; owner decides Admin SDK vs lightweight JWT (artifact size)
DEPENDENCIES: MT-02
FOCUSED VERIFICATION: tests with a test signing key and fake JWKS: valid, expired, wrong audience/issuer/subject, `alg: none`, unknown `kid`, rotation, grace, cold-cache 503
DONE WHEN: all pass, and pins/grace come from configuration, not code constants.

### MT-26
ID: MT-26
TITLE: Dispatch integration, response semantics and events
P0 CONTROL(S): SEC-API-BOT-001, SEC-API-BOT-002
PURPOSE: `off|monitor|enforce`, exempt routes (410, preflight), the section 13.1 403/503 codes, security events, and local server mode `off`.
LAYER: backend
LIKELY FILES / CONFIG: `src/api/api_handler.py`, `scripts/local_api_server.py`
EXTERNAL WRITE: none
OWNER APPROVAL REQUIRED: Explicit owner assignment of this microtask; commit/PR only
DEPENDENCIES: MT-01, MT-25
FOCUSED VERIFICATION: `tests/api/test_api_handler.py`, `tests/api/test_retired_routes.py`, new tests; a spy proof of zero data-plane calls on rejection
DONE WHEN: modes behave per spec and production configuration cannot be `off`.

### MT-27
ID: MT-27
TITLE: App Check negatives across all routes + no-bypass proof
P0 CONTROL(S): SEC-TEST-001 (launch scope, parts 2 and 4), SEC-API-BOT-001
PURPOSE: prove no route bypasses the boundary.
LAYER: backend tests
LIKELY FILES / CONFIG: new `tests/security/test_route_attestation.py` driven by the MT-01 classification
EXTERNAL WRITE: none
OWNER APPROVAL REQUIRED: Explicit owner assignment of this microtask; commit/PR only
DEPENDENCIES: MT-26
FOCUSED VERIFICATION: `pytest -m security tests/security -q`
DONE WHEN: every applicable route has missing/invalid/expired negatives and the meta-test fails on any unclassified route.

### MT-28
ID: MT-28
TITLE: Terraform code for attestation settings and the CORS header
P0 CONTROL(S): SEC-API-BOT-002
PURPOSE: Lambda env for mode/pins and `x-firebase-appcheck` in `allow_headers`, as variables with no fabricated values.
LAYER: Terraform (code only)
LIKELY FILES / CONFIG: `terraform/lambda.tf`, `terraform/variables.tf`, `terraform/api_gateway.tf`; structure test (production mode must be `enforce`)
EXTERNAL WRITE: none
OWNER APPROVAL REQUIRED: Explicit owner assignment of this microtask; commit/PR only
DEPENDENCIES: MT-26
FOCUSED VERIFICATION: structure tests, `terraform fmt -check`
DONE WHEN: the tests pass. Values required later, supplied by the owner at MT-29: project number, web app ID, production origin.

---

## Phase I -- Firebase production preparation

### MT-29
ID: MT-29
TITLE: Firebase and App Check setup by the owner
P0 CONTROL(S): SEC-API-BOT-002
PURPOSE: create or confirm the Firebase project, register the web app, create the reCAPTCHA Enterprise key (production domains only, never localhost), register App Check, set up a separate non-production project/app for debug tokens, decide TTL and billing posture.
LAYER: Firebase/Google Cloud console
LIKELY FILES / CONFIG: console only; values recorded for the later tasks
EXTERNAL WRITE: YES (Firebase)
OWNER APPROVAL REQUIRED: Explicit owner assignment of this microtask; the owner performs it and approves each Firebase change
DEPENDENCIES: none
FOCUSED VERIFICATION: values recorded
DONE WHEN: supplied at this step, not invented: Firebase project ID, project number, web app ID, hosting site, production origin, TTL, billing posture.
REAL ACCESS: Firebase

### MT-08
ID: MT-08
TITLE: `firebase.json` with the P0 header subset (after Firebase values are known)
P0 CONTROL(S): SEC-FE-002 (part 1)
PURPOSE: frame protection, `nosniff`, HSTS only if Firebase does not already send it, `index.html` and `sw.js` no-cache. No deploy. Use only owner-supplied values from MT-29; never fabricate a project ID, hosting site ID, production origin, project number or web app ID.
LAYER: frontend/Firebase config file
LIKELY FILES / CONFIG: new `frontend/dashboard/firebase.json`; test parsing it. `.firebaserc` only if MT-29 supplies the real project ID.
EXTERNAL WRITE: none (file only)
OWNER APPROVAL REQUIRED: Explicit owner assignment of this microtask; commit/PR only
DEPENDENCIES: MT-29
FOCUSED VERIFICATION: a test asserts the required header keys and the no-cache rules
DONE WHEN: the test passes. Live verification is MT-33.

### MT-30
ID: MT-30
TITLE: Frontend App Check integration
P0 CONTROL(S): SEC-API-BOT-002
PURPOSE: SDK init with the Enterprise provider and auto-refresh, `X-Firebase-AppCheck` on API calls, a single retry on `ATTESTATION_*` codes, and a debug provider for local dev only. No tokens in source.
LAYER: frontend
LIKELY FILES / CONFIG: `frontend/dashboard/package.json` (the Firebase JS SDK dependency, a new supply-chain item), `src/shared/api/apiClient.ts`, a new init module, tests
EXTERNAL WRITE: none
OWNER APPROVAL REQUIRED: Explicit owner assignment of this microtask; commit/PR; dependency approval
DEPENDENCIES: MT-07 (bundle gate), MT-29 (config values). Sequenced after MT-08 by assignment order only; no code dependency.
FOCUSED VERIFICATION: vitest on `apiClient` (header, one-shot retry, no loop); the bundle gate with the public-config allowlist
DONE WHEN: tests pass and the gate passes with exact-value allowlisting.

### MT-31
ID: MT-31
TITLE: Apply attestation configuration (monitor mode) + CORS header
P0 CONTROL(S): SEC-API-BOT-002
PURPOSE: turn on MT-28 in monitor mode. The CORS header must be live before the frontend starts sending `X-Firebase-AppCheck`.
LAYER: AWS
LIKELY FILES / CONFIG: plan/apply with the real values from MT-29
EXTERNAL WRITE: YES (AWS)
OWNER APPROVAL REQUIRED: Explicit owner assignment of this microtask; each AWS command shown first and separately approved
DEPENDENCIES: MT-28, MT-29, MT-19
FOCUSED VERIFICATION: preflight check shows the new header allowed
DONE WHEN: applied in monitor mode and the rollback command is recorded.
REAL ACCESS: AWS

### MT-32A
ID: MT-32A
TITLE: Backend App Check monitor-mode deployment
P0 CONTROL(S): SEC-API-BOT-001, SEC-API-BOT-002
PURPOSE: backend deployment only, with App Check in monitor mode, using the established artifact deploy flow.
LAYER: AWS deploy
LIKELY FILES / CONFIG: existing `scripts/deploy` flow; each AWS command shown first
EXTERNAL WRITE: YES (AWS)
OWNER APPROVAL REQUIRED: Explicit owner assignment of this microtask; each step shown first and separately approved
DEPENDENCIES: MT-24, MT-26, MT-31, MT-19
FOCUSED VERIFICATION: monitor-mode events appear in the logs; `CodeSha256` match; existing routes unaffected
DONE WHEN: backend live in monitor mode and the AWS rollback artifact is recorded.
REAL ACCESS: AWS

### MT-32B
ID: MT-32B
TITLE: Firebase Hosting frontend deployment with App Check + security headers
P0 CONTROL(S): SEC-API-BOT-002, SEC-FE-002
PURPOSE: frontend Firebase Hosting deployment only: Firebase App Check integration plus the Hosting headers/config.
LAYER: Firebase deploy
LIKELY FILES / CONFIG: Firebase Hosting deploy of the frontend build
EXTERNAL WRITE: YES (Firebase)
OWNER APPROVAL REQUIRED: Explicit owner assignment of this microtask; each Firebase command shown first and separately approved
DEPENDENCIES: MT-08, MT-29, MT-30, MT-31, MT-32A
FOCUSED VERIFICATION: the app loads and sends a token; monitor-mode logs show valid tokens from it
DONE WHEN: frontend live and the frontend rollback/version is recorded.
REAL ACCESS: Firebase

### MT-33
ID: MT-33
TITLE: Verify live headers
P0 CONTROL(S): SEC-FE-002
PURPOSE: confirm the launch subset, including HSTS behavior and `sw.js`/`index.html` revalidation.
LAYER: read-only HTTP check
LIKELY FILES / CONFIG: curl or header scan of the live site
EXTERNAL WRITE: none
OWNER APPROVAL REQUIRED: Explicit owner assignment of this microtask; none beyond running reads
DEPENDENCIES: MT-32B
FOCUSED VERIFICATION: header assertions
DONE WHEN: all subset headers confirmed.

---

## Phase J -- Monitor and enforce

### MT-34
ID: MT-34
TITLE: Monitor-mode observation and TTL/billing decisions
P0 CONTROL(S): SEC-API-BOT-001, SEC-API-BOT-002
PURPOSE: monitor mode observes and records; it does not reject. Measure assessment volume, verification-failure reasons and any unexplained failures from legitimate production UI traffic; decide TTL and billing posture as deployment decisions.
LAYER: operations
LIKELY FILES / CONFIG: logs and Firebase metrics
EXTERNAL WRITE: none (a TTL change later is a Firebase write)
OWNER APPROVAL REQUIRED: Explicit owner assignment of this microtask; the owner decides
DEPENDENCIES: MT-32A, MT-32B
FOCUSED VERIFICATION: assessment count versus the allowance; no unexplained App Check verification failures from legitimate production UI traffic
DONE WHEN: the decisions are recorded.

### MT-39
ID: MT-39
TITLE: Flip App Check to `enforce` + production negative verification
P0 CONTROL(S): SEC-API-BOT-001, SEC-API-BOT-002
PURPOSE: reject unattested direct clients in production, with route throttling already live.
LAYER: AWS
LIKELY FILES / CONFIG: Terraform env change, plan/apply; at most 50 authorized read-only probes
EXTERNAL WRITE: YES (AWS)
OWNER APPROVAL REQUIRED: Explicit owner assignment of this microtask; each AWS command shown first and separately approved
DEPENDENCIES: MT-18, MT-27, MT-34, MT-36, MT-38, MT-19
FOCUSED VERIFICATION: tokenless and invalid requests return 403 with zero data-plane work; the app still works
DONE WHEN: enforce is live and legitimate use is unaffected.
REAL ACCESS: AWS

---

## Phase K -- Final gate

### MT-40
ID: MT-40
TITLE: Final P0 gate walk
P0 CONTROL(S): all 14 (verification only)
PURPOSE: confirm evidence for each P0 control against section 38.
LAYER: review
LIKELY FILES / CONFIG: evidence checklist
EXTERNAL WRITE: none
OWNER APPROVAL REQUIRED: Explicit owner assignment of this microtask; owner sign-off
DEPENDENCIES: all of MT-01 through MT-39 (including MT-23A, MT-23B, MT-32A, MT-32B)
FOCUSED VERIFICATION: the checklist
DONE WHEN: every P0 control has recorded evidence or an approved exception.

---

## P0 coverage

TOTAL P0 CONTROLS COVERED: 14 / 14

- SEC-API-001: MT-03, MT-04
- SEC-API-003: MT-14, MT-15, MT-18 (evidence: MT-16)
- SEC-API-005: MT-20, MT-21, MT-22, MT-23A, MT-23B, MT-24
- SEC-API-BOT-001: MT-26, MT-27, MT-32A, MT-34, MT-39
- SEC-API-BOT-002: MT-25, MT-26, MT-28, MT-29, MT-30, MT-31, MT-32A, MT-32B, MT-34, MT-39
- SEC-FE-001: MT-06, MT-07
- SEC-FE-002: MT-08, MT-32B, MT-33
- SEC-AWS-001: MT-12, MT-16
- SEC-AWS-003: MT-19, MT-35, MT-36, MT-37
- SEC-AWS-004: MT-13, MT-17
- SEC-DEP-002: MT-09, MT-10, MT-11
- SEC-TEST-001: MT-01, MT-05, MT-27
- SEC-CI-001: MT-02, MT-07
- SEC-OPS-001: MT-37, MT-38

TOTAL MICROTASKS: 42

FIRST MICROTASK RECOMMENDED: MT-01 (not authorized; awaits explicit owner assignment)

## Decisions still needed from the owner

- MT-03: confirm the `clientId` format against `client_id.ts` (UUID v4) before tightening validation.
- MT-14: accept the access-log evidence at gate E-1 and confirm N_design and N_sync; final values are not chosen here.
- MT-20: choose the shared-cache mechanism.
- MT-25: choose Admin SDK vs lightweight JWT verification; approve the Firebase JS SDK dependency at MT-30.
- MT-29: supply the Firebase values.
- MT-35: record the emergency-stop threshold policy. No threshold is chosen in this roadmap.
