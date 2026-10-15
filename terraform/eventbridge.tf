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
        Effect = "Allow"
        Principal = {
          AWS = [
            local.scheduler_role_arn,
            local.history_scheduler_role_arn,
          ]
        }
        Action   = "sqs:SendMessage"
        Resource = aws_sqs_queue.scheduler_dlq.arn
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

# PHASE B cutover (prepared, not yet applied -- PB1): retargeted from the
# legacy collector Lambda to the new daily_history Step Functions state
# machine, using the history-scheduler role (states:StartExecution on this
# exact state machine only -- see terraform/manual-iam/policy-history-
# scheduler.json). Same schedule name and 18:00 Asia/Tokyo timing as
# before; only the target changed. `input` supplies $.shards directly on
# the execution's raw input -- history.tf's own ValidateShardsInput state
# reads it via "shards.$" = "$.shards" before any other state runs, so it
# must be present here, not derived internally. Rollback is reverting
# `target` back to {arn = aws_lambda_function.collector.arn, role_arn =
# local.scheduler_role_arn, no input}.
resource "aws_scheduler_schedule" "daily_collection" {
  name                         = "yobi-analytics-daily-collection"
  group_name                   = "default"
  schedule_expression          = "cron(0 18 * * ? *)"
  schedule_expression_timezone = "Asia/Tokyo"

  flexible_time_window {
    mode = "OFF"
  }

  target {
    arn      = aws_sfn_state_machine.daily_history.arn
    role_arn = local.history_scheduler_role_arn
    input    = jsonencode({ shards = range(16) })

    dead_letter_config {
      arn = aws_sqs_queue.scheduler_dlq.arn
    }
  }
}

# The centralized new-video discovery windows (JST): one collector invocation per window, each a discovery-only run of the whole roster
# (never per subscriber) that records the new-video events the 30-minute dispatcher below delivers from. THIS LIST MIRRORS
# DISCOVERY_WINDOWS_JST in src/tracking/discovery_windows.py -- tests/test_discovery_windows_schedule.py fails if they drift, so change
# both together. Cost: one uploads-playlist read per discovery-enabled creator per window.
locals {
  discovery_windows_jst = {
    "0000" = "00:00"
    "0900" = "09:00"
    "1300" = "13:00"
    "2000" = "20:00"
    "2200" = "22:00"
  }
}

# The existing single 00:00 schedule becomes the "0000" window under its ORIGINAL name, so it is updated in place (it gains the `window`
# input) rather than destroyed and recreated; the other four windows are new.
moved {
  from = aws_scheduler_schedule.discovery_only
  to   = aws_scheduler_schedule.discovery_window["0000"]
}

resource "aws_scheduler_schedule" "discovery_window" {
  for_each = local.discovery_windows_jst

  name                         = each.key == "0000" ? "yobi-analytics-discovery-only" : "yobi-analytics-discovery-${each.key}"
  group_name                   = "default"
  schedule_expression          = "cron(${tonumber(split(":", each.value)[1])} ${tonumber(split(":", each.value)[0])} * * ? *)"
  schedule_expression_timezone = "Asia/Tokyo"

  flexible_time_window {
    mode = "OFF"
  }

  target {
    arn      = aws_lambda_function.collector.arn
    role_arn = local.scheduler_role_arn
    input    = jsonencode({ mode = "discovery_only", window = each.key })

    dead_letter_config {
      arn = aws_sqs_queue.scheduler_dlq.arn
    }
  }
}

# R7 (AWS Cost Recovery): the trending_precompute_batches schedules (and
# their local.precompute_batches/_PRECOMPUTE_BATCH_COUNT locals) that used to
# live here were removed -- they had already been Terraform-disabled
# (state = "DISABLED") since the new ranking_reducer pipeline took over as
# YobiTrendingCache's real production writer, and analytics/trending_
# precompute.py (the code they targeted) was deleted in the same pass.

# Single-stream/creator live-reminder spec section 8/10 (prepared, NOT applied):
# the product's own reminder options include "1min"/"10min" -- the previous
# rate(15 minutes) could only ever honour those roughly (up to ~14 minutes
# late). Lowered to rate(1 minute) so notification_dispatcher.py's own
# _REMINDER_WINDOW (now 1 minute, kept equal to this rate -- see that
# module's docstring) can actually catch a reminder at its configured
# offset instead of merely eventually. Cost/frequency tradeoff, deliberately
# not evaluated further here (out of this change's scope): this is a 15x
# increase in invocations/Holodex /users/live calls per day.
resource "aws_scheduler_schedule" "notification_dispatch" {
  name                         = "yobi-analytics-notification-dispatch"
  group_name                   = "default"
  schedule_expression          = "rate(1 minute)"
  schedule_expression_timezone = "UTC"

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

# Scheduled new-video delivery: ONE shared dispatcher every 15 minutes, at UTC :00/:15/:30/:45. Delivery times are the user's own local
# :00/:30 (src/notifications/delivery_slots.py) and every IANA zone's UTC offset is a multiple of 15 minutes (+05:45 Nepal, +12:45
# Chatham ...), so every local slot start lands exactly on one of these ticks: 08:00 Kathmandu is delivered at 08:00, not 08:15. Still one
# schedule for everybody -- no per-user scheduler -- and 96 tiny runs a day. It is a `mode` of the same notification dispatcher Lambda the 1-minute reminder schedule above
# invokes; the mode routes it to src/notifications/new_video_dispatcher.py before any reminder work. The input must stay a plain string:
# jsonencode would escape the angle brackets and the Scheduler would then not substitute its context attribute, which carries the
# scheduled time the run serves (a run that starts a few seconds late stays in its own slot). A failed run is retried at most
# twice and only within an hour, so a retry can never serve a long-passed slot.
resource "aws_scheduler_schedule" "new_video_dispatch" {
  name                         = "yobi-analytics-new-video-dispatch"
  group_name                   = "default"
  schedule_expression          = "cron(0/15 * * * ? *)"
  schedule_expression_timezone = "UTC"

  flexible_time_window {
    mode = "OFF"
  }

  target {
    arn      = aws_lambda_function.notification_dispatcher.arn
    role_arn = local.scheduler_role_arn
    input    = "{\"mode\":\"new_video_slots\",\"scheduledTime\":\"<aws.scheduler.scheduled-time>\"}"

    retry_policy {
      maximum_retry_attempts       = 2
      maximum_event_age_in_seconds = 3600
    }

    dead_letter_config {
      arn = aws_sqs_queue.scheduler_dlq.arn
    }
  }
}

# Livestream completion lifecycle (SOURCE IMPLEMENTATION CHECKPOINT -- not yet applied, see
# tracking/livestream_lifecycle.py): every 5 minutes is this feature's own refresh cadence, independent of
# notification_dispatch's 1-minute/15-minute cadence above, which serves a different concern (reminder timing) and
# is not touched by this schedule. AWS-aware verification (2026-10-13) confirmed no schedule of this name exists
# yet (`aws scheduler list-schedules --group-name default`) -- no collision, no duplicate poller introduced. The
# scheduler role additionally needs lambda:InvokeFunction on the new function's ARN below -- out of this Terraform
# project's scope (manual IAM console grant, same precedent as the DLQ grant's own comment above) -- this genuinely
# cannot be granted or verified until this is applied, since the function doesn't exist yet to name in that grant.
resource "aws_scheduler_schedule" "livestream_lifecycle_refresh" {
  name                         = "yobi-analytics-livestream-lifecycle-refresh"
  group_name                   = "default"
  schedule_expression          = "rate(5 minutes)"
  schedule_expression_timezone = "UTC"

  flexible_time_window {
    mode = "OFF"
  }

  target {
    arn      = aws_lambda_function.livestream_lifecycle.arn
    role_arn = local.scheduler_role_arn

    dead_letter_config {
      arn = aws_sqs_queue.scheduler_dlq.arn
    }
  }
}

# Livestream DISPLAY refresh: every minute, the same Lambda as above with {"mode":"display"}. This is what makes a
# newly started stream visible within about a minute; the 5-minute completion lifecycle above is untouched (its own
# snapshot, pending-candidate set and 12-attempt retry window are not shared with this job). One aggregate Holodex
# request per run with a persisted shared cooldown on failure (tracking/livestream_lifecycle.py), so the upstream rate
# is capped at 1,440 requests/day regardless of how many browser tabs are open. Re-uses the existing scheduler role
# (it already holds lambda:InvokeFunction on this function, as the 5-minute schedule works) and the shared DLQ; a run
# that cannot start within 2 minutes is dropped rather than retried, since the next minute's run supersedes it.
resource "aws_scheduler_schedule" "livestream_display_refresh" {
  name                         = "yobi-analytics-livestream-display-refresh"
  group_name                   = "default"
  schedule_expression          = "rate(1 minute)"
  schedule_expression_timezone = "UTC"

  flexible_time_window {
    mode = "OFF"
  }

  target {
    arn      = aws_lambda_function.livestream_lifecycle.arn
    role_arn = local.scheduler_role_arn
    input    = "{\"mode\":\"display\"}"

    retry_policy {
      maximum_retry_attempts       = 1
      maximum_event_age_in_seconds = 120
    }

    dead_letter_config {
      arn = aws_sqs_queue.scheduler_dlq.arn
    }
  }
}
