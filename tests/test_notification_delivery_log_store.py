import boto3
import pytest
from moto import mock_aws

from notification_delivery_log_store import (
    NOTIFICATION_DELIVERY_LOG_TABLE,
    NotificationDeliveryLogStoreError,
    already_delivered,
    mark_delivered,
)

AWS_REGION = "ap-northeast-1"


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
    assert already_delivered("c1", "v1") is False


def test_marking_delivered_makes_already_delivered_true(delivery_log_table):
    mark_delivered("c1", "v1", "2026-09-03T18:05:00+00:00")

    assert already_delivered("c1", "v1") is True


def test_delivery_is_scoped_per_client_and_per_video(delivery_log_table):
    mark_delivered("c1", "v1", "2026-09-03T18:05:00+00:00")

    assert already_delivered("c1", "v2") is False
    assert already_delivered("c2", "v1") is False


def test_mark_delivered_raises_store_error_when_table_is_missing(aws_credentials):
    with mock_aws():
        with pytest.raises(NotificationDeliveryLogStoreError):
            mark_delivered("c1", "v1", "2026-09-03T18:05:00+00:00")
