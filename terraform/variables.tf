variable "aws_region" {
  description = "AWS region all Yobi Analytics resources live in"
  type        = string
  default     = "ap-northeast-1"
}

# 2026-09-07: admin_api_key and vapid_private_key used to live here (real
# values supplied via terraform.tfvars, surfaced as plaintext Lambda
# environment variables) — removed now that both Lambdas read the real
# value from Secrets Manager at runtime instead (see secrets.tf's
# `admin_api_key`/`vapid_private_key` data sources and lambda.tf's
# `_SECRET_NAME` environment variables), the same pattern already used for
# YOUTUBE_API_KEY. Unlike the old plaintext-var approach, this needs no
# Terraform variable at all: the secret's value lives only in Secrets
# Manager, independent of the Lambda's own lifecycle, so even a
# destroy+recreate never needs a repository-visible fallback value.
#
# vapid_claims_sub remains a plaintext Lambda env var — it's a contact
# `mailto:` URI (VAPID's required "sub" claim), not a secret, so moving it
# to Secrets Manager would add ceremony without a real security benefit.
variable "vapid_claims_sub" {
  description = "Real value for VAPID_CLAIMS_SUB (Web Push, Roadmap 4.6) — supplied at apply time, never committed"
  type        = string
  sensitive   = true

  validation {
    condition     = var.vapid_claims_sub != "REPLACE_ME_NOT_MANAGED_HERE" && length(var.vapid_claims_sub) > 0
    error_message = "vapid_claims_sub must be the real value, not the placeholder or empty."
  }
}
