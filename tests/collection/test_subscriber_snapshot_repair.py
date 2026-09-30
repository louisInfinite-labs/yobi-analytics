"""Tests for collection.subscriber_snapshot.collect_subscriber_snapshot_if_missing
(ranking-simplification, R3 correction 2026-09-29, then the bounded same-
invocation retry correction) -- roster-completeness-based repair, replacing
the earlier "object exists -> skip forever" behavior that could permanently
seal a partial/empty snapshot from a transient failure, plus a single bounded
in-invocation retry pass for still-missing channels (production isolates
subscriber failures so the video-history workflow always completes, so there
is no guarantee of a second Lambda invocation the same day to repair a
partial result later).
"""

from datetime import date
from unittest.mock import MagicMock

import boto3
import pytest
from moto import mock_aws

from collection.subscriber_snapshot import collect_subscriber_snapshot_if_missing
from collection.youtube_client import QuotaExhaustedError
from stores.subscriber_history_store import S3SubscriberHistoryStore, SubscriberRow
from tracking.creator_master import Creator

BUCKET = "test-history-bucket"
REGION = "ap-northeast-1"
DAY = date(2026, 9, 29)
OBSERVED_AT = "2026-09-29T18:00:00+09:00"


def _creator(creator_id: str, channel_id: str) -> Creator:
    return Creator(
        creator_id=creator_id,
        display_name=creator_id,
        organization="hololive",
        youtube_channel_id=channel_id,
        active=True,
        branch="holo_jp",
        group_key=["NO"],
        channel_type="member",
        lifecycle_stage="active",
        display_order=1,
    )


def _make_channels_client(response):
    youtube = MagicMock()
    youtube.channels.return_value.list.return_value.execute.return_value = response
    return youtube


@pytest.fixture
def s3_store(aws_credentials):
    with mock_aws():
        client = boto3.client("s3", region_name=REGION)
        client.create_bucket(Bucket=BUCKET, CreateBucketConfiguration={"LocationConstraint": REGION})
        yield S3SubscriberHistoryStore(BUCKET, s3_client=client)


# --- complete existing snapshot -----------------------------------------------


def test_complete_existing_snapshot_skips_youtube_entirely(s3_store):
    creators = [_creator("creator_a", "UC_a"), _creator("creator_b", "UC_b")]
    s3_store.write_daily_snapshot(
        DAY,
        [
            SubscriberRow(creator_id="creator_a", subscriber_count=100, hidden_subscriber_count=False, observed_at=OBSERVED_AT),
            SubscriberRow(creator_id="creator_b", subscriber_count=None, hidden_subscriber_count=True, observed_at=OBSERVED_AT),
        ],
    )
    youtube = MagicMock()

    key, skip_reasons, collected = collect_subscriber_snapshot_if_missing(
        youtube, creators, collection_date=DAY, observed_at=OBSERVED_AT, store=s3_store
    )

    assert collected is False
    assert skip_reasons == {}
    assert key == "subscriber-history/date=2026-09-29.parquet"
    youtube.channels.assert_not_called()


# --- empty existing snapshot ---------------------------------------------------


def test_empty_existing_snapshot_fetches_every_roster_creator(s3_store):
    creators = [_creator("creator_a", "UC_a"), _creator("creator_b", "UC_b")]
    s3_store.write_daily_snapshot(DAY, [])  # a prior total-failure attempt sealed an empty object
    response = {
        "items": [
            {"id": "UC_a", "statistics": {"subscriberCount": "100", "hiddenSubscriberCount": False}},
            {"id": "UC_b", "statistics": {"subscriberCount": "200", "hiddenSubscriberCount": False}},
        ]
    }
    youtube = _make_channels_client(response)

    key, skip_reasons, collected = collect_subscriber_snapshot_if_missing(
        youtube, creators, collection_date=DAY, observed_at=OBSERVED_AT, store=s3_store
    )

    assert collected is True
    assert skip_reasons == {}
    rows = {row.creator_id: row for row in s3_store.read_daily_snapshot(DAY)}
    assert rows["creator_a"].subscriber_count == 100
    assert rows["creator_b"].subscriber_count == 200


def test_no_existing_snapshot_at_all_behaves_like_empty(s3_store):
    creators = [_creator("creator_a", "UC_a")]
    response = {"items": [{"id": "UC_a", "statistics": {"subscriberCount": "1", "hiddenSubscriberCount": False}}]}
    youtube = _make_channels_client(response)

    key, skip_reasons, collected = collect_subscriber_snapshot_if_missing(
        youtube, creators, collection_date=DAY, observed_at=OBSERVED_AT, store=s3_store
    )

    assert collected is True
    rows = s3_store.read_daily_snapshot(DAY)
    assert len(rows) == 1


# --- partial existing snapshot: only missing creators are fetched -----------


def test_partial_existing_snapshot_fetches_only_the_missing_creators(s3_store):
    creators = [_creator("creator_a", "UC_a"), _creator("creator_b", "UC_b"), _creator("creator_c", "UC_c")]
    s3_store.write_daily_snapshot(
        DAY, [SubscriberRow(creator_id="creator_a", subscriber_count=100, hidden_subscriber_count=False, observed_at=OBSERVED_AT)]
    )
    response = {
        "items": [
            {"id": "UC_b", "statistics": {"subscriberCount": "200", "hiddenSubscriberCount": False}},
            {"id": "UC_c", "statistics": {"subscriberCount": "300", "hiddenSubscriberCount": False}},
        ]
    }
    youtube = _make_channels_client(response)

    key, skip_reasons, collected = collect_subscriber_snapshot_if_missing(
        youtube, creators, collection_date=DAY, observed_at=OBSERVED_AT, store=s3_store
    )

    assert collected is True
    requested_ids = youtube.channels.return_value.list.call_args.kwargs["id"].split(",")
    assert sorted(requested_ids) == ["UC_b", "UC_c"]  # UC_a (already observed) never re-requested
    rows = {row.creator_id: row for row in s3_store.read_daily_snapshot(DAY)}
    assert rows["creator_a"].subscriber_count == 100  # untouched, exact same value preserved
    assert rows["creator_b"].subscriber_count == 200
    assert rows["creator_c"].subscriber_count == 300


# --- retry where some missing creators recover, some don't ------------------


def test_retry_where_some_missing_creators_recover_merges_partial_results(s3_store):
    creators = [_creator("creator_a", "UC_a"), _creator("creator_b", "UC_b"), _creator("creator_c", "UC_c")]
    s3_store.write_daily_snapshot(
        DAY, [SubscriberRow(creator_id="creator_a", subscriber_count=100, hidden_subscriber_count=False, observed_at=OBSERVED_AT)]
    )
    # creator_c's channel is still missing from this response -- it stays skipped.
    response = {"items": [{"id": "UC_b", "statistics": {"subscriberCount": "200", "hiddenSubscriberCount": False}}]}
    youtube = _make_channels_client(response)

    key, skip_reasons, collected = collect_subscriber_snapshot_if_missing(
        youtube, creators, collection_date=DAY, observed_at=OBSERVED_AT, store=s3_store
    )

    assert collected is True
    assert "UC_c" in skip_reasons
    rows = {row.creator_id for row in s3_store.read_daily_snapshot(DAY)}
    assert rows == {"creator_a", "creator_b"}  # creator_c still missing, not fabricated


# --- retry where none recover: existing good rows are preserved -------------


def test_retry_where_none_recover_preserves_existing_good_rows_unchanged(s3_store):
    creators = [_creator("creator_a", "UC_a"), _creator("creator_b", "UC_b")]
    s3_store.write_daily_snapshot(
        DAY, [SubscriberRow(creator_id="creator_a", subscriber_count=100, hidden_subscriber_count=False, observed_at=OBSERVED_AT)]
    )
    youtube = MagicMock()
    youtube.channels.return_value.list.return_value.execute.side_effect = ConnectionError("still down")

    key, skip_reasons, collected = collect_subscriber_snapshot_if_missing(
        youtube, creators, collection_date=DAY, observed_at=OBSERVED_AT, store=s3_store
    )

    assert collected is False  # nothing new recovered -- no S3 write, per the write-optimization rule
    assert "UC_b" in skip_reasons
    rows = {row.creator_id: row for row in s3_store.read_daily_snapshot(DAY)}
    assert rows.keys() == {"creator_a"}
    assert rows["creator_a"].subscriber_count == 100  # never touched, never downgraded


# --- hidden subscriber creator counts as observed -----------------------------


def test_hidden_subscriber_creator_counts_as_observed_and_is_never_refetched(s3_store):
    creators = [_creator("creator_a", "UC_a"), _creator("creator_hidden", "UC_hidden")]
    s3_store.write_daily_snapshot(
        DAY,
        [
            SubscriberRow(creator_id="creator_a", subscriber_count=100, hidden_subscriber_count=False, observed_at=OBSERVED_AT),
            SubscriberRow(creator_id="creator_hidden", subscriber_count=None, hidden_subscriber_count=True, observed_at=OBSERVED_AT),
        ],
    )
    youtube = MagicMock()

    key, skip_reasons, collected = collect_subscriber_snapshot_if_missing(
        youtube, creators, collection_date=DAY, observed_at=OBSERVED_AT, store=s3_store
    )

    assert collected is False
    youtube.channels.assert_not_called()
    rows = {row.creator_id: row for row in s3_store.read_daily_snapshot(DAY)}
    assert rows["creator_hidden"].subscriber_count is None
    assert rows["creator_hidden"].hidden_subscriber_count is True


# --- roster changes during the same report date -------------------------------


def test_creator_removed_from_roster_keeps_its_existing_row_not_pruned(s3_store):
    s3_store.write_daily_snapshot(
        DAY,
        [
            SubscriberRow(creator_id="creator_a", subscriber_count=100, hidden_subscriber_count=False, observed_at=OBSERVED_AT),
            SubscriberRow(creator_id="creator_departed", subscriber_count=50, hidden_subscriber_count=False, observed_at=OBSERVED_AT),
        ],
    )
    # creator_departed is no longer in the current roster passed to this call.
    creators = [_creator("creator_a", "UC_a")]
    youtube = MagicMock()

    collect_subscriber_snapshot_if_missing(
        youtube, creators, collection_date=DAY, observed_at=OBSERVED_AT, store=s3_store
    )

    rows = {row.creator_id for row in s3_store.read_daily_snapshot(DAY)}
    assert "creator_departed" in rows  # preserved, never pruned


def test_creator_newly_added_to_roster_is_treated_as_missing_and_fetched(s3_store):
    s3_store.write_daily_snapshot(
        DAY, [SubscriberRow(creator_id="creator_a", subscriber_count=100, hidden_subscriber_count=False, observed_at=OBSERVED_AT)]
    )
    creators = [_creator("creator_a", "UC_a"), _creator("creator_new", "UC_new")]
    response = {"items": [{"id": "UC_new", "statistics": {"subscriberCount": "5", "hiddenSubscriberCount": False}}]}
    youtube = _make_channels_client(response)

    collect_subscriber_snapshot_if_missing(
        youtube, creators, collection_date=DAY, observed_at=OBSERVED_AT, store=s3_store
    )

    requested_ids = youtube.channels.return_value.list.call_args.kwargs["id"].split(",")
    assert requested_ids == ["UC_new"]
    rows = {row.creator_id: row for row in s3_store.read_daily_snapshot(DAY)}
    assert rows["creator_new"].subscriber_count == 5
    assert rows["creator_a"].subscriber_count == 100


# --- bounded same-invocation retry (2026-09-29 correction) -------------------


def test_first_pass_partial_triggers_a_second_pass_for_only_still_missing_channels(s3_store):
    creators = [_creator("creator_a", "UC_a"), _creator("creator_b", "UC_b"), _creator("creator_c", "UC_c")]
    youtube = MagicMock()
    youtube.channels.return_value.list.return_value.execute.side_effect = [
        # Pass 1: whole roster requested, only creator_a comes back.
        {"items": [{"id": "UC_a", "statistics": {"subscriberCount": "100", "hiddenSubscriberCount": False}}]},
        # Pass 2: must be asked about ONLY the still-missing UC_b/UC_c.
        {"items": [{"id": "UC_b", "statistics": {"subscriberCount": "200", "hiddenSubscriberCount": False}}]},
    ]

    key, skip_reasons, collected = collect_subscriber_snapshot_if_missing(
        youtube, creators, collection_date=DAY, observed_at=OBSERVED_AT, store=s3_store
    )

    assert youtube.channels.return_value.list.call_count == 2
    second_pass_ids = sorted(youtube.channels.return_value.list.call_args_list[1].kwargs["id"].split(","))
    assert second_pass_ids == ["UC_b", "UC_c"]  # UC_a (already recovered in pass 1) never re-requested


def test_second_pass_recovery_is_merged_into_the_written_snapshot(s3_store):
    creators = [_creator("creator_a", "UC_a"), _creator("creator_b", "UC_b")]
    youtube = MagicMock()
    youtube.channels.return_value.list.return_value.execute.side_effect = [
        {"items": []},  # pass 1: nothing comes back at all
        {
            "items": [
                {"id": "UC_a", "statistics": {"subscriberCount": "1", "hiddenSubscriberCount": False}},
                {"id": "UC_b", "statistics": {"subscriberCount": "2", "hiddenSubscriberCount": False}},
            ]
        },
    ]

    key, skip_reasons, collected = collect_subscriber_snapshot_if_missing(
        youtube, creators, collection_date=DAY, observed_at=OBSERVED_AT, store=s3_store
    )

    assert collected is True
    assert skip_reasons == {}
    rows = {row.creator_id: row for row in s3_store.read_daily_snapshot(DAY)}
    assert rows["creator_a"].subscriber_count == 1
    assert rows["creator_b"].subscriber_count == 2


def test_existing_good_rows_are_never_re_requested_across_both_passes(s3_store):
    creators = [_creator("creator_a", "UC_a"), _creator("creator_b", "UC_b")]
    s3_store.write_daily_snapshot(
        DAY, [SubscriberRow(creator_id="creator_a", subscriber_count=999, hidden_subscriber_count=False, observed_at=OBSERVED_AT)]
    )
    youtube = MagicMock()
    youtube.channels.return_value.list.return_value.execute.side_effect = [
        {"items": []},  # pass 1 for UC_b fails
        {"items": [{"id": "UC_b", "statistics": {"subscriberCount": "5", "hiddenSubscriberCount": False}}]},
    ]

    collect_subscriber_snapshot_if_missing(
        youtube, creators, collection_date=DAY, observed_at=OBSERVED_AT, store=s3_store
    )

    for call in youtube.channels.return_value.list.call_args_list:
        assert "UC_a" not in call.kwargs["id"].split(",")
    rows = {row.creator_id: row for row in s3_store.read_daily_snapshot(DAY)}
    assert rows["creator_a"].subscriber_count == 999  # untouched


def test_quota_exhaustion_before_any_success_stops_immediately_with_no_second_pass_and_no_write(s3_store):
    """Quota exhausted before ANY batch succeeds: caught internally (not
    re-raised, mirroring collection.main.py's own established handling of
    get_video_statistics's identical enrichment), no bounded second pass,
    and no empty/misleading S3 object is written."""
    creators = [_creator("creator_a", "UC_a"), _creator("creator_b", "UC_b")]
    youtube = MagicMock()
    youtube.channels.return_value.list.return_value.execute.side_effect = QuotaExhaustedError("quota exceeded")

    key, skip_reasons, collected = collect_subscriber_snapshot_if_missing(
        youtube, creators, collection_date=DAY, observed_at=OBSERVED_AT, store=s3_store
    )

    assert youtube.channels.return_value.list.call_count == 1  # no bounded retry attempted at all
    assert collected is False
    assert set(skip_reasons) == {"UC_a", "UC_b"}
    assert s3_store.read_daily_snapshot(DAY) == []  # nothing written
    assert s3_store.snapshot_exists(DAY) is False


def test_quota_exhaustion_after_some_batches_succeed_preserves_them_and_writes_once(s3_store):
    """The exact scenario this correction targets: 118 creators, batches of
    <=50 -- first 50 succeed, second 50 succeed, the final (18-item) batch
    raises QuotaExhaustedError. The first 100 successful observations must
    remain persistable (not discarded along with the exception), written in
    a single S3 PUT, with no further API request after the quota wall and
    the remaining 18 creators left missing/repairable."""
    roster_size = 118
    creators = [_creator(f"creator_{i}", f"UC_{i}") for i in range(roster_size)]
    batch_1 = {
        "items": [
            {"id": f"UC_{i}", "statistics": {"subscriberCount": str(i), "hiddenSubscriberCount": False}}
            for i in range(50)
        ]
    }
    batch_2 = {
        "items": [
            {"id": f"UC_{i}", "statistics": {"subscriberCount": str(i), "hiddenSubscriberCount": False}}
            for i in range(50, 100)
        ]
    }
    youtube = MagicMock()
    youtube.channels.return_value.list.return_value.execute.side_effect = [
        batch_1,
        batch_2,
        QuotaExhaustedError("quota exceeded on batch 3"),
    ]

    key, skip_reasons, collected = collect_subscriber_snapshot_if_missing(
        youtube, creators, collection_date=DAY, observed_at=OBSERVED_AT, store=s3_store
    )

    # Exactly 3 requests total: the 3 pass-1 batches. No bounded second pass
    # (pass 1 itself hit quota), so no 4th request.
    assert youtube.channels.return_value.list.call_count == 3
    assert collected is True
    rows = {row.creator_id: row for row in s3_store.read_daily_snapshot(DAY)}
    assert len(rows) == 100
    for i in range(100):
        assert rows[f"creator_{i}"].subscriber_count == i
    for i in range(100, 118):
        assert f"creator_{i}" not in rows
        assert f"UC_{i}" in skip_reasons  # still missing, repairable by a later invocation


def test_quota_exhaustion_on_second_pass_stops_and_keeps_first_pass_results(s3_store):
    creators = [_creator("creator_a", "UC_a"), _creator("creator_b", "UC_b")]
    youtube = MagicMock()
    youtube.channels.return_value.list.return_value.execute.side_effect = [
        {"items": [{"id": "UC_a", "statistics": {"subscriberCount": "100", "hiddenSubscriberCount": False}}]},
        QuotaExhaustedError("quota exceeded"),
    ]

    key, skip_reasons, collected = collect_subscriber_snapshot_if_missing(
        youtube, creators, collection_date=DAY, observed_at=OBSERVED_AT, store=s3_store
    )

    assert youtube.channels.return_value.list.call_count == 2  # exactly the bounded second pass, never a third
    assert collected is True
    assert "UC_b" in skip_reasons
    rows = {row.creator_id: row for row in s3_store.read_daily_snapshot(DAY)}
    assert rows["creator_a"].subscriber_count == 100  # pass 1's recovery was not discarded


# --- S3 write optimization ----------------------------------------------------


def test_complete_snapshot_makes_zero_youtube_calls_and_zero_s3_writes(monkeypatch, s3_store):
    creators = [_creator("creator_a", "UC_a")]
    s3_store.write_daily_snapshot(
        DAY, [SubscriberRow(creator_id="creator_a", subscriber_count=100, hidden_subscriber_count=False, observed_at=OBSERVED_AT)]
    )
    write_calls = []
    monkeypatch.setattr(
        s3_store.s3_client, "put_object", lambda **kwargs: write_calls.append(kwargs) or {}
    )
    youtube = MagicMock()

    collect_subscriber_snapshot_if_missing(
        youtube, creators, collection_date=DAY, observed_at=OBSERVED_AT, store=s3_store
    )

    youtube.channels.assert_not_called()
    assert write_calls == []


def test_no_recovery_across_both_passes_makes_zero_s3_writes(monkeypatch, s3_store):
    creators = [_creator("creator_a", "UC_a")]
    s3_store.write_daily_snapshot(DAY, [])
    write_calls = []
    monkeypatch.setattr(
        s3_store.s3_client, "put_object", lambda **kwargs: write_calls.append(kwargs) or {}
    )
    youtube = MagicMock()
    youtube.channels.return_value.list.return_value.execute.return_value = {"items": []}

    key, skip_reasons, collected = collect_subscriber_snapshot_if_missing(
        youtube, creators, collection_date=DAY, observed_at=OBSERVED_AT, store=s3_store
    )

    assert collected is False
    assert write_calls == []  # no identical/no-op rewrite


def test_completely_failed_fresh_collection_does_not_seal_an_empty_snapshot(s3_store):
    """No existing object at all, and nothing recoverable across both bounded
    passes: this must never create a "complete-looking" empty object -- the
    next invocation must still see this date as fully missing and retry the
    whole roster."""
    creators = [_creator("creator_a", "UC_a"), _creator("creator_b", "UC_b")]
    youtube = MagicMock()
    youtube.channels.return_value.list.return_value.execute.return_value = {"items": []}

    key, skip_reasons, collected = collect_subscriber_snapshot_if_missing(
        youtube, creators, collection_date=DAY, observed_at=OBSERVED_AT, store=s3_store
    )

    assert collected is False
    assert s3_store.snapshot_exists(DAY) is False
    assert s3_store.read_daily_snapshot(DAY) == []


def test_bounded_retry_happens_at_most_once_even_when_both_passes_fail(s3_store):
    creators = [_creator("creator_a", "UC_a")]
    youtube = MagicMock()
    youtube.channels.return_value.list.return_value.execute.return_value = {"items": []}

    collect_subscriber_snapshot_if_missing(
        youtube, creators, collection_date=DAY, observed_at=OBSERVED_AT, store=s3_store
    )

    assert youtube.channels.return_value.list.call_count == 2  # pass 1 + exactly one bounded retry, never more
