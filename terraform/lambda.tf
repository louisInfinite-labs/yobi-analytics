# Terraform manages configuration only. Code deployment stays on the existing
# `aws lambda update-function-code` flow from Roadmap 2.2, so `filename` here
# never has to match the real deployed package.
locals {
  lambda_placeholder_zip = "${path.module}/placeholder.zip"
}

# Runtime secrets live in SSM Parameter Store (SecureString, Standard tier) -- the old Secrets Manager secrets cost $0.40/month each plus API
# calls. Lambda environments carry only the parameter NAMES below (locators), never a value; the values were created out-of-band (a script that
# copies them in memory from Secrets Manager, never printing them) and are never in Terraform variables or state.
#
# TRANSITION STAGE 1: every function keeps its old *_SECRET_NAME locator next to the new *_SSM_PARAMETER one. ops/config.py reads SSM first and
# uses the old secret only when the parameter does not exist yet or this role cannot read it yet (it logs `secret source: ... source=ssm|
# secretsmanager`). The role itself (yobi-analytics-lambda-role) is managed by hand in the IAM console, never by Terraform; the statement it needs
# is terraform/manual-iam/policy-lambda-ssm-parameter-read.json. STAGE 2 (separate change, after every consumer logs source=ssm) drops the
# *_SECRET_NAME lines, the fallback code and the secretsmanager:GetSecretValue permissions.
locals {
  ssm_parameter_names = {
    youtube_api_key   = "/yobi-analytics/youtube-api-key"
    admin_api_key     = "/yobi-analytics/admin-api-key"
    vapid_private_key = "/yobi-analytics/vapid-private-key"
    holodex_api_key   = "/yobi-analytics/holodex-api-key"
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
      YOUTUBE_API_KEY_SECRET_NAME   = "yobi-analytics/youtube-api-key"
      YOUTUBE_API_KEY_SSM_PARAMETER = local.ssm_parameter_names.youtube_api_key
      YOBI_DATA_DIR                 = "/tmp"
      YOBI_HISTORY_BUCKET           = aws_s3_bucket.history.id
      YOBI_STORAGE_BACKEND          = "dynamodb"
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
      YOUTUBE_API_KEY_SECRET_NAME   = "yobi-analytics/youtube-api-key"
      YOUTUBE_API_KEY_SSM_PARAMETER = local.ssm_parameter_names.youtube_api_key
      YOBI_HISTORY_BUCKET           = aws_s3_bucket.history.id
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
      YOBI_ADMIN_API_KEY_SECRET_NAME   = "yobi-analytics/admin-api-key"
      YOBI_ADMIN_API_KEY_SSM_PARAMETER = local.ssm_parameter_names.admin_api_key
      YOBI_STORAGE_BACKEND             = "dynamodb"
      # No history-bucket variable here on purpose: the read paths (video-ranking, subscriber-ranking,
      # Oshi Status) resolve the fixed bucket through stores.history_bucket, where the env var is only
      # an optional override. Keeping it out of this block means deploying the API needs no change to
      # this Lambda's live environment.
      HOLODEX_SECRET_NAME   = "yobi-analytics/holodex-api-key"
      HOLODEX_SSM_PARAMETER = local.ssm_parameter_names.holodex_api_key
      # The LOCATOR of the existing YouTube key (never the key): GET /live-streams classifies a still-unclassified UPCOMING stream with the
      # collector's own classifier (Holodex lists a YouTube Premiere like a stream), read at runtime through ops.config.get_api_key() from the
      # same secret the collector uses. The role needs secretsmanager:GetSecretValue on that one secret
      # (terraform/manual-iam/policy-lambda-youtube-key-read.json). Without it the lookup fails open and is logged.
      YOUTUBE_API_KEY_SECRET_NAME   = "yobi-analytics/youtube-api-key"
      YOUTUBE_API_KEY_SSM_PARAMETER = local.ssm_parameter_names.youtube_api_key
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
      VAPID_CLAIMS_SUB                = var.vapid_claims_sub
      VAPID_PRIVATE_KEY_SECRET_NAME   = "yobi-analytics/vapid-private-key"
      VAPID_PRIVATE_KEY_SSM_PARAMETER = local.ssm_parameter_names.vapid_private_key
      # Every dispatcher run builds the reminder schedule through read_api.get_live_streams(): that needs the Holodex key locator, the
      # DynamoDB storage backend (Video Master classification join) and the YouTube key locator (unclassified upcoming streams), the same
      # three locators/switch the API Lambda uses. Locators only -- no key value is ever in the environment.
      YOBI_STORAGE_BACKEND          = "dynamodb"
      HOLODEX_SECRET_NAME           = "yobi-analytics/holodex-api-key"
      HOLODEX_SSM_PARAMETER         = local.ssm_parameter_names.holodex_api_key
      YOUTUBE_API_KEY_SECRET_NAME   = "yobi-analytics/youtube-api-key"
      YOUTUBE_API_KEY_SSM_PARAMETER = local.ssm_parameter_names.youtube_api_key
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
