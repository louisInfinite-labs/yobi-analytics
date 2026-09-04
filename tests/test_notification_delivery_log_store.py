from datetime import datetime, timedelta, timezone

import boto3
import pytest
from moto import mock_aws

from notification_delivery_log_store import (
    NOTIFICATION_DELIVERY_LOG_TABLE,
    NotificationDeliveryLogStoreError,
    already_delivered,
    confirm_delivered,
    mark_delivered,
    release_claim,
)

AWS_REGION = "ap-northeast-1"
NOW = datetime(2026, 9, 3, 18, 5, tzinfo=timezone.utc)


@pytest.fixture(autouse=True)
def aws_credentials(monkeypatch):
    """moto still requires boto3 to resolve *some* credentials; these never reach real AWS."""
    monkeypatch.setenv("AWS_ACCESS_KEY_ID", "testing")
    monkeypatch.setenv("AWS_SECRET_ACCESS_KEY", "testing")
    monkeypatch.setenv("AWS_SECURITY_TOKEN", "testing")
    monkeypatch.setenv("AWS_SESSION_TOKEN", "testing")
    monkeypatch.setenv("AWS_DEFAULT_REGION", AWS_REGION)


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
