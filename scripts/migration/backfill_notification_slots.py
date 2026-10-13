"""Index every existing client's new-video delivery slots into the slot-recipient table (one-time cutover step).

Scheduled new-video delivery (notifications/new_video_dispatcher.py) serves only clients found in the slot-recipient index
(stores/notification_slot_store.py), which the preference PUT route fills from now on. A client that stored its preference BEFORE that
route existed is not in the index until it next saves, so this reads every stored `notificationPreference` and indexes the enabled ones.

DRY-RUN BY DEFAULT: nothing is written unless --apply is passed. The report lists, for every client, what would be indexed and which
stored values the 4-slot/half-hour rule changes (floored to the half hour, capped at four). Stored times are read as JST from now on.

`activeSince` of a backfilled client is the time of this run: events that already came due before the cutover are not replayed, while
events still waiting for their window are delivered at the client's next slot. A client whose preference is disabled or invalid is also
cleaned up (--apply) so the index matches the stored preferences.

Run order at cutover (see docs/new-video-scheduled-push.md): table exists -> this script --apply -> deploy -> enable the 30-minute schedule.

Usage:
    python scripts/migration/backfill_notification_slots.py            # dry run, read-only
    python scripts/migration/backfill_notification_slots.py --apply    # writes the slot-recipient table
"""

from __future__ import annotations

import argparse
import sys
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent.parent / "src"))

from notifications import notification_dispatch  # noqa: E402
from notifications.delivery_slots import slot_label  # noqa: E402
from stores import notification_slot_store, remote_config_store  # noqa: E402

_PREFERENCE_KEY = "notificationPreference"


@dataclass
class BackfillReport:
    indexed: list[tuple[str, tuple[int, ...]]] = field(default_factory=list)  # (client, slots)
    removed: list[str] = field(default_factory=list)  # disabled or invalid clients cleaned from the index
    normalized: list[tuple[str, list[str], list[str]]] = field(default_factory=list)  # (client, stored windows, effective slots)
    invalid: list[str] = field(default_factory=list)

    def lines(self) -> list[str]:
        out = [
            f"Clients to index:          {len(self.indexed)}",
            f"Clients to remove/skip:    {len(self.removed)} (disabled or invalid preference)",
            f"Invalid stored preferences: {len(self.invalid)}",
            f"Windows changed by the rule: {len(self.normalized)}",
        ]
        for client_id, stored, effective in self.normalized:
            out.append(f"  {client_id}: stored {stored} -> delivers at {effective}")
        for client_id in self.invalid:
            out.append(f"  invalid: {client_id}")
        return out


def run(*, apply: bool, now: datetime | None = None) -> BackfillReport:
    """Read every stored preference and (with apply) make the index match. Returns what was, or would be, done."""
    now_iso = (now or datetime.now(timezone.utc)).isoformat()
    report = BackfillReport()
    for record in remote_config_store.list_by_key(_PREFERENCE_KEY):
        client_id = record["clientId"]
        try:
            preference = notification_dispatch.parse_notification_preference(record["value"])
        except notification_dispatch.ClientError:
            report.invalid.append(client_id)
            report.removed.append(client_id)
            if apply:
                notification_slot_store.remove_client(client_id)
            continue

        if not preference.enabled:
            report.removed.append(client_id)
            if apply:
                notification_slot_store.remove_client(client_id)
            continue

        slots = preference.delivery_slots
        stored_windows = sorted(window.strftime("%H:%M") for window in preference.delivery_windows)
        effective = [slot_label(slot) for slot in slots]
        if stored_windows != effective:
            report.normalized.append((client_id, stored_windows, effective))
        report.indexed.append((client_id, slots))
        if apply:
            notification_slot_store.sync_client_slots(client_id, slots=slots, now_iso=now_iso)
    return report


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--apply", action="store_true", help="write the slot-recipient table (default: dry run, read-only)")
    args = parser.parse_args(argv)

    report = run(apply=args.apply)
    print("APPLIED" if args.apply else "DRY RUN (nothing written; pass --apply to write)")
    print("\n".join(report.lines()))
    return 0


if __name__ == "__main__":
    sys.exit(main())
