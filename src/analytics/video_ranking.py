"""Per-creator, per-topic own-video ranking (video-ranking Phase B).

Videos NEVER rank across creators: every ranking this module produces is
scoped to exactly one creator's own catalog, never a cross-creator/org
scope the way analytics.history_ranking's pre-existing trending pipeline is.

Phase C storage correction: this module now builds and persists exactly ONE
canonical row per video per creator per day (build_creator_video_catalog),
carrying every metric's own anchor view count on that same row -- never a
separate, duplicated row set per metric (total/1d/7d/30d), which is what an
earlier version of this feature used to store. Sorting/ranking/topic
filtering for a specific metric all happen at READ time instead
(rank_video_rows), over that one persisted canonical row set -- see
stores.video_ranking_store's own docstring for the S3 layout this produces.

Reuses analytics.history_ranking.exact_gains unchanged for the growth
metrics (1d/7d/30d): the "does this video get a fabricated 0 baseline, or
stay a real gap" new-video rule (history_ranking._period_value) must not
diverge between this feature and the pre-existing creator/org trending
pipeline that rule was written for -- reimplementing it here would risk a
silent behavioral drift between the two.

Topic is the manifest's own persisted classification (tracking.
tracking_manifest.ManifestEntry.topic, ultimately tracking.video_topics.
classify_video_topic at discovery time) -- this module never re-derives a
topic from a title itself.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date
from typing import Any, Mapping

from analytics.history_ranking import exact_gains
from stores.history_store import EXACT_ANCHOR_DAYS, HistoryRow
from tracking.video_topics import OTHER_TOPIC, TOPIC_IDS

TOTAL_METRIC = "total"
GROWTH_METRICS = tuple(f"{days}d" for days in EXACT_ANCHOR_DAYS)  # ("1d", "7d", "30d")
VALID_METRICS = (TOTAL_METRIC,) + GROWTH_METRICS

# "all" is not one of the real topic ids (TOPIC_IDS) -- it is this feature's
# own filter keyword for "no topic filter", the same "all" + closed-enum
# shape analytics.subscriber_ranking/read_api already use for organization.
TOPIC_SCOPE_ALL = "all"
VALID_TOPIC_SCOPES = frozenset({TOPIC_SCOPE_ALL}) | TOPIC_IDS


@dataclass(frozen=True)
class VideoRankingRow:
    """One video's canonical, metric-independent ranking data for one
    creator per report date -- the ONLY row this feature ever persists per
    video (Phase C storage correction). `anchor_view_counts` maps each
    growth metric ("1d"/"7d"/"30d") to that period's exact anchor view
    count, or None when that period is a genuine collection gap (never a
    fabricated 0) -- see _anchor_view_counts_for below.

    title/thumbnail_url (video-ranking metadata propagation) are read
    straight from the tracking manifest's own persisted values (ultimately
    Video Master, populated at discovery time from the YouTube response
    already paid for -- see tracking.video_discovery/tracking.video_master),
    never a separate runtime lookup. published_at/discovered_at are
    diagnostic-only passthroughs of the manifest's own values.
    """

    video_id: str
    creator_id: str
    topic: str
    current_view_count: int
    anchor_view_counts: Mapping[str, int | None]
    title: str | None = None
    thumbnail_url: str | None = None
    published_at: str | None = None
    discovered_at: str | None = None


def _topic_for(video_id: str, topic_by_video: Mapping[str, str]) -> str:
    """A video with no manifest topic yet, or an unrecognized one, falls
    back to OTHER_TOPIC -- the same "nothing matched" bucket
    classify_video_topic itself returns for a genuinely unclassifiable
    title, never a fabricated guess (mirrors collection.history_worker.
    _resolve_manifest_topics' own fallback, applied here at read-of-the-
    mapping time instead of at manifest-resolution time)."""
    topic = topic_by_video.get(video_id)
    return topic if topic in TOPIC_IDS else OTHER_TOPIC


def build_creator_video_catalog(
    today_rows: list[HistoryRow],
    anchor_rows_by_days: Mapping[int, list[HistoryRow]],
    *,
    creator_id: str,
    report_date: date,
    topic_by_video: Mapping[str, str],
    discovered_date_by_video: Mapping[str, date] | None = None,
    title_by_video: Mapping[str, str] | None = None,
    thumbnail_by_video: Mapping[str, str] | None = None,
    published_at_by_video: Mapping[str, str] | None = None,
    discovered_at_by_video: Mapping[str, str] | None = None,
) -> list[VideoRankingRow]:
    """Build one creator's own-video canonical ranking catalog: one row per
    video with today's own lifetime view count plus every growth metric's
    own exact anchor view count (or None for a genuine gap).

    `today_rows`/`anchor_rows_by_days` may carry other creators' rows too --
    a caller reading raw S3 history shards gets the whole catalog, not one
    creator's own slice (creators' videos are scattered across the history
    store's hash-based shards, not partitioned by creator) -- so this
    filters to `creator_id`'s own rows FIRST, before any gain computation,
    enforcing "videos never rank across creators" as this function's own
    contract rather than trusting every caller to have already sliced
    correctly. `topic_by_video`/`discovered_date_by_video`/`title_by_video`/
    `thumbnail_by_video`/`published_at_by_video`/`discovered_at_by_video` may
    likewise be the whole catalog's own mapping -- only this creator's own
    video ids are ever looked up in them.

    discovered_date_by_video (dates, possibly UNKNOWN_DISCOVERED_DATE-
    filled) feeds exact_gains' own new-video baseline rule; discovered_at_by_
    video (raw ISO strings, only ever present when a manifest entry actually
    has one) is a separate, purely diagnostic passthrough onto each row --
    never the sentinel-filled value, which must never be serialized as if it
    were a real discovery date.
    """
    creator_today_rows = [row for row in today_rows if row.creator_id == creator_id]
    creator_anchor_rows_by_days = {
        days: [row for row in rows if row.creator_id == creator_id]
        for days, rows in anchor_rows_by_days.items()
    }

    gains = exact_gains(
        creator_today_rows,
        creator_anchor_rows_by_days,
        report_date=report_date,
        discovered_date_by_video=discovered_date_by_video,
    )

    title_by_video = title_by_video or {}
    thumbnail_by_video = thumbnail_by_video or {}
    published_at_by_video = published_at_by_video or {}
    discovered_at_by_video = discovered_at_by_video or {}

    rows: list[VideoRankingRow] = []
    for row in sorted(creator_today_rows, key=lambda r: r.video_id):
        anchor_view_counts = _anchor_view_counts_for(row, gains)
        rows.append(
            VideoRankingRow(
                video_id=row.video_id,
                creator_id=creator_id,
                topic=_topic_for(row.video_id, topic_by_video),
                current_view_count=row.view_count,
                anchor_view_counts=anchor_view_counts,
                title=title_by_video.get(row.video_id),
                thumbnail_url=thumbnail_by_video.get(row.video_id),
                published_at=published_at_by_video.get(row.video_id),
                discovered_at=discovered_at_by_video.get(row.video_id),
            )
        )
    return rows


def _anchor_view_counts_for(
    row: HistoryRow, gains: Mapping[str, Mapping[int, int | None]]
) -> dict[str, int | None]:
    """One row's own anchor view count per growth period: current -
    exact_gains' own gain, or None when exact_gains itself returned None (a
    genuine collection gap, not a new video -- never a fabricated 0
    baseline). A new-video-baseline gain (row.view_count itself, when
    exact_gains applied that rule) yields anchor_view_count == 0 here, which
    is a real, meaningful value (this video's own period truly started from
    nothing observable), distinct from None (unavailable, must be excluded
    at read time)."""
    result: dict[str, int | None] = {}
    for days, period in zip(EXACT_ANCHOR_DAYS, GROWTH_METRICS):
        gain = gains[row.video_id][days]
        result[period] = None if gain is None else row.view_count - gain
    return result


def _anchor_field_name(metric: str) -> str:
    return f"anchor{metric}ViewCount"


def rank_video_rows(rows: list[dict[str, Any]], *, metric: str, topic: str) -> list[dict[str, Any]]:
    """Derive one metric/topic's ranked view from the one persisted canonical
    row set at READ time (Phase D) -- operates directly on the serialized
    JSON row dicts (stores.video_ranking_store's own persisted shape), the
    same "read time, over raw persisted dicts" pattern api.read_api.
    _filter_and_rerank_subscriber_rows already uses for R5.

    metric="total": sorts by currentViewCount descending, videoId ascending
    tie-break -- every row participates (total never excludes for a missing
    anchor).

    A growth metric ("1d"/"7d"/"30d"): a row whose own anchor{metric}
    ViewCount is None (a genuine gap for that specific period -- never a
    fabricated 0) is excluded from that metric's ranking entirely, never
    given a fabricated baseline. Sorts by absoluteGrowth (current - anchor)
    descending, videoId ascending tie-break -- percentageGrowth is always
    display-only and never affects this order (an anchor of 0 -- the
    established new-video baseline, not a gap -- makes percentageGrowth
    None rather than dividing by zero).

    Topic filtering (topic != TOPIC_SCOPE_ALL) happens first, before any
    sort/rank -- mirrors analytics.subscriber_ranking.filter_by_organization/
    api.read_api._filter_and_rerank_subscriber_rows' own "filter first, then
    assign fresh ranks starting at 1" contract.
    """
    if topic != TOPIC_SCOPE_ALL:
        rows = [row for row in rows if row.get("topic") == topic]

    if metric == TOTAL_METRIC:
        ordered = sorted(rows, key=lambda row: (-row["currentViewCount"], row["videoId"]))
        return [_total_output_row(rank, row) for rank, row in enumerate(ordered, start=1)]

    anchor_field = _anchor_field_name(metric)
    candidates = [row for row in rows if row.get(anchor_field) is not None]
    ordered = sorted(
        candidates,
        key=lambda row: (-(row["currentViewCount"] - row[anchor_field]), row["videoId"]),
    )
    return [_growth_output_row(rank, row, anchor_field) for rank, row in enumerate(ordered, start=1)]


def _total_output_row(rank: int, row: dict[str, Any]) -> dict[str, Any]:
    return {
        "rank": rank,
        "videoId": row["videoId"],
        "creatorId": row["creatorId"],
        "topic": row["topic"],
        "currentViewCount": row["currentViewCount"],
        "title": row.get("title"),
        "thumbnailUrl": row.get("thumbnailUrl"),
    }


def _growth_output_row(rank: int, row: dict[str, Any], anchor_field: str) -> dict[str, Any]:
    anchor_view_count = row[anchor_field]
    absolute_growth = row["currentViewCount"] - anchor_view_count
    percentage_growth = (absolute_growth / anchor_view_count) if anchor_view_count > 0 else None
    return {
        "rank": rank,
        "videoId": row["videoId"],
        "creatorId": row["creatorId"],
        "topic": row["topic"],
        "currentViewCount": row["currentViewCount"],
        "anchorViewCount": anchor_view_count,
        "absoluteGrowth": absolute_growth,
        "percentageGrowth": percentage_growth,
        "title": row.get("title"),
        "thumbnailUrl": row.get("thumbnailUrl"),
    }
