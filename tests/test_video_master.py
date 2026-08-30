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
