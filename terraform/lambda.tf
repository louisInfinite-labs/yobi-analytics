# Terraform manages configuration only. Code deployment stays on the existing
# `aws lambda update-function-code` flow from Roadmap 2.2, so `filename` here
# never has to match the real deployed package.
locals {
  lambda_placeholder_zip = "${path.module}/placeholder.zip"
}

resource "aws_lambda_function" "collector" {
  function_name = "yobi-analytics-collector"
  role          = local.lambda_role_arn
  handler       = "lambda_handler.lambda_handler"
  runtime       = "python3.12"
  timeout       = 900
  memory_size   = 1024
  filename      = local.lambda_placeholder_zip

  environment {
    variables = {
      YOUTUBE_API_KEY_SECRET_NAME = "yobi-analytics/youtube-api-key"
      YOBI_DATA_DIR                = "/tmp"
      YOBI_STORAGE_BACKEND          = "dynamodb"
    }
  }

  lifecycle {
    ignore_changes = [filename, source_code_hash, environment]
  }
}

resource "aws_lambda_function" "api" {
  function_name = "yobi-analytics-api"
  role          = local.lambda_role_arn
  handler       = "api_handler.lambda_handler"
  runtime       = "python3.12"
  timeout       = 60
  memory_size   = 1024
  filename      = local.lambda_placeholder_zip

  environment {
    variables = {
      YOBI_ADMIN_API_KEY_SECRET_NAME = "yobi-analytics/admin-api-key"
      YOBI_STORAGE_BACKEND           = "dynamodb"
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
  handler       = "notification_dispatcher.lambda_handler"
  runtime       = "python3.12"
  timeout       = 60
  memory_size   = 512
  filename      = local.lambda_placeholder_zip

  environment {
    variables = {
      VAPID_CLAIMS_SUB             = var.vapid_claims_sub
      VAPID_PRIVATE_KEY_SECRET_NAME = "yobi-analytics/vapid-private-key"
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
