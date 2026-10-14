"""Static, text-level checks that terraform/dynamodb.tf declares the 3 tables Device Sync's stores read/write.

Same role as test_terraform_client_credentials_table.py: a textual substitute for `terraform validate`,
pinning the declared tables to pairing_token_store.py's/sync_profile_store.py's own exact key-schema contract.
"""

from __future__ import annotations

import pathlib

from stores import pairing_token_store, sync_profile_store

REPO_ROOT = pathlib.Path(__file__).resolve().parent.parent
DYNAMODB_TF = (REPO_ROOT / "terraform" / "dynamodb.tf").read_text()


def _resource_block(source: str, resource_line: str) -> str:
    start = source.index(resource_line)
    next_resource = source.find('\nresource "', start + len(resource_line))
    return source[start : next_resource if next_resource != -1 else len(source)]


def test_pairing_tokens_table_matches_the_store_contract():
    block = _resource_block(DYNAMODB_TF, 'resource "aws_dynamodb_table" "pairing_tokens"')
    assert f'name         = "{pairing_token_store.PAIRING_TOKENS_TABLE}"' in block
    assert 'hash_key     = "tokenHash"' in block
    assert "range_key" not in block
    assert f'name            = "{pairing_token_store.HUMAN_CODE_INDEX}"' in block
    assert 'hash_key        = "humanCodeHash"' in block
    assert 'attribute_name = "expiresAt"' in block
    assert "enabled        = true" in block
    assert "deletion_protection_enabled = true" in block


def test_sync_profiles_table_matches_the_store_contract():
    block = _resource_block(DYNAMODB_TF, 'resource "aws_dynamodb_table" "sync_profiles"')
    assert f'name         = "{sync_profile_store.SYNC_PROFILES_TABLE}"' in block
    assert 'hash_key     = "profileId"' in block
    assert "range_key" not in block
    assert "global_secondary_index" not in block
    assert "deletion_protection_enabled = true" in block


def test_sync_devices_table_matches_the_store_contract():
    block = _resource_block(DYNAMODB_TF, 'resource "aws_dynamodb_table" "sync_devices"')
    assert f'name         = "{sync_profile_store.SYNC_DEVICES_TABLE}"' in block
    assert 'hash_key     = "profileId"' in block
    assert 'range_key    = "deviceId"' in block
    assert f'name            = "{sync_profile_store.DEVICE_ID_INDEX}"' in block
    assert 'hash_key        = "deviceId"' in block
    assert "deletion_protection_enabled = true" in block


def test_every_device_sync_table_follows_repo_billing_conventions():
    for resource_name in ("pairing_tokens", "sync_profiles", "sync_devices"):
        block = _resource_block(DYNAMODB_TF, f'resource "aws_dynamodb_table" "{resource_name}"')
        assert 'billing_mode = "PAY_PER_REQUEST"' in block
        assert "max_read_request_units  = 200" in block
        assert "max_write_request_units = 100" in block
        assert "point_in_time_recovery {" in block
