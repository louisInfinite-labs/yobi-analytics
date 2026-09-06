# yobi-analytics-scheduler-role's ARN is a hardcoded local in iam.tf
# (see the note there — yobi-analytics-cli has no IAM access, so its policy
# stays manually managed via root Console, not Terraform).

resource "aws_scheduler_schedule" "daily_collection" {
  name                          = "yobi-analytics-daily-collection"
  group_name                    = "default"
  schedule_expression           = "cron(0 18 * * ? *)"
  schedule_expression_timezone  = "Asia/Tokyo"

  flexible_time_window {
    mode = "OFF"
  }

  target {
    arn      = aws_lambda_function.collector.arn
    role_arn = local.scheduler_role_arn
  }
}

resource "aws_scheduler_schedule" "discovery_only" {
  name                          = "yobi-analytics-discovery-only"
  group_name                    = "default"
  schedule_expression           = "cron(0 0 * * ? *)"
  schedule_expression_timezone  = "Asia/Tokyo"

  flexible_time_window {
    mode = "OFF"
  }

  target {
    arn      = aws_lambda_function.collector.arn
    role_arn = local.scheduler_role_arn
    input    = jsonencode({ mode = "discovery_only" })
  }
}

resource "aws_scheduler_schedule" "trending_precompute" {
  name                          = "yobi-analytics-trending-precompute"
  group_name                    = "default"
  schedule_expression           = "cron(0 19 * * ? *)"
  schedule_expression_timezone  = "Asia/Tokyo"

  flexible_time_window {
    mode = "OFF"
  }

  target {
    arn      = aws_lambda_function.collector.arn
    role_arn = local.scheduler_role_arn
    input    = jsonencode({ mode = "precompute_trending", period = "1d" })
  }
}

resource "aws_scheduler_schedule" "trending_precompute_7d" {
  name                          = "yobi-analytics-trending-precompute-7d"
  group_name                    = "default"
  schedule_expression           = "cron(0 20 * * ? *)"
  schedule_expression_timezone  = "Asia/Tokyo"

  flexible_time_window {
    mode = "OFF"
  }

  target {
    arn      = aws_lambda_function.collector.arn
    role_arn = local.scheduler_role_arn
    input    = jsonencode({ mode = "precompute_trending", period = "7d" })
  }
}

resource "aws_scheduler_schedule" "trending_precompute_30d" {
  name                          = "yobi-analytics-trending-precompute-30d"
  group_name                    = "default"
  schedule_expression           = "cron(0 21 * * ? *)"
  schedule_expression_timezone  = "Asia/Tokyo"

  flexible_time_window {
    mode = "OFF"
  }

  target {
    arn      = aws_lambda_function.collector.arn
    role_arn = local.scheduler_role_arn
    input    = jsonencode({ mode = "precompute_trending", period = "30d" })
  }
}

resource "aws_scheduler_schedule" "notification_dispatch" {
  name                          = "yobi-analytics-notification-dispatch"
  group_name                    = "default"
  schedule_expression           = "rate(15 minutes)"
  schedule_expression_timezone  = "UTC"

  flexible_time_window {
    mode = "OFF"
  }

  target {
    arn      = aws_lambda_function.notification_dispatcher.arn
    role_arn = local.scheduler_role_arn
  }
}
