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
        Principal = { AWS = local.scheduler_role_arn }
        Action    = "sqs:SendMessage"
        Resource  = aws_sqs_queue.scheduler_dlq.arn
      }
    ]
  })
}

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

# 2026-09-07: moved off the 19:00-21:00 JST evening window and split each
# period into 2 batches (_PRECOMPUTE_BATCH_COUNT, trending_precompute.py) --
# not because of memory (each invocation's memory is flat regardless of
# batch size, confirmed against the real Lambda) but for two other reasons:
# 1. 01:00-03:00 JST is this project's lowest-traffic window, away from
#    the 00:00 discovery_only trigger and the 18:00 daily_collection run
#    on the same Lambda -- this account's Lambda concurrency quota is
#    stuck at 10 (account-wide, shared across every function), so keeping
#    invocations spread out and off-peak reduces the chance of a live API
#    request getting throttled by a concurrent precompute run.
# 2. Batching halves each invocation's duration (~120s instead of ~240s
#    for the current 112-creator roster) -- pure headroom against the
#    roster continuing to grow (more agencies, more clip/highlight
#    channels) well before any single invocation approaches the 900s
#    Lambda timeout again.
#
# Each batch within a period is spaced 30 minutes apart (batch_index * 30)
# -- exactly Lambda's own hard maximum single-invocation duration (900s =
# 15 minutes), doubled. Even a future invocation that runs the full 900s
# (the absolute worst case, not just today's ~120s) still finishes with
# 15 minutes to spare before the next batch's scheduled start, so two
# batches can never overlap and contend for a concurrency slot at once --
# a tighter gap (the original 10 minutes) would only guarantee that at
# today's much smaller duration, not as the roster keeps growing.
locals {
  _PRECOMPUTE_BATCH_COUNT = 2

  precompute_schedule_times = {
    "1d"  = { hour = 1, base_minute = 0 }
    "7d"  = { hour = 2, base_minute = 0 }
    "30d" = { hour = 3, base_minute = 0 }
  }

  precompute_batches = {
    for pair in flatten([
      for period, timing in local.precompute_schedule_times : [
        for batch_index in range(local._PRECOMPUTE_BATCH_COUNT) : {
          key         = "${period}-${batch_index}"
          period      = period
          hour        = timing.hour
          minute      = timing.base_minute + batch_index * 30
          batch_index = batch_index
        }
      ]
    ]) : pair.key => pair
  }
}

resource "aws_scheduler_schedule" "trending_precompute_batches" {
  for_each = local.precompute_batches

  name                          = "yobi-analytics-trending-precompute-${each.value.period}-batch${each.value.batch_index}"
  group_name                    = "default"
  schedule_expression           = "cron(${each.value.minute} ${each.value.hour} * * ? *)"
  schedule_expression_timezone  = "Asia/Tokyo"

  flexible_time_window {
    mode = "OFF"
  }

  target {
    arn      = aws_lambda_function.collector.arn
    role_arn = local.scheduler_role_arn
    input = jsonencode({
      mode            = "precompute_trending"
      period          = each.value.period
      batchIndex      = each.value.batch_index
      batchCount      = local._PRECOMPUTE_BATCH_COUNT
      includeOrgScope = each.value.batch_index == 0
    })

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
