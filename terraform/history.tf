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
    ]
  })
}

resource "aws_sfn_state_machine" "daily_history" {
  name     = "yobi-analytics-daily-history"
  role_arn = aws_iam_role.history_orchestrator.arn

  definition = jsonencode({
    StartAt = "CollectHistoryShards"
    States = {
      CollectHistoryShards = {
        Type           = "Map"
        ItemsPath      = "$.shards"
        MaxConcurrency = 4
        ItemSelector = {
          "shard.$" = "$$.Map.Item.Value"
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
                  "shard.$"     = "$.shard"
                  "startedAt.$" = "$$.Execution.StartTime"
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
        Next = "ReduceRankings"
      }
      ReduceRankings = {
        Type       = "Task"
        Resource   = "arn:aws:states:::lambda:invoke"
        Parameters = {
          FunctionName = aws_lambda_function.ranking_reducer.arn
          Payload = {
            "startedAt.$" = "$$.Execution.StartTime"
          }
        }
        OutputPath = "$.Payload"
        End        = true
      }
    }
  })
}
