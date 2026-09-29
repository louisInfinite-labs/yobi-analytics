"""One independently retryable daily collection-shard worker."""

from __future__ import annotations

from dataclasses import dataclass, replace
from datetime import date, datetime, timedelta
from typing import Mapping

from analytics.history_ranking import (
    CreatorDimensions,
    RankedGrowth,
    ScopeKey,
    load_exact_anchor_rows,
    top_n_by_scope,
)
from stores.history_store import HISTORY_SHARD_COUNT, HistoryRow, HistoryStore, daily_history_key, shard_for_video
from tracking.tracking_manifest import ManifestEntry, TrackingManifestStore, discovered_dates_by_video, patch_shard
from tracking.tracking_schedule import classify_after_observation, select_due_video_ids
from tracking.video_master import Video, VideoMasterStore
from tracking.video_topics import OTHER_TOPIC, TOPIC_IDS
from collection.youtube_client import get_video_statistics


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
    topic_by_video: dict[str, str]


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

    AWS Cost Recovery: only videos `tracking_schedule.select_due_video_ids`
    considers due today ever reach YouTube or `_build_scheduler_updates`. A
    non-due active video is still carried into today's row set (so ranking,
    daily S3 history, and the D-1/D-7/D-30 anchors it feeds never gap) via
    `_carry_forward_non_due_rows` -- reusing yesterday's own already-persisted
    shard (one extra S3 GetObject for the whole shard, not one DynamoDB read
    per non-due video) and falling back to Video Master's own last observation
    only for the rare video missing from yesterday's shard. A carried-forward
    row keeps its real prior `observed_at` (never stamped as observed today)
    and is never passed to `_build_scheduler_updates` -- see that function's
    own docstring for why a row must have been a genuine observation this run
    to update scheduler state at all.

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
    video's fresh statistics and persist the result to Video Master. AWS
    Cost Recovery (third pass): whenever this produces at least one real
    scheduler update, this shard's own manifest entries are also patched
    in-place (`_patch_manifest_activity_states`) so discovery no longer needs
    a full-catalog daily Scan to learn about it -- see that function's own
    docstring.

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
        # HistoryRow.carried_forward (not this call's own `observed_at`,
        # which is freshly computed from wall-clock time on every single
        # invocation, including a retry -- never a value that can be
        # expected to match what an earlier, already-succeeded invocation
        # itself persisted) is what recovers "the rows this shard's own day
        # actually observed" out of the read-back combined set on a
        # shard_exists retry.
        fresh_rows = [row for row in rows if not row.carried_forward]
        requested_count = len(fresh_rows)
    else:
        due_ids = set(
            select_due_video_ids(
                ((entry.video_id, entry.published_at, entry.activity_state) for entry in active_entries),
                as_of=collection_date,
            )
        )
        non_due_ids = [video_id for video_id in video_ids if video_id not in due_ids]
        carried_rows, forced_due_ids = _carry_forward_non_due_rows(
            non_due_ids,
            creator_by_video=creator_by_video,
            collection_date=collection_date,
            shard=shard,
            history_store=history_store,
            video_master_store=video_master_store,
        )
        ids_to_fetch = sorted(due_ids | forced_due_ids)
        videos, skipped = get_video_statistics(youtube, ids_to_fetch)
        fresh_rows = [
            HistoryRow(
                video_id=video["videoId"],
                creator_id=creator_by_video[video["videoId"]],
                view_count=video["viewCount"],
                observed_at=observed_at,
                availability_status="available",
            )
            for video in videos
        ]
        rows = sorted(fresh_rows + carried_rows, key=lambda row: row.video_id)
        history_key = history_store.write_daily_shard(collection_date, shard, rows)
        requested_count = len(ids_to_fetch)

    if video_master_store is not None:
        scheduler_updates = _build_scheduler_updates(fresh_rows, video_master_store=video_master_store)
        if scheduler_updates:
            video_master_store.upsert_videos(scheduler_updates)
            _patch_manifest_activity_states(manifest_store, shard=shard, updates=scheduler_updates)
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
    return ShardCollectionResult(
        collection_date=collection_date,
        shard=shard,
        requested_count=requested_count,
        collected_count=len(rows),
        skipped=skipped,
        history_key=history_key,
        rows=rows,
        rankings=rankings,
        topic_by_video=_resolve_manifest_topics(active_entries),
    )


def _resolve_manifest_topics(entries) -> dict[str, str]:
    """videoId -> topic straight from the manifest's own persisted topic (AWS
    Cost Recovery second pass) -- no DynamoDB read, replacing the daily
    full-catalog dynamodb_store.get_video_topics BatchGetItem this once ran
    from history_worker_handler.lambda_handler.

    A manifest entry with no topic, or an unrecognized one (a manifest
    object predating this field, or a video whose discovery-time
    classification/one-time backfill hasn't landed yet), falls back to
    OTHER_TOPIC -- the same "nothing matched" bucket classify_video_topic
    itself returns for a genuinely unclassifiable title, never a fabricated
    guess. Unlike video_topics.resolve_video_topics (still used elsewhere,
    e.g. an ops/audit script with a title available to reclassify from),
    this never re-derives a topic from a title: the manifest doesn't carry
    one, and every video's real primary topic is classified exactly once,
    either at discovery time (collection.main._discover_creator) or by the
    one-time topic backfill (scripts/backfill/backfill_video_topics.py) --
    both write straight to Video Master, which publish_tracking_manifest
    then carries onto every subsequent manifest object unchanged.
    """
    return {entry.video_id: entry.topic if entry.topic in TOPIC_IDS else OTHER_TOPIC for entry in entries}


def _carry_forward_non_due_rows(
    non_due_ids: list[str],
    *,
    creator_by_video: dict[str, str],
    collection_date: date,
    shard: int,
    history_store: HistoryStore,
    video_master_store: VideoMasterStore | None,
) -> tuple[list[HistoryRow], set[str]]:
    """Reuse each non-due video's last known view straight from yesterday's
    already-persisted daily shard, so it stays represented in today's ranking/
    history without YouTube ever being asked about it (AWS Cost Recovery).

    The low-cost source is yesterday's own shard object -- one extra S3
    GetObject for this whole shard, never one DynamoDB read per non-due
    video (`YobiVideoMaster` GetItem is a per-video fallback below, not the
    bulk path: with most of a shard's videos non-due on any given day, a
    mandatory GetItem per non-due video would trade one cheap daily S3 read
    for thousands of DynamoDB reads for the exact same information most days
    already have sitting in S3).

    `video_master_store` is consulted only for videos absent from yesterday's
    shard (a genuine gap day, or a video that only just became non-due and
    was collected too recently for "yesterday" to have it under the old
    whole-catalog regime already writing every video every day -- lookback:
    -1). A video with no usable prior state anywhere (missing from
    yesterday's shard, and no last_view_count/last_checked_at on Video
    Master either) is returned in the second element instead of silently
    dropped -- the caller must still collect it from YouTube this run, since
    there is nothing real to carry forward.

    AWS Cost Recovery (third pass, Scope H): every missing-from-yesterday's-
    shard video is looked up in exactly *one* batched call
    (video_master_store.get_videos, when the store provides it -- see
    VideoMasterStore's own docstring) rather than one GetItem per video. An
    ordinary day has only a handful of such gaps, so this barely matters --
    but a day where an *entire* previous shard is missing (a real S3 outage,
    quantified in the third-pass report's own worst-case analysis) would
    otherwise mean hundreds of sequential GetItem calls per shard instead of
    a couple of chunked BatchGetItem calls. Falls back to the original
    per-video get_video loop for any store that doesn't provide get_videos
    (e.g. a test double implementing only the original two-method Protocol),
    so this is a pure optimization, never a behavior change, for such a
    caller.
    """
    if not non_due_ids:
        return [], set()

    previous_rows = history_store.read_daily_shard(collection_date - timedelta(days=1), shard)
    previous_by_id = {row.video_id: row for row in previous_rows}
    missing_ids = [video_id for video_id in non_due_ids if video_id not in previous_by_id]

    fallback_videos: dict[str, Video] = {}
    if missing_ids and video_master_store is not None:
        get_videos = getattr(video_master_store, "get_videos", None)
        if get_videos is not None:
            fallback_videos = get_videos(missing_ids)
        else:
            for video_id in missing_ids:
                video = video_master_store.get_video(video_id)
                if video is not None:
                    fallback_videos[video_id] = video

    carried_rows: list[HistoryRow] = []
    forced_due_ids: set[str] = set()
    for video_id in non_due_ids:
        previous_row = previous_by_id.get(video_id)
        if previous_row is not None:
            # replace(..., carried_forward=True), not the row object as-is:
            # yesterday's own row may itself already have been a carried-
            # forward row (a Cold video can go many days between genuine
            # observations) -- today's own copy must say so regardless of
            # what it was carried in as, since from today's perspective it
            # was not observed today either way.
            carried_rows.append(replace(previous_row, carried_forward=True))
            continue

        existing = fallback_videos.get(video_id)
        if existing is not None and existing.last_view_count is not None and existing.last_checked_at is not None:
            carried_rows.append(
                HistoryRow(
                    video_id=video_id,
                    creator_id=creator_by_video[video_id],
                    view_count=existing.last_view_count,
                    observed_at=existing.last_checked_at,
                    availability_status="available",
                    carried_forward=True,
                )
            )
            continue

        forced_due_ids.add(video_id)

    return carried_rows, forced_due_ids


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
        existing_checked_at = (
            _parse_observed_at(existing.last_checked_at)
            if existing.last_checked_at is not None
            else None
        )
        if (
            existing_checked_at is not None
            and existing_checked_at.tzinfo is not None
            and existing_checked_at >= _parse_observed_at(row.observed_at)
        ):
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


def _patch_manifest_activity_states(
    manifest_store: TrackingManifestStore, *, shard: int, updates: list[Video]
) -> None:
    """Patch this shard's own manifest entries' activity_state to match today's
    scheduler-state updates, replacing discovery's old full-catalog daily
    Scan+republish as the way the manifest ever learns about an
    activity_state change (AWS Cost Recovery, third pass).

    Every video in `updates` was read from -- and therefore belongs to --
    this exact shard's own manifest entries (`updates` is built from
    `fresh_rows`, itself built only from `active_entries`, which
    collect_history_shard read from `manifest_store.read_shard(shard)`
    earlier in this same call) -- so no shard-membership lookup is needed
    here, unlike _patch_manifest_with_new_videos_if_configured's own
    per-video shard_for_video grouping in collection.main.

    Uses patch_shard's bounded-retry read-modify-write (S3 If-Match/
    If-None-Match), not an unconditional overwrite of the whole shard: the
    only other writer that can ever touch this same shard is discovery,
    adding brand-new videos this shard has never seen before -- a disjoint
    set of video_ids from the ones being patched here, but still a
    concurrent writer to the same S3 object under the rare EventBridge
    retry-collision scenario (see the third-pass report's own race
    analysis), so a plain read-modify-write without this protection could
    silently lose one side's update.

    A video_id in `updates` that (impossibly, absent a bug elsewhere) isn't
    present in the shard being patched is simply left unmatched -- never
    inserted as a new entry here; only
    _patch_manifest_with_new_videos_if_configured ever adds a brand-new
    manifest entry.
    """
    activity_state_by_video = {video.video_id: video.activity_state for video in updates}

    def _apply(entries: list[ManifestEntry]) -> list[ManifestEntry]:
        return [
            replace(entry, activity_state=activity_state_by_video[entry.video_id])
            if entry.video_id in activity_state_by_video
            else entry
            for entry in entries
        ]

    patch_shard(manifest_store, shard, _apply)


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
