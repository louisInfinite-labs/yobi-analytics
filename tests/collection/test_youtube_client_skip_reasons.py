"""get_video_statistics names its skip reasons so a caller can classify them without matching on message text."""

from collection import youtube_client
from collection.youtube_client import SKIP_REASON_API_ERROR_PREFIX, SKIP_REASON_NO_DATA, get_video_statistics


class _Youtube:
    """A minimal videos().list(...).execute() double: returns `items`, or raises OSError when `fail` is set."""

    def __init__(self, items, *, fail=False):
        self.items, self.fail = items, fail

    def videos(self):
        return self

    def list(self, **kwargs):
        return self

    def execute(self):
        if self.fail:
            raise OSError("simulated network failure")
        return {"items": self.items}


def test_the_skip_reason_texts_are_unchanged():
    assert SKIP_REASON_NO_DATA == "No data returned by YouTube API (video may be deleted or private)"
    assert SKIP_REASON_API_ERROR_PREFIX == "YouTube API error: "


def test_a_video_youtube_does_not_return_is_skipped_with_the_no_data_reason():
    _results, skipped = get_video_statistics(_Youtube([]), ["gone"])

    assert skipped == {"gone": SKIP_REASON_NO_DATA}


def test_a_failed_batch_is_skipped_with_the_api_error_prefix(monkeypatch):
    monkeypatch.setattr(youtube_client.time, "sleep", lambda seconds: None)

    _results, skipped = get_video_statistics(_Youtube([], fail=True), ["a", "b"])

    assert set(skipped) == {"a", "b"}
    assert all(reason.startswith(SKIP_REASON_API_ERROR_PREFIX) for reason in skipped.values())
