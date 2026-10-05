# GitHub security state — evidence (MT-09, MT-10, MT-11)

Recorded 2026-10-06 from read-only GitHub API calls and a local Git-history pattern pass. No setting was changed and no
alert content was read (alerts were counted only). This note supports SEC-DEP-002 and replaces the `UNVERIFIED`
enablement statuses in `docs/security/V1_SECURITY_BASELINE.md` §18.1.

## MT-09 — actual repository settings

| Capability | State observed | Baseline target |
|---|---|---|
| Repository visibility | public | public (UD-3) |
| Secret scanning (alerts) | **enabled** | required, P0 (SEC-DEP-002) |
| Push protection (repository level) | **enabled** | required, P0 (SEC-DEP-002) |
| Secret scanning — non-provider patterns | disabled | optional |
| Secret scanning — validity checks | disabled | optional |
| Dependabot alerts | disabled | P1 (SEC-DEP-005) |
| Dependabot security updates | disabled | P1 (SEC-DEP-005) |
| Code scanning (CodeQL) default setup | not configured | P1 (SEC-DEP-003) |
| Open secret-scanning alerts | 0 | 0 before production |

## MT-10 — enable repository-level secret scanning and push protection

Both were **already enabled at the repository level** when MT-09 inspected the settings, so no GitHub setting change was
required and none was made. The P0 requirement of SEC-DEP-002 is met.

The three P1 capabilities that are still off (Dependabot alerts, Dependabot security updates, CodeQL) are not part of the
42-task P0 roadmap; they remain follow-on work under SEC-DEP-003 and SEC-DEP-005 and are not claimed as enabled.

## MT-11 — full-history secret check

A pattern pass over all 298 commits of every ref (key-shaped strings, private-key blocks, token formats, and generic
credential assignments) found no real secret. The only matches were:

- a test fixture containing the literal text of a private-key header, not a key;
- secret-store parameter *names* (paths) in a Terraform comment/config, not values;
- `REPLACE…` placeholders in the Terraform variables example file.

Open secret-scanning alerts: 0. No rotation was required.
