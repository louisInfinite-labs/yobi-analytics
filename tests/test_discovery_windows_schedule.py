"""Static, text-level check that terraform/eventbridge.tf's discovery schedules match src/tracking/discovery_windows.py.

No AWS access is needed (or used): this reads the .tf source. `terraform validate` and `terraform plan` remain the real checks of the
HCL itself; this guards the two lists, and the details a plan cannot judge, from drifting apart.
"""

from __future__ import annotations

import pathlib
import re

from tracking.discovery_windows import DISCOVERY_WINDOWS_JST

REPO_ROOT = pathlib.Path(__file__).resolve().parent.parent
EVENTBRIDGE_TF = (REPO_ROOT / "terraform" / "eventbridge.tf").read_text()


def _block(header: str) -> str:
    start = EVENTBRIDGE_TF.index(header)
    following = re.search(r"\n(?:resource|locals|moved) ", EVENTBRIDGE_TF[start + len(header) :])
    end = start + len(header) + following.start() if following else len(EVENTBRIDGE_TF)
    return EVENTBRIDGE_TF[start:end]


def _terraform_windows() -> dict[str, str]:
    body = _block("locals {\n  discovery_windows_jst")
    return dict(re.findall(r'"(\d{4})"\s*=\s*"(\d{2}:\d{2})"', body))


def test_the_terraform_windows_are_exactly_the_python_windows():
    assert _terraform_windows() == dict(DISCOVERY_WINDOWS_JST)


def test_the_terraform_windows_are_exactly_the_specified_jst_times():
    assert _terraform_windows() == {"0000": "00:00", "0900": "09:00", "1300": "13:00", "2000": "20:00", "2200": "22:00"}


def test_the_schedule_timezone_is_asia_tokyo_so_each_window_is_a_jst_clock_time():
    block = _block('resource "aws_scheduler_schedule" "discovery_window"')
    assert block.count("schedule_expression_timezone") == 1
    assert 'schedule_expression_timezone = "Asia/Tokyo"' in block


def test_the_old_single_schedule_is_moved_onto_the_midnight_window_not_destroyed():
    moved = _block("moved {")
    assert "aws_scheduler_schedule.discovery_only" in moved
    assert 'aws_scheduler_schedule.discovery_window["0000"]' in moved
    assert 'resource "aws_scheduler_schedule" "discovery_only"' not in EVENTBRIDGE_TF


def test_the_midnight_window_keeps_the_original_schedule_name_so_it_is_updated_in_place():
    block = _block('resource "aws_scheduler_schedule" "discovery_window"')
    assert '"0000" ? "yobi-analytics-discovery-only"' in block
    assert "yobi-analytics-discovery-${each.key}" in block


def test_every_window_runs_in_jst_as_a_discovery_only_collector_invocation_with_its_own_id():
    block = _block('resource "aws_scheduler_schedule" "discovery_window"')
    assert 'schedule_expression_timezone = "Asia/Tokyo"' in block
    assert "for_each = local.discovery_windows_jst" in block
    assert 'jsonencode({ mode = "discovery_only", window = each.key })' in block
    assert "aws_lambda_function.collector.arn" in block
    assert "dead_letter_config" in block
    assert re.search(r'"cron\(\$\{tonumber\(split\(":", each.value\)\[1\]\)\} \$\{tonumber\(split\(":", each.value\)\[0\]\)\} \* \* \? \*\)"', block)


def test_the_daily_history_schedule_is_untouched_and_no_discovery_window_shares_its_hour():
    history = _block('resource "aws_scheduler_schedule" "daily_collection"')
    assert 'schedule_expression          = "cron(0 18 * * ? *)"' in history
    assert "aws_sfn_state_machine.daily_history.arn" in history
    assert 'mode = "discovery_only"' not in history
    assert "18:00" not in dict(DISCOVERY_WINDOWS_JST).values()
