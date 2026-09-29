import io
import json
from datetime import date

import pytest
from botocore.exceptions import ClientError

from analytics.history_ranking import RankedGrowth
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


def test_write_then_read_round_trips_scope_rankings():
    client = _FakeS3Client()
    store = S3PartialRankingStore("test-bucket", s3_client=client)
    rankings = {("creator", "c1"): {"7d": [_ranked("v1", "c1", value=500, rank=1)]}}

    key = store.write(date(2026, 9, 9), 3, rankings)

    assert key == partial_ranking_key(date(2026, 9, 9), 3)
    assert store.read(date(2026, 9, 9), 3) == rankings


def test_write_produces_exactly_one_put_object_call_per_shard():
    client = _FakeS3Client()
    store = S3PartialRankingStore("test-bucket", s3_client=client)

    store.write(date(2026, 9, 9), 0, {})

    assert client.put_calls == 1


def test_payload_carries_schema_version():
    client = _FakeS3Client()
    store = S3PartialRankingStore("test-bucket", s3_client=client)
    rankings = {("creator", "c1"): {"7d": [_ranked("v1", "c1", value=500, rank=1)]}}

    store.write(date(2026, 9, 9), 0, rankings)

    raw = json.loads(client.objects[("test-bucket", partial_ranking_key(date(2026, 9, 9), 0))])
    assert raw["schemaVersion"] == PARTIAL_RANKING_SCHEMA_VERSION
    assert raw["scopeRankings"][0]["scopeValue"] == "c1"


def test_read_rejects_an_unsupported_schema_version():
    client = _FakeS3Client()
    store = S3PartialRankingStore("test-bucket", s3_client=client)
    key = partial_ranking_key(date(2026, 9, 9), 0)
    client.objects[("test-bucket", key)] = json.dumps({"schemaVersion": 1, "foo": "bar"}).encode("utf-8")

    with pytest.raises(PartialRankingStoreError):
        store.read(date(2026, 9, 9), 0)


# --- read() GET-count discipline (Roadmap 5.x reducer single-read) ----------


def test_read_costs_exactly_one_get_object_call():
    client = _FakeS3Client()
    store = S3PartialRankingStore("test-bucket", s3_client=client)
    store.write(date(2026, 9, 9), 0, {})
    client.get_calls = 0  # ignore any GETs from setup above

    store.read(date(2026, 9, 9), 0)

    assert client.get_calls == 1


def test_reducer_style_loop_over_sixteen_shards_costs_exactly_sixteen_gets():
    """Reproduces ranking_reducer.lambda_handler's own read loop shape: one
    read() call per shard, HISTORY_SHARD_COUNT shards total -- must cost
    exactly 16 GetObject calls, never more (no shard read twice) and never
    fewer (no shard silently skipped)."""
    from stores.history_store import HISTORY_SHARD_COUNT

    client = _FakeS3Client()
    store = S3PartialRankingStore("test-bucket", s3_client=client)
    for shard in range(HISTORY_SHARD_COUNT):
        store.write(date(2026, 9, 9), shard, {})
    client.get_calls = 0  # ignore the writes' own (zero) GETs

    for shard in range(HISTORY_SHARD_COUNT):
        store.read(date(2026, 9, 9), shard)

    assert client.get_calls == HISTORY_SHARD_COUNT == 16


# --- R7/R8B safety correction: schemaVersion=2 compatibility across a ------
# --- rolling deploy of history_worker (writer) and ranking_reducer -------
# --- (reader), two separately-deployed Lambdas that are not guaranteed to --
# --- update atomically -------------------------------------------------------


def test_schema_version_was_not_bumped_by_removing_topic_or_creator_partials():
    """The smallest compatible change: dropping topicPartials (R7) and later
    creatorPartials (R8B) must not need a schemaVersion bump, the same
    "additive/removable field, no version bump" precedent topicPartials' own
    original introduction already established. Pinned explicitly so a future
    edit can't silently change this without a test failing."""
    assert PARTIAL_RANKING_SCHEMA_VERSION == 2


def test_new_reader_code_safely_ignores_topic_and_creator_partials_in_an_old_writers_payload():
    """Direction A: a new (post-R7/R8B) reader must tolerate a shard object
    an old history_worker Lambda already wrote -- real, non-empty
    topicPartials and creatorPartials arrays included -- since the two
    Lambdas are deployed independently and the writer may still be on old
    code for a while. schemaVersion is unchanged (2), so this object remains
    readable at all; the extra keys must simply be ignored, never raise."""
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
        # Real, non-empty arrays -- exactly what a still-old history_worker
        # Lambda would have written before R7/R8B deployed there.
        "creatorPartials": [
            {"creatorId": "c1", "period": "7d", "viewSum": 500, "catalogVideoCount": 1,
             "eligibleVideoCount": 1, "topCandidates": []},
        ],
        "topicPartials": [{"creatorId": "c1", "topic": "apex", "viewSum": 500, "videoCount": 1}],
    }
    client.objects[("test-bucket", key)] = json.dumps(old_shaped_payload).encode("utf-8")

    scope_rankings = store.read(date(2026, 9, 9), 0)

    assert [entry.video_id for entry in scope_rankings[("creator", "c1")]["7d"]] == ["v1"]


def test_new_writers_payload_has_no_top_level_topic_or_creator_partials_key_at_all():
    """Direction B's own precondition, proven directly: a payload the
    current write() produces has neither a "topicPartials" nor a
    "creatorPartials" key at all -- not an empty list, absent entirely. For
    topicPartials this is exactly what an old reducer's own historical
    `payload.get("topicPartials", [])` tolerant read was already designed to
    survive. creatorPartials was never read that tolerantly (see the next
    test) -- this only proves what the new writer itself produces, not that
    every possible old reader survives it."""
    client = _FakeS3Client()
    store = S3PartialRankingStore("test-bucket", s3_client=client)

    store.write(date(2026, 9, 9), 0, {})

    raw = json.loads(client.objects[("test-bucket", partial_ranking_key(date(2026, 9, 9), 0))])
    assert "topicPartials" not in raw
    assert "creatorPartials" not in raw


def test_old_hard_required_creator_partials_read_would_not_survive_a_new_writers_payload():
    """Honest documentation of the one rolling-deploy direction R8B's
    creatorPartials removal does NOT make safe, unlike topicPartials.

    An old (pre-R7) reducer's `_from_payload` read topicPartials tolerantly
    from day one (`payload.get("topicPartials", [])`), so removing it from
    the writer was safe in both directions. creatorPartials was instead a
    required v2 key from its own introduction (`payload["creatorPartials"]`,
    no `.get()` fallback) -- reproduced here directly, against a real
    payload this repo's *current* write() produces, to prove the gap is real
    rather than asserting it only in a docstring. Closing it is a deploy-
    ordering concern (upgrade the reducer before, or atomically with, history_
    worker), not something a future code change alone can retroactively fix
    for an already-deployed old Lambda."""
    client = _FakeS3Client()
    store = S3PartialRankingStore("test-bucket", s3_client=client)
    store.write(date(2026, 9, 9), 0, {})

    raw = json.loads(client.objects[("test-bucket", partial_ranking_key(date(2026, 9, 9), 0))])

    with pytest.raises(KeyError):
        raw["creatorPartials"]  # noqa: B018 -- the old reducer's own required-key access, reproduced
