"""Index every existing client's new-video delivery slots into the slot-recipient table, per IANA time zone.

Scheduled new-video delivery (notifications/new_video_dispatcher.py) serves only clients found in the slot-recipient index
(stores/notification_slot_store.py), which the preference PUT route fills. The index key is (the client's own `notificationTimeZone`,
the local half-hour slot of each `deliveryWindows` entry), so this reads every stored `notificationPreference`, indexes the enabled ones
under their own stored zone, and removes the rest. It is also the migration of the first release, which keyed the index by the bare JST
slot: those rows are re-keyed, keeping each client's original `activeSince`, so nothing is replayed.

DRY-RUN BY DEFAULT: nothing is written unless --apply is passed. The report lists, per time zone, how many clients and rows would be
written, and which stored values the 4-slot/half-hour rule changes (floored to the half hour, capped at four).

`activeSince` of a client that is already indexed is kept; a client that was not indexed gets the time of this run, so events that
already came due before the cutover are not replayed, while events still waiting for their window are delivered at the client's next
slot. A client whose preference is disabled or invalid is also cleaned up (--apply) so the index matches the stored preferences.

Gap-free cutover (see docs/new-video-scheduled-push.md): run --apply --keep-legacy BEFORE deploying the new Lambdas (it only adds the
zone-keyed rows; the running dispatcher still reads the first-release rows), deploy, then run --apply once more to prune the
first-release rows. Plain --apply is safe to repeat at any time.

Usage:
    python scripts/migration/backfill_notification_slots.py                        # dry run, read-only
    python scripts/migration/backfill_notification_slots.py --apply --keep-legacy  # add zone-keyed rows, leave first-release rows
    python scripts/migration/backfill_notification_slots.py --apply                # make the index match the preferences exactly
"""

from __future__ import annotations

import argparse
import sys
from collections import Counter
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
    indexed: list[tuple[str, str, tuple[int, ...]]] = field(default_factory=list)  # (client, zone, local slots)
    removed: list[str] = field(default_factory=list)  # disabled or invalid clients cleaned from the index
    normalized: list[tuple[str, list[str], list[str]]] = field(default_factory=list)  # (client, stored windows, effective slots)
    invalid: list[str] = field(default_factory=list)

    def rows(self) -> int:
        """How many (client, slot) rows the index holds for the indexed clients."""
        return sum(len(slots) for _, _, slots in self.indexed)

    def lines(self) -> list[str]:
        per_zone = Counter(zone for _, zone, _ in self.indexed)
        out = [
            f"Clients to index:          {len(self.indexed)} ({self.rows()} slot rows)",
            f"Clients to remove/skip:    {len(self.removed)} (disabled or invalid preference)",
            f"Invalid stored preferences: {len(self.invalid)}",
            f"Windows changed by the rule: {len(self.normalized)}",
            f"Time zones:                {len(per_zone)}",
        ]
        for zone, count in sorted(per_zone.items()):
            out.append(f"  {zone}: {count} client(s)")
        for client_id, stored, effective in self.normalized:
            out.append(f"  {client_id}: stored {stored} -> delivers at {effective}")
        for client_id in self.invalid:
            out.append(f"  invalid: {client_id}")
        return out


def run(*, apply: bool, keep_legacy: bool = False, now: datetime | None = None) -> BackfillReport:
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
        report.indexed.append((client_id, preference.time_zone, slots))
        if apply:
            notification_slot_store.sync_client_slots(
                client_id, zone=preference.time_zone, slots=slots, now_iso=now_iso, prune_legacy=not keep_legacy
            )
    return report


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--apply", action="store_true", help="write the slot-recipient table (default: dry run, read-only)")
    parser.add_argument("--keep-legacy", action="store_true", help="with --apply: leave first-release (JST-keyed) rows in place")
    args = parser.parse_args(argv)
    if args.keep_legacy and not args.apply:
        parser.error("--keep-legacy only makes sense with --apply")

    report = run(apply=args.apply, keep_legacy=args.keep_legacy)
    print("APPLIED" if args.apply else "DRY RUN (nothing written; pass --apply to write)")
    print("\n".join(report.lines()))
    return 0


if __name__ == "__main__":
    sys.exit(main())
