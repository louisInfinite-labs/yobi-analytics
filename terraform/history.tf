resource "aws_s3_bucket" "history" {
  bucket_prefix = "yobi-analytics-history-"
  force_destroy = false
}

resource "aws_s3_bucket_versioning" "history" {
  bucket = aws_s3_bucket.history.id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "history" {
  bucket = aws_s3_bucket.history.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_public_access_block" "history" {
  bucket                  = aws_s3_bucket.history.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_iam_role" "history_orchestrator" {
  name = "yobi-analytics-history-orchestrator"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "states.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy" "history_orchestrator" {
  name = "InvokeHistoryWorkers"
  role = aws_iam_role.history_orchestrator.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Action = "lambda:InvokeFunction"
      Resource = [
        aws_lambda_function.history_worker.arn,
        aws_lambda_function.ranking_reducer.arn,
      ]
    }]
  })
}

resource "aws_iam_role" "history_scheduler" {
  name = "yobi-analytics-history-scheduler"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "scheduler.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy" "history_scheduler" {
  name = "StartDailyHistoryCollection"
  role = aws_iam_role.history_scheduler.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = "states:StartExecution"
        Resource = aws_sfn_state_machine.daily_history.arn
      },
      {
        Effect   = "Allow"
        Action   = "sqs:SendMessage"
        Resource = aws_sqs_queue.scheduler_dlq.arn
      },
    ]
  })
}

resource "aws_iam_role_policy" "lambda_history_access" {
  name = "YobiHistoryStorage"
  role = "yobi-analytics-lambda-role"
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "s3:GetObject",
          "s3:PutObject",
        ]
        Resource = "${aws_s3_bucket.history.arn}/*"
      },
      {
        Effect = "Allow"
        Action = [
          "dynamodb:GetItem",
          "dynamodb:PutItem",
        ]
        Resource = [
          aws_dynamodb_table.video_master.arn,
          aws_dynamodb_table.trending_cache.arn,
        ]
      },
      {
        # execution_lock.py's own operations: acquire is a conditional
        # PutItem, renew/mark_execution_complete/mark_execution_failed are
        # conditional UpdateItems -- no GetItem/DeleteItem is ever issued
        # against this table (a COMPLETE/FAILED row is updated in place,
        # never read back or deleted; DynamoDB's own TTL sweep removes it
        # later using an AWS-internal service principal, not this role), so
        # neither is granted here.
        Effect = "Allow"
        Action = [
          "dynamodb:PutItem",
          "dynamodb:UpdateItem",
        ]
        Resource = aws_dynamodb_table.history_execution_lock.arn
      },
    ]
  })
}

resource "aws_sfn_state_machine" "daily_history" {
  name     = "yobi-analytics-daily-history"
  role_arn = aws_iam_role.history_orchestrator.arn

  definition = jsonencode({
    StartAt = "ValidateShardsInput"
    # Confirmed execution-lock design: bounds the whole execution against a
    # pathological worst case where every CollectShard Task in every one of
    # the Map's 4 sequential MaxConcurrency batches exhausts its full Retry
    # budget (4 attempts * 900s + 30s + 60s + 120s = 3810s per shard * 4
    # batches ~= 15240s), plus ValidateShardsInput/AcquireExecutionLock/
    # ReduceRankings/MarkExecutionComplete each up to their own 900s Lambda
    # timeout (~3600s) -- roughly 18840s (~5.23h) total -- with headroom to
    # 21600s (6h). A top-level TimeoutSeconds fails the whole execution with
    # States.Timeout and does not run any state's own Catch (not even
    # MarkExecutionFailed's) -- recovery from that specific case relies
    # entirely on execution_lock's own lease expiry (at most 90 minutes
    # after the last per-shard renewal, or 45 minutes into ReduceRankings),
    # comfortably before the next day's own 24h-later scheduled trigger.
    TimeoutSeconds = 21600
    States = {
      # Roadmap 5.3 cost/abuse containment: the Map below reads its whole
      # shard list from $.shards, which is this execution's own input
      # (terraform/eventbridge.tf's scheduled trigger always supplies
      # range(16), but StartExecution isn't restricted to that) — not a
      # value baked into this definition. Without this state, a malformed
      # or adversarial execution input (e.g. thousands of repeated shard
      # entries) would fan out into that many Lambda invocations and Step
      # Functions transitions before any per-shard validation ever got a
      # chance to reject or short-circuit a single one of them. Reuses
      # history_worker's own Lambda (history_worker_handler.lambda_handler
      # branches on `shards` vs `validatedShards` vs `shard`) rather than
      # deploying a second function. Deliberately has no Retry: a bad
      # shards array should fail this execution once, not retry the same
      # rejection three times.
      ValidateShardsInput = {
        Type       = "Task"
        Resource   = "arn:aws:states:::lambda:invoke"
        Parameters = {
          FunctionName = aws_lambda_function.history_worker.arn
          Payload = {
            "shards.$" = "$.shards"
          }
        }
        # ResultPath = "$" (spelled out explicitly, though it's ASL's own
        # default) replaces the whole state input with the raw lambda:invoke
        # result {"Payload": <this Lambda's return value>, ...}; OutputPath
        # then extracts just .Payload as this state's entire output. Since
        # history_worker_handler.lambda_handler's `shards` branch returns
        # exactly {"shards": [...]} (validated/normalized), this state's
        # output IS {"shards": [...]} — so AcquireExecutionLock's own
        # "validatedShards.$" = "$.shards" still resolves correctly
        # afterward. test_lambda_handler_validates_a_shards_event_without_
        # any_other_setup (tests/test_history_architecture.py) pins that
        # exact return shape, since this data flow depends on it. Not
        # ResultPath = null: null would discard this Lambda's result and
        # pass the ORIGINAL, unvalidated $.shards straight through,
        # silently skipping the validation this state exists to enforce.
        ResultPath = "$"
        OutputPath = "$.Payload"
        Next       = "AcquireExecutionLock"
      }
      # Confirmed execution-lock design: claims exclusive rights to this
      # reportDate before the Map below ever fans out, and canonicalizes
      # reportDate exactly once -- CollectHistoryShards' ItemSelector,
      # ReduceRankings, MarkExecutionComplete and MarkExecutionFailed all
      # forward the same $.reportDate/$.ownerToken this state produces,
      # rather than any of them re-deriving "today" independently.
      # `executionInput.$` = "$$.Execution.Input" (the whole original
      # StartExecution input, however it was shaped), not
      # "$$.Execution.Input.date"/"$$.Execution.Input.forceRecovery"
      # directly: those are optional, and an ASL `.$` reference to a path
      # that doesn't exist on the input fails to resolve at all --
      # history_worker_handler._acquire_execution_lock does the .get("date")
      # / .get("forceRecovery", False) itself instead.
      AcquireExecutionLock = {
        Type       = "Task"
        Resource   = "arn:aws:states:::lambda:invoke"
        Parameters = {
          FunctionName = aws_lambda_function.history_worker.arn
          Payload = {
            "executionInput.$"  = "$$.Execution.Input"
            "validatedShards.$" = "$.shards"
            "executionId.$"     = "$$.Execution.Id"
            "startedAt.$"       = "$$.Execution.StartTime"
          }
        }
        ResultPath = "$"
        OutputPath = "$.Payload"
        # No Retry: a rejected acquire (someone else already legitimately
        # holds this reportDate) must fail this execution once, not retry
        # a rejection that will keep being a rejection. execution_lock.
        # ExecutionLockHeldError is this Lambda's own raised exception class
        # name, not one of CollectShard's Retry-covered invocation-level
        # errors, so it reaches this Catch on the very first attempt.
        Catch = [{
          ErrorEquals = ["ExecutionLockHeldError"]
          Next        = "ExecutionLockHeld"
        }]
        Next = "CollectHistoryShards"
      }
      CollectHistoryShards = {
        Type           = "Map"
        ItemsPath      = "$.shards"
        MaxConcurrency = 4
        ItemSelector = {
          "shard.$"      = "$$.Map.Item.Value"
          "reportDate.$" = "$.reportDate"
          "ownerToken.$" = "$.ownerToken"
        }
        ItemProcessor = {
          ProcessorConfig = {
            Mode = "INLINE"
          }
          StartAt = "CollectShard"
          States = {
            CollectShard = {
              Type       = "Task"
              Resource   = "arn:aws:states:::lambda:invoke"
              Parameters = {
                FunctionName = aws_lambda_function.history_worker.arn
                Payload = {
                  "shard.$"      = "$.shard"
                  "reportDate.$" = "$.reportDate"
                  "ownerToken.$" = "$.ownerToken"
                }
              }
              Retry = [{
                ErrorEquals     = ["Lambda.ServiceException", "Lambda.TooManyRequestsException", "States.TaskFailed"]
                IntervalSeconds = 30
                MaxAttempts     = 3
                BackoffRate     = 2
              }]
              OutputPath = "$.Payload"
              End        = true
            }
          }
        }
        # ResultPath (not the ASL default of "$") keeps $.reportDate/
        # $.ownerToken from AcquireExecutionLock intact alongside this Map's
        # own per-shard results -- ReduceRankings/MarkExecutionComplete/
        # MarkExecutionFailed all still need those two fields afterward.
        ResultPath = "$.shardResults"
        Catch = [{
          ErrorEquals = ["States.ALL"]
          ResultPath  = "$.error"
          Next        = "MarkExecutionFailed"
        }]
        Next = "ReduceRankings"
      }
      ReduceRankings = {
        Type       = "Task"
        Resource   = "arn:aws:states:::lambda:invoke"
        Parameters = {
          FunctionName = aws_lambda_function.ranking_reducer.arn
          Payload = {
            "reportDate.$" = "$.reportDate"
            "ownerToken.$" = "$.ownerToken"
          }
        }
        # Same reasoning as CollectHistoryShards' own ResultPath: preserves
        # $.reportDate/$.ownerToken for MarkExecutionComplete afterward,
        # rather than replacing the whole state input with this Task's own
        # (unrelated-shaped) {"date":..., "cacheWrites":...} result.
        ResultPath = "$.reduceResult"
        Catch = [{
          ErrorEquals = ["States.ALL"]
          ResultPath  = "$.error"
          Next        = "MarkExecutionFailed"
        }]
        Next = "MarkExecutionComplete"
      }
      # Never a delete -- see execution_lock.mark_execution_complete's own
      # docstring for why a COMPLETE row must stay in place (so a normal,
      # non-repair re-run of an already-finished reportDate is rejected by
      # AcquireExecutionLock, not silently allowed to re-run the reducer).
      MarkExecutionComplete = {
        Type       = "Task"
        Resource   = "arn:aws:states:::lambda:invoke"
        Parameters = {
          FunctionName = aws_lambda_function.ranking_reducer.arn
          Payload = {
            "markCompleteForDate.$" = "$.reportDate"
            "ownerToken.$"          = "$.ownerToken"
          }
        }
        OutputPath = "$.Payload"
        End        = true
      }
      # Catch target for both CollectHistoryShards and ReduceRankings.
      # Always transitions to Fail next, whether this Task itself succeeds
      # or fails (e.g. ExecutionLockLostError, if this owner's lease was
      # already reclaimed by someone else) -- so a secondary conditional-
      # write error here can never mask the original pipeline failure that
      # is already carried in $.error from the Catch that led here.
      MarkExecutionFailed = {
        Type       = "Task"
        Resource   = "arn:aws:states:::lambda:invoke"
        Parameters = {
          FunctionName = aws_lambda_function.ranking_reducer.arn
          Payload = {
            "markFailedForDate.$" = "$.reportDate"
            "ownerToken.$"        = "$.ownerToken"
            "error.$"             = "$.error"
          }
        }
        Catch = [{
          ErrorEquals = ["States.ALL"]
          Next        = "Fail"
        }]
        Next = "Fail"
      }
      Fail = {
        Type  = "Fail"
        Error = "HistoryExecutionFailed"
      }
      # Distinct from MarkExecutionFailed/Fail: an execution that never
      # acquired the lock in the first place must never attempt an
      # owner-conditional cleanup write against a row it doesn't own.
      ExecutionLockHeld = {
        Type  = "Fail"
        Error = "ExecutionLockHeld"
      }
    }
  })
}
