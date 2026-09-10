resource "aws_dynamodb_table" "heartbeat" {
  name         = "YobiHeartbeat"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "clientId"

  attribute {
    name = "clientId"
    type = "S"
  }

  on_demand_throughput {
    max_read_request_units  = 200
    max_write_request_units = 100
  }

  point_in_time_recovery {
    enabled = true
  }

  deletion_protection_enabled = true
}

resource "aws_dynamodb_table" "history_execution_lock" {
  name         = "YobiHistoryExecutionLock"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "reportDate"

  # Only reportDate is declared here -- it's the only attribute this table's
  # key schema (or an index) actually references. ownerToken/status/
  # currentPhase/expiresAt/completedShards/lastError/acquiredAt/renewedAt/
  # completedAt/ttlAt are ordinary schemaless item attributes written by
  # src/execution_lock.py; declaring any of them as their own `attribute`
  # block here (with no index using them) is rejected by the AWS provider
  # as an unused attribute definition.
  attribute {
    name = "reportDate"
    type = "S"
  }

  on_demand_throughput {
    max_read_request_units  = 200
    max_write_request_units = 100
  }

  # ttlAt (epoch seconds) is written by execution_lock.mark_execution_complete/
  # mark_execution_failed, ~30 days out -- background cleanup only, never
  # consulted by acquire_execution_lock's own mutual-exclusion logic.
  ttl {
    attribute_name = "ttlAt"
    enabled        = true
  }

  point_in_time_recovery {
    enabled = true
  }

  deletion_protection_enabled = true
}

resource "aws_dynamodb_table" "notification_delivery_log" {
  name         = "YobiNotificationDeliveryLog"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "clientId"
  range_key    = "videoId"

  attribute {
    name = "clientId"
    type = "S"
  }

  attribute {
    name = "videoId"
    type = "S"
  }

  on_demand_throughput {
    max_read_request_units  = 200
    max_write_request_units = 100
  }

  point_in_time_recovery {
    enabled = true
  }

  deletion_protection_enabled = true
}

resource "aws_dynamodb_table" "notification_events" {
  name         = "YobiNotificationEvents"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "eventDate"
  range_key    = "videoId"

  attribute {
    name = "eventDate"
    type = "S"
  }

  attribute {
    name = "videoId"
    type = "S"
  }

  on_demand_throughput {
    max_read_request_units  = 200
    max_write_request_units = 100
  }

  point_in_time_recovery {
    enabled = true
  }

  deletion_protection_enabled = true
}

resource "aws_dynamodb_table" "remote_config" {
  name         = "YobiRemoteConfig"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "clientId"
  range_key    = "configKey"

  attribute {
    name = "clientId"
    type = "S"
  }

  attribute {
    name = "configKey"
    type = "S"
  }

  on_demand_throughput {
    max_read_request_units  = 200
    max_write_request_units = 100
  }

  point_in_time_recovery {
    enabled = true
  }

  deletion_protection_enabled = true
}

resource "aws_dynamodb_table" "run_summaries" {
  name         = "YobiRunSummaries"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "snapshotDate"

  attribute {
    name = "snapshotDate"
    type = "S"
  }

  on_demand_throughput {
    max_read_request_units  = 200
    max_write_request_units = 100
  }

  point_in_time_recovery {
    enabled = true
  }

  deletion_protection_enabled = true
}

resource "aws_dynamodb_table" "snapshots" {
  name         = "YobiSnapshots"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "videoId"
  range_key    = "snapshotDate"

  attribute {
    name = "videoId"
    type = "S"
  }

  attribute {
    name = "snapshotDate"
    type = "S"
  }

  on_demand_throughput {
    max_read_request_units  = 200
    max_write_request_units = 100
  }

  point_in_time_recovery {
    enabled = true
  }

  deletion_protection_enabled = true
}

resource "aws_dynamodb_table" "trending_cache" {
  name         = "YobiTrendingCache"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "cacheKey"

  attribute {
    name = "cacheKey"
    type = "S"
  }

  on_demand_throughput {
    max_read_request_units  = 200
    max_write_request_units = 100
  }

  point_in_time_recovery {
    enabled = true
  }

  deletion_protection_enabled = true
}

resource "aws_dynamodb_table" "video_master" {
  name         = "YobiVideoMaster"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "videoId"

  attribute {
    name = "videoId"
    type = "S"
  }

  attribute {
    name = "creatorId"
    type = "S"
  }

  global_secondary_index {
    name            = "creatorId-index"
    hash_key        = "creatorId"
    projection_type = "ALL"
  }

  on_demand_throughput {
    max_read_request_units  = 200
    max_write_request_units = 100
  }

  point_in_time_recovery {
    enabled = true
  }

  deletion_protection_enabled = true
}
