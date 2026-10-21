"""The scheduled-start in-memory world, with every DynamoDB-shaped operation the dispatcher performs recorded.

Used to assert cost properties, not just outcomes: what an idle minute reads, what a due minute reads, and that none of it grows with the number of
registered clients. Operations are recorded as tuples whose first element is the kind:

    ("get", clientId, key)          remote_config_store.get_remote_config (a GetItem)
    ("list_by_key", key)            remote_config_store.list_by_key (a configKey-index Query)
    ("list_prefix", clientId, prefix)  list_remote_config_by_prefix (a Query of one client's partition)
    ("put", clientId, key)          a plain or conditional PutItem on the config table
    ("delete", clientId, key)       a DeleteItem on the config table
    ("delivery_read", clientId, id) a GetItem on the delivery log
    ("delivery_write", clientId, id) a PutItem / DeleteItem on the delivery log
"""

from __future__ import annotations

from tests.notifications.test_scheduled_start_notifications import Harness


class CountingHarness(Harness):
    """Harness + an `ops` log of every storage operation."""

    def __init__(self, monkeypatch):
        """Wire the base world, then start with an empty log."""
        self.ops: list[tuple] = []
        super().__init__(monkeypatch)

    # ---- config table
    def _get_config(self, client_id, key):
        """Record, then answer."""
        self.ops.append(("get", client_id, key))
        return super()._get_config(client_id, key)

    def _list_by_key(self, key):
        """Record, then answer."""
        self.ops.append(("list_by_key", key))
        return super()._list_by_key(key)

    def _list_by_prefix(self, client_id, prefix):
        """Record, then answer."""
        self.ops.append(("list_prefix", client_id, prefix))
        return super()._list_by_prefix(client_id, prefix)

    def _put_config(self, record):
        """Record, then store."""
        self.ops.append(("put", record["clientId"], record["key"]))
        return super()._put_config(record)

    def _put_config_if_newer(self, record, *, revision):
        """Record the attempt (the inner store call records the put), then apply the condition."""
        return super()._put_config_if_newer(record, revision=revision)

    def _put_config_versioned(self, record, *, expected_version):
        """Record, then apply the compare-and-set."""
        self.ops.append(("put", record["clientId"], record["key"]))
        current = self.config.get((record["clientId"], record["key"]))
        if expected_version is None:
            if current is not None:
                return False
        elif current is None or current.get("version") != expected_version:
            return False
        self.config[(record["clientId"], record["key"])] = record["value"]
        return True

    def _delete_config(self, client_id, key):
        """Record, then delete."""
        self.ops.append(("delete", client_id, key))
        return super()._delete_config(client_id, key)

    # ---- delivery log
    def _already_delivered(self, client_id, video_id, *, now=None):
        """Record, then answer."""
        self.ops.append(("delivery_read", client_id, video_id))
        return super()._already_delivered(client_id, video_id, now=now)

    def _row_status(self, client_id, video_id, *, now=None):
        """Record, then answer."""
        self.ops.append(("delivery_read", client_id, video_id))
        return super()._row_status(client_id, video_id, now=now)

    def _handled_within(self, client_id, video_id, within, *, now=None):
        """Record, then answer."""
        self.ops.append(("delivery_read", client_id, video_id))
        return super()._handled_within(client_id, video_id, within, now=now)

    def _mark_delivered(self, client_id, video_id, claimed_at, *, now=None):
        """Record, then claim."""
        self.ops.append(("delivery_write", client_id, video_id))
        return super()._mark_delivered(client_id, video_id, claimed_at, now=now)

    def _confirm_delivered(self, client_id, video_id, delivered_at):
        """Record, then confirm."""
        self.ops.append(("delivery_write", client_id, video_id))
        return super()._confirm_delivered(client_id, video_id, delivered_at)

    def _release_claim(self, client_id, video_id):
        """Record, then release."""
        self.ops.append(("delivery_write", client_id, video_id))
        return super()._release_claim(client_id, video_id)

    # ---- helpers for assertions
    def take_ops(self) -> list[tuple]:
        """The operations recorded since the last call (and clear the log)."""
        taken, self.ops = self.ops, []
        return taken

    def clients_touched(self, ops: list[tuple]) -> set[str]:
        """Every real client (not the system record) a get / prefix query / delivery operation named."""
        return {op[1] for op in ops if op[0] != "list_by_key" and op[1] != "__system__"}
