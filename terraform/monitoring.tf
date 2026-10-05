# SEC-AWS-004 (P0 launch alarms): API 5xx, API Lambda errors and API 429/throttling, delivered to a DEDICATED SNS topic.
#
# This topic is deliberately NOT aws_sns_topic.emergency_stop: that topic's subscriber is the emergency-stop Lambda, so
# routing an alarm there would throttle the API. Alarm thresholds are tunable launch values (variables.tf), not security
# invariants; the alarm CATEGORIES are what the launch gate requires.

resource "aws_sns_topic" "security_alarms" {
  name = "yobi-analytics-security-alarms"
  # No customer-managed key: CloudWatch alarms cannot publish to a topic encrypted with an AWS-managed key.
}

# Only created when an address is supplied; the owner must confirm the subscription email before alarms reach anyone.
resource "aws_sns_topic_subscription" "security_alarms_email" {
  count     = var.alarm_email == "" ? 0 : 1
  topic_arn = aws_sns_topic.security_alarms.arn
  protocol  = "email"
  endpoint  = var.alarm_email
}

# HTTP APIs expose no dedicated 429 metric (429s are part of the 4xx count), so the access log is the 429 signal.
resource "aws_cloudwatch_log_metric_filter" "api_throttled_429" {
  name           = "yobi-analytics-api-429"
  log_group_name = aws_cloudwatch_log_group.api_access.name
  pattern        = "{ $.status = \"429\" }"

  metric_transformation {
    name          = "Api429Count"
    namespace     = "YobiAnalytics/Security"
    value         = "1"
    default_value = "0"
  }
}

# --- Category 1: API 5xx -------------------------------------------------------------------------------------------

resource "aws_cloudwatch_metric_alarm" "api_5xx" {
  alarm_name          = "yobi-analytics-api-5xx"
  alarm_description   = "API Gateway 5xx responses (SEC-AWS-004)"
  namespace           = "AWS/ApiGateway"
  metric_name         = "5xx"
  dimensions          = { ApiId = aws_apigatewayv2_api.http_api.id, Stage = aws_apigatewayv2_stage.default.name }
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = var.alarm_api_5xx_threshold
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.security_alarms.arn]
}

# --- Category 2: Lambda errors -------------------------------------------------------------------------------------

resource "aws_cloudwatch_metric_alarm" "api_lambda_errors" {
  alarm_name          = "yobi-analytics-api-lambda-errors"
  alarm_description   = "API Lambda invocation errors (SEC-AWS-004)"
  namespace           = "AWS/Lambda"
  metric_name         = "Errors"
  dimensions          = { FunctionName = aws_lambda_function.api.function_name }
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = var.alarm_lambda_errors_threshold
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.security_alarms.arn]
}

# --- Category 3: API 429 / throttling ------------------------------------------------------------------------------

resource "aws_cloudwatch_metric_alarm" "api_throttled_429" {
  alarm_name          = "yobi-analytics-api-429"
  alarm_description   = "API Gateway 429 responses counted from the access log (SEC-AWS-004)"
  namespace           = "YobiAnalytics/Security"
  metric_name         = "Api429Count"
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = var.alarm_throttle_threshold
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.security_alarms.arn]
  depends_on          = [aws_cloudwatch_log_metric_filter.api_throttled_429]
}

resource "aws_cloudwatch_metric_alarm" "api_lambda_throttles" {
  alarm_name          = "yobi-analytics-api-lambda-throttles"
  alarm_description   = "API Lambda concurrency throttles (SEC-AWS-004)"
  namespace           = "AWS/Lambda"
  metric_name         = "Throttles"
  dimensions          = { FunctionName = aws_lambda_function.api.function_name }
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = var.alarm_throttle_threshold
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.security_alarms.arn]
}
