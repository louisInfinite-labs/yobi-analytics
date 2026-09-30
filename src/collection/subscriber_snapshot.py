"""One independently callable daily creator subscriber-count snapshot
(ranking-simplification, subscriber-history foundation, R1; wired into the
existing daily production execution in R3 -- see
api.history_worker_handler._collect_subscriber_snapshot_if_configured, the
AcquireExecutionLock branch, which calls collect_subscriber_snapshot_if_missing
below exactly once per report date).
"""

from __future__ import annotations

from datetime import date

from collection.youtube_client import QuotaExhaustedError, get_channel_statistics
from stores.subscriber_history_store import SubscriberHistoryStore, SubscriberRow, subscriber_history_key
from tracking.creator_master import Creator


def collect_subscriber_snapshot(
    youtube, creators: list[Creator], *, collection_date: date, observed_at: str, store: SubscriberHistoryStore
) -> tuple[str, dict[str, str]]:
    """Fetch today's subscriberCount for every given creator and persist one
    whole-roster daily snapshot.

    Idempotent per collection_date the same way collect_history_shard's own
    S3-key replacement is: a retry simply overwrites the same day's object
    with a freshly recomputed one, never appending or deleting.

    A creator whose channel statistics could not be fetched at all (a
    YouTube API/network failure, or the channel returning no usable data) is
    simply absent from the written snapshot -- never a fabricated row -- and
    is reported in the returned skip_reasons instead, mirroring
    collect_history_shard's own skipped-video reporting.

    Two creators sharing the same youtube_channel_id would otherwise collide
    in the returned per-channel result keyed by channel id; Creator Master's
    own uniqueness invariant (find_creator_by_youtube_channel_id) already
    guarantees this never happens in real data, so it is not re-validated
    here.
    """
    channel_id_by_creator = {creator.youtube_channel_id: creator.creator_id for creator in creators}
    results, skip_reasons = get_channel_statistics(youtube, list(channel_id_by_creator))

    rows = [
        SubscriberRow(
            creator_id=channel_id_by_creator[channel_id],
            subscriber_count=result["subscriberCount"],
            hidden_subscriber_count=result["hiddenSubscriberCount"],
            observed_at=observed_at,
        )
        for channel_id, result in results.items()
    ]
    key = store.write_daily_snapshot(collection_date, rows)
    return key, skip_reasons


def collect_subscriber_snapshot_if_missing(
    youtube, creators: list[Creator], *, collection_date: date, observed_at: str, store: SubscriberHistoryStore
) -> tuple[str, dict[str, str], bool]:
    """Idempotent, retry-safe, and REPAIRING production entry point (R3
    correction 2026-09-29, then bounded same-invocation retry added
    2026-09-29): unlike a video-history shard, a subscriber snapshot has no
    carry-forward mechanism, so "the object exists" alone is NOT treated as
    "complete" -- completeness is judged against the authoritative
    `creators` roster instead. A prior attempt that only observed some of
    today's roster (a transient per-batch failure, or an empty snapshot from
    a total outage) is repaired here by fetching ONLY the still-missing
    creators' channels and merging their results onto the existing good rows
    -- an already-observed creator is never re-fetched, so a repair attempt
    can never downgrade or lose a row that already succeeded earlier the
    same collection_date.

    Same-invocation bounded retry: in production, a subscriber failure is
    isolated so the video-history workflow still completes successfully
    (api.history_worker_handler._collect_subscriber_snapshot_if_configured's
    own broad except) -- meaning there is no guarantee a second Lambda
    invocation for this same report_date will ever happen. Relying solely on
    "the next invocation repairs it" would leave a transient partial failure
    partial for the whole day. So after the first collection pass, if any
    requested channel is still missing for a non-quota reason, this makes
    exactly ONE additional bounded pass for only those still-missing
    channels, then stops -- never a third pass, never an unbounded loop.

    QuotaExhaustedError from EITHER pass is caught here, never re-raised:
    get_channel_statistics itself batches internally (MAX_IDS_PER_REQUEST),
    so a single pass covering e.g. 118 channels already issues several
    batches, and a LATER batch hitting quota after EARLIER ones already
    succeeded still returns that earlier progress via the exception's own
    partial_results/partial_skip_reasons/remaining_video_ids enrichment
    (2026-09-29 fix -- see get_channel_statistics's own docstring). That
    partial progress is merged exactly as if the interrupted call had
    returned normally, and no further YouTube request is made this
    invocation once ANY pass hits quota -- pass 1 hitting quota skips the
    bounded second pass entirely (every remaining request today would fail
    the same way); pass 2 hitting quota simply stops after merging whatever
    it recovered before its own wall. Either way, whatever was genuinely
    collected before the exhaustion is preserved and eligible to be written.

    A roster creator counts as "successfully observed" the moment ANY row
    for their creator_id exists in the snapshot -- a hidden observation
    (subscriber_count=None, hidden_subscriber_count=True) is exactly as
    complete/final as a visible one; only a creator with NO row at all (this
    creator's own collection attempt failed, every time so far) counts as
    missing and eligible for this call's own fetch.

    A creator present in the existing snapshot but no longer in the current
    `creators` roster (a roster change mid-report-date -- e.g. deactivated
    between two retries of the same day) is left in place, never pruned:
    this function only ever ADDS rows for currently-missing roster
    creators. A creator newly ADDED to the roster mid-day is simply treated
    as missing (no existing row can reference a creator_id that didn't
    exist in any earlier attempt) and is fetched normally. Downstream
    roster/organization eligibility (analytics.subscriber_ranking's own
    roster check) is re-validated independently at calculation time, so a
    stale or extra raw row here causes no incorrect leaderboard result.

    S3 write optimization: `store.write_daily_snapshot` is only ever called
    when at least one NEW row was actually recovered this call (across
    either pass) -- an invocation that attempts collection but recovers
    nothing new never rewrites the object (there is nothing to change), and
    an invocation against a wholly absent/empty snapshot that recovers
    nothing at all never creates one either. This is deliberate: a written
    (even empty) object would make this same function treat that date as
    having "no missing creators to check against an existing empty row set"
    incorrectly -- in fact an EMPTY existing snapshot already correctly
    re-derives every roster creator as missing on the next call (see
    `observed_creator_ids` below, built from whatever rows genuinely exist),
    so never writing here simply means the next call sees no object at all
    and still retries the full roster, exactly as it should.

    Returns (key, skip_reasons, collected) where collected=True iff a new S3
    write happened this call. collected=False covers two different cases,
    both distinguishable via skip_reasons: an empty skip_reasons means every
    roster creator already had a row (nothing was attempted, YouTube was
    never called); a non-empty skip_reasons means collection was attempted
    (one or two passes) but recovered nothing new, so nothing was written --
    skip_reasons then names every creator still missing after both passes.
    """
    channel_id_by_creator = {creator.youtube_channel_id: creator.creator_id for creator in creators}
    existing_rows = store.read_daily_snapshot(collection_date)
    observed_creator_ids = {row.creator_id for row in existing_rows}
    missing_channel_ids = [
        channel_id
        for channel_id, creator_id in channel_id_by_creator.items()
        if creator_id not in observed_creator_ids
    ]

    if not missing_channel_ids:
        return subscriber_history_key(collection_date), {}, False

    # Pass 1. get_channel_statistics itself may issue several internal
    # batches (MAX_IDS_PER_REQUEST=50) for one call -- e.g. 118 missing
    # channels is 3 batches. If a LATER batch hits quota after EARLIER ones
    # already succeeded, get_channel_statistics's own QuotaExhaustedError
    # carries that already-paid-for partial progress (2026-09-29 fix, same
    # convention collection.main.py already relies on for
    # get_video_statistics) -- caught and merged here exactly as if this
    # call had returned normally, never discarded. No bounded second pass is
    # attempted when pass 1 itself hit quota: every remaining request today
    # would fail the same way.
    quota_exhausted = False
    try:
        results, skip_reasons = get_channel_statistics(youtube, missing_channel_ids)
    except QuotaExhaustedError as exc:
        print(f"Warning: YouTube quota exhausted mid-pass, keeping partial results: {exc}")
        results = dict(exc.partial_results)
        skip_reasons = {
            **exc.partial_skip_reasons,
            **{channel_id: f"YouTube quota exhausted: {exc}" for channel_id in exc.remaining_video_ids},
        }
        quota_exhausted = True

    still_missing_channel_ids = list(skip_reasons)
    if still_missing_channel_ids and not quota_exhausted:
        try:
            retry_results, retry_skip_reasons = get_channel_statistics(youtube, still_missing_channel_ids)
        except QuotaExhaustedError as exc:
            print(
                f"Warning: bounded subscriber-snapshot retry pass stopped early, YouTube quota "
                f"exhausted; keeping whatever was recovered so far: {exc}"
            )
            results.update(exc.partial_results)
            skip_reasons = {
                **exc.partial_skip_reasons,
                **{channel_id: f"YouTube quota exhausted: {exc}" for channel_id in exc.remaining_video_ids},
            }
        else:
            results.update(retry_results)
            skip_reasons = retry_skip_reasons
        # Exactly one bounded retry pass, win or lose -- never a third attempt.

    if not results:
        return subscriber_history_key(collection_date), skip_reasons, False

    new_rows = [
        SubscriberRow(
            creator_id=channel_id_by_creator[channel_id],
            subscriber_count=result["subscriberCount"],
            hidden_subscriber_count=result["hiddenSubscriberCount"],
            observed_at=observed_at,
        )
        for channel_id, result in results.items()
    ]
    key = store.write_daily_snapshot(collection_date, existing_rows + new_rows)
    return key, skip_reasons, True
