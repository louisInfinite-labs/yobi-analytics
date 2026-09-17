"""One independently retryable daily collection-shard worker."""

from __future__ import annotations

from dataclasses import dataclass, replace
from datetime import date, datetime
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
from tracking_schedule import classify_after_observation
from video_master import Video, VideoMasterStore
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
    video_master_store: VideoMasterStore | None = None,
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

    `video_master_store` (Roadmap 1.5, currently bootstrap-only — see
    `_build_scheduler_updates`) is optional so every existing caller/test
    that doesn't care about scheduler-state write-back is unaffected; pass
    it (history_worker_handler.lambda_handler always does, via
    `dynamodb_store` directly) to also classify each successfully-observed
    video's fresh statistics and persist the result to Video Master.

    Applied from `rows` — not from the freshly-fetched `videos` — on
    *both* branches above, which is what makes this retry-safe across a
    Lambda interruption between `write_daily_shard` succeeding and the
    scheduler-state write completing: a shard_exists retry re-derives the
    exact same rows (read back from S3, never refetched from YouTube) and
    reconciles them the same way a fresh run would. `_build_scheduler_updates`
    itself is what keeps this idempotent per-video (never double-classifying
    a row whose observation was already applied) — see its own docstring.
    Each shard is still reconciled at most once per invocation (video Master
    is only ever read/written here, never inside a loop that could re-derive
    `rows` mid-way), so 70-of-100 videos already updated by a prior,
    interrupted invocation are left untouched and only the remaining 30 are
    completed — never a double application, and never a lost one.
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

    if video_master_store is not None:
        scheduler_updates = _build_scheduler_updates(rows, video_master_store=video_master_store)
        if scheduler_updates:
            video_master_store.upsert_videos(scheduler_updates)
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


def _build_scheduler_updates(rows: list[HistoryRow], *, video_master_store: VideoMasterStore) -> list[Video]:
    """Classify each successfully-observed row's statistics (Roadmap 1.5) and merge the
    result onto its authoritative existing Video Master row — idempotently, so calling
    this twice for the exact same persisted `rows` (a shard_exists retry recovering from
    an invocation that was interrupted between write_daily_shard and this write-back)
    never double-applies an observation.

    `rows` only ever contains videos that were actually, successfully observed:
    on a fresh run it's built from get_video_statistics's own successfully-
    collected results (never its skipped/failed entries); on a shard_exists
    retry it's read back from the exact same already-persisted S3 object.
    Either way, a video that failed statistics collection simply never
    appears here, so its activity_state/snapshot_count/quiet_streak/
    last_checked_at are left exactly as they were — matching the pre-reset
    collector's own rule that a missing or incomplete observation must never
    count as a quiet observation or demote a video.

    Idempotency/monotonicity rule, comparing `existing.last_checked_at` against
    `row.observed_at` (parsed via `_parse_observed_at`, this repository's existing
    `datetime.fromisoformat(value.replace("Z", "+00:00"))` convention already used for
    this exact pair of fields in tracking_schedule.py's `_growth_per_day`/`_age_in_days`
    — not a raw string/lexicographic comparison, since a "Z"-suffixed and an
    explicit-offset timestamp are not safely comparable as opaque strings):

    - `existing.last_checked_at is None` -> apply (first-ever observation).
    - parsed existing < parsed row.observed_at -> apply (a genuinely newer observation).
    - parsed existing == parsed row.observed_at -> no-op (this exact observation
      was already applied — reclassifying it would double-count it: incrementing
      snapshot_count twice, re-evaluating quiet_streak twice, for one real-world
      observation).
    - parsed existing > parsed row.observed_at -> no-op (the persisted row is
      OLDER than what Video Master already reflects — an out-of-order replay,
      e.g. an old shard reprocessed after a newer observation already landed —
      must never regress scheduler state backwards).

    Every update this function produces sets `last_checked_at` to that same
    row's own `observed_at` (never a fresh `datetime.now()`), which is what
    makes the comparison above meaningful across separate invocations. This
    reuses the two fields already recorded for every video for exactly this
    purpose — no second scheduler-state store, no new persisted field.

    Builds each update via dataclasses.replace(existing, ...), never a fresh
    Video(...), so every other Video Master field (title, published_at,
    creator_id, discovered_at, ...) is carried over unchanged — the
    pre-reset collector's equivalent block built a new Video() by hand and
    silently dropped discovered_at back to None on every single successful
    observation; reusing the authoritative row instead of reconstructing one
    is what avoids repeating that.

    A video_id with no existing Video Master row (the manifest listed it as
    active, but the store no longer has it) is skipped rather than
    fabricated: Video requires an authoritative title this function has no
    source for, and inventing one would risk overwriting a real future
    record with placeholder data.
    """
    updates = []
    for row in rows:
        existing = video_master_store.get_video(row.video_id)
        if existing is None:
            print(f"Warning: {row.video_id!r} has no existing Video Master row; skipping scheduler-state update")
            continue
        if existing.last_checked_at is not None and _parse_observed_at(
            existing.last_checked_at
        ) >= _parse_observed_at(row.observed_at):
            # Already applied (equal), or this row is an OLDER observation than
            # what Video Master already reflects (an out-of-order/old-shard
            # replay) -- either way, never overwrite newer scheduler state
            # with an older or identical one.
            continue
        result = classify_after_observation(
            current_state=existing.activity_state,
            snapshot_count=existing.snapshot_count,
            quiet_streak=existing.quiet_streak,
            previous_view_count=existing.last_view_count,
            previous_checked_at=existing.last_checked_at,
            new_view_count=row.view_count,
            observed_at=row.observed_at,
        )
        updates.append(
            replace(
                existing,
                activity_state=result.activity_state,
                last_checked_at=row.observed_at,
                last_view_count=row.view_count,
                snapshot_count=result.snapshot_count,
                quiet_streak=result.quiet_streak,
                last_classification_reason=result.reason,
                last_percent_growth_per_day=result.percent_per_day,
                last_avg_views_per_day=result.avg_views_per_day,
            )
        )
    return updates


def _parse_observed_at(value: str) -> datetime:
    """Parse an observed_at/last_checked_at timestamp for monotonic comparison, using this
    repository's existing convention for this exact pair of fields (tracking_schedule.py's
    `_growth_per_day`): `.replace("Z", "+00:00")` before `datetime.fromisoformat`, so a
    "Z"-suffixed UTC timestamp and an explicit-offset timestamp compare correctly as
    timezone-aware datetimes instead of as opaque, not-safely-orderable strings.
    """
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


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
