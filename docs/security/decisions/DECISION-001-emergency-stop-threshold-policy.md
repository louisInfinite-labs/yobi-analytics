# DECISION-001 — Emergency-stop threshold policy (roadmap MT-35, SEC-AWS-003)

Status: **OWNER DECISION PENDING.** This brief sets out the evidence and the options. It chooses no threshold and sets
no dollar figure; the baseline forbids inventing one (A9).

## Owner policy this decision must satisfy

`$5/month` is the operating-cost **target**. It is **not** an automatic security kill-switch threshold. Security
controls must not intentionally shut down legitimate production traffic merely because normal usage approaches the
target. Thresholds for any automatic stop are selected from:

1. measured legitimate baseline spend,
2. reasonable normal-growth headroom,
3. abnormal-cost amplification detection, and
4. the emergency-response policy.

## What exists (MT-19, read-only verification)

- A cost budget notifies by email at several percentages of the monthly target, and its **highest** notification also
  publishes to a topic whose subscriber is an emergency-stop function that sets the API function's reserved concurrency
  to zero. This is the **legacy automatic trigger** the policy above does not endorse.
- The deployed stop function matches the repository copy. The stop-and-reset cycle was drilled once by publishing to the
  topic directly; the budget-to-topic hop has never fired for real.
- Budgets lag billing data by hours, so the trigger is delayed and best-effort, not a hard cap.
- The API's declared reserved concurrency is a non-zero value in Terraform. A reset must restore **that** declared value;
  an older operations note describes resetting to "unreserved", which differs from the declared configuration (the
  incident runbook corrects this).

The current-month spend figures and the exact trigger setting are operational data and are deliberately not recorded in
this public repository; the owner has them from the MT-19 run.

## Why this needs a decision

Ordinary growth toward the operating target would, with the legacy trigger armed, switch the whole public API off. That
is the self-inflicted-outage threat T-17 in the baseline. Legitimate traffic cost is small in absolute terms but a
meaningful share of the target (baseline cost sanity), so this is a live risk, not a theoretical one.

## Options (no numbers)

| Option | What changes | Pros | Cons |
|---|---|---|---|
| A. Disarm the automatic trigger; keep email notifications and the manual stop | Remove the automatic publish at the highest budget notification; keep the stop function for manual/alarm-driven use | Ordinary growth can never cause an outage; simplest | A real runaway is contained only when a human responds |
| B. Re-arm the stop on an abnormal-amplification signal instead of a budget percentage | Trigger from request-rate / anomaly alarms (SEC-AWS-004/011), not from spend | Targets abuse, not growth | More moving parts; needs tuned thresholds from access-log evidence |
| C. Keep a budget-triggered stop, moved well above expected spend | Owner picks a threshold from measured baseline plus headroom | Retains an automatic backstop | Still a lagging, spend-based trigger; needs periodic re-selection |
| D. Combination: B for automation, A's manual stop, and C only as a last-resort ceiling | Layered | Covers abuse and runaway | Highest complexity |

## Interim stance recommended until the owner chooses

Treat the legacy trigger as **unreconciled**. The lowest-risk interim is option A: keep every notification email, keep
the stop function and its tested reset procedure for manual use, and do not let the automatic publish fire. This is an AWS
change and therefore an approval-gated step (MT-36); it is listed in the external-write gate, not applied.

## Decision record (to be completed by the owner)

```
Chosen option:        (A / B / C / D)
Threshold values:     (none for A; owner-selected for B/C/D, with the evidence they derive from)
Interim stance:       (until the final option is applied)
Decided by / date:
```
