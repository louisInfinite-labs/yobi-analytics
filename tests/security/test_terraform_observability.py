"""SEC-AWS-001 / SEC-AWS-004 structure tests for the access-logging and alarm Terraform (roadmap MT-12, MT-13).

Text-level checks against the raw .tf source (the same approach as the repository's other Terraform structure tests);
`terraform fmt -check` and `terraform validate` are the syntax authority.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

pytestmark = pytest.mark.security

TERRAFORM = Path(__file__).resolve().parents[2] / "terraform"
API_GATEWAY_TF = (TERRAFORM / "api_gateway.tf").read_text(encoding="utf-8")
MONITORING_TF = (TERRAFORM / "monitoring.tf").read_text(encoding="utf-8")
# Comments may legitimately name the emergency-stop topic to explain why it is NOT used; the checks below are on code.
MONITORING_CODE = "\n".join(line for line in MONITORING_TF.splitlines() if not line.lstrip().startswith("#"))
SNS_TF = (TERRAFORM / "sns.tf").read_text(encoding="utf-8")
VARIABLES_TF = (TERRAFORM / "variables.tf").read_text(encoding="utf-8")


def _block(source: str, header: str) -> str:
    start = source.index(header)
    following = source.find('\nresource "', start + len(header))
    return source[start : following if following != -1 else len(source)]


def _alarms() -> dict[str, str]:
    blocks = re.split(r'(?m)^resource "aws_cloudwatch_metric_alarm" "', MONITORING_TF)[1:]
    return {b.split('"', 1)[0]: b for b in blocks}


# --- MT-12: access logging --------------------------------------------------------------------------------------------


def test_the_stage_writes_json_access_logs_to_a_managed_log_group_with_explicit_retention():
    stage = _block(API_GATEWAY_TF, 'resource "aws_apigatewayv2_stage" "default"')
    log_group = _block(API_GATEWAY_TF, 'resource "aws_cloudwatch_log_group" "api_access"')

    assert "access_log_settings" in stage and "aws_cloudwatch_log_group.api_access.arn" in stage
    assert "jsonencode(" in stage
    assert "retention_in_days = var.api_access_log_retention_days" in log_group
    default = re.search(r'variable "api_access_log_retention_days".*?default\s*=\s*(\d+)', VARIABLES_TF, re.DOTALL)
    assert default is not None and int(default.group(1)) > 0, "retention must default to an explicit finite value"


def test_the_access_log_format_is_an_allowlist_with_no_headers_paths_or_user_agent():
    stage = _block(API_GATEWAY_TF, 'resource "aws_apigatewayv2_stage" "default"')
    fmt = re.search(r"format\s*=\s*jsonencode\(\{(.*?)\n\s*\}\)", stage, re.DOTALL)
    assert fmt is not None
    used = set(re.findall(r"\$context\.[A-Za-z.]+", fmt.group(1)))

    assert used == {
        "$context.requestId",
        "$context.requestTimeEpoch",
        "$context.routeKey",
        "$context.httpMethod",
        "$context.status",
        "$context.responseLatency",
        "$context.integrationLatency",
        "$context.integrationStatus",
        "$context.integrationErrorMessage",
        "$context.responseLength",
        "$context.identity.sourceIp",
    }
    assert "$request" not in fmt.group(1), "no request headers/query values in access logs"
    assert "$context.path" not in fmt.group(1) and "userAgent" not in fmt.group(1)


# --- MT-13: launch alarm categories ----------------------------------------------------------------------------------


def test_a_dedicated_alarm_topic_exists_and_is_not_the_emergency_stop_topic():
    assert 'resource "aws_sns_topic" "security_alarms"' in MONITORING_TF
    assert 'name = "yobi-analytics-security-alarms"' in MONITORING_TF
    emergency = re.search(r'resource "aws_sns_topic" "emergency_stop".*?name\s*=\s*"([^"]+)"', SNS_TF, re.DOTALL)
    alarm = re.search(r'resource "aws_sns_topic" "security_alarms".*?name\s*=\s*"([^"]+)"', MONITORING_TF, re.DOTALL)
    assert emergency and alarm and emergency.group(1) != alarm.group(1)


def test_no_alarm_ever_targets_the_emergency_stop_topic():
    assert "aws_sns_topic.emergency_stop" not in MONITORING_CODE
    assert _alarms(), "no alarms found"
    for name, block in _alarms().items():
        assert "alarm_actions       = [aws_sns_topic.security_alarms.arn]" in block, f"{name} must notify the dedicated topic"


def _covers(metric: str, namespace: str) -> bool:
    return any(f'namespace           = "{namespace}"' in b and f'metric_name         = "{metric}"' in b for b in _alarms().values())


def test_the_three_launch_alarm_categories_are_each_covered_by_at_least_one_alarm():
    # Categories, not an exact resource count: the number of alarm resources follows the Lambda/API structure.
    assert _covers("5xx", "AWS/ApiGateway"), "API 5xx category"
    assert _covers("Errors", "AWS/Lambda"), "Lambda errors category"
    throttling = _covers("Api429Count", "YobiAnalytics/Security") or _covers("Throttles", "AWS/Lambda")
    assert throttling, "API 429/throttling category"


def test_the_429_signal_comes_from_the_access_log_the_stage_writes():
    filter_block = _block(MONITORING_TF, 'resource "aws_cloudwatch_log_metric_filter" "api_throttled_429"')

    assert "aws_cloudwatch_log_group.api_access.name" in filter_block
    assert '$.status = \\"429\\"' in filter_block
    assert 'namespace     = "YobiAnalytics/Security"' in filter_block


def test_alarm_thresholds_are_variables_not_hardcoded():
    for name, block in _alarms().items():
        assert re.search(r"threshold\s*=\s*var\.alarm_", block), f"{name} threshold must be a tunable variable"


def test_the_alarm_email_is_a_variable_with_no_committed_address():
    assert re.search(r'variable "alarm_email".*?default\s*=\s*""', VARIABLES_TF, re.DOTALL)
    assert "@" not in MONITORING_CODE
