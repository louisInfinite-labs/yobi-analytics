"""Subscriber Leaderboard calculation (ranking-simplification, R2).

Pure reducer over stores.subscriber_history_store.SubscriberRow snapshots --
no persistence, no DynamoDB, no cache, no API wiring. R1's daily collection
is not yet scheduled in production, and no read path exists yet either, so
there is nothing for a persisted result to serve: the smallest correct R2 is
a pure calculation module a later pass can call (from a Lambda, from an S3
writer, from tests) once those pieces exist. See this repository's own R2
report for the full "why defer persistence" reasoning.

Builds exactly four canonical, unfiltered results: Total Subscribers, 1d
growth, 7d growth, 30d growth. ALL/VSPO/Hololive are never persisted or
computed here -- filter_by_organization derives them at read time from one
of these four canonical lists, per the product scope's own explicit
"read-time filter+re-rank, not 12 persisted copies" decision.

Missing/hidden semantics are intentionally stricter than
analytics.history_ranking's own video-growth rule: a video's "not yet
discovered => 0 baseline" fact has no subscriber analog. A creator's
subscriber count before this project started tracking them is UNKNOWN, not
zero -- so a missing or hidden observation (current OR anchor) always makes
that creator ineligible for the affected metric, never a fabricated 0. See
stores.subscriber_history_store's own module docstring for the same rule
stated from the storage side.

`dimensions_by_creator` is the authoritative supported-creator roster, not a
convenience lookup: a current observation whose creatorId isn't in that
roster, or whose organization is missing/not one of VALID_SUBSCRIBER_
ORGANIZATIONS, is excluded from every ranked result entirely (never admitted
with organization=None) -- otherwise it would appear in the unfiltered
canonical list while disappearing from both the VSPO and Hololive filtered
views, silently breaking "ALL = union of VSPO + Hololive". The production
entry point, build_subscriber_leaderboards, makes dimensions_by_creator a
required argument for exactly this reason: there is no default that could
let a caller accidentally skip roster validation by simply omitting it. The
lower-level per-metric builders keep it optional so they stay reusable in
isolation (e.g. a unit test exercising pure sort/eligibility behavior with
no roster concept at all); passing None there deliberately skips roster/
organization validation rather than treating an absent roster as "empty",
which would make every creator "not in roster".
"""

from __future__ import annotations

from dataclasses import dataclass, replace
from datetime import date, timedelta
from typing import Mapping, TypeVar

from stores.subscriber_history_store import SubscriberRow

SUBSCRIBER_EXACT_ANCHOR_DAYS = (1, 7, 30)
GROWTH_PERIODS = tuple(f"{days}d" for days in SUBSCRIBER_EXACT_ANCHOR_DAYS)

VALID_SUBSCRIBER_ORGANIZATIONS = frozenset({"vspo", "hololive"})


@dataclass(frozen=True)
class CreatorSubscriberDimensions:
    """Small master-data projection needed to attach organization to a row."""

    organization: str | None = None


@dataclass(frozen=True)
class TotalSubscribersRow:
    rank: int
    creator_id: str
    organization: str | None
    subscriber_count: int


@dataclass(frozen=True)
class SubscriberGrowthRow:
    rank: int
    creator_id: str
    organization: str | None
    current_subscriber_count: int
    anchor_subscriber_count: int
    absolute_growth: int
    percentage_growth: float | None


@dataclass(frozen=True)
class SubscriberLeaderboards:
    """The four canonical results, plus per-metric ineligibility diagnostics.

    `total_ineligible`/`growth_ineligible` map creator_id -> a short machine
    reason string (never a fabricated ranked position) for every creator
    considered but excluded from that metric's ranked list -- see this
    module's own eligibility rules below for the exact reason strings.
    """

    total: list[TotalSubscribersRow]
    total_ineligible: dict[str, str]
    growth: dict[str, list[SubscriberGrowthRow]]
    growth_ineligible: dict[str, dict[str, str]]


def load_exact_anchor_subscriber_rows(store, *, report_date: date) -> dict[int, list[SubscriberRow]]:
    """Read exactly D-1, D-7 and D-30's snapshots, never nearby dates."""
    return {
        days: store.read_daily_snapshot(report_date - timedelta(days=days))
        for days in SUBSCRIBER_EXACT_ANCHOR_DAYS
    }


def dimensions_from_creators(creators) -> dict[str, CreatorSubscriberDimensions]:
    """creator_id -> CreatorSubscriberDimensions, from Creator Master records."""
    return {
        creator.creator_id: CreatorSubscriberDimensions(organization=creator.organization)
        for creator in creators
    }


def _roster_missing_ineligible(
    current_rows: list[SubscriberRow], dimensions_by_creator: Mapping[str, CreatorSubscriberDimensions]
) -> dict[str, str]:
    """A creator known to the authoritative roster (dimensions_by_creator)
    but with no row at all in today's collection must still be
    distinguishable as unavailable, never silently absent -- unlike a
    creator_id that appears in neither the roster nor current_rows, which
    is not invented into diagnostics at all (there is no authoritative
    record that it should exist)."""
    seen = {row.creator_id for row in current_rows}
    return {creator_id: "current_missing" for creator_id in dimensions_by_creator if creator_id not in seen}


def _validate_roster_membership(
    creator_id: str, dimensions_by_creator: Mapping[str, CreatorSubscriberDimensions] | None
) -> tuple[str | None, str | None]:
    """Return (organization, ineligible_reason) -- organization is only ever
    non-None when ineligible_reason is None.

    dimensions_by_creator is None means "no roster was given at all" (a
    lower-level helper called directly, without production's own mandatory
    roster) -- roster/organization validation is skipped entirely, and this
    returns (None, None) unconditionally, exactly this function's own
    pre-correction behavior. build_subscriber_leaderboards never calls this
    with None, since dimensions_by_creator is a required argument there.

    dimensions_by_creator being an empty (but not None) mapping means an
    authoritative roster that happens to list no one -- every creator_id is
    then "creator_not_in_roster", not silently permitted through.
    """
    if dimensions_by_creator is None:
        return None, None
    dimensions = dimensions_by_creator.get(creator_id)
    if dimensions is None:
        return None, "creator_not_in_roster"
    organization = dimensions.organization
    if not organization:
        return None, "organization_missing"
    if organization not in VALID_SUBSCRIBER_ORGANIZATIONS:
        return None, "organization_invalid"
    return organization, None


def build_total_subscribers_leaderboard(
    current_rows: list[SubscriberRow],
    *,
    dimensions_by_creator: Mapping[str, CreatorSubscriberDimensions] | None = None,
) -> tuple[list[TotalSubscribersRow], dict[str, str]]:
    """Total Subscribers: eligible creators sorted by subscriberCount
    descending, creatorId ascending tie-break. A hidden or missing current
    observation is never coerced to 0 -- it is excluded and reported as
    ineligible instead. A roster creator (per dimensions_by_creator) with no
    row at all is reported as "current_missing", never silently dropped. A
    current row whose creator isn't in the roster, or whose organization is
    missing/invalid, is likewise excluded -- see _validate_roster_membership."""
    eligible: list[tuple[str, int, str]] = []
    ineligible: dict[str, str] = _roster_missing_ineligible(current_rows, dimensions_by_creator or {})
    for row in current_rows:
        organization, roster_reason = _validate_roster_membership(row.creator_id, dimensions_by_creator)
        if roster_reason is not None:
            ineligible[row.creator_id] = roster_reason
            continue
        if row.hidden_subscriber_count:
            ineligible[row.creator_id] = "current_hidden"
            continue
        if row.subscriber_count is None:
            ineligible[row.creator_id] = "current_missing"
            continue
        eligible.append((row.creator_id, row.subscriber_count, organization))

    ordered = sorted(eligible, key=lambda item: (-item[1], item[0]))
    rows = [
        TotalSubscribersRow(
            rank=rank,
            creator_id=creator_id,
            organization=organization,
            subscriber_count=subscriber_count,
        )
        for rank, (creator_id, subscriber_count, organization) in enumerate(ordered, start=1)
    ]
    return rows, ineligible


def build_growth_leaderboard(
    current_rows: list[SubscriberRow],
    anchor_rows: list[SubscriberRow],
    *,
    dimensions_by_creator: Mapping[str, CreatorSubscriberDimensions] | None = None,
) -> tuple[list[SubscriberGrowthRow], dict[str, str]]:
    """One growth period's leaderboard: eligible creators sorted by
    absoluteGrowth descending, creatorId ascending tie-break.
    percentageGrowth is display-only and never affects order.

    Eligibility requires BOTH a usable current observation and a usable
    *exact* anchor observation (whatever `anchor_rows` was given -- this
    function performs no date lookup of its own, so the exact-anchor
    requirement is enforced entirely by what its caller reads and passes
    in). Missing/hidden anchor is never a 0 baseline -- see this module's
    own docstring for why this is stricter than the video-history rule. A
    roster creator (per dimensions_by_creator) with no current row at all is
    reported as "current_missing", never silently dropped. A current row
    whose creator isn't in the roster, or whose organization is missing/
    invalid, is likewise excluded -- see _validate_roster_membership.
    """
    anchor_by_creator = {row.creator_id: row for row in anchor_rows}

    candidates: list[tuple[str, int, int, int, float | None, str]] = []
    ineligible: dict[str, str] = _roster_missing_ineligible(current_rows, dimensions_by_creator or {})
    for row in current_rows:
        organization, roster_reason = _validate_roster_membership(row.creator_id, dimensions_by_creator)
        if roster_reason is not None:
            ineligible[row.creator_id] = roster_reason
            continue
        if row.hidden_subscriber_count:
            ineligible[row.creator_id] = "current_hidden"
            continue
        if row.subscriber_count is None:
            ineligible[row.creator_id] = "current_missing"
            continue

        anchor = anchor_by_creator.get(row.creator_id)
        if anchor is None:
            ineligible[row.creator_id] = "anchor_missing"
            continue
        if anchor.hidden_subscriber_count:
            ineligible[row.creator_id] = "anchor_hidden"
            continue
        if anchor.subscriber_count is None:
            ineligible[row.creator_id] = "anchor_missing"
            continue

        absolute_growth = row.subscriber_count - anchor.subscriber_count
        percentage_growth = (
            absolute_growth / anchor.subscriber_count if anchor.subscriber_count > 0 else None
        )
        candidates.append(
            (row.creator_id, row.subscriber_count, anchor.subscriber_count, absolute_growth, percentage_growth, organization)
        )

    ordered = sorted(candidates, key=lambda item: (-item[3], item[0]))
    rows = [
        SubscriberGrowthRow(
            rank=rank,
            creator_id=creator_id,
            organization=organization,
            current_subscriber_count=current_count,
            anchor_subscriber_count=anchor_count,
            absolute_growth=absolute_growth,
            percentage_growth=percentage_growth,
        )
        for rank, (creator_id, current_count, anchor_count, absolute_growth, percentage_growth, organization) in enumerate(
            ordered, start=1
        )
    ]
    return rows, ineligible


def build_subscriber_leaderboards(
    current_rows: list[SubscriberRow],
    anchor_rows_by_days: Mapping[int, list[SubscriberRow]],
    *,
    dimensions_by_creator: Mapping[str, CreatorSubscriberDimensions],
) -> SubscriberLeaderboards:
    """Build all four canonical results in one call -- the R2 entry point a
    later scheduled job/handler will invoke with today's + D-1/D-7/D-30's
    SubscriberRow snapshots (e.g. from load_exact_anchor_subscriber_rows).

    dimensions_by_creator has no default: this is the production path, and
    the authoritative roster it enforces (see _validate_roster_membership)
    must never be skippable by simply omitting the argument. Pass an empty
    dict explicitly if a caller genuinely has no known creators yet -- that
    correctly makes every observed creator "creator_not_in_roster" rather
    than silently disabling validation.
    """
    total, total_ineligible = build_total_subscribers_leaderboard(
        current_rows, dimensions_by_creator=dimensions_by_creator
    )
    growth: dict[str, list[SubscriberGrowthRow]] = {}
    growth_ineligible: dict[str, dict[str, str]] = {}
    for days in SUBSCRIBER_EXACT_ANCHOR_DAYS:
        period = f"{days}d"
        rows, ineligible = build_growth_leaderboard(
            current_rows,
            anchor_rows_by_days.get(days, []),
            dimensions_by_creator=dimensions_by_creator,
        )
        growth[period] = rows
        growth_ineligible[period] = ineligible
    return SubscriberLeaderboards(
        total=total,
        total_ineligible=total_ineligible,
        growth=growth,
        growth_ineligible=growth_ineligible,
    )


RowT = TypeVar("RowT", TotalSubscribersRow, SubscriberGrowthRow)


def filter_by_organization(rows: list[RowT], organization: str) -> list[RowT]:
    """Derive an ALL/VSPO/Hololive view from one canonical list at read
    time: filtering an already-sorted-by-key sequence preserves that same
    order for the retained subsequence, so this only needs to re-number
    rank, never re-sort -- see this feature's own impact-analysis report for
    the underlying sorted-subsequence proof. Never persisted; called fresh
    on every read."""
    filtered = [row for row in rows if row.organization == organization]
    return [replace(row, rank=rank) for rank, row in enumerate(filtered, start=1)]
