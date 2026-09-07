# Referenced by ARN only — the secret VALUE is never read into Terraform
# state. This is a data source (read existing), not a managed resource:
# Terraform must never create/own/rotate this secret's value.
data "aws_secretsmanager_secret" "youtube_api_key" {
  name = "yobi-analytics/youtube-api-key"
}

# 2026-09-07: same pattern for the two secrets that used to be plaintext
# Lambda environment variables (`var.admin_api_key`/`var.vapid_private_key`
# in the now-removed variables.tf entries) — created manually in the AWS
# Console, referenced here by name only, never owned/rotated by Terraform.
data "aws_secretsmanager_secret" "admin_api_key" {
  name = "yobi-analytics/admin-api-key"
}

data "aws_secretsmanager_secret" "vapid_private_key" {
  name = "yobi-analytics/vapid-private-key"
}
