import json
import os

import pytest

from video_master import Video, VideoMasterError, load_video_ids_for_creator, load_videos, upsert_videos


def test_upsert_removes_temp_file_when_replace_fails(tmp_path, monkeypatch):
    """If os.replace fails during a write, the leftover temp file is cleaned up
    instead of accumulating stale .tmp files in the store directory."""
    path = tmp_path / "video_master.json"

    def _failing_replace(*_args, **_kwargs):
        raise OSError("simulated replace failure")

    monkeypatch.setattr("json_store.os.replace", _failing_replace)

    with pytest.raises(VideoMasterError):
        upsert_videos(
            [Video(video_id="v1", creator_id="aizawa_ema", title="A", published_at="2026-08-20T00:00:00Z")],
            path,
        )

    leftover_tmp_files = [f for f in os.listdir(tmp_path) if f.endswith(".tmp")]
    assert leftover_tmp_files == []


def test_upsert_creates_new_records(tmp_path):
    """New videos are written to a fresh Video Master file."""
    path = tmp_path / "video_master.json"
    videos = [
        Video(
            video_id="v1",
            creator_id="aizawa_ema",
            title="藍沢エマ Video",
            published_at="2026-08-20T00:00:00Z",
        ),
    ]

    upsert_videos(videos, path)

    assert load_videos(path) == videos


def test_upsert_deduplicates_by_video_id(tmp_path):
    """Upserting an existing video ID updates the record instead of duplicating it."""
    path = tmp_path / "video_master.json"
    upsert_videos(
        [Video(video_id="v1", creator_id="aizawa_ema", title="Old Title", published_at="2026-08-20T00:00:00Z")],
        path,
    )

    upsert_videos(
        [Video(video_id="v1", creator_id="aizawa_ema", title="New Title", published_at="2026-08-20T00:00:00Z")],
        path,
    )

    loaded = load_videos(path)
    assert len(loaded) == 1
    assert loaded[0].title == "New Title"


def test_load_video_ids_for_creator_filters_by_creator(tmp_path):
    """Only video IDs belonging to the requested creator are returned."""
    path = tmp_path / "video_master.json"
    upsert_videos(
        [
            Video(video_id="v1", creator_id="aizawa_ema", title="A", published_at="2026-08-20T00:00:00Z"),
            Video(video_id="v2", creator_id="other_creator", title="B", published_at="2026-08-20T00:00:00Z"),
        ],
        path,
    )

    assert load_video_ids_for_creator("aizawa_ema", path) == {"v1"}


def test_load_video_ids_for_creator_uses_preloaded_videos_without_reading_disk(tmp_path, monkeypatch):
    """Passing videos= avoids re-reading the store from disk."""
    path = tmp_path / "video_master.json"
    preloaded = [
        Video(video_id="v1", creator_id="aizawa_ema", title="A", published_at="2026-08-20T00:00:00Z"),
        Video(video_id="v2", creator_id="other_creator", title="B", published_at="2026-08-20T00:00:00Z"),
    ]

    def _fail_if_called(*_args, **_kwargs):
        raise AssertionError("load_videos should not be called when videos= is provided")

    monkeypatch.setattr("video_master.load_videos", _fail_if_called)

    assert load_video_ids_for_creator("aizawa_ema", path, videos=preloaded) == {"v1"}


def test_load_videos_returns_empty_list_when_file_missing(tmp_path):
    """A Video Master path that doesn't exist yet behaves like an empty store."""
    assert load_videos(tmp_path / "does_not_exist.json") == []


def test_load_videos_raises_on_invalid_json(tmp_path):
    """A corrupted Video Master file raises VideoMasterError instead of crashing."""
    path = tmp_path / "video_master.json"
    path.write_text("{not valid json", encoding="utf-8")

    with pytest.raises(VideoMasterError):
        load_videos(path)


def test_load_videos_raises_when_not_a_list(tmp_path):
    """A Video Master file containing something other than a JSON array is rejected."""
    path = tmp_path / "video_master.json"
    path.write_text('{"videoId": "v1"}', encoding="utf-8")

    with pytest.raises(VideoMasterError):
        load_videos(path)


def test_load_videos_raises_on_record_missing_field(tmp_path):
    """A record missing a required field raises VideoMasterError, not a raw KeyError."""
    path = tmp_path / "video_master.json"
    path.write_text('[{"videoId": "v1"}]', encoding="utf-8")

    with pytest.raises(VideoMasterError):
        load_videos(path)


@pytest.mark.parametrize("bad_record", [None, ["not", "an", "object"], "a string", 42])
def test_load_videos_raises_on_non_object_record(tmp_path, bad_record):
    """A list element that isn't a JSON object (null, array, string, number) is
    rejected before it reaches field-parsing, instead of crashing with AttributeError."""
    path = tmp_path / "video_master.json"
    path.write_text(json.dumps([bad_record]), encoding="utf-8")

    with pytest.raises(VideoMasterError):
        load_videos(path)


def test_load_videos_raises_on_non_string_field(tmp_path):
    """A record with a non-string value (e.g. a number) for a required field is rejected."""
    path = tmp_path / "video_master.json"
    path.write_text(
        '[{"videoId": "v1", "creatorId": "aizawa_ema", "title": 42, "publishedAt": "2026-08-20T00:00:00Z"}]',
        encoding="utf-8",
    )

    with pytest.raises(VideoMasterError):
        load_videos(path)


def test_pre_scheduler_state_record_parses_with_bootstrap_defaults(tmp_path):
    """A record written before Roadmap 1.5's scheduler-state fields existed still
    parses, as if it had never yet been classified."""
    path = tmp_path / "video_master.json"
    path.write_text(
        '[{"videoId": "v1", "creatorId": "aizawa_ema", "title": "A", "publishedAt": "2026-08-20T00:00:00Z"}]',
        encoding="utf-8",
    )

    videos = load_videos(path)

    assert videos[0].activity_state == "Unknown"
    assert videos[0].last_checked_at is None
    assert videos[0].last_view_count is None
    assert videos[0].snapshot_count == 0
    assert videos[0].quiet_streak == 0
    assert videos[0].last_classification_reason is None
    assert videos[0].last_percent_growth_per_day is None
    assert videos[0].last_avg_views_per_day is None


def test_scheduler_state_fields_round_trip(tmp_path):
    """A video's full scheduler state survives a write/read round trip."""
    path = tmp_path / "video_master.json"
    video = Video(
        video_id="v1",
        creator_id="aizawa_ema",
        title="A",
        published_at="2026-08-20T00:00:00Z",
        activity_state="Hot",
        last_checked_at="2026-08-30T18:00:00+09:00",
        last_view_count=12345,
        snapshot_count=4,
        quiet_streak=1,
        last_classification_reason="strong_growth",
        last_percent_growth_per_day=20.0,
        last_avg_views_per_day=2000.0,
    )

    upsert_videos([video], path)

    assert load_videos(path) == [video]


def test_non_numeric_velocity_field_is_rejected(tmp_path):
    """A non-numeric 'lastAvgViewsPerDay' is rejected instead of silently accepted."""
    path = tmp_path / "video_master.json"
    path.write_text(
        json.dumps(
            [
                {
                    "videoId": "v1",
                    "creatorId": "aizawa_ema",
                    "title": "A",
                    "publishedAt": "2026-08-20T00:00:00Z",
                    "lastAvgViewsPerDay": "2000",
                }
            ]
        ),
        encoding="utf-8",
    )

    with pytest.raises(VideoMasterError):
        load_videos(path)


@pytest.mark.parametrize("bad_value", [float("nan"), float("inf"), float("-inf")])
def test_non_finite_velocity_field_is_rejected(tmp_path, bad_value):
    """NaN/+-Infinity are rejected — standard JSON has no token for them, so
    silently accepting one here would let it round-trip back out through
    json.dump as non-conformant JSON (`NaN`/`Infinity`) the next time this
    video is upserted."""
    path = tmp_path / "video_master.json"
    path.write_text(
        json.dumps(
            [
                {
                    "videoId": "v1",
                    "creatorId": "aizawa_ema",
                    "title": "A",
                    "publishedAt": "2026-08-20T00:00:00Z",
                    "lastAvgViewsPerDay": bad_value,
                }
            ]
        ),
        encoding="utf-8",
    )

    with pytest.raises(VideoMasterError):
        load_videos(path)


def test_integer_velocity_field_is_accepted(tmp_path):
    """A whole-number velocity measurement round-trips through JSON without a
    decimal point (e.g. 1000, not 1000.0) and must still parse as a float."""
    path = tmp_path / "video_master.json"
    path.write_text(
        json.dumps(
            [
                {
                    "videoId": "v1",
                    "creatorId": "aizawa_ema",
                    "title": "A",
                    "publishedAt": "2026-08-20T00:00:00Z",
                    "lastAvgViewsPerDay": 1000,
                }
            ]
        ),
        encoding="utf-8",
    )

    videos = load_videos(path)

    assert videos[0].last_avg_views_per_day == 1000.0


def test_unknown_activity_state_is_rejected(tmp_path):
    """An activityState outside the defined set (Hot/Unknown/Warm/Cold) is rejected."""
    path = tmp_path / "video_master.json"
    path.write_text(
        json.dumps(
            [
                {
                    "videoId": "v1",
                    "creatorId": "aizawa_ema",
                    "title": "A",
                    "publishedAt": "2026-08-20T00:00:00Z",
                    "activityState": "Lukewarm",
                }
            ]
        ),
        encoding="utf-8",
    )

    with pytest.raises(VideoMasterError):
        load_videos(path)


def test_non_integer_snapshot_count_is_rejected(tmp_path):
    """A non-integer 'snapshotCount' is rejected instead of silently accepted."""
    path = tmp_path / "video_master.json"
    path.write_text(
        json.dumps(
            [
                {
                    "videoId": "v1",
                    "creatorId": "aizawa_ema",
                    "title": "A",
                    "publishedAt": "2026-08-20T00:00:00Z",
                    "snapshotCount": "3",
                }
            ]
        ),
        encoding="utf-8",
    )

    with pytest.raises(VideoMasterError):
        load_videos(path)
