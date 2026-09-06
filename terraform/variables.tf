variable "aws_region" {
  description = "AWS region all Yobi Analytics resources live in"
  type        = string
  default     = "ap-northeast-1"
}

# These 3 have no default and are validated against the placeholder string —
# `environment` is in every Lambda's own `ignore_changes`, so a plan/apply
# against the already-imported resources never actually applies these
# values, but a destroy+recreate (disaster recovery, a fresh account) would.
# Requiring a real value here means that scenario fails loudly on `apply`
# instead of silently deploying a known, repository-visible placeholder as
# a real admin key / VAPID credential. Supply real values once via a local
# terraform.tfvars (gitignored, never commit real secrets) — see
# terraform.tfvars.example.
variable "admin_api_key" {
  description = "Real value for YOBI_ADMIN_API_KEY — supplied at apply time, never committed"
  type        = string
  sensitive   = true

  validation {
    condition     = var.admin_api_key != "REPLACE_ME_NOT_MANAGED_HERE" && length(var.admin_api_key) > 0
    error_message = "admin_api_key must be the real admin key, not the placeholder or empty."
  }
}

variable "vapid_claims_sub" {
  description = "Real value for VAPID_CLAIMS_SUB (Web Push, Roadmap 4.6) — supplied at apply time, never committed"
  type        = string
  sensitive   = true

  validation {
    condition     = var.vapid_claims_sub != "REPLACE_ME_NOT_MANAGED_HERE" && length(var.vapid_claims_sub) > 0
    error_message = "vapid_claims_sub must be the real value, not the placeholder or empty."
  }
}

variable "vapid_private_key" {
  description = "Real value for VAPID_PRIVATE_KEY (Web Push, Roadmap 4.6) — supplied at apply time, never committed"
  type        = string
  sensitive   = true

  validation {
    condition     = var.vapid_private_key != "REPLACE_ME_NOT_MANAGED_HERE" && length(var.vapid_private_key) > 0
    error_message = "vapid_private_key must be the real value, not the placeholder or empty."
  }
}
