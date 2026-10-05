# Incident runbook (V1 minimal) — roadmap MT-38, SEC-OPS-001

Three procedures only: emergency stop and reset, leaked-secret response, and a rollback pointer. This repository is
public, so concrete identifiers are written as `<placeholders>`; the real names are in the Terraform files and the
owner's operations notes.

Who may act: the repository owner. No automated process restores service after an emergency stop.

---

## 1. Emergency stop and reset

### What an emergency stop is

The stop function sets the API function's **reserved concurrency to zero**, so every API request is throttled until a
human restores it. The data-collection pipeline and notification dispatcher are not affected. It can be started
automatically (a budget-driven trigger, whose threshold policy is DECISION-001) or manually.

### When to stop manually

Stop when abnormal traffic or cost is actively harming availability or spend and throttling individual routes is not
enough: a sustained flood visible in the access logs, an alarm that keeps firing, or an unexplained cost climb.

Contain first by tightening route throttles if time allows; stop if it does not.

### Manual stop

```
aws lambda put-function-concurrency --function-name <api-function> --reserved-concurrent-executions 0 --region <region>
```

Verify:

```
aws lambda get-function-concurrency --function-name <api-function> --region <region>
```

The result must show `ReservedConcurrentExecutions: 0`.

### Assess

Use the API access log group (`<access-log-group>`): requests per route, status mix, top source IPs, 429 share. Check
CloudWatch metrics for the API function and the cost console for the month. Decide whether the traffic is abuse, a bug or
legitimate growth.

### When it is safe to reset

Reset only when the cause is understood and contained: the abusive source is blocked or throttled, the bug is fixed, or
the cost driver is gone. Do not reset merely because the budget percentage fell.

### Reset

Restore the **declared** reserved concurrency, not "unreserved". The declared value is `reserved_concurrent_executions`
on the API function in `terraform/lambda.tf`. Preferred: re-apply Terraform for that resource. Direct command:

```
aws lambda put-function-concurrency --function-name <api-function> --reserved-concurrent-executions <declared-value> --region <region>
```

Verify with `get-function-concurrency` (the declared value) and a read-only smoke check of one public route (HTTP 200).

> The older operations note describes resetting to unreserved concurrency. That differs from the declared configuration;
> use the declared value above so Terraform shows no drift.

### Drill record (MT-37)

Complete after the controlled drill: date, trigger method, time to throttle, reset method, time to restore, API healthy
after reset (yes/no), and any gap found. If the drill exposes a gap, update this section before the next drill.

```
Date:
Trigger:
Observed throttle (seconds):
Reset method:
Time to restore (minutes):
API healthy after reset:
Gaps found / runbook updates:
```

---

## 2. Leaked-secret response

**Rotate or revoke first.** Deleting a file or reverting a commit is not remediation: the value stays in history, clones,
forks and cached views.

1. **Identify** the secret type and where it was exposed (repository, pull request, log, bundle, chat).
2. **Rotate / revoke** at the source immediately:
   - admin API key — rotate in the secret store (no deploy required);
   - VAPID private key — rotate; existing push subscriptions must be re-created;
   - Holodex key — revoke and re-issue;
   - YouTube API key — restrict/revoke and re-issue;
   - session-signing key (when it ships) — rotate through the two-active-key overlap;
   - cloud or service-account credentials — deactivate and re-issue.
3. **Update** the secret store and confirm the service still works.
4. **Remediate history only if necessary** (the value is still sensitive after rotation): use a history-rewrite tool with
   its sensitive-data-removal option, and open a request with GitHub Support for cached views and forks.
5. **Verify**: no open secret-scanning alerts, a clean full-history pattern pass, and a record of the rotation date.
6. **Learn**: add a permanent regression check (bundle scan, push protection, test) for the leak path.

---

## 3. Rollback pointer

Every change must be revertible; record the rollback next to the apply.

- **Backend (Lambda):** redeploy the previously recorded artifact and confirm its `CodeSha256` matches the build record.
  The deploy flow is in `scripts/deploy/`; the previous artifact and its hash are kept with the deployment record.
- **Frontend:** redeploy the previous hosting release from the hosting provider's release history.
- **Infrastructure:** revert the Terraform commit and apply, or re-apply the previous plan; route-throttle and logging
  changes roll back this way.
- **Configuration modes:** the App Check mode and the `/live-streams` protection parameters are environment values and
  roll back by restoring the previous value.
- No security change may require deleting data; DynamoDB deletion protection and S3 versioning stay on.
