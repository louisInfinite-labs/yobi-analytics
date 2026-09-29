"""AWS Cost Recovery (third pass), Scope C/M: prove the D-1/D-7/D-30 exact-anchor
ranking path is genuinely driven end to end by 31 real, consecutive days of S3
daily-shard history -- not just a unit-level exact_gains() call with two
hand-built anchor dicts. This is deliberately an integration test across the
real HistoryStore contract (write_daily_shard/read_daily_shard), not a mock of
history_ranking's own internals, so it proves the actual persisted-data shape
production writes is what these functions actually compute against.

Covers, per AWS Cost Recovery's own Scope C/M requirements:
  - exact D-1 calculation (a daily-observed video)
  - exact D-7 calculation
  - exact D-30 calculation
  - carried-forward rows preserve anchor continuity (a Cold-style video only
    genuinely observed a few times across the 31 days, carried forward every
    other day -- exactly collection.history_worker._carry_forward_non_due_rows'
    own persisted shape)
  - a video not observed every day (in the "did not exist yet" sense) still
    gets the correct, non-fabricated D-30 baseline (0, per history_ranking.
    _period_value's own new-video rule) -- not a silently-dropped gap
  - a genuinely old video with a real historical gap (no row at all on the
    anchor date, unrelated to being new) gets None, never a fabricated 0 --
    the conservative branch of the same rule
  - no legacy YobiSnapshots dependency anywhere in this path
"""

from __future__ import annotations

from datetime import date, timedelta

from analytics.history_ranking import (
    CreatorDimensions,
    exact_gains,
    load_exact_anchor_rows,
    top_n_by_scope,
)
from stores.history_store import HistoryRow, shard_for_video

DAY0 = date(2026, 8, 31)
REPORT_DATE = DAY0 + timedelta(days=30)  # Day 30: 2026-09-30


def _ids_in_one_shard(count: int) -> list[str]:
    """Deterministically find `count` distinct video ids that all hash to the
    exact same shard -- so this test can read them back with one single
    load_exact_anchor_rows(..., shard=SHARD) call, faithfully matching the
    real one-shard-per-invocation production architecture."""
    target_shard = shard_for_video("video-000000")
    ids = []
    candidate = 0
    while len(ids) < count:
        video_id = f"video-{candidate:06d}"
        if shard_for_video(video_id) == target_shard:
            ids.append(video_id)
        candidate += 1
    return ids


HOT, CARRIED, NEW, GAP = _ids_in_one_shard(4)
SHARD = shard_for_video(HOT)


class _InMemoryHistoryStore:
    """A HistoryStore implementation with real in-memory shard storage --
    matching the real S3HistoryStore contract exactly (write/read/exists per
    (date, shard)), so this test exercises the real read_daily_shard/
    shard_exists semantics load_exact_anchor_rows depends on."""

    def __init__(self):
        self.objects: dict[tuple[date, int], list[HistoryRow]] = {}

    def write_daily_shard(self, collection_date, shard, rows):
        self.objects[(collection_date, shard)] = list(rows)
        return f"history/daily/date={collection_date.isoformat()}/shard={shard:02d}.parquet"

    def read_daily_shard(self, collection_date, shard):
        return self.objects.get((collection_date, shard), [])

    def shard_exists(self, collection_date, shard):
        return (collection_date, shard) in self.objects


def _build_thirty_one_days() -> _InMemoryHistoryStore:
    """Write real day-0..day-30 shards for four videos, each with a distinct,
    hand-computable real-world pattern -- see this module's own docstring."""
    store = _InMemoryHistoryStore()

    for day_offset in range(31):
        day = DAY0 + timedelta(days=day_offset)
        rows: list[HistoryRow] = []

        # HOT: genuinely observed every single day, +1000 views/day from a
        # 10,000 baseline on day 0.
        rows.append(
            HistoryRow(
                video_id=HOT,
                creator_id="c1",
                view_count=10_000 + 1000 * day_offset,
                observed_at=f"{day.isoformat()}T18:00:00+09:00",
                availability_status="available",
                carried_forward=False,
            )
        )

        # CARRIED: a Cold-style video genuinely observed only on day 0, day
        # 15, and day 30 -- every other day carries the last real value
        # forward (exactly collection.history_worker._carry_forward_non_due_
        # rows' own persisted shape: carried_forward=True, real historical
        # view_count/observed_at, never today's wall-clock time).
        if day_offset == 0:
            carried_view, carried_observed, carried_forward_flag = 5000, f"{day.isoformat()}T18:00:00+09:00", False
        elif day_offset == 15:
            carried_view, carried_observed, carried_forward_flag = 5300, f"{day.isoformat()}T18:00:00+09:00", False
        elif day_offset == 30:
            carried_view, carried_observed, carried_forward_flag = 5900, f"{day.isoformat()}T18:00:00+09:00", False
        elif day_offset < 15:
            carried_view, carried_observed, carried_forward_flag = 5000, f"{DAY0.isoformat()}T18:00:00+09:00", True
        else:
            carried_view = 5300
            carried_observed = f"{(DAY0 + timedelta(days=15)).isoformat()}T18:00:00+09:00"
            carried_forward_flag = True
        rows.append(
            HistoryRow(
                video_id=CARRIED,
                creator_id="c1",
                view_count=carried_view,
                observed_at=carried_observed,
                availability_status="available",
                carried_forward=carried_forward_flag,
            )
        )

        # NEW: discovered on day 20 -- no row at all before then. Observed
        # daily afterward, +100 views/day from a 2,000 baseline.
        if day_offset >= 20:
            rows.append(
                HistoryRow(
                    video_id=NEW,
                    creator_id="c1",
                    view_count=2_000 + 100 * (day_offset - 20),
                    observed_at=f"{day.isoformat()}T18:00:00+09:00",
                    availability_status="available",
                    carried_forward=False,
                )
            )

        # GAP: an old video (discovered long before day 0) with a genuine
        # historical collection gap on day 0 and day 23 (no row at all --
        # unrelated to being new), but real rows on day 29 and day 30.
        if day_offset == 29:
            rows.append(
                HistoryRow(
                    video_id=GAP,
                    creator_id="c1",
                    view_count=790,
                    observed_at=f"{day.isoformat()}T18:00:00+09:00",
                    availability_status="available",
                    carried_forward=False,
                )
            )
        elif day_offset == 30:
            rows.append(
                HistoryRow(
                    video_id=GAP,
                    creator_id="c1",
                    view_count=800,
                    observed_at=f"{day.isoformat()}T18:00:00+09:00",
                    availability_status="available",
                    carried_forward=False,
                )
            )
        # day 0 and day 23 (the D-30/D-7 anchors) deliberately get no GAP row.

        store.write_daily_shard(day, SHARD, rows)

    return store


def _discovered_dates() -> dict[str, date]:
    return {
        HOT: DAY0,
        CARRIED: DAY0,
        NEW: DAY0 + timedelta(days=20),
        GAP: date(2020, 1, 1),  # long predates day 0 -- a real gap, not a new video
    }


def test_exact_d1_d7_d30_gains_from_a_real_thirty_one_day_history():
    store = _build_thirty_one_days()
    today_rows = store.read_daily_shard(REPORT_DATE, SHARD)
    anchor_rows = load_exact_anchor_rows(store, report_date=REPORT_DATE, shard=SHARD)

    gains = exact_gains(today_rows, anchor_rows, report_date=REPORT_DATE, discovered_date_by_video=_discovered_dates())

    # HOT: genuinely observed every day, so every anchor is a real prior row.
    assert gains[HOT][1] == 1000  # 40000 - 39000
    assert gains[HOT][7] == 7000  # 40000 - 33000
    assert gains[HOT][30] == 30000  # 40000 - 10000

    # CARRIED: anchors resolve through carried-forward rows, not gaps --
    # continuity is preserved even though the video wasn't genuinely
    # re-observed on most of these days.
    assert gains[CARRIED][1] == 600  # 5900 - 5300 (day 29 carries day 15's value)
    assert gains[CARRIED][7] == 600  # 5900 - 5300 (day 23 also carries day 15's value)
    assert gains[CARRIED][30] == 900  # 5900 - 5000 (day 0's own real value)

    # NEW: discovered day 20. D-1/D-7 have real anchors; D-30 has none, but
    # the video didn't exist yet as of that anchor date, so its value is the
    # defensible new-video baseline (full latest count), never a dropped gap.
    assert gains[NEW][1] == 100  # 3000 - 2900
    assert gains[NEW][7] == 700  # 3000 - 2300
    assert gains[NEW][30] == 3000  # baseline 0 -> full latest view_count

    # GAP: an old video with a genuine historical gap on both the D-7 and
    # D-30 anchor dates -- must be None (incomplete), never fabricated as 0
    # or as the full latest count (that rule is reserved for genuinely new
    # videos only).
    assert gains[GAP][1] == 10  # 800 - 790, a real anchor
    assert gains[GAP][7] is None
    assert gains[GAP][30] is None


def test_top_n_by_scope_ranks_the_same_real_thirty_one_day_history_correctly():
    """The same real data through the actual production ranking function
    (top_n_by_scope), not just the lower-level exact_gains -- proving the
    full read path, not only its inner arithmetic."""
    store = _build_thirty_one_days()
    today_rows = store.read_daily_shard(REPORT_DATE, SHARD)
    anchor_rows = load_exact_anchor_rows(store, report_date=REPORT_DATE, shard=SHARD)
    dimensions = {"c1": CreatorDimensions(organization="vspo", branch="vspo_jp")}

    rankings = top_n_by_scope(
        today_rows,
        anchor_rows,
        report_date=REPORT_DATE,
        discovered_date_by_video=_discovered_dates(),
        dimensions_by_creator=dimensions,
        limit=10,
    )

    global_30d = {entry.video_id: entry.gain for entry in rankings[("global", "global")]["30d"]}
    # GAP is correctly excluded from the 30d ranking entirely (a real
    # incomplete gap, gain=None) -- it must never appear ranked with a
    # fabricated value.
    assert GAP not in global_30d
    assert global_30d[HOT] == 30000
    assert global_30d[CARRIED] == 900
    assert global_30d[NEW] == 3000

    # GAP does appear in the 1d ranking (it has a real D-1 anchor).
    global_1d = {entry.video_id: entry.gain for entry in rankings[("global", "global")]["1d"]}
    assert global_1d[GAP] == 10


def test_history_ranking_module_has_no_legacy_snapshots_dependency():
    """Structural proof, not just an absence of failures: the D-1/D-7/D-30
    ranking path has zero import-time coupling to YobiSnapshots or any
    DynamoDB store -- it is genuinely S3-only, not merely "not exercising"
    a legacy dependency that's still technically wired in."""
    import analytics.history_ranking as module

    source = module.__file__
    with open(source, encoding="utf-8") as f:
        contents = f.read()

    assert "snapshot_store" not in contents
    assert "dynamodb_store" not in contents
    assert "YobiSnapshots" not in contents
