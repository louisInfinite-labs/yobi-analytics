import io
import json
from datetime import date

import pytest
from botocore.exceptions import ClientError

from analytics.history_ranking import CreatorPeriodPartial, RankedGrowth
from stores.ranking_partial_store import (
    PARTIAL_RANKING_SCHEMA_VERSION,
    PartialRankingStoreError,
    S3PartialRankingStore,
    partial_ranking_key,
)


class _FakeS3Client:
    """In-memory stand-in for boto3's S3 client, tracking put_object/get_object calls."""

    def __init__(self):
        self.objects: dict[tuple[str, str], bytes] = {}
        self.put_calls = 0
        self.get_calls = 0

    def put_object(self, *, Bucket, Key, Body, ContentType):
        self.objects[(Bucket, Key)] = Body
        self.put_calls += 1

    def get_object(self, *, Bucket, Key):
        self.get_calls += 1
        if (Bucket, Key) not in self.objects:
            raise ClientError({"Error": {"Code": "NoSuchKey", "Message": "boom"}}, "GetObject")
        return {"Body": io.BytesIO(self.objects[(Bucket, Key)])}


def _ranked(video_id, creator_id, *, value, rank, period="7d"):
    return RankedGrowth(
        rank=rank,
        video_id=video_id,
        creator_id=creator_id,
        period=period,
        view_count=value,
        anchor_view_count=0,
        gain=value,
        observed_at="2026-09-09T18:00:00+09:00",
    )


def _creator_partial(creator_id, period, *, view_sum, catalog, eligible, top_candidates):
    return CreatorPeriodPartial(
        creator_id=creator_id,
        period=period,
        view_sum=view_sum,
        catalog_video_count=catalog,
        eligible_video_count=eligible,
        top_candidates=top_candidates,
    )


def test_write_then_read_round_trips_scope_rankings_and_creator_partials():
    """The one payload write() produces must round-trip both halves it now
    carries -- the original scope (video) Top-N rankings, unchanged in shape,
    and the new per-creator/per-period partials, via two separate read
    methods that both read the same underlying S3 object."""
    client = _FakeS3Client()
    store = S3PartialRankingStore("test-bucket", s3_client=client)
    rankings = {("creator", "c1"): {"7d": [_ranked("v1", "c1", value=500, rank=1)]}}
    creator_partials = {
        "c1": {
            "7d": _creator_partial(
                "c1", "7d", view_sum=500, catalog=1, eligible=1, top_candidates=[_ranked("v1", "c1", value=500, rank=1)]
            )
        }
    }

    key = store.write(date(2026, 9, 9), 3, rankings, creator_partials)

    assert key == partial_ranking_key(date(2026, 9, 9), 3)
    assert store.read(date(2026, 9, 9), 3) == rankings
    assert store.read_creator_partials(date(2026, 9, 9), 3) == creator_partials


def test_write_produces_exactly_one_put_object_call_per_shard():
    """Extending the payload with creator partials must not cost a second PUT --
    one write() call, one S3 object, regardless of how much it now carries."""
    client = _FakeS3Client()
    store = S3PartialRankingStore("test-bucket", s3_client=client)

    store.write(date(2026, 9, 9), 0, {}, {})

    assert client.put_calls == 1


def test_payload_carries_schema_version_and_creator_completeness_fields():
    client = _FakeS3Client()
    store = S3PartialRankingStore("test-bucket", s3_client=client)
    creator_partials = {
        "c1": {"7d": _creator_partial("c1", "7d", view_sum=100, catalog=5, eligible=3, top_candidates=[])},
    }

    store.write(date(2026, 9, 9), 0, {}, creator_partials)

    raw = json.loads(client.objects[("test-bucket", partial_ranking_key(date(2026, 9, 9), 0))])
    assert raw["schemaVersion"] == PARTIAL_RANKING_SCHEMA_VERSION
    entry = raw["creatorPartials"][0]
    assert entry == {
        "creatorId": "c1",
        "period": "7d",
        "viewSum": 100,
        "catalogVideoCount": 5,
        "eligibleVideoCount": 3,
        "isComplete": False,
        "topCandidates": [],
    }

    read_back = store.read_creator_partials(date(2026, 9, 9), 0)
    assert read_back["c1"]["7d"].is_complete is False
    assert read_back["c1"]["7d"].catalog_video_count == 5
    assert read_back["c1"]["7d"].eligible_video_count == 3


def test_creator_partials_are_grouped_by_creator_and_period_even_when_shard_mixes_creators():
    """One shard's payload legitimately covers many creators (sharding is by
    video_id, not creator) -- the stored/round-tripped structure must still
    key each partial by its own (creatorId, period), never flatten or merge
    across creators."""
    client = _FakeS3Client()
    store = S3PartialRankingStore("test-bucket", s3_client=client)
    creator_partials = {
        "holo_creator": {"7d": _creator_partial("holo_creator", "7d", view_sum=1_000, catalog=2, eligible=2, top_candidates=[])},
        "vspo_creator": {"7d": _creator_partial("vspo_creator", "7d", view_sum=5_000, catalog=1, eligible=1, top_candidates=[])},
    }

    store.write(date(2026, 9, 9), 0, {}, creator_partials)
    read_back = store.read_creator_partials(date(2026, 9, 9), 0)

    assert read_back["holo_creator"]["7d"].view_sum == 1_000
    assert read_back["vspo_creator"]["7d"].view_sum == 5_000
    assert "vspo_creator" not in read_back["holo_creator"]


def test_read_rejects_an_unsupported_schema_version():
    client = _FakeS3Client()
    store = S3PartialRankingStore("test-bucket", s3_client=client)
    key = partial_ranking_key(date(2026, 9, 9), 0)
    client.objects[("test-bucket", key)] = json.dumps({"schemaVersion": 1, "foo": "bar"}).encode("utf-8")

    with pytest.raises(PartialRankingStoreError):
        store.read(date(2026, 9, 9), 0)


# --- read_bundle GET-count discipline (Roadmap 5.x reducer single-read) ----


def test_read_bundle_costs_exactly_one_get_object_call():
    client = _FakeS3Client()
    store = S3PartialRankingStore("test-bucket", s3_client=client)
    store.write(date(2026, 9, 9), 0, {}, {})
    client.get_calls = 0  # ignore any GETs from setup above

    store.read_bundle(date(2026, 9, 9), 0)

    assert client.get_calls == 1


def test_reading_both_halves_via_read_and_read_creator_partials_separately_costs_two_gets():
    """Documents the exact inefficiency read_bundle exists to avoid: calling
    read() then read_creator_partials() for the same shard costs 2 GETs, not 1."""
    client = _FakeS3Client()
    store = S3PartialRankingStore("test-bucket", s3_client=client)
    store.write(date(2026, 9, 9), 0, {}, {})
    client.get_calls = 0

    store.read(date(2026, 9, 9), 0)
    store.read_creator_partials(date(2026, 9, 9), 0)

    assert client.get_calls == 2


def test_reducer_style_loop_over_sixteen_shards_costs_exactly_sixteen_gets():
    """Reproduces ranking_reducer.lambda_handler's own read loop shape: one
    read_bundle() call per shard, HISTORY_SHARD_COUNT shards total -- must
    cost exactly 16 GetObject calls, never 32 (one read() + one
    read_creator_partials() per shard) and never more than 16 (no shard read
    twice)."""
    from stores.history_store import HISTORY_SHARD_COUNT

    client = _FakeS3Client()
    store = S3PartialRankingStore("test-bucket", s3_client=client)
    for shard in range(HISTORY_SHARD_COUNT):
        store.write(date(2026, 9, 9), shard, {}, {})
    client.get_calls = 0  # ignore the writes' own (zero) GETs

    for shard in range(HISTORY_SHARD_COUNT):
        store.read_bundle(date(2026, 9, 9), shard)

    assert client.get_calls == HISTORY_SHARD_COUNT == 16


# --- R7 safety correction: schemaVersion=2 compatibility across a rolling --
# --- deploy of history_worker (writer) and ranking_reducer (reader), two --
# --- separately-deployed Lambdas that are not guaranteed to update atomically


def test_schema_version_was_not_bumped_by_removing_topic_partials():
    """The smallest compatible change: dropping topicPartials must not need
    a schemaVersion bump, the same "additive/removable field, no version
    bump" precedent topicPartials' own original introduction already
    established. Pinned explicitly so a future edit can't silently change
    this without a test failing."""
    assert PARTIAL_RANKING_SCHEMA_VERSION == 2


def test_new_reader_code_safely_ignores_topic_partials_in_an_old_writers_payload():
    """Direction A: a new (post-R7) reader must tolerate a shard object an
    old (pre-R7) history_worker Lambda already wrote -- a real, non-empty
    topicPartials array included -- since the two Lambdas are deployed
    independently and the writer may still be on old code for a while.
    schemaVersion is unchanged (2), so this object remains readable at all;
    the extra key must simply be ignored, never raise."""
    client = _FakeS3Client()
    store = S3PartialRankingStore("test-bucket", s3_client=client)
    key = partial_ranking_key(date(2026, 9, 9), 0)
    old_shaped_payload = {
        "schemaVersion": 2,
        "scopeRankings": [
            {
                "scopeType": "creator",
                "scopeValue": "c1",
                "period": "7d",
                "entries": [
                    {
                        "rank": 1, "videoId": "v1", "creatorId": "c1", "viewCount": 500,
                        "anchorViewCount": 0, "gain": 500, "observedAt": "2026-09-09T18:00:00+09:00",
                    }
                ],
            }
        ],
        "creatorPartials": [],
        # A real, non-empty topicPartials array -- exactly what a still-old
        # history_worker Lambda would have written before R7 deployed there.
        "topicPartials": [{"creatorId": "c1", "topic": "apex", "viewSum": 500, "videoCount": 1}],
    }
    client.objects[("test-bucket", key)] = json.dumps(old_shaped_payload).encode("utf-8")

    scope_rankings, creator_partials = store.read_bundle(date(2026, 9, 9), 0)

    assert [entry.video_id for entry in scope_rankings[("creator", "c1")]["7d"]] == ["v1"]
    assert creator_partials == {}


def test_new_writers_payload_has_no_top_level_topic_partials_key_at_all():
    """Direction B's own precondition, proven directly: a payload the
    current (post-R7) write() produces has no "topicPartials" key at all --
    not an empty list, absent entirely. This is exactly what an old (pre-R7)
    reducer's own historical `payload.get("topicPartials", [])` tolerant
    read was already designed to survive (that pattern treats "key missing"
    and "key present but empty" identically, returning [] either way) -- so
    an old reducer reading a new writer's object degrades to zero topic data
    for that shard rather than raising. Proven here at the data-contract
    level, since the pre-R7 reducer code itself no longer exists in this
    repo to invoke directly."""
    client = _FakeS3Client()
    store = S3PartialRankingStore("test-bucket", s3_client=client)

    store.write(date(2026, 9, 9), 0, {}, {})

    raw = json.loads(client.objects[("test-bucket", partial_ranking_key(date(2026, 9, 9), 0))])
    assert "topicPartials" not in raw
    assert raw.get("topicPartials", []) == []  # the exact old tolerant-read pattern, still safe


def test_old_readers_required_keys_are_still_present_in_a_new_writers_payload():
    """The two keys an old (pre-R7) reducer's own _from_payload required
    outright (payload["scopeRankings"] / payload["creatorPartials"], no
    .get() fallback) must still be present and correctly shaped in a new
    writer's payload -- these were never part of the topicPartials removal,
    but this pins that a new writer never accidentally drops them too."""
    client = _FakeS3Client()
    store = S3PartialRankingStore("test-bucket", s3_client=client)
    rankings = {("creator", "c1"): {"7d": [_ranked("v1", "c1", value=500, rank=1)]}}

    store.write(date(2026, 9, 9), 0, rankings, {})

    raw = json.loads(client.objects[("test-bucket", partial_ranking_key(date(2026, 9, 9), 0))])
    assert raw["schemaVersion"] == 2
    assert isinstance(raw["scopeRankings"], list) and len(raw["scopeRankings"]) == 1
    assert raw["creatorPartials"] == []
