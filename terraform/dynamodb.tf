# Per-client secret hashes (src/stores/client_credential_store.py): one item per
# clientId -- {clientId, secretHash, createdAt} -- written by a conditional
# PutItem and read by GetItem only. The store's default table name
# ("YobiClientCredentials") is what the API Lambda uses (no
# YOBI_CLIENT_CREDENTIALS_TABLE override is set), so no Lambda environment
# change is needed. Without this table POST /clients/{id}/credential and every
# client-scoped route (push-subscription, notification-preference, reminders)
# fail with ResourceNotFoundException -> 500.
# secretHash/createdAt are ordinary schemaless attributes, deliberately not
# declared (no index references them). No TTL: the store never writes one.
resource "aws_dynamodb_table" "client_credentials" {
  name         = "YobiClientCredentials"
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

# Slot-recipient index for scheduled new-video delivery (src/stores/notification_slot_store.py): one item per
# (IANA time zone, local half-hour slot, client) the client chose, so the 30-minute dispatcher asks "who is due at this slot?" with a
# bounded Query instead of reading every stored notification preference. slotKey is "<IANA zone>|<local slot 00..47>"
# (notifications.delivery_slots.zone_slot_key): the key is the client's LOCAL time in its own zone, so a daylight-saving change or a
# moved device never needs a re-index -- the dispatcher works out, per zone, which local slots a tick starts. The partition slotKey =
# "zones" is a small registry (clientId = the zone name) of the zones that have recipients. Both live in this one table and use the
# same two key attributes, so no schema change was needed when delivery times became local (rows of the first release, whose slotKey was
# the bare JST slot, are re-keyed by scripts/migration/backfill_notification_slots.py).
# The remote-config table's configKey-index cannot answer this: it can only list EVERY client that stored a notificationPreference,
# and a client has up to four slots.
# clientId-index lists one client's own items so a changed or cancelled selection removes exactly its stale ones. The other item
# attributes (zone, slot, activeSince) are ordinary schemaless attributes, so only the key attributes are declared.
resource "aws_dynamodb_table" "notification_delivery_slots" {
  name         = "YobiNotificationDeliverySlots"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "slotKey"
  range_key    = "clientId"

  attribute {
    name = "slotKey"
    type = "S"
  }

  attribute {
    name = "clientId"
    type = "S"
  }

  global_secondary_index {
    name            = "clientId-index"
    hash_key        = "clientId"
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

  # AWS Cost Recovery (production-path audit): remote_config_store.list_by_key
  # used to be a table-wide Scan+FilterExpression to answer "every client that
  # has ever stored this configKey" (e.g. the notification dispatcher's own
  # "notificationPreference" lookup, every 15 minutes) -- O(total clients),
  # the exact same failure class as VideoMaster's old full-catalog scan, just
  # on a different scaling axis. This GSI makes that a bounded Query instead:
  # RCU now scales with how many clients actually stored that one key, never
  # with the whole table.
  global_secondary_index {
    name            = "configKey-index"
    hash_key        = "configKey"
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

# R9 (org-trending retirement): aws_dynamodb_table.trending_cache
# (YobiTrendingCache) was removed here -- its only writer
# (analytics.ranking_reducer.persist_rankings) and only readers
# (api.read_api.get_creator_trending/get_organization_trending) were both
# retired. NOT YET APPLIED: this table has deletion_protection_enabled = true
# in the real deployed resource, so an actual `terraform apply` of this
# removal will fail until that protection is disabled on the live table
# first (see this task's own final report for the exact manual step).

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

# Home Topic Catalog: the SINGLE SOURCE OF TRUTH for which video topics exist (ids, display order, zh-TW/en/ja labels, search aliases).
# Partition catalog_id="GLOBAL" holds the approved topics (one Query serves the whole list, never a YobiVideoMaster scan); a separate
# catalog_id="REVIEW" partition holds unreviewed candidates that nothing in this repo reads or promotes. The backend only READS this
# table (stores/topic_catalog_store.py -> tracking/video_topics.py); the records are curated by hand and are never written, seeded or
# reconciled from code.
#
# This table was created by hand in the console (2026-10-15) and then brought under Terraform with `terraform import`; the settings
# below describe it exactly as it is, so a plan shows no change for it. Deletion protection and point-in-time recovery are OFF today --
# both are cheap and worth turning on, but that is a deliberate change to a live table, made separately, not as a side effect here.
# The Lambda role's read access is the inline policy `YobiTopicCatalogAccess` (terraform/manual-iam/).
resource "aws_dynamodb_table" "topic_catalog" {
  name         = "YobiTopicCatalog"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "catalog_id"
  range_key    = "topic_tag"

  attribute {
    name = "catalog_id"
    type = "S"
  }

  attribute {
    name = "topic_tag"
    type = "S"
  }

  point_in_time_recovery {
    enabled = false
  }

  deletion_protection_enabled = false
}
