import pytest

from stores import notification_delivery_log_store


@pytest.fixture(autouse=True)
def stub_delivered_lookup(monkeypatch):
    """The dispatcher reads a client's delivery log in bulk (delivered_video_ids). Most notification tests declare "already
    delivered" per (client, video) by patching already_delivered, so by default the bulk read is answered from whatever
    already_delivered is patched to at call time -- the same answers through the one new read path. Tests of the bulk read
    itself patch delivered_video_ids directly."""
    monkeypatch.setattr(
        notification_delivery_log_store,
        "delivered_video_ids",
        lambda client_id, video_ids, *, now=None: {v for v in video_ids if notification_delivery_log_store.already_delivered(client_id, v)},
    )
