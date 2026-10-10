"""GET /live-streams for an UNCLASSIFIED upcoming stream: the collector's own classifier decides, once, with the Data API.

Video Master's stored classification always comes first. Only an upcoming stream with NO stored classification is looked up (one batched
videos.list, never per stream); a definitive answer is cached, stored for every other consumer, and a failed/ambiguous lookup keeps the stream.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest

from api import livestream_classification as lc
from api import read_api
from tracking.creator_master import Creator
from tracking.video_master import Video

from tests.api.test_cover_mv_premiere_filtering import _iso

# the real, un-patched function (tests/conftest.py replaces the attribute for every test so nothing can reach YouTube)
_REAL_FETCH = lc._fetch_classifications

CHANNEL = "UC_emma"


def _creator() -> Creator:
    return Creator(
        creator_id="emma", display_name="Emma", organization="vspo", youtube_channel_id=CHANNEL, active=True,
        branch="vspo_jp", group_key=["1期生"], channel_type="member", lifecycle_stage="active", display_order=0,
    )


def _holodex(video_id: str, status: str = "upcoming", title: str = "t") -> dict:
    start = datetime.now(timezone.utc) + timedelta(hours=3)
    return {"id": video_id, "status": status, "channel": {"id": CHANNEL, "name": "Emma"}, "title": title, "start_scheduled": _iso(start),
            "start_actual": _iso(datetime.now(timezone.utc)) if status == "live" else None}


def _video(video_id: str, content_type: str | None, live_status: str | None = None) -> Video:
    return Video(video_id=video_id, creator_id="emma", title=video_id, published_at="2026-10-01T00:00:00Z", content_type=content_type, live_status=live_status)


@pytest.fixture
def setup(monkeypatch):
    """Holodex list, Video Master rows, the Data API answers and the writes, all in memory."""
    state = {"holodex": [], "stored": {}, "api": {}, "asked": [], "written": []}
    monkeypatch.setattr(read_api, "load_creators", lambda: [_creator()])
    monkeypatch.setattr(read_api, "holodex_get", lambda path, params=None: list(state["holodex"]))
    monkeypatch.setattr(read_api, "get_videos", lambda ids: {i: state["stored"][i] for i in ids if i in state["stored"]})

    def fetch(video_ids):
        state["asked"].append(list(video_ids))
        return {i: state["api"][i] for i in video_ids if i in state["api"]}

    monkeypatch.setattr(lc, "_fetch_classifications", fetch)
    monkeypatch.setattr(read_api, "set_video_classification", lambda video_id, content_type, live_status: state["written"].append((video_id, content_type, live_status)) or True)
    return state


def _ids() -> list[str]:
    return [stream["videoId"] for stream in read_api.get_live_streams()["streams"]]


def test_an_unclassified_upcoming_premiere_is_asked_about_and_hidden_and_a_real_upcoming_stream_is_kept(setup):
    setup["holodex"] = [_holodex("cover-premiere"), _holodex("real-upcoming")]
    setup["api"] = {"cover-premiere": ("upload", None), "real-upcoming": ("live", "upcoming")}

    assert _ids() == ["real-upcoming"]
    assert setup["asked"] == [["cover-premiere", "real-upcoming"]]  # ONE batched lookup, not one per stream


def test_the_stored_classification_always_wins_and_is_never_looked_up_again(setup):
    setup["holodex"] = [_holodex("known-stream"), _holodex("known-video")]
    setup["stored"] = {"known-stream": _video("known-stream", "live", "upcoming"), "known-video": _video("known-video", "upload")}
    setup["api"] = {"known-stream": ("upload", None)}  # even if YouTube said otherwise, the canonical stored value decides

    assert _ids() == ["known-stream"]
    assert setup["asked"] == []


def test_only_upcoming_streams_are_looked_up_a_live_one_is_not_classified_by_duration(setup):
    setup["holodex"] = [_holodex("running", status="live"), _holodex("soon")]
    setup["api"] = {"soon": ("live", "upcoming")}

    assert _ids() == ["running", "soon"]
    assert setup["asked"] == [["soon"]]


def test_a_definitive_answer_is_stored_for_every_consumer_only_when_a_record_exists(setup):
    setup["holodex"] = [_holodex("recorded-premiere"), _holodex("undiscovered-premiere")]
    setup["stored"] = {"recorded-premiere": _video("recorded-premiere", None)}  # discovered, not yet classified
    setup["api"] = {"recorded-premiere": ("upload", None), "undiscovered-premiere": ("upload", None)}

    assert _ids() == []
    assert setup["written"] == [("recorded-premiere", "upload", None)]  # the undiscovered one has no record to write to; it is answered per request


def test_the_answer_is_cached_so_repeated_requests_do_not_ask_again(setup):
    setup["holodex"] = [_holodex("cover-premiere")]
    setup["api"] = {"cover-premiere": ("upload", None)}

    assert _ids() == [] and _ids() == [] and _ids() == []
    assert len(setup["asked"]) == 1


def test_a_failed_lookup_keeps_the_stream_logs_it_and_is_not_retried_within_the_failure_window(setup, monkeypatch, capsys):
    setup["holodex"] = [_holodex("cover-premiere")]

    def boom(video_ids):
        setup["asked"].append(list(video_ids))
        raise RuntimeError("quota exceeded")

    monkeypatch.setattr(lc, "_fetch_classifications", boom)

    assert _ids() == ["cover-premiere"]  # fail open: never guessed from the title ("Cover") and never hidden
    assert "could not classify" in capsys.readouterr().out
    assert _ids() == ["cover-premiere"]
    assert len(setup["asked"]) == 1


def test_an_id_the_api_did_not_return_or_an_ambiguous_answer_is_unknown_and_kept(setup, capsys):
    setup["holodex"] = [_holodex("missing"), _holodex("ambiguous")]
    setup["api"] = {"ambiguous": ("live", "completed")}  # not a definitive answer for an UPCOMING candidate

    assert _ids() == ["missing", "ambiguous"]
    assert "no definitive classification" in capsys.readouterr().out


def test_the_failure_marker_expires_so_the_lookup_is_retried_later(monkeypatch):
    calls = []
    monkeypatch.setattr(lc, "_fetch_classifications", lambda ids: calls.append(ids) or (_ for _ in ()).throw(RuntimeError("down")))

    lc.classify_unclassified_upcoming(["v1"], now=1000.0)
    lc.classify_unclassified_upcoming(["v1"], now=1000.0 + lc._FAILURE_TTL_SECONDS - 1)
    assert len(calls) == 1
    lc.classify_unclassified_upcoming(["v1"], now=1000.0 + lc._FAILURE_TTL_SECONDS + 1)
    assert len(calls) == 2


def test_the_real_fetch_hands_the_data_api_items_to_the_collectors_own_classifier(monkeypatch):
    """No second heuristic: the answer is exactly collection.youtube_client._parse_video_item's, on a real response shape."""
    from collection import youtube_client
    from ops import config

    def item(video_id, content_details):
        return {
            "id": video_id,
            "snippet": {"title": video_id, "publishedAt": "2026-10-08T04:03:21Z", "liveBroadcastContent": "upcoming"},
            "statistics": {"viewCount": "0"},
            "liveStreamingDetails": {"scheduledStartTime": "2026-10-12T11:00:00Z"},
            "contentDetails": content_details,
        }

    class _Request:
        def execute(self):
            return {"items": [item("premiere", {"definition": "hd"}), item("stream", {"definition": "hd", "duration": "P0D"})]}

    class _Videos:
        def list(self, **kwargs):
            assert kwargs["part"] == "snippet,statistics,liveStreamingDetails,contentDetails"
            return _Request()

    class _Youtube:
        def videos(self):
            return _Videos()

    monkeypatch.setattr(config, "get_api_key", lambda: "not-a-real-key")
    monkeypatch.setattr(youtube_client, "build_youtube_client", lambda api_key: _Youtube())

    assert _REAL_FETCH(["premiere", "stream"]) == {"premiere": ("upload", None), "stream": ("live", "upcoming")}
