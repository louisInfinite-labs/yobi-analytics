"""Regression coverage for scripts/maintenance/sync_creator_avatars.py's CLI error
handling (C7C) -- build_youtube_client(api_key) used to run before the existing
try/except that handles YouTubeAPIError, so a client-construction failure (e.g. a
rejected/malformed API key) produced an unhandled traceback instead of the CLI's
controlled "Error: ..." + exit code 1 path.
"""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path
from types import SimpleNamespace

_MODULE_PATH = Path(__file__).resolve().parents[3] / "scripts" / "maintenance" / "sync_creator_avatars.py"
_spec = importlib.util.spec_from_file_location("sync_creator_avatars", _MODULE_PATH)
sync_creator_avatars = importlib.util.module_from_spec(_spec)
sys.modules.setdefault("sync_creator_avatars", sync_creator_avatars)
_spec.loader.exec_module(sync_creator_avatars)


def test_main_handles_client_construction_failure_without_a_traceback(monkeypatch, capsys):
    """build_youtube_client raising YouTubeAPIError (e.g. a rejected API key) must be
    caught by the CLI's existing controlled error path: printed message, return code
    1, no unhandled exception escaping main()."""
    monkeypatch.setattr(sync_creator_avatars, "get_api_key", lambda: "fake-key")
    monkeypatch.setattr(
        sync_creator_avatars,
        "load_creators",
        lambda: [SimpleNamespace(youtube_channel_id="UC_TEST")],
    )

    def _raise_on_client_construction(_api_key):
        raise sync_creator_avatars.YouTubeAPIError("Failed to create YouTube API client: invalid key")

    monkeypatch.setattr(sync_creator_avatars, "build_youtube_client", _raise_on_client_construction)

    exit_code = sync_creator_avatars.main([])

    assert exit_code == 1
    captured = capsys.readouterr()
    assert "Error: avatar fetch failed" in captured.out
    assert "Traceback" not in captured.out
    assert "Traceback" not in captured.err
