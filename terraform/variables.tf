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

variable "api_access_log_retention_days" {
  description = "Retention for the API Gateway access-log group (SEC-AWS-001). Explicit so logs never default to never-expire; the final value follows the privacy retention decision."
  type        = number
  default     = 30

  validation {
    condition     = contains([1, 3, 5, 7, 14, 30, 60, 90, 120, 150, 180, 365], var.api_access_log_retention_days)
    error_message = "api_access_log_retention_days must be a retention value CloudWatch Logs accepts (1, 3, 5, 7, 14, 30, 60, 90, 120, 150, 180, 365)."
  }
}

variable "alarm_email" {
  description = "Email address subscribed to the dedicated launch-alarm SNS topic (SEC-AWS-004). Empty = topic and alarms are created without a subscription. The owner must confirm the subscription email."
  type        = string
  default     = ""
  sensitive   = true
}

variable "alarm_api_5xx_threshold" {
  description = "API Gateway 5xx responses in one evaluation period that raise the 5xx alarm. A tunable launch value, revisited from access logs."
  type        = number
  default     = 5
}

variable "alarm_lambda_errors_threshold" {
  description = "API Lambda errors in one evaluation period that raise the Lambda-errors alarm. A tunable launch value."
  type        = number
  default     = 3
}

variable "alarm_throttle_threshold" {
  description = "Throttled (429) responses or Lambda throttles in one evaluation period that raise the throttling alarms. A tunable launch value."
  type        = number
  default     = 20
}

# PROVISIONAL launch values (roadmap MT-14 stage 1): derived from the baseline section 20 formulas with N_design = 100,
# N_sync = 100, headroom h_r = 2 and no client jitter (the larger burst column). They are NOT final: stage 2 replaces
# them with values grounded in real access-log evidence (gate E-1) after access logging has run. rate = sustained average
# (requests/second); burst = bucket capacity for one wave. An empty map applies no per-route settings.
variable "launch_route_throttles" {
  description = "Per-route API Gateway throttles for the launch route set (SEC-API-003). Keys are exact route keys."
  type = map(object({
    rate  = number
    burst = number
  }))
  default = {
    "GET /live-streams"                        = { rate = 4, burst = 60 }
    "GET /recent-streams"                      = { rate = 1, burst = 5 }
    "POST /heartbeat"                          = { rate = 4, burst = 60 }
    "GET /creators/{creatorId}/videos/recent"  = { rate = 1, burst = 90 }
    "GET /creators/{creatorId}/videos/ranking" = { rate = 1, burst = 90 }
    "GET /creators/{creatorId}/oshi-status"    = { rate = 1, burst = 90 }
    "POST /clients/{clientId}/credential"      = { rate = 1, burst = 40 }
    "POST /remote-config"                      = { rate = 1, burst = 5 }
    "GET /admin/heartbeat-stats"               = { rate = 1, burst = 5 }
  }

  validation {
    condition     = alltrue([for route, s in var.launch_route_throttles : s.rate >= 1 && s.burst >= s.rate])
    error_message = "Every launch route throttle needs rate >= 1 and burst >= rate."
  }
}

# SEC-API-005 /live-streams upstream protection (ADR-001). Launch defaults, chosen from the acceptable Live Status delay
# (the web app polls about once a minute); tunable from the metrics the API logs. None is derived from a provider quota.
variable "live_streams_refresh_window_seconds" {
  description = "A refresh of the shared /live-streams cache happens at most once per window."
  type        = number
  default     = 30
  validation {
    condition     = var.live_streams_refresh_window_seconds > 0
    error_message = "live_streams_refresh_window_seconds must be positive."
  }
}

variable "live_streams_max_stale_seconds" {
  description = "Bounded stale-if-error: the oldest cached result that may be served when Holodex fails or is cooling down."
  type        = number
  default     = 300
  validation {
    condition     = var.live_streams_max_stale_seconds >= var.live_streams_refresh_window_seconds
    error_message = "live_streams_max_stale_seconds must be at least live_streams_refresh_window_seconds."
  }
}

variable "live_streams_cooldown_base_seconds" {
  description = "First shared cooldown after an upstream 429 when no Retry-After is sent."
  type        = number
  default     = 30
  validation {
    condition     = var.live_streams_cooldown_base_seconds > 0
    error_message = "live_streams_cooldown_base_seconds must be positive."
  }
}

variable "live_streams_cooldown_max_seconds" {
  description = "Ceiling on the shared 429 cooldown (exponential growth stops here)."
  type        = number
  default     = 300
  validation {
    condition     = var.live_streams_cooldown_max_seconds >= var.live_streams_cooldown_base_seconds
    error_message = "live_streams_cooldown_max_seconds must be at least live_streams_cooldown_base_seconds."
  }
}

variable "live_streams_retry_attempts" {
  description = "Extra upstream attempts inside ONE refresh operation (never per client request). 0 = none."
  type        = number
  default     = 0
  validation {
    condition     = var.live_streams_retry_attempts >= 0 && var.live_streams_retry_attempts <= 3
    error_message = "live_streams_retry_attempts must be between 0 and 3."
  }
}

variable "live_streams_retry_backoff_seconds" {
  description = "Exponential backoff base between attempts inside one refresh (with jitter)."
  type        = number
  default     = 1
  validation {
    condition     = var.live_streams_retry_backoff_seconds >= 0
    error_message = "live_streams_retry_backoff_seconds must be non-negative."
  }
}

variable "live_streams_refresh_deadline_seconds" {
  description = "Hard total deadline for one refresh operation (attempts plus backoff)."
  type        = number
  default     = 20
  validation {
    condition     = var.live_streams_refresh_deadline_seconds > 0
    error_message = "live_streams_refresh_deadline_seconds must be positive."
  }
}
