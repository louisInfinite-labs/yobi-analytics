from datetime import datetime, timedelta, timezone

import boto3
import pytest
from moto import mock_aws

from stores.notification_delivery_log_store import (
    NOTIFICATION_DELIVERY_LOG_TABLE,
    NotificationDeliveryLogStoreError,
    already_delivered,
    confirm_delivered,
    handled_within,
    mark_delivered,
    mark_suppressed,
    release_claim,
    row_status,
)

AWS_REGION = "ap-northeast-1"
NOW = datetime(2026, 9, 3, 18, 5, tzinfo=timezone.utc)




@pytest.fixture
def delivery_log_table(aws_credentials):
    """Create the production-shaped Notification Delivery Log table inside moto's fully mocked DynamoDB."""
    with mock_aws():
        client = boto3.client("dynamodb", region_name=AWS_REGION)
        client.create_table(
            TableName=NOTIFICATION_DELIVERY_LOG_TABLE,
            AttributeDefinitions=[
                {"AttributeName": "clientId", "AttributeType": "S"},
                {"AttributeName": "videoId", "AttributeType": "S"},
            ],
            KeySchema=[
                {"AttributeName": "clientId", "KeyType": "HASH"},
                {"AttributeName": "videoId", "KeyType": "RANGE"},
            ],
            BillingMode="PAY_PER_REQUEST",
        )
        yield


def test_a_video_not_yet_delivered_to_a_client_is_reported_as_such(delivery_log_table):
    assert already_delivered("c1", "v1", now=NOW) is False


def test_a_live_claim_makes_already_delivered_true(delivery_log_table):
    """An unexpired claim (send in flight, not yet confirmed) counts as
    already-delivered from the pre-check's point of view — it must not let
    a concurrent run start a second send while this one is still working."""
    mark_delivered("c1", "v1", NOW.isoformat(), now=NOW)

    assert already_delivered("c1", "v1", now=NOW) is True


def test_confirmed_delivery_makes_already_delivered_true(delivery_log_table):
    mark_delivered("c1", "v1", NOW.isoformat(), now=NOW)
    confirm_delivered("c1", "v1", NOW.isoformat())

    assert already_delivered("c1", "v1", now=NOW) is True


def test_confirmed_delivery_stays_true_even_long_after_the_claim_expiry_window(delivery_log_table):
    """Unlike a bare claim, a confirmed delivery is permanent — it must
    never expire just because enough time has passed."""
    mark_delivered("c1", "v1", NOW.isoformat(), now=NOW)
    confirm_delivered("c1", "v1", NOW.isoformat())

    much_later = NOW + timedelta(days=30)
    assert already_delivered("c1", "v1", now=much_later) is True


def test_a_claim_exactly_at_the_expiry_boundary_is_still_reported_as_live(delivery_log_table):
    """already_delivered's own expiry check and mark_delivered's reclaim
    condition must agree at the exact boundary — both strict, so a claim
    aged exactly _CLAIM_EXPIRY is not yet reclaimable from either side."""
    mark_delivered("c1", "v1", NOW.isoformat(), now=NOW)

    exactly_at_expiry = NOW + timedelta(minutes=20)
    assert already_delivered("c1", "v1", now=exactly_at_expiry) is True
    assert mark_delivered("c1", "v1", exactly_at_expiry.isoformat(), now=exactly_at_expiry) is False


def test_an_expired_unconfirmed_claim_is_reported_as_not_yet_delivered(delivery_log_table):
    """The dispatcher invocation that claimed this pair never confirmed or
    released it (crash, Lambda timeout) — after _CLAIM_EXPIRY, a later run
    must be able to try again instead of the video looking permanently,
    silently, delivered with nothing ever actually sent."""
    mark_delivered("c1", "v1", NOW.isoformat(), now=NOW)

    after_expiry = NOW + timedelta(minutes=21)
    assert already_delivered("c1", "v1", now=after_expiry) is False


def test_delivery_is_scoped_per_client_and_per_video(delivery_log_table):
    mark_delivered("c1", "v1", NOW.isoformat(), now=NOW)

    assert already_delivered("c1", "v2", now=NOW) is False
    assert already_delivered("c2", "v1", now=NOW) is False


def test_mark_delivered_raises_store_error_when_table_is_missing(aws_credentials):
    with mock_aws():
        with pytest.raises(NotificationDeliveryLogStoreError):
            mark_delivered("c1", "v1", NOW.isoformat())


def test_mark_delivered_returns_true_when_it_performed_the_claim(delivery_log_table):
    assert mark_delivered("c1", "v1", NOW.isoformat(), now=NOW) is True


def test_a_second_mark_delivered_call_for_the_same_still_live_pair_returns_false(delivery_log_table):
    """The conditional write that closes notification_dispatcher.py's race:
    a second caller (a concurrent run) must not silently overwrite a still-
    live claim — it loses and must not send."""
    assert mark_delivered("c1", "v1", NOW.isoformat(), now=NOW) is True

    assert mark_delivered("c1", "v1", (NOW + timedelta(minutes=1)).isoformat(), now=NOW) is False
    assert already_delivered("c1", "v1", now=NOW) is True


def test_a_second_mark_delivered_call_after_confirmed_delivery_returns_false(delivery_log_table):
    mark_delivered("c1", "v1", NOW.isoformat(), now=NOW)
    confirm_delivered("c1", "v1", NOW.isoformat())

    assert mark_delivered("c1", "v1", NOW.isoformat(), now=NOW) is False


def test_mark_delivered_can_reclaim_an_expired_unconfirmed_claim(delivery_log_table):
    mark_delivered("c1", "v1", NOW.isoformat(), now=NOW)

    after_expiry = NOW + timedelta(minutes=21)
    assert mark_delivered("c1", "v1", after_expiry.isoformat(), now=after_expiry) is True
    assert already_delivered("c1", "v1", now=after_expiry) is True


def test_release_claim_allows_a_future_claim_to_succeed(delivery_log_table):
    assert mark_delivered("c1", "v1", NOW.isoformat(), now=NOW) is True

    release_claim("c1", "v1")

    assert already_delivered("c1", "v1", now=NOW) is False
    assert mark_delivered("c1", "v1", (NOW + timedelta(minutes=5)).isoformat(), now=NOW) is True


def test_release_claim_raises_store_error_when_table_is_missing(aws_credentials):
    with mock_aws():
        with pytest.raises(NotificationDeliveryLogStoreError):
            release_claim("c1", "v1")


def test_confirm_delivered_raises_store_error_when_table_is_missing(aws_credentials):
    with mock_aws():
        with pytest.raises(NotificationDeliveryLogStoreError):
            confirm_delivered("c1", "v1", NOW.isoformat())


def test_a_suppressed_notification_is_reported_as_already_handled_forever(delivery_log_table):
    assert mark_suppressed("c1", "v1", NOW.isoformat()) is True

    assert already_delivered("c1", "v1", now=NOW) is True
    assert already_delivered("c1", "v1", now=NOW + timedelta(days=30)) is True


def test_a_suppressed_notification_can_never_be_claimed_for_delivery_afterwards(delivery_log_table):
    mark_suppressed("c1", "v1", NOW.isoformat())

    assert mark_delivered("c1", "v1", NOW.isoformat(), now=NOW + timedelta(days=1)) is False


def test_mark_suppressed_never_overwrites_an_existing_record(delivery_log_table):
    mark_delivered("c1", "v1", NOW.isoformat(), now=NOW)
    confirm_delivered("c1", "v1", NOW.isoformat())

    assert mark_suppressed("c1", "v1", NOW.isoformat()) is False
    assert mark_suppressed("c1", "v2", NOW.isoformat()) is True
    assert mark_suppressed("c1", "v2", NOW.isoformat()) is False


def test_mark_suppressed_raises_store_error_when_table_is_missing(aws_credentials):
    with mock_aws():
        with pytest.raises(NotificationDeliveryLogStoreError):
            mark_suppressed("c1", "v1", NOW.isoformat())


def test_handled_within_reports_only_recent_deliveries(delivery_log_table):
    """A legacy row is "just sent" only while it is fresh; an older delivery belongs to a time the stream may since have left."""
    assert handled_within("c1", "v1", timedelta(minutes=10), now=NOW) is False  # no row
    mark_delivered("c1", "v1", NOW.isoformat(), now=NOW)
    confirm_delivered("c1", "v1", (NOW - timedelta(minutes=3)).isoformat())

    assert handled_within("c1", "v1", timedelta(minutes=10), now=NOW) is True
    assert handled_within("c1", "v1", timedelta(minutes=2), now=NOW) is False
    assert handled_within("c1", "other", timedelta(minutes=10), now=NOW) is False  # scoped per video


def test_handled_within_counts_a_live_claim_but_not_an_expired_one(delivery_log_table):
    """A send in flight blocks a concurrent run; an abandoned claim does not."""
    mark_delivered("c1", "v1", (NOW - timedelta(minutes=1)).isoformat(), now=NOW)
    assert handled_within("c1", "v1", timedelta(minutes=10), now=NOW) is True
    assert handled_within("c1", "v1", timedelta(minutes=10), now=NOW + timedelta(minutes=30)) is False


def test_handled_within_raises_store_error_when_table_is_missing(aws_credentials):
    """Same error contract as the other reads."""
    with mock_aws():
        with pytest.raises(NotificationDeliveryLogStoreError):
            handled_within("c1", "v1", timedelta(minutes=10), now=NOW)


def test_row_status_tells_a_settled_row_a_live_claim_and_nothing_apart(delivery_log_table):
    """delivered / suppressed / a live claim are distinguished (already_delivered folds them together); no row is None."""
    assert row_status("c1", "simul:1:a", now=NOW) is None
    mark_delivered("c1", "simul:1:a", NOW.isoformat(), now=NOW)
    assert row_status("c1", "simul:1:a", now=NOW) == "claimed"
    confirm_delivered("c1", "simul:1:a", NOW.isoformat())
    assert row_status("c1", "simul:1:a", now=NOW) == "delivered"
    mark_suppressed("c1", "simul:1:b", NOW.isoformat())
    assert row_status("c1", "simul:1:b", now=NOW) == "suppressed"


def test_row_status_treats_an_abandoned_claim_as_absent_so_it_can_be_taken_over(delivery_log_table):
    """A claim older than the expiry window belongs to a dead worker: not live, and mark_delivered may reclaim it."""
    mark_delivered("c1", "simul:1:a", (NOW - timedelta(minutes=30)).isoformat(), now=NOW - timedelta(minutes=30))

    assert row_status("c1", "simul:1:a", now=NOW) is None
    assert mark_delivered("c1", "simul:1:a", NOW.isoformat(), now=NOW) is True


def test_a_failed_push_release_lets_the_same_notice_be_claimed_again(delivery_log_table):
    """Claim -> release (the push failed) -> the retry can claim the very same key: a failure never permanently loses the notice."""
    assert mark_delivered("c1", "simul:1:a", NOW.isoformat(), now=NOW) is True
    assert mark_delivered("c1", "simul:1:a", NOW.isoformat(), now=NOW) is False  # a concurrent worker cannot also claim it
    release_claim("c1", "simul:1:a")

    assert mark_delivered("c1", "simul:1:a", NOW.isoformat(), now=NOW) is True


def test_a_premiere_archived_phase_key_is_fully_independent_of_the_videos_own_announcement_row(delivery_log_table):
    """notifications.new_video_dispatcher writes the Premiere archive-confirmation phase under "{videoId}#premiere_archived" --
    against the real table (not a fake), confirm it round-trips and never shares state with the bare videoId's own row, exactly
    like the reminder system's own "{videoId}:reminder:{kind}" composite keys already proven above."""
    assert mark_delivered("c1", "v1", NOW.isoformat(), now=NOW) is True
    confirm_delivered("c1", "v1", NOW.isoformat())

    assert already_delivered("c1", "v1#premiere_archived") is False  # the announcement's delivery never settles the archive phase
    assert mark_delivered("c1", "v1#premiere_archived", NOW.isoformat(), now=NOW) is True
    confirm_delivered("c1", "v1#premiere_archived", NOW.isoformat())

    assert already_delivered("c1", "v1") is True
    assert already_delivered("c1", "v1#premiere_archived") is True


def test_two_concurrent_dispatcher_runs_cannot_both_deliver_the_same_premiere_archived_notification(delivery_log_table):
    """Two overlapping new_video_dispatcher invocations racing on the same (client, archived-phase) pair: only one wins the claim,
    the loser must not send -- the same atomic guarantee mark_delivered already gives the bare videoId case, unaffected by the
    qualifier's extra characters."""
    first_run_claimed = mark_delivered("c1", "v1#premiere_archived", NOW.isoformat(), now=NOW)
    second_run_claimed = mark_delivered("c1", "v1#premiere_archived", NOW.isoformat(), now=NOW)

    assert first_run_claimed is True and second_run_claimed is False
