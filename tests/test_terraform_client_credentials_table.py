"""Static, text-level checks that terraform/dynamodb.tf declares the table client_credential_store.py reads/writes.

The store (src/stores/client_credential_store.py) writes {clientId, secretHash, createdAt} with a conditional PutItem
keyed on clientId alone and reads it back by GetItem on clientId. Production had no such table (V1 localhost
validation, 2026-10-09), so registration and every client-scoped route returned 500. These checks pin the
declared table to that exact contract; they are a textual substitute for `terraform validate`, not a replacement.
"""

from __future__ import annotations

import pathlib

from stores import client_credential_store

REPO_ROOT = pathlib.Path(__file__).resolve().parent.parent
DYNAMODB_TF = (REPO_ROOT / "terraform" / "dynamodb.tf").read_text()
LAMBDA_TF = (REPO_ROOT / "terraform" / "lambda.tf").read_text()


def _resource_block(source: str, resource_line: str) -> str:
    """Slice one `resource` block up to the next top-level resource (good enough for this repo's formatting)."""
    start = source.index(resource_line)
    next_resource = source.find('\nresource "', start + len(resource_line))
    return source[start : next_resource if next_resource != -1 else len(source)]


def _block() -> str:
    """The client_credentials table block."""
    return _resource_block(DYNAMODB_TF, 'resource "aws_dynamodb_table" "client_credentials"')


def test_table_name_is_declared():
    """The declared table carries the exact name the store defaults to."""
    assert 'name         = "YobiClientCredentials"' in _block()


def test_store_default_name_is_the_declared_table(monkeypatch):
    """With no override the store resolves to the declared table name."""
    monkeypatch.delenv("YOBI_CLIENT_CREDENTIALS_TABLE", raising=False)
    import importlib

    reloaded = importlib.reload(client_credential_store)
    try:
        assert reloaded.CLIENT_CREDENTIALS_TABLE == "YobiClientCredentials"
    finally:
        importlib.reload(client_credential_store)


def test_key_schema_is_client_id_hash_only():
    """Partition key clientId (string) and nothing else: the store never uses a sort key or any other key."""
    block = _block()
    assert 'hash_key     = "clientId"' in block
    assert "range_key" not in block
    assert block.count("attribute {") == 1
    assert 'name = "clientId"' in block
    assert 'type = "S"' in block


def test_no_unused_attribute_or_index_or_ttl_declared():
    """secretHash/createdAt stay schemaless; no GSI/LSI/TTL because the store never writes or queries them."""
    code_lines = [line for line in _block().splitlines() if not line.lstrip().startswith("#")]
    code = "\n".join(code_lines)
    for forbidden in ("secretHash", "createdAt", "global_secondary_index", "local_secondary_index", "ttl {"):
        assert forbidden not in code, forbidden


def test_follows_repo_table_conventions():
    """On-demand billing with the standard throughput cap, PITR and deletion protection like every other table."""
    block = _block()
    assert 'billing_mode = "PAY_PER_REQUEST"' in block
    assert "max_read_request_units  = 200" in block
    assert "max_write_request_units = 100" in block
    assert "point_in_time_recovery {" in block
    assert "enabled = true" in block
    assert "deletion_protection_enabled = true" in block


def test_api_lambda_needs_no_table_name_override():
    """The API Lambda keeps using the store default, so no YOBI_CLIENT_CREDENTIALS_TABLE is added to its environment."""
    api_block = _resource_block(LAMBDA_TF, 'resource "aws_lambda_function" "api"')
    assert "YOBI_CLIENT_CREDENTIALS_TABLE" not in api_block
