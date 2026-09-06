# `yobi-analytics-cli` has no IAM read access on some of these roles (even
# plain GetRole 403s on yobi-analytics-emergency-stop-role) — and because
# Terraform evaluates every data source in the whole config on every command,
# a data "aws_iam_role" lookup here would block ALL terraform commands, not
# just ones touching IAM. These ARNs are already known (captured from
# `aws lambda list-functions` / `aws scheduler get-schedule` output) and are
# deterministic (account ID + fixed role name), so hardcoding them as plain
# strings avoids any IAM API call entirely. Policy content for these 3 roles
# stays manually managed via root Console — out of this Terraform project's
# scope, same as before.
# Derived from the active credentials' own identity (sts:GetCallerIdentity,
# which yobi-analytics-cli can call — unlike the IAM APIs above) rather than
# a hardcoded default, so an apply under the wrong account's credentials
# fails on a real "no such role" error instead of silently building ARNs
# against a stale account ID.
data "aws_caller_identity" "current" {}

locals {
  lambda_role_arn         = "arn:aws:iam::${data.aws_caller_identity.current.account_id}:role/yobi-analytics-lambda-role"
  emergency_stop_role_arn = "arn:aws:iam::${data.aws_caller_identity.current.account_id}:role/yobi-analytics-emergency-stop-role"
  scheduler_role_arn      = "arn:aws:iam::${data.aws_caller_identity.current.account_id}:role/yobi-analytics-scheduler-role"
}
