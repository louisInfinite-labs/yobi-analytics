"""Static, text-level check that the notification dispatcher's EventBridge
cadence (terraform/eventbridge.tf) matches notification_dispatcher.py's own
_REMINDER_WINDOW -- the single-stream/creator live-reminder spec's
requirement that the dispatcher be "prepared" (not applied) to honour the
product's smallest reminder option ("1min") precisely.

No `terraform` CLI is available in this environment (see
test_terraform_execution_lock_structure.py's own note) -- this is a
best-effort textual substitute, not proof the HCL is syntactically valid.
"""

from __future__ import annotations

import pathlib
import re
from datetime import timedelta

from notifications import notification_dispatcher

REPO_ROOT = pathlib.Path(__file__).resolve().parent.parent
EVENTBRIDGE_TF = (REPO_ROOT / "terraform" / "eventbridge.tf").read_text()


def _notification_dispatch_block() -> str:
    start = EVENTBRIDGE_TF.index('resource "aws_scheduler_schedule" "notification_dispatch"')
    next_resource = EVENTBRIDGE_TF.find("\nresource ", start + 1)
    return EVENTBRIDGE_TF[start : next_resource if next_resource != -1 else len(EVENTBRIDGE_TF)]


def test_notification_dispatch_schedule_is_rate_one_minute():
    block = _notification_dispatch_block()
    match = re.search(r'schedule_expression\s*=\s*"([^"]+)"', block)
    assert match is not None, "notification_dispatch's schedule_expression not found"
    assert match.group(1) == "rate(1 minute)"


def test_reminder_window_matches_the_prepared_cadence():
    """_REMINDER_WINDOW must not silently drift out of sync with the
    EventBridge rate it's documented to mirror -- a reminder's fire window
    needs to be at least one full cadence wide so it's never skipped
    between two runs, and no wider than necessary or "1min" stops being
    honoured precisely."""
    assert notification_dispatcher._REMINDER_WINDOW == timedelta(minutes=1)
