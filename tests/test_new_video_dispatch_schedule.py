"""Static, text-level checks of the scheduled new-video delivery infrastructure (terraform/*.tf) against the Python side.

Source validation only -- nothing here talks to AWS. `terraform validate`/`plan` are the real HCL checks.
"""

from __future__ import annotations

import pathlib
import re

from notifications import new_video_dispatcher
from notifications.delivery_slots import SLOT_MINUTES, TICK_MINUTES
from stores import notification_slot_store

REPO_ROOT = pathlib.Path(__file__).resolve().parent.parent
EVENTBRIDGE_TF = (REPO_ROOT / "terraform" / "eventbridge.tf").read_text()
DYNAMODB_TF = (REPO_ROOT / "terraform" / "dynamodb.tf").read_text()
LAMBDA_TF = (REPO_ROOT / "terraform" / "lambda.tf").read_text()


def _block(source: str, header: str) -> str:
    start = source.index(header)
    following = re.search(r"\n(?:resource|locals|moved) ", source[start + len(header) :])
    return source[start : start + len(header) + following.start()] if following else source[start:]


def test_the_dispatcher_runs_on_the_quarter_hour_boundaries_in_utc_as_one_shared_schedule():
    block = _block(EVENTBRIDGE_TF, 'resource "aws_scheduler_schedule" "new_video_dispatch"')
    assert 'schedule_expression          = "cron(0/15 * * * ? *)"' in block
    assert 'schedule_expression_timezone = "UTC"' in block
    assert TICK_MINUTES == 15  # the cron step is the tick length
    assert SLOT_MINUTES % TICK_MINUTES == 0  # a user-chosen half hour is always a whole number of ticks
    # One schedule for everybody: no per-user or per-zone scheduler exists in the Terraform at all.
    assert "for_each" not in block and "count" not in block.replace("account", "")


def test_every_iana_zone_offset_is_a_whole_multiple_of_the_tick_so_a_local_slot_start_is_always_exactly_a_tick():
    """The guarantee the 15-minute cadence rests on. If a future tzdata ever introduced an offset that is not a multiple of 15 minutes, this
    fails and the cadence has to be revisited -- rather than silently delivering such a zone's users late."""
    from datetime import datetime, timedelta, timezone
    from zoneinfo import ZoneInfo, available_timezones

    sample_days = [datetime(2026, month, 15, 12, tzinfo=timezone.utc) for month in range(1, 13)]
    odd = {}
    for name in sorted(available_timezones()):
        zone = ZoneInfo(name)
        for day in sample_days:
            offset = day.astimezone(zone).utcoffset()
            if offset % timedelta(minutes=TICK_MINUTES) != timedelta(0):
                odd[name] = offset
    assert odd == {}


def test_the_dispatcher_invokes_the_existing_notification_dispatcher_lambda_in_slot_mode():
    block = _block(EVENTBRIDGE_TF, 'resource "aws_scheduler_schedule" "new_video_dispatch"')
    assert "aws_lambda_function.notification_dispatcher.arn" in block
    assert f'\\"mode\\":\\"{new_video_dispatcher.MODE}\\"' in block
    assert "dead_letter_config" in block


def test_the_input_is_a_plain_string_so_the_scheduler_substitutes_the_scheduled_time():
    block = _block(EVENTBRIDGE_TF, 'resource "aws_scheduler_schedule" "new_video_dispatch"')
    input_line = next(line for line in block.splitlines() if line.strip().startswith("input"))
    assert "<aws.scheduler.scheduled-time>" in input_line
    assert "jsonencode" not in input_line  # jsonencode would escape the angle brackets and defeat the substitution


def test_a_failed_slot_run_is_retried_only_briefly_so_it_cannot_serve_a_long_passed_slot():
    block = _block(EVENTBRIDGE_TF, 'resource "aws_scheduler_schedule" "new_video_dispatch"')
    attempts = int(re.search(r"maximum_retry_attempts\s*=\s*(\d+)", block).group(1))
    age = int(re.search(r"maximum_event_age_in_seconds\s*=\s*(\d+)", block).group(1))
    assert attempts <= 2
    assert age <= new_video_dispatcher._MAX_TICK_LAG.total_seconds()  # a retry never arrives later than the dispatcher honours


def test_the_one_minute_reminder_schedule_is_unchanged_and_sends_no_mode():
    block = _block(EVENTBRIDGE_TF, 'resource "aws_scheduler_schedule" "notification_dispatch"')
    assert '"rate(1 minute)"' in block
    assert re.search(r"^\s*input\s*=", block, re.MULTILINE) is None  # no input at all: the reminder job is the no-mode default


def test_the_slot_table_has_the_keys_and_index_the_store_queries():
    block = _block(DYNAMODB_TF, 'resource "aws_dynamodb_table" "notification_delivery_slots"')
    assert f'name         = "{notification_slot_store.NOTIFICATION_SLOTS_TABLE}"' in block
    assert 'hash_key     = "slotKey"' in block and 'range_key    = "clientId"' in block
    index = _block(block, "global_secondary_index {")
    assert f'name            = "{notification_slot_store.CLIENT_INDEX}"' in index
    assert 'hash_key        = "clientId"' in index
    assert "PAY_PER_REQUEST" in block and "deletion_protection_enabled = true" in block


def test_the_dispatcher_lambda_has_time_for_a_slot_run_and_its_deadline_margin_fits():
    block = _block(LAMBDA_TF, 'resource "aws_lambda_function" "notification_dispatcher"')
    timeout = int(re.search(r"timeout\s*=\s*(\d+)", block).group(1))
    assert timeout >= 300
    assert new_video_dispatcher._DEADLINE_MARGIN_MS < timeout * 1000


def test_the_manual_iam_policy_names_the_slot_table_index_and_the_conditional_events_put():
    import json

    policy = json.loads((REPO_ROOT / "terraform" / "manual-iam" / "policy-lambda-notification-delivery-slots.json").read_text())
    resources = [r for statement in policy["Statement"] for r in ([statement["Resource"]] if isinstance(statement["Resource"], str) else statement["Resource"])]
    assert any(r.endswith(f"table/{notification_slot_store.NOTIFICATION_SLOTS_TABLE}") for r in resources)
    assert any(r.endswith(f"index/{notification_slot_store.CLIENT_INDEX}") for r in resources)
    assert any(r.endswith("table/YobiNotificationEvents") for r in resources)
