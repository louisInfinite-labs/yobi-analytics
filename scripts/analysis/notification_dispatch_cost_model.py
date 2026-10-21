"""DynamoDB cost model of the notification dispatcher: before (HEAD c70dc8a) vs after (due-candidate lookup + simultaneous-livestream notice).

Run from the repository root:

    PYTHONUTF8=1 PYTHONPATH=src:. python -m scripts.analysis.notification_dispatch_cost_model [--old-source <path to the old notification_dispatcher.py>]

What is measured and what is not (every number in the output carries one of these labels):

- MEASURED-OPS: the number and kind of storage operations the REAL dispatcher code performs, counted by running it (the old module from git and the
  new one) on the same in-memory world through tests/notifications/op_counting_harness.py. Nothing here is a moto estimate and nothing was run on AWS.
- SIZES: item sizes are computed from the real item shapes (the real preference writer, the real schedule derivation) with DynamoDB's documented
  item-size rules (names + values + the map/list overheads), not taken from any consumed-capacity figure.
- BILLING: RRU / WRU follow the documented rules (eventually consistent GetItem 0.5 RRU per 4 KB item; Query = the SUM of the items read rounded up to
  4 KB, halved when eventually consistent; every write 1 WRU per 1 KB, and every write to the config table ALSO writes configKey-index, a second
  charge, because every item carries configKey and the index projects ALL attributes). The code uses boto3's default (eventually consistent) reads.
- ASSUMPTION: client population shape (creators followed, share of subscribed / opted-in clients, setting mix, streams per day) and the unit prices.
  These are inputs, printed in the header, not facts about production. Live production figures were NOT read (no AWS access was used).
"""

from __future__ import annotations

import argparse
import importlib.util
import math
import subprocess
import sys
import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[2]
UTC = timezone.utc

# ---------------------------------------------------------------- ASSUMPTIONS (inputs)
CREATORS_FOLLOWED = 8  # creators a client has a creator-全部 reminder for
SUBSCRIBED_SHARE = 1.0  # share of clients with a stored push subscription (the old loop skips the rest after reading their preference)
STREAMS_PER_ACTIVE_DAY = 60  # distinct upcoming streams whose reminder moments fall in the day
OPTED_IN_SHARE = 0.3  # share of clients that opt in to the simultaneous notice
NEW_VIDEO_CREATORS_ON = 30  # creators a client has the new-video switch ON for (affects the stored preference size)
CLIENT_COUNTS = (100, 1_000, 10_000)
# Unit prices: ASSUMED. AWS's pricing page lists $0.625 / million WRU and $0.125 / million RRU for its reference region; ap-northeast-1 has been
# priced about 14% higher than that reference, giving the figures below. Verify against the current Tokyo price list; the RRU / WRU counts do not depend on it.
PRICE_PER_MILLION_RRU = 0.1425
PRICE_PER_MILLION_WRU = 0.715
PRICE_PER_GB_MONTH = 0.285


# ---------------------------------------------------------------- DynamoDB item sizes and billing rules


def attribute_size(value) -> int:
    """The documented size of one attribute VALUE (bytes)."""
    if value is None or isinstance(value, bool):
        return 1
    if isinstance(value, str):
        return len(value.encode("utf-8"))
    if isinstance(value, (int, float)):
        digits = len(str(abs(value)).replace(".", "").lstrip("0")) or 1
        return min(21, math.ceil(digits / 2) + 1)
    if isinstance(value, dict):
        return 3 + sum(len(k.encode("utf-8")) + attribute_size(v) + 1 for k, v in value.items())
    if isinstance(value, (list, tuple)):
        return 3 + sum(attribute_size(v) + 1 for v in value)
    raise TypeError(type(value))


def item_size(item: dict) -> int:
    """Item size: every attribute's name plus its value."""
    return sum(len(name.encode("utf-8")) + attribute_size(value) for name, value in item.items())


def config_item_size(client_id: str, key: str, value, updated_at: str = "2026-10-21T00:00:00+00:00") -> int:
    """Size of one YobiRemoteConfig item."""
    return item_size({"clientId": client_id, "configKey": key, "value": value, "updatedAt": updated_at})


def rru_get(size: int, *, consistent: bool = False) -> float:
    """GetItem: 1 RRU per 4 KB (or part), halved when eventually consistent."""
    units = math.ceil(max(size, 1) / 4096)
    return units * (1.0 if consistent else 0.5)


def rru_query(total_size: int, *, consistent: bool = False) -> float:
    """Query: the items read are summed and rounded up to 4 KB once; an empty result still costs the minimum unit."""
    units = max(1, math.ceil(total_size / 4096))
    return units * (1.0 if consistent else 0.5)


def wru_put(size: int, *, gsi: bool) -> int:
    """PutItem / DeleteItem: 1 WRU per 1 KB (or part), plus the same again for configKey-index when `gsi`."""
    units = max(1, math.ceil(size / 1024))
    return units * (2 if gsi else 1)


# ---------------------------------------------------------------- realistic item shapes (built with the real code)


def build_world_values(roster: list[str]) -> dict:
    """The stored shapes: a preference as the real writer stores it, a push subscription, a reminder, a schedule record."""
    sys.path.insert(0, str(REPO / "src"))
    from notifications import live_reminder, notification_dispatch

    on = set(roster[:NEW_VIDEO_CREATORS_ON])
    raw_preference = {
        "enabled": True,
        "notificationLevel": "all",
        "notificationTimeZone": "Asia/Tokyo",
        "notificationLocale": "ja",
        "deliveryWindows": ["08:00", "18:00"],
        "newVideoCreatorOverride": {creator: creator in on for creator in roster},
        "newVideoShortCreatorOverride": {creator: False for creator in roster},
    }
    preference = notification_dispatch.stamp_new_video_activation(
        raw_preference, previous_value=None, previous_updated_at=None, now=datetime(2026, 10, 1, tzinfo=UTC)
    )
    subscription = {
        "endpoint": "https://fcm.googleapis.com/fcm/send/" + "d" * 142,
        "keys": {"p256dh": "B" * 87, "auth": "a" * 22},
    }
    reminder = {"notifyAtStart": True, "advanceReminder": "30min"}
    entries = {
        f"vid{index:08d}"[:11].ljust(11, "x"): {
            "creatorId": roster[index % len(roster)],
            "scheduledStartMs": 1_790_000_000_000 + index * 600_000,
            "topic": None,
            "title": "【雑談】今日はのんびり配信やっていきます！みんな来てね　" + str(index),
            "status": "upcoming",
        }
        for index in range(STREAMS_PER_ACTIVE_DAY)
    }
    first_seen = live_reminder.first_seen_to_value(
        {
            video_id: live_reminder.FirstSeen(value["scheduledStartMs"] // 60_000, datetime(2026, 10, 20, tzinfo=UTC), ())
            for video_id, value in entries.items()
        }
    )
    schedule = {
        "entries": entries,
        "refreshedAt": "2026-10-21T00:00:00+00:00",
        "firstSeen": first_seen,
        "sourceRefreshedAt": "2026-10-21T00:00:00+00:00",
        "revision": 1_790_000_000_000,
    }
    return {"preference": preference, "subscription": subscription, "reminder": reminder, "schedule": schedule}


# ---------------------------------------------------------------- the measured world


def _load_old_dispatcher(source: Path):
    """The pre-change dispatcher module, from a file (git show HEAD:src/notifications/notification_dispatcher.py)."""
    spec = importlib.util.spec_from_file_location("old_notification_dispatcher", source)
    module = importlib.util.module_from_spec(spec)
    sys.modules["old_notification_dispatcher"] = module
    spec.loader.exec_module(module)
    return module


class Costs:
    """Operation counts and billed units of one run."""

    def __init__(self) -> None:
        """All zero."""
        self.ops = {"GetItem": 0, "Query": 0, "PutItem": 0, "DeleteItem": 0}
        self.rru = 0.0
        self.wru = 0

    def add(self, other: "Costs", times: float = 1.0) -> None:
        """Accumulate another run's costs `times` times."""
        for key, count in other.ops.items():
            self.ops[key] += count * times
        self.rru += other.rru * times
        self.wru += other.wru * times


def run_costs(world, ops: list[tuple], sizes: dict) -> Costs:
    """Bill the recorded operations. `sizes` maps what the harness cannot know (a record's size by kind)."""
    costs = Costs()
    for op in ops:
        kind = op[0]
        if kind == "get":
            costs.ops["GetItem"] += 1
            costs.rru += rru_get(sizes["get"](op[1], op[2]))
        elif kind in ("list_by_key", "list_prefix"):
            costs.ops["Query"] += 1
            costs.rru += rru_query(sizes["query"](op))
        elif kind == "put":
            costs.ops["PutItem"] += 1
            costs.wru += wru_put(sizes["put"](op[1], op[2]), gsi=True)
        elif kind == "delete":
            costs.ops["DeleteItem"] += 1
            costs.wru += wru_put(sizes["put"](op[1], op[2]), gsi=True)
        elif kind == "delivery_read":
            costs.ops["GetItem"] += 1
            costs.rru += rru_get(80)
        elif kind == "delivery_write":
            costs.ops["PutItem"] += 1
            costs.wru += wru_put(80, gsi=False)
    return costs


def main() -> None:
    """Measure and print the before / after tables."""
    parser = argparse.ArgumentParser()
    parser.add_argument("--old-source", type=Path, default=None, help="the pre-change notification_dispatcher.py (default: git show HEAD)")
    args = parser.parse_args()
    sys.path.insert(0, str(REPO / "src"))
    sys.path.insert(0, str(REPO))

    from notifications import live_reminder, notification_dispatcher
    from notifications import simultaneous_live as sim
    from tests.notifications.op_counting_harness import CountingHarness
    from tests.notifications.test_notification_dispatcher import _creator
    from tests.notifications.test_scheduled_start_notifications import SNAPSHOT_AT, START, _frozen, _stream
    from tracking.creator_master import load_creators

    roster = [creator.creator_id for creator in load_creators() if creator.active and creator.channel_type == "member"]
    values = build_world_values(roster)
    size_pref = config_item_size("c-00000", "notificationPreference", values["preference"])
    size_sub = config_item_size("c-00000", "pushSubscription", values["subscription"])
    size_rem = config_item_size("c-00000", "creatorReminder#aizawa_ema#all", values["reminder"])
    size_sched = config_item_size("__system__", "streamSchedule", values["schedule"])
    size_opt = config_item_size("c-00000", sim.OPT_IN_KEY, {"enabled": True})

    if args.old_source is None:
        old_path = Path(tempfile.mkdtemp(prefix="old_dispatcher_")) / "old_notification_dispatcher.py"
        old_path.write_text(
            subprocess.run(["git", "-C", str(REPO), "show", "HEAD:src/notifications/notification_dispatcher.py"], capture_output=True, check=True, text=True, encoding="utf-8").stdout,
            encoding="utf-8",
        )
        args.old_source = old_path
    old = _load_old_dispatcher(args.old_source)

    print("# Notification dispatcher DynamoDB cost model")
    print()
    print("## Inputs")
    print(f"- ASSUMPTION creators followed per client {CREATORS_FOLLOWED}; subscribed share {SUBSCRIBED_SHARE:.0%}; streams per active day {STREAMS_PER_ACTIVE_DAY}; opted-in share {OPTED_IN_SHARE:.0%}; roster {len(roster)} member creators")
    print(f"- ASSUMPTION prices (ap-northeast-1 on-demand, unverified): ${PRICE_PER_MILLION_RRU}/M RRU, ${PRICE_PER_MILLION_WRU}/M WRU, ${PRICE_PER_GB_MONTH}/GB-month")
    print(f"- SIZES (computed from real shapes): preference {size_pref} B, push subscription {size_sub} B, creator reminder {size_rem} B, streamSchedule ({STREAMS_PER_ACTIVE_DAY} streams) {size_sched} B, opt-in {size_opt} B")
    print()

    followed_by: dict[int, list[str]] = {}

    def follows(index: int) -> list[str]:
        """The creators client `index` follows (deterministic spread over the roster)."""
        if index not in followed_by:
            followed_by[index] = [roster[(index * 7 + step * 13) % len(roster)] for step in range(CREATORS_FOLLOWED)]
        return followed_by[index]

    advances = [None, "1min", "10min", "30min", "1hour"]

    def build(monkeypatch, n: int, *, opted_in: bool, stream_creators: list[str]) -> tuple:
        """A counting world with `n` clients, the old dispatcher patched onto it, and one stream per creator in `stream_creators`."""
        from notifications import simultaneous_dispatcher

        simultaneous_dispatcher.reset_cache()  # every measured world starts in a cold container: no memory of an earlier world's collisions
        world = CountingHarness(monkeypatch)
        world.creators = [_creator(creator_id=roster[0])]
        for module in (old,):
            monkeypatch.setattr(module, "get_vapid_credentials", lambda: ("pem", {"sub": "mailto:a@b.com"}))
            monkeypatch.setattr(module, "load_creators", lambda: world.creators)
            monkeypatch.setattr(module, "_read_source_refreshed_at", lambda: world.snapshot_at)
        sizes = {"clients_following": {creator: 0 for creator in stream_creators}}
        for index in range(n):
            client = f"c-{index:05d}"
            reminders = {creator: {"notifyAtStart": True, "advanceReminder": advances[(index + step) % 5]} for step, creator in enumerate(follows(index))}
            world.add_client(client, preference=values["preference"], creator_reminders=reminders)
            world.config[(client, "pushSubscription")] = values["subscription"]
            if opted_in and index % round(1 / OPTED_IN_SHARE) == 0:
                world.config[(client, sim.OPT_IN_KEY)] = {"enabled": True}
            for creator in stream_creators:
                if creator in reminders:
                    sizes["clients_following"][creator] += 1
        world.refresh_snapshot(
            [_stream(f"vid{index:08d}"[:11].ljust(11, "x"), creator=creator) for index, creator in enumerate(stream_creators)], SNAPSHOT_AT
        )
        return world, sizes

    def sizers(world):
        """Item-size lookups over the world's real stored values."""
        def get_size(client_id, key):
            """Size of the GetItem-ed record."""
            if key == live_reminder.STREAM_SCHEDULE_KEY:
                return size_sched  # the real record carries the day's streams; the measured world holds only a few
            return config_item_size(client_id, key, world.config.get((client_id, key), {"x": 1}))

        def query_size(op):
            """Sum of the sizes a Query reads."""
            if op[0] == "list_by_key":
                return sum(config_item_size(c, k, v) for (c, k), v in world.config.items() if k == op[1])
            return sum(config_item_size(c, k, v) for (c, k), v in world.config.items() if c == op[1] and k.startswith(op[2]))

        def put_size(client_id, key):
            """Size of the written / deleted record."""
            return config_item_size(client_id, key, world.config.get((client_id, key), {"version": 1, "work": {}}))

        return {"get": get_size, "query": query_size, "put": put_size}

    def scaled(n: int, which: str) -> tuple[int, float]:
        """(clients to actually simulate, factor to scale the result by). The OLD dispatcher does a per-client Query against the in-memory fake, which
        scans every stored item, so simulating 10,000 clients is quadratic; its work is exactly linear in the number of clients (verified by the
        100 vs 1,000 rows), so it is measured at <= 1,000 clients and scaled. The new dispatcher is always simulated at the real size."""
        if which == "old" and n > 1_000:
            return 1_000, n / 1_000
        return n, 1.0

    measured: dict[tuple, Costs] = {}

    warm = timedelta(minutes=-1)  # the previous run finished exactly one cadence ago in this warm container: the steady state

    def measure_minute(
        monkeypatch, n: int, now_offset: timedelta, which: str, *, creators_streamed: list[str], last_served: timedelta | None = warm
    ) -> Costs:
        """Ops and units of ONE dispatcher run at START + now_offset, by the old or the new code (memoised: the same minute is asked for by several tables).

        `last_served` is when the new dispatcher's warm container last finished a run, relative to this run (None = a cold container: it remembers nothing)."""
        memo_key = (n, now_offset, which, tuple(creators_streamed), last_served)
        if memo_key not in measured:
            measured[memo_key] = _measure_minute(monkeypatch, n, now_offset, which, creators_streamed=creators_streamed, last_served=last_served)
        return measured[memo_key]

    def _measure_minute(
        monkeypatch, n: int, now_offset: timedelta, which: str, *, creators_streamed: list[str], last_served: timedelta | None
    ) -> Costs:
        """Run the dispatcher once and bill what it did."""
        n_sim, factor = scaled(n, which)
        world, _ = build(monkeypatch, n_sim, opted_in=False, stream_creators=creators_streamed)
        world.run(START - timedelta(hours=6))  # derive + persist the schedule once; not part of the measurement
        world.take_ops()
        world.delivery.clear()
        now = START + now_offset
        monkeypatch.setattr(notification_dispatcher, "datetime", _frozen(now))
        monkeypatch.setattr(notification_dispatcher, "_last_served_ms", None if last_served is None else int((now + last_served).timestamp() * 1000))
        monkeypatch.setattr(old, "datetime", _frozen(now))
        (notification_dispatcher if which == "new" else old).lambda_handler({}, None)
        costs = run_costs(world, world.take_ops(), sizers(world))
        if factor != 1.0:
            scaled_costs = Costs()
            scaled_costs.add(costs, factor)
            return scaled_costs
        return costs

    def day(n: int, which: str, *, streams: int) -> Costs:
        """One day = minutes with nothing due + the five reminder moments of each stream (measured per moment)."""
        total = Costs()
        idle_cost = Costs()
        due_creator = [roster[0]]
        moments = {"start": timedelta(seconds=10)}
        moments.update({offset: -timedelta(minutes=minutes) + timedelta(seconds=10) for offset, minutes in live_reminder.ADVANCE_REMINDER_OFFSET_MINUTES.items()})
        with pytest.MonkeyPatch.context() as mp:
            idle_cost = measure_minute(mp, n, -timedelta(minutes=200), which, creators_streamed=due_creator)
        total.add(idle_cost, 1440 - 5 * streams)
        # followers differ per creator only through the spread; measure one representative creator and scale by the average followers.
        for moment, offset in moments.items():
            with pytest.MonkeyPatch.context() as mp:
                moment_cost = measure_minute(mp, n, offset, which, creators_streamed=due_creator)
            total.add(moment_cost, streams)
        return total

    def money(costs: Costs) -> float:
        """USD of a Costs, per its own units."""
        return costs.rru / 1e6 * PRICE_PER_MILLION_RRU + costs.wru / 1e6 * PRICE_PER_MILLION_WRU

    print("## Per-day cost, before vs after (MEASURED-OPS x SIZES x BILLING)")
    print()
    print("| clients | day | version | GetItem | Query | Put/Delete | RRU/day | WRU/day | USD/day | USD/30 days |")
    print("|---:|---|---|---:|---:|---:|---:|---:|---:|---:|")
    for n in CLIENT_COUNTS:
        for label, streams in (("idle (0 streams)", 0), (f"active ({STREAMS_PER_ACTIVE_DAY} streams)", STREAMS_PER_ACTIVE_DAY)):
            for which in ("old", "new"):
                costs = day(n, which, streams=streams)
                # one run per minute also reads the shared snapshot heartbeat (identical in both versions; counted as 1440 x 0.5 RRU here)
                costs.rru += 1440 * rru_get(100)
                costs.ops["GetItem"] += 1440
                # also in both versions: the schedule re-derivation writes the whole streamSchedule record (base + configKey-index) every 10 minutes
                costs.wru += 144 * wru_put(size_sched, gsi=True)
                costs.ops["PutItem"] += 144
                print(
                    f"| {n:,} | {label} | {'before' if which == 'old' else 'after'} | {costs.ops['GetItem']:,.0f} | {costs.ops['Query']:,.0f} | "
                    f"{costs.ops['PutItem'] + costs.ops['DeleteItem']:,.0f} | {costs.rru:,.0f} | {costs.wru:,.0f} | {money(costs):.4f} | {money(costs) * 30:.2f} |"
                )
    print()
    print("(The active day measures ONE representative creator's moments and multiplies by the streams; deliveries, the schedule record's read each minute, the shared heartbeat read and the 144 schedule re-derivation writes are in both versions and cost the same. The 'before' rows at 10,000 clients are measured at 1,000 and scaled linearly: the old per-client work is exactly linear, as the 100 -> 1,000 rows show.)")

    print()
    print("## Per-minute shape at 10,000 clients (MEASURED-OPS)")
    print()
    print("| minute | version | GetItem | Query | RRU |")
    print("|---|---|---:|---:|---:|")
    n = 10_000
    for label, offset in (("idle", -timedelta(minutes=200)), ("a start minute (creator followed by ~7% of clients)", timedelta(seconds=10))):
        for which in ("old", "new"):
            with pytest.MonkeyPatch.context() as mp:
                c = measure_minute(mp, n, offset, which, creators_streamed=[roster[0]])
            print(f"| {label} | {'before' if which == 'old' else 'after'} | {c.ops['GetItem']:,.0f} | {c.ops['Query']:,.0f} | {c.rru:,.0f} |")

    print()
    print("## Recovery cost (new code, MEASURED-OPS, 10,000 clients)")
    print()
    print("| situation | GetItem | Query | Put/Delete | RRU |")
    print("|---|---:|---:|---:|---:|")
    n = 10_000
    for label, offset, last in (
        ("idle minute, warm container (steady state)", -timedelta(minutes=200), warm),
        ("idle minute, COLD container (it re-serves the previous minute)", -timedelta(minutes=200), None),
        ("idle minute after a 5-minute gap (recovers 4 earlier minutes)", -timedelta(minutes=200), timedelta(minutes=-5)),
        ("a start minute served on time, warm", timedelta(seconds=10), warm),
        ("the same start minute served 2 minutes late after a gap (recovered)", timedelta(minutes=2), timedelta(minutes=-7)),
    ):
        with pytest.MonkeyPatch.context() as mp:
            c = measure_minute(mp, n, offset, "new", creators_streamed=[roster[0]], last_served=last)
        print(f"| {label} | {c.ops['GetItem']:,.0f} | {c.ops['Query']:,.0f} | {c.ops['PutItem'] + c.ops['DeleteItem']:,.0f} | {c.rru:,.0f} |")
    print()
    print("## Worst case: ONE creator followed by every client, at its start minute (MEASURED-OPS)")
    print()
    print("| clients | version | GetItem | Query | RRU for that minute |")
    print("|---:|---|---:|---:|---:|")
    for n in CLIENT_COUNTS:
        for which in ("old", "new"):
            n_sim, factor = scaled(n, which)
            with pytest.MonkeyPatch.context() as mp:
                world, _ = build(mp, n_sim, opted_in=False, stream_creators=[roster[0]])
                for index in range(n_sim):  # everyone follows roster[0] with notify-at-start
                    world.config[(f"c-{index:05d}", live_reminder.creator_reminder_key(roster[0], "all"))] = {"notifyAtStart": True, "advanceReminder": None}
                world.run(START - timedelta(hours=6))
                world.take_ops()
                world.delivery.clear()
                now = START + timedelta(seconds=10)
                mp.setattr(notification_dispatcher, "datetime", _frozen(now))
                mp.setattr(notification_dispatcher, "_last_served_ms", int((now + warm).timestamp() * 1000))
                mp.setattr(old, "datetime", _frozen(now))
                (notification_dispatcher if which == "new" else old).lambda_handler({}, None)
                c = run_costs(world, world.take_ops(), sizers(world))
            if factor != 1.0:
                bigger = Costs()
                bigger.add(c, factor)
                c = bigger
            print(f"| {n:,} | {'before' if which == 'old' else 'after'} | {c.ops['GetItem']:,.0f} | {c.ops['Query']:,.0f} | {c.rru:,.0f} |")
    print()
    print("Both versions then do the same delivery work (the claim / send / confirm per reminder); the difference is what is read to find the recipients.")

    print()
    print("## Simultaneous-livestream notice and the other events (new code only; MEASURED-OPS)")
    print()
    print("Triggered by schedule CHANGES only. Each row is ONE dispatcher run; the rows of one block follow each other in time. Half of the clients follow")
    print("creators A+B only, half follow A+B+C; 30 % of all clients have opted in (assumption).")
    print()
    print("| event | GetItem | Query | Put/Delete | RRU | WRU |")
    print("|---|---:|---:|---:|---:|---:|")
    first_start = START - timedelta(hours=9)

    def run_step(world, mp, now: datetime, streams: list[dict] | None = None) -> Costs:
        """One dispatcher run at `now` in a warm container; with `streams`, a NEWER shared snapshot listing them is in place first."""
        if streams is not None:
            world.refresh_snapshot(streams, world.snapshot_at + timedelta(minutes=10))
        mp.setattr(notification_dispatcher, "datetime", _frozen(now))
        mp.setattr(notification_dispatcher, "_last_served_ms", int((now - timedelta(minutes=1)).timestamp() * 1000))
        notification_dispatcher.lambda_handler({}, None)
        return run_costs(world, world.take_ops(), sizers(world))

    def row(label: str, costs: Costs) -> None:
        """One table row."""
        print(f"| {label} | {costs.ops['GetItem']:,.0f} | {costs.ops['Query']:,.0f} | {costs.ops['PutItem'] + costs.ops['DeleteItem']:,.0f} | {costs.rru:,.0f} | {costs.wru:,.0f} |")

    for n in (1_000, 10_000):
        with pytest.MonkeyPatch.context() as mp:
            trio = [roster[0], roster[7], roster[14]]
            world, _ = build(mp, n, opted_in=True, stream_creators=[trio[0]])
            for index in range(n):
                for creator in trio[: 2 if index % 2 == 0 else 3]:
                    world.config[(f"c-{index:05d}", live_reminder.creator_reminder_key(creator, "all"))] = {"notifyAtStart": True, "advanceReminder": None}
            s_a = _stream("vidAAAAAAAA1", creator=trio[0])
            s_b = _stream("vidAAAAAAAA2", creator=trio[1])
            s_c = _stream("vidAAAAAAAA3", creator=trio[2])
            world.run(first_start)  # the baseline: the first-ever schedule announces nothing
            world.take_ops()
            row(f"[{n:,} clients] A known, nothing changes (an ordinary refresh)", run_step(world, mp, first_start + timedelta(minutes=10), [s_a]))
            row(f"[{n:,} clients] B discovered: new collision A+B", run_step(world, mp, first_start + timedelta(hours=2), [s_a, s_b]))
            row(f"[{n:,} clients] C discovered: A+B+C (the A+B-only half is deduplicated, the A+B+C half is told)", run_step(world, mp, first_start + timedelta(hours=5), [s_a, s_b, s_c]))
            row(f"[{n:,} clients] the next refresh, unchanged (pending list is cleaned: nothing else)", run_step(world, mp, first_start + timedelta(hours=5, minutes=10), [s_a, s_b, s_c]))
            row(f"[{n:,} clients] a plain minute with nothing pending", run_step(world, mp, first_start + timedelta(hours=5, minutes=11)))
            row(f"[{n:,} clients] C cancelled: the A+B+C ledger is deleted", run_step(world, mp, first_start + timedelta(hours=6), [s_a, s_b]))
    print(f"| a user opts in / out (one item, base + configKey-index) | 0 | 0 | 1 | 0 | {wru_put(size_opt, gsi=True)} |")
    print(f"| a user adds / edits / removes a reminder (UNCHANGED by this work: no derived record to maintain) | 0 | 0 | 1 | 0 | {wru_put(size_rem, gsi=True)} |")
    print(f"| a user changes the notification preference (UNCHANGED) | 0 | 0 | 1 | 0 | {wru_put(size_pref, gsi=True)} |")

    print()
    print("## Storage added (SIZES)")
    print(f"- opt-in: {size_opt} B per opted-in client (x2 in configKey-index); at {OPTED_IN_SHARE:.0%} of 10,000 clients = {3000 * size_opt * 2 / 1e6:.2f} MB")
    print("- one ledger per NEW collision (created when the schedule change is detected), deleted when the collision disappears: a few hundred bytes plus ~110 B per OPEN RETRY (the recipient list itself is never stored); `pendingNotices` ids ride in the existing schedule record")
    print("- NO new table, NO new index, NO derived per-user due record")


if __name__ == "__main__":
    main()
