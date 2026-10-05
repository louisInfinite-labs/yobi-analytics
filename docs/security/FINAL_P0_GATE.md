# V1 Security P0 — final gate checklist (roadmap MT-40)

This is the evidence walk for the 14 P0 controls of `docs/security/V1_SECURITY_BASELINE.md`, kept honest: **a control is
only "verified in production" after the external steps below have been approved, applied and verified.** Status values:

- `IMPLEMENTED` — code, configuration or documentation is in the repository and covered by automated checks;
- `PENDING-EXTERNAL` — implemented locally, but its production apply/deploy/setup needs an approval-gated external step;
- `PENDING-DECISION` — waits on an owner decision;
- `VERIFIED` — evidence recorded in production (none is claimed here until the external steps have run).

Last updated after the local implementation of every microtask that does not modify an external system.

| P0 control | Microtasks | Repository evidence | Status |
|---|---|---|---|
| SEC-API-001 identifier and field bounds, offset ceiling, validate before downstream | MT-03, MT-04 | `src/api/identifiers.py`; `tests/security/test_input_bounds.py` (spy-proven zero data-plane calls on rejection) | PENDING-EXTERNAL (backend deploy) |
| SEC-API-003 launch route throttling, rate and burst separate | MT-14, MT-15, MT-18 | `terraform/variables.tf` `launch_route_throttles` (provisional); `tests/security/test_terraform_throttles.py`; periodic-only jitter `frontend/dashboard/src/shared/api/jitter.ts` | PENDING-EXTERNAL (apply) — final values wait on access-log evidence (MT-14 stage 2) |
| SEC-API-005 `/live-streams` upstream protection | MT-20 to MT-24 | `docs/security/adr/ADR-001-live-streams-shared-cache.md`; `src/api/live_streams_protection.py`; `src/stores/live_streams_cache_store.py`; `tests/security/test_live_streams_*.py` | PENDING-EXTERNAL (parameter apply and deploy) |
| SEC-API-BOT-001 attestation required; layers 1 and 5 at launch | MT-26, MT-27, MT-32A, MT-34, MT-39 | `src/api/api_handler.py` modes and codes; `tests/security/test_attestation_dispatch.py`, `test_route_attestation.py` | PENDING-EXTERNAL (monitor then enforce) |
| SEC-API-BOT-002 App Check verification | MT-25, MT-28 to MT-32, MT-34, MT-39 | `src/api/attestation.py`; `tests/security/test_attestation.py`; Terraform `attestation_*` variables; frontend `appCheck.ts` | PENDING-EXTERNAL (Firebase setup, then rollout) |
| SEC-FE-001 no secrets in the bundle | MT-06, MT-07 | `frontend/dashboard/scripts/check-bundle-secrets.mjs` and its tests; PR CI build then gate | IMPLEMENTED |
| SEC-FE-002 launch header subset | MT-08, MT-32B, MT-33 | `frontend/dashboard/firebase.json`; `scripts/firebase-config.test.ts` | PENDING-EXTERNAL (hosting deploy; HSTS decided from the live check) |
| SEC-AWS-001 API access logging | MT-12, MT-16 | `terraform/api_gateway.tf`; `tests/security/test_terraform_observability.py` | PENDING-EXTERNAL (apply) |
| SEC-AWS-003 emergency stop: verification, runbook, threshold policy | MT-19, MT-35 to MT-38 | live state verified read-only (MT-19); `docs/security/INCIDENT_RUNBOOK.md`; `docs/security/decisions/DECISION-001-emergency-stop-threshold-policy.md` | PENDING-DECISION (threshold policy), then PENDING-EXTERNAL (apply, drill) |
| SEC-AWS-004 launch alarms | MT-13, MT-17 | `terraform/monitoring.tf`; category-coverage tests | PENDING-EXTERNAL (apply, email confirmation, test-fire) |
| SEC-DEP-002 secret scanning and push protection | MT-09, MT-10, MT-11 | `docs/security/evidence/GITHUB_SECURITY_STATE.md` (both already enabled; history clean; 0 open alerts) | IMPLEMENTED |
| SEC-TEST-001 route inventory, App Check and auth negatives, no-bypass proof | MT-01, MT-05, MT-27 | `tests/security/` (route inventory meta-test, auth negatives, attestation negatives) | IMPLEMENTED |
| SEC-CI-001 the security suite always runs in PR CI | MT-02, MT-07 | `.github/workflows/pr-ci.yml` (`-m security` step; bundle gate) | IMPLEMENTED (confirmed by the next PR CI run) |
| SEC-OPS-001 minimal incident runbook | MT-37, MT-38 | `docs/security/INCIDENT_RUNBOOK.md` | PENDING-EXTERNAL (controlled drill) |

## External steps that must complete before this checklist can read `VERIFIED`

1. Apply API access logging (MT-16) and the alarms (MT-17), confirm the alarm email, test-fire one alarm.
2. Collect legitimate access-log evidence, then finalize and apply the route throttles (MT-14 stage 2, MT-18).
3. Apply the `/live-streams` parameters (MT-23B) and deploy the backend (MT-24); verify the amplification ratio.
4. Owner decision on the emergency-stop threshold policy (MT-35), apply it (MT-36), then run the controlled drill (MT-37)
   and record it in the runbook.
5. Owner Firebase / App Check setup and values (MT-29); apply the attestation configuration in monitor mode (MT-31);
   deploy the backend in monitor mode (MT-32A) and the frontend to Firebase Hosting (MT-32B); verify live headers (MT-33).
6. Complete the monitor-mode review (MT-34), then flip to `enforce` and verify production negatives (MT-39).
7. Re-run this walk against production and record the evidence (MT-40).

## Local verification that is already green

- Backend: the full suite and the `-m security` suite.
- Frontend: the explicit CI test list, `tsc -b`, lint, a production build and the bundle secret gate.
- Terraform: `fmt` and `validate`, and targeted plans that touch only the intended resources.
