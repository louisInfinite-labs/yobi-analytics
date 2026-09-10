"""One independently retryable daily collection-shard worker."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date
from typing import Mapping

from history_ranking import (
    CreatorDimensions,
    CreatorPeriodPartial,
    RankedGrowth,
    ScopeKey,
    creator_period_partials,
    load_exact_anchor_rows,
    top_n_by_scope,
)
from history_store import HISTORY_SHARD_COUNT, HistoryRow, HistoryStore, daily_history_key, shard_for_video
from tracking_manifest import TrackingManifestStore, discovered_dates_by_video
from youtube_client import get_video_statistics


@dataclass(frozen=True)
class ShardCollectionResult:
    """In-memory outcome for one shard; no other shard is rolled back."""

    collection_date: date
    shard: int
    requested_count: int
    collected_count: int
    skipped: dict[str, str]
    history_key: str
    rows: list[HistoryRow]
    rankings: dict[ScopeKey, dict[str, list[RankedGrowth]]]
    creator_partials: dict[str, dict[str, CreatorPeriodPartial]]


def collect_history_shard(
    *,
    youtube,
    collection_date: date,
    observed_at: str,
    shard: int,
    manifest_store: TrackingManifestStore,
    history_store: HistoryStore,
    dimensions_by_creator: Mapping[str, CreatorDimensions] | None = None,
    top_n: int = 100,
) -> ShardCollectionResult:
    """Collect and persist exactly one manifest shard.

    Retrying calls this function with the failed shard only. Its deterministic
    PutObject key is replaced idempotently; no scan/delete rollback exists.
    Today's rows remain in memory for ranking and are never read back from S3.

    Cost/abuse containment (Roadmap 5.3): `shard` is validated up front — the
    Step Functions Map's shard list is supplied as execution input
    (terraform/eventbridge.tf's `range(16)`), not baked into the state
    machine definition, so a malformed or adversarial StartExecution input
    could otherwise dispatch a shard number this pipeline never assigns to
    any video. And if `collection_date`'s shard was already written (a
    genuine retry, or the same shard number appearing twice in one Map's
    input), this never calls YouTube a second time for the same day — it
    reads the already-persisted rows back and only recomputes the (free,
    local) ranking from them.

    Known limitation (not addressed here): this idempotency check is a
    plain read-then-act, not a claim/lock — two Step Functions executions
    running concurrently for the same (collection_date, shard) can both
    observe "not collected yet" and both call YouTube. See
    HistoryStore.shard_exists's own docstring for why closing that race is
    deliberately out of scope for this change.

    Each shard's own manifest entries carry discovered_at (published by
    tracking_manifest.publish_tracking_manifest from Video Master), threaded
    into top_n_by_scope as discovered_date_by_video — a video collected for
    only a day or two still enters the 7d/30d ranking with its full latest
    view count counted, instead of being silently excluded for lacking a
    D-7/D-30 anchor it could never have. See history_ranking._period_value.
    """
    _validate_shard(shard)
    entries = manifest_store.read_shard(shard)
    _reject_wrong_shard_entries(entries, shard=shard)
    active_entries = [entry for entry in entries if entry.active]

    creator_by_video = {entry.video_id: entry.creator_id for entry in active_entries}
    video_ids = sorted(creator_by_video)

    if history_store.shard_exists(collection_date, shard):
        # Already written today — including the legitimate case of a shard
        # that collected zero rows (every video in it was unavailable).
        # shard_exists (existence), not "are there any rows", is what tells
        # a genuine retry/duplicate-input invocation apart from one that
        # still needs to call YouTube — read_daily_shard's own empty list
        # means the same thing for both cases and can't distinguish them.
        rows = history_store.read_daily_shard(collection_date, shard)
        skipped: dict[str, str] = {}
        history_key = daily_history_key(collection_date, shard)
    else:
        videos, skipped = get_video_statistics(youtube, video_ids)
        rows = [
            HistoryRow(
                video_id=video["videoId"],
                creator_id=creator_by_video[video["videoId"]],
                view_count=video["viewCount"],
                observed_at=observed_at,
                availability_status="available",
            )
            for video in videos
        ]
        history_key = history_store.write_daily_shard(collection_date, shard, rows)
    anchors = load_exact_anchor_rows(history_store, report_date=collection_date, shard=shard)
    discovered_date_by_video = discovered_dates_by_video(active_entries)
    rankings = top_n_by_scope(
        rows,
        anchors,
        report_date=collection_date,
        discovered_date_by_video=discovered_date_by_video,
        dimensions_by_creator=dimensions_by_creator,
        limit=top_n,
    )
    # Same rows/anchors/report_date/discovered_date_by_video already built
    # above for the video-ranking scopes — no extra Video Master or history
    # read for this. Computed unconditionally, including the shard_exists
    # (idempotent-skip) branch above: a retry that skips YouTube must still
    # produce the same creator-period partials, not omit them, since this
    # is the only place that writes them for the day.
    partials = creator_period_partials(
        rows,
        anchors,
        report_date=collection_date,
        discovered_date_by_video=discovered_date_by_video,
    )
    return ShardCollectionResult(
        collection_date=collection_date,
        shard=shard,
        requested_count=len(video_ids),
        collected_count=len(rows),
        skipped=skipped,
        history_key=history_key,
        rows=rows,
        rankings=rankings,
        creator_partials=partials,
    )


def _validate_shard(shard: int) -> None:
    """Reject anything outside the fixed [0, HISTORY_SHARD_COUNT) shard space up front.

    `daily_history_key`/`manifest_key` already reject an out-of-range shard
    deep inside their own S3 key construction, but only after a caller has
    already done other setup work (building a YouTube client, loading
    Creator Master) — checking here (and in
    history_worker_handler.lambda_handler, before any of that) fails before
    any of it happens.
    """
    if isinstance(shard, bool) or not isinstance(shard, int) or not 0 <= shard < HISTORY_SHARD_COUNT:
        raise ValueError(f"shard must be an integer within [0, {HISTORY_SHARD_COUNT}), got {shard!r}")


def _reject_wrong_shard_entries(entries, *, shard: int) -> None:
    """Fail fast on a manifest shard that's obviously corrupt: any entry whose own
    deterministic shard doesn't match the shard object it was read from. Checked
    against every entry (not just active ones) — a misplaced inactive entry is
    still evidence the manifest itself is wrong, not just stale."""
    wrong_shard = [entry.video_id for entry in entries if shard_for_video(entry.video_id) != shard]
    if wrong_shard:
        raise ValueError(f"Manifest shard {shard:02d} contains misplaced videos: {sorted(wrong_shard)}")
