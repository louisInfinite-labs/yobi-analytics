import pytest

from api import lambda_handler as lambda_handler_module


def test_lambda_handler_returns_200_on_success(monkeypatch):
    """A successful collection run (exit code 0) returns a 200 status."""
    monkeypatch.setattr(lambda_handler_module, "main", lambda: 0)

    result = lambda_handler_module.lambda_handler({}, None)

    assert result == {"statusCode": 200}


def test_lambda_handler_raises_on_failure(monkeypatch):
    """A failed collection run (non-zero exit code) raises, so Lambda/CloudWatch
    records the invocation as an error rather than a silent success."""
    monkeypatch.setattr(lambda_handler_module, "main", lambda: 1)

    with pytest.raises(RuntimeError, match="exit code 1"):
        lambda_handler_module.lambda_handler({}, None)


# --- R7 safety correction: a retired/unrecognized mode must never silently --
# --- fall through to the default collection job -----------------------------


def test_lambda_handler_rejects_the_retired_precompute_trending_mode(monkeypatch):
    """mode=precompute_trending used to dispatch to the now-deleted
    analytics.trending_precompute module. It must NOT silently fall through
    to the default collection job (that would mean a stale/manual event
    carrying this old mode quietly runs a full YouTube-statistics collection
    run instead of doing nothing) -- it must raise before either main() or
    run_discovery() ever runs, and must never import the deleted module."""
    import sys

    assert "analytics.trending_precompute" not in sys.modules

    def _main_should_not_run():
        raise AssertionError("main() must not run for a retired-mode event")

    def _discovery_should_not_run():
        raise AssertionError("run_discovery() must not run for a retired-mode event")

    monkeypatch.setattr(lambda_handler_module, "main", _main_should_not_run)
    monkeypatch.setattr(lambda_handler_module, "run_discovery", _discovery_should_not_run)

    with pytest.raises(lambda_handler_module.UnsupportedModeError, match="precompute_trending"):
        lambda_handler_module.lambda_handler({"mode": "precompute_trending"}, None)

    assert "analytics.trending_precompute" not in sys.modules


def test_lambda_handler_rejects_any_other_unrecognized_mode(monkeypatch):
    """Not just the one retired name -- any explicit mode outside the known
    set must raise, never silently default to the collection job."""

    def _main_should_not_run():
        raise AssertionError("main() must not run for an unrecognized-mode event")

    monkeypatch.setattr(lambda_handler_module, "main", _main_should_not_run)

    with pytest.raises(lambda_handler_module.UnsupportedModeError):
        lambda_handler_module.lambda_handler({"mode": "totally_made_up_mode"}, None)


def test_lambda_handler_omitted_mode_still_runs_the_default_collection_job(monkeypatch):
    """The one legitimate case that must NOT raise: mode absent entirely
    (the field's own None default) still means "run the default job", not
    "unsupported"."""
    monkeypatch.setattr(lambda_handler_module, "main", lambda: 0)

    result = lambda_handler_module.lambda_handler({}, None)

    assert result == {"statusCode": 200}


def test_lambda_handler_dispatches_to_discovery_only_in_discovery_only_mode(monkeypatch):
    """An event carrying mode=discovery_only runs run_discovery(), never main()."""

    def _main_should_not_run():
        raise AssertionError("main() must not run for a discovery_only-mode event")

    monkeypatch.setattr(lambda_handler_module, "main", _main_should_not_run)
    monkeypatch.setattr(lambda_handler_module, "run_discovery", lambda: 0)

    result = lambda_handler_module.lambda_handler({"mode": "discovery_only"}, None)

    assert result == {"statusCode": 200}


def test_lambda_handler_raises_on_discovery_only_failure(monkeypatch):
    """A failed discovery-only run (non-zero exit code) raises, matching the default-mode behavior."""
    monkeypatch.setattr(lambda_handler_module, "run_discovery", lambda: 1)

    with pytest.raises(RuntimeError, match="exit code 1"):
        lambda_handler_module.lambda_handler({"mode": "discovery_only"}, None)
