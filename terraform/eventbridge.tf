# yobi-analytics-scheduler-role's ARN is a hardcoded local in iam.tf
# (see the note there — yobi-analytics-cli has no IAM access, so its policy
# stays manually managed via root Console, not Terraform).

# 2026-09-07 CodeRabbit PR #25 finding: every schedule below omitted
# dead_letter_config, so a target invocation that exhausts EventBridge
# Scheduler's own retries just vanished — no durable record that a day's
# collection/precompute/notification run never actually happened. One
# shared queue (not one per schedule) keeps this simple; a failed message
# still carries which schedule/input produced it, so failures remain
# distinguishable without needing six separate queues. Granted via a queue
# policy naming the existing scheduler role directly, rather than editing
# that role's own IAM policy (out of this Terraform project's scope — see
# iam.tf).
resource "aws_sqs_queue" "scheduler_dlq" {
  name                      = "yobi-analytics-scheduler-dlq"
  message_retention_seconds = 1209600 # 14 days (SQS max) -- long enough to notice and investigate a failure
}

resource "aws_sqs_queue_policy" "scheduler_dlq_allow_scheduler_role" {
  queue_url = aws_sqs_queue.scheduler_dlq.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect    = "Allow"
        Principal = {
          AWS = [
            local.scheduler_role_arn,
            aws_iam_role.history_scheduler.arn,
          ]
        }
        Action    = "sqs:SendMessage"
        Resource  = aws_sqs_queue.scheduler_dlq.arn
      }
    ]
  })
}

# CodeRabbit (PR #25) correctly points out that AWS's own docs describe the
# DLQ grant as belonging on the *execution role's own identity policy*, not
# (only) a resource-based queue policy like the one above -- same-account
# access generally works with either, but this is the officially documented
# shape. `sqs:SendMessage` on this queue's ARN has been added directly to
# `yobi-analytics-scheduler-role` via root Console (2026-09-07,
# `AllowSchedulerDlqSendMessage`, matching this project's existing
# `InvokeYobiCollector`/`InvokeYobiNotificationDispatcher` naming) -- not
# reflected here because IAM role policy content is out of this Terraform
# project's scope entirely (see iam.tf's own note: yobi-analytics-cli has no
# IAM access at all, not even read).

resource "aws_scheduler_schedule" "daily_collection" {
  name                          = "yobi-analytics-daily-collection"
  group_name                    = "default"
  schedule_expression           = "cron(0 18 * * ? *)"
  schedule_expression_timezone  = "Asia/Tokyo"

  flexible_time_window {
    mode = "OFF"
  }

  target {
    arn      = aws_sfn_state_machine.daily_history.arn
    role_arn = aws_iam_role.history_scheduler.arn
    input    = jsonencode({ shards = range(16) })

    dead_letter_config {
      arn = aws_sqs_queue.scheduler_dlq.arn
    }
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

    dead_letter_config {
      arn = aws_sqs_queue.scheduler_dlq.arn
    }
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

    dead_letter_config {
      arn = aws_sqs_queue.scheduler_dlq.arn
    }
  }
}
