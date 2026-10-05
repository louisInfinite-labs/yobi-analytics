# Terraform manages configuration only. Code deployment stays on the existing
# `aws lambda update-function-code` flow from Roadmap 2.2, so `filename` here
# never has to match the real deployed package.
locals {
  lambda_placeholder_zip = "${path.module}/placeholder.zip"
}

# AWS Cost Recovery (third pass, Scope I): every *_SSM_PARAMETER variable
# below is PREPARED ONLY -- see ops/config.py's own module docstring for the
# code-side precedence (SSM checked first, falling back to the existing
# *_SECRET_NAME/plaintext path unchanged). DO NOT apply this file's
# *_SSM_PARAMETER additions until, in this exact order:
#   1. The real SSM SecureString parameter is created (manual, live AWS --
#      this repo's own IAM/secret provisioning has always been done outside
#      Terraform; see iam.tf's own comments).
#   2. yobi-analytics-lambda-role is granted ssm:GetParameter on that
#      parameter's ARN (manual, live AWS -- same reasoning).
#   3. Only then apply this Terraform change.
#   4. Verify the Lambda still starts and the relevant call succeeds.
# Applying step 3 before steps 1-2 would make the affected Lambda try to
# read a parameter that doesn't exist yet (or lacks permission), breaking
# production -- this is why these lines exist here as documentation of the
# prepared change, not as something to apply blindly alongside everything
# else in this pass. The old *_SECRET_NAME variable is deliberately left in
# place alongside the new one (not removed) for the same reason: it's the
# rollback path if the new one needs to be reverted.
locals {
  ssm_parameter_prepared_not_applied = {
    youtube_api_key   = "/yobi-analytics/youtube-api-key"
    admin_api_key     = "/yobi-analytics/admin-api-key"
    vapid_private_key = "/yobi-analytics/vapid-private-key"
  }
}

resource "aws_lambda_function" "collector" {
  function_name = "yobi-analytics-collector"
  role          = local.lambda_role_arn
  handler       = "api.lambda_handler.lambda_handler"
  runtime       = "python3.12"
  timeout       = 900
  memory_size   = 1024
  filename      = local.lambda_placeholder_zip

  environment {
    variables = {
      YOUTUBE_API_KEY_SECRET_NAME = "yobi-analytics/youtube-api-key"
      # YOUTUBE_API_KEY_SSM_PARAMETER = local.ssm_parameter_prepared_not_applied.youtube_api_key
      YOBI_DATA_DIR        = "/tmp"
      YOBI_HISTORY_BUCKET  = aws_s3_bucket.history.id
      YOBI_STORAGE_BACKEND = "dynamodb"
    }
  }

  lifecycle {
    ignore_changes = [filename, source_code_hash]
  }
}

resource "aws_lambda_function" "history_worker" {
  function_name = "yobi-analytics-history-worker"
  role          = local.lambda_role_arn
  handler       = "api.history_worker_handler.lambda_handler"
  runtime       = "python3.12"
  timeout       = 900
  memory_size   = 2048
  filename      = local.lambda_placeholder_zip

  environment {
    variables = {
      YOUTUBE_API_KEY_SECRET_NAME = "yobi-analytics/youtube-api-key"
      # YOUTUBE_API_KEY_SSM_PARAMETER = local.ssm_parameter_prepared_not_applied.youtube_api_key
      YOBI_HISTORY_BUCKET = aws_s3_bucket.history.id
    }
  }

  lifecycle {
    ignore_changes = [filename, source_code_hash]
  }
}

resource "aws_lambda_function" "ranking_reducer" {
  function_name = "yobi-analytics-ranking-reducer"
  role          = local.lambda_role_arn
  handler       = "analytics.ranking_reducer.lambda_handler"
  runtime       = "python3.12"
  timeout       = 900
  memory_size   = 2048
  filename      = local.lambda_placeholder_zip

  # R9 (org-trending retirement): YOBI_STORAGE_BACKEND/YOBI_TRENDING_CACHE_
  # TABLE/YOBI_VIDEO_MASTER_TABLE removed -- this Lambda's only remaining
  # work (execution-lock renewal, video-ranking Phase C) is entirely
  # S3-based (YOBI_HISTORY_BUCKET) and never touches DynamoDB.
  environment {
    variables = {
      YOBI_HISTORY_BUCKET = aws_s3_bucket.history.id
    }
  }

  lifecycle {
    ignore_changes = [filename, source_code_hash]
  }
}

resource "aws_lambda_function" "api" {
  function_name = "yobi-analytics-api"
  role          = local.lambda_role_arn
  handler       = "api.api_handler.lambda_handler"
  runtime       = "python3.12"
  timeout       = 60
  memory_size   = 1024
  filename      = local.lambda_placeholder_zip
  # Codifies the live value (confirmed intentional, 2026-09-13) -- was
  # previously undeclared here, so terraform wanted to strip it back to
  # the unreserved default (-1) on every plan/apply, unrelated to any
  # actual config change anyone made.
  reserved_concurrent_executions = 50

  environment {
    variables = {
      YOBI_ADMIN_API_KEY_SECRET_NAME = "yobi-analytics/admin-api-key"
      # YOBI_ADMIN_API_KEY_SSM_PARAMETER = local.ssm_parameter_prepared_not_applied.admin_api_key
      YOBI_STORAGE_BACKEND = "dynamodb"
      # No history-bucket variable here on purpose: the read paths (video-ranking, subscriber-ranking,
      # Oshi Status) resolve the fixed bucket through stores.history_bucket, where the env var is only
      # an optional override. Keeping it out of this block means deploying the API needs no change to
      # this Lambda's live environment.
      HOLODEX_SECRET_NAME = "yobi-analytics/holodex-api-key"
      # SEC-API-005: /live-streams upstream-protection parameters. Configuration, not code constants; none is derived from
      # a provider quota. The in-code defaults equal these variable defaults, so an unset value behaves identically.
      LIVE_STREAMS_REFRESH_WINDOW_SECONDS   = tostring(var.live_streams_refresh_window_seconds)
      LIVE_STREAMS_MAX_STALE_SECONDS        = tostring(var.live_streams_max_stale_seconds)
      LIVE_STREAMS_COOLDOWN_BASE_SECONDS    = tostring(var.live_streams_cooldown_base_seconds)
      LIVE_STREAMS_COOLDOWN_MAX_SECONDS     = tostring(var.live_streams_cooldown_max_seconds)
      LIVE_STREAMS_RETRY_ATTEMPTS           = tostring(var.live_streams_retry_attempts)
      LIVE_STREAMS_RETRY_BACKOFF_SECONDS    = tostring(var.live_streams_retry_backoff_seconds)
      LIVE_STREAMS_REFRESH_DEADLINE_SECONDS = tostring(var.live_streams_refresh_deadline_seconds)
    }
  }

  # `environment` is deliberately NOT in ignore_changes here (unlike
  # collector/notification_dispatcher's original reasoning) -- CodeRabbit
  # (PR #25) correctly pointed out that ignoring it meant `apply` could
  # never actually push the *_SECRET_NAME migration to the live Lambda; the
  # old plaintext values would keep being used by the runtime's fallback
  # path forever. 2026-09-07: the live Lambda was already manually aligned
  # to exactly this config via `aws lambda update-function-configuration`,
  # so removing this is a no-op today (confirmed via `terraform plan`) and
  # only changes what happens the next time this config changes.
  lifecycle {
    ignore_changes = [filename, source_code_hash]
  }
}

resource "aws_lambda_function" "notification_dispatcher" {
  function_name = "yobi-analytics-notification-dispatcher"
  role          = local.lambda_role_arn
  handler       = "notifications.notification_dispatcher.lambda_handler"
  runtime       = "python3.12"
  timeout       = 60
  memory_size   = 512
  filename      = local.lambda_placeholder_zip

  environment {
    variables = {
      VAPID_CLAIMS_SUB              = var.vapid_claims_sub
      VAPID_PRIVATE_KEY_SECRET_NAME = "yobi-analytics/vapid-private-key"
      # VAPID_PRIVATE_KEY_SSM_PARAMETER = local.ssm_parameter_prepared_not_applied.vapid_private_key
    }
  }

  # See aws_lambda_function.api's own comment above -- same reasoning.
  lifecycle {
    ignore_changes = [filename, source_code_hash]
  }
}

resource "aws_lambda_function" "emergency_stop" {
  function_name = "yobi-analytics-emergency-stop"
  role          = local.emergency_stop_role_arn
  handler       = "lambda_function.lambda_handler"
  runtime       = "python3.13"
  timeout       = 3
  memory_size   = 128
  filename      = local.lambda_placeholder_zip

  lifecycle {
    ignore_changes = [filename, source_code_hash]
  }
}
