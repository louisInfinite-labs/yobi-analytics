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
# (fixed JST half-hour slot, client) the client chose, so the 30-minute dispatcher asks "who is due at this slot?" with a bounded
# Query instead of reading every stored notification preference. slotKey is the plain "00".."47" JST slot (notifications.delivery_slots.
# slot_key) -- there is no per-time-zone key or zone registry; every delivery slot is Asia/Tokyo wall-clock (see delivery_slots.py).
# The remote-config table's configKey-index cannot answer this: it can only list EVERY client that stored a notificationPreference,
# and a client has up to four slots.
# clientId-index lists one client's own items so a changed or cancelled selection removes exactly its stale ones. The other item
# attributes (slot, activeSince) are ordinary schemaless attributes, so only the key attributes are declared.
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

# Device Sync (src/stores/pairing_token_store.py): one item per pairing session, keyed by tokenHash
# (the QR's own secret, hashed -- never the raw value). humanCodeHash is looked up via the GSI below so
# a scanned QR and a typed code both resolve to the same session item. expiresAt is a TTL attribute:
# background cleanup only, same role as history_execution_lock's ttlAt -- the store's own
# get_live_session_by_* functions check it directly rather than trusting TTL deletion to be instant.
# consumed/consumedAt/profileId/createdByDeviceId are ordinary schemaless attributes.
resource "aws_dynamodb_table" "pairing_tokens" {
  name         = "YobiPairingTokens"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "tokenHash"

  attribute {
    name = "tokenHash"
    type = "S"
  }

  attribute {
    name = "humanCodeHash"
    type = "S"
  }

  global_secondary_index {
    name            = "humanCodeHash-index"
    hash_key        = "humanCodeHash"
    projection_type = "ALL"
  }

  ttl {
    attribute_name = "expiresAt"
    enabled        = true
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

# Device Sync (src/stores/sync_profile_store.py): one bare item per Sync Profile -- {profileId, createdAt}.
# Carries no preference data of its own; synced preference VALUES reuse the existing remote_config
# table/routes with profileId in place of a lone device's own clientId (see api_handler.py's /sync/*
# routes' own module-level comment).
resource "aws_dynamodb_table" "sync_profiles" {
  name         = "YobiSyncProfiles"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "profileId"

  attribute {
    name = "profileId"
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

# Device Sync (src/stores/sync_profile_store.py): one item per device attached to a Sync Profile,
# keyed by (profileId, deviceId). deviceId-index answers "which profile is MY deviceId attached to",
# the reverse lookup every device needs before it can read/write its shared preferences --
# without this GSI that would be an unbounded Scan across every profile's devices.
resource "aws_dynamodb_table" "sync_devices" {
  name         = "YobiSyncDevices"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "profileId"
  range_key    = "deviceId"

  attribute {
    name = "profileId"
    type = "S"
  }

  attribute {
    name = "deviceId"
    type = "S"
  }

  global_secondary_index {
    name            = "deviceId-index"
    hash_key        = "deviceId"
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
