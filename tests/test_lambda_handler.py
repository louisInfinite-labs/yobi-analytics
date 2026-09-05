import pytest

import lambda_handler as lambda_handler_module


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


def test_lambda_handler_dispatches_to_trending_precompute_in_precompute_mode(monkeypatch):
    """An event carrying mode=precompute_trending runs trending_precompute.run(), never main()."""
    import trending_precompute

    def _main_should_not_run():
        raise AssertionError("main() must not run for a precompute-mode event")

    monkeypatch.setattr(lambda_handler_module, "main", _main_should_not_run)
    monkeypatch.setattr(trending_precompute, "run", lambda report_date, periods: {"scopes_written": 5, "scopes_failed": 0})

    result = lambda_handler_module.lambda_handler({"mode": "precompute_trending"}, None)

    assert result == {"statusCode": 200, "body": {"scopes_written": 5, "scopes_failed": 0}}


def test_lambda_handler_precompute_mode_still_returns_200_when_some_scopes_failed(monkeypatch):
    """A partial precompute failure (best-effort per scope) is logged, not raised — most scopes
    still getting a fresh cache entry is a successful invocation, not a failed one."""
    import trending_precompute

    monkeypatch.setattr(lambda_handler_module, "main", lambda: (_ for _ in ()).throw(AssertionError))
    monkeypatch.setattr(trending_precompute, "run", lambda report_date, periods: {"scopes_written": 4, "scopes_failed": 1})

    result = lambda_handler_module.lambda_handler({"mode": "precompute_trending"}, None)

    assert result["statusCode"] == 200


def test_lambda_handler_precompute_mode_passes_through_a_single_period(monkeypatch):
    """An event's own `period` field precomputes just that period, not all three — each of the
    three EventBridge schedules passes its own period so no single invocation does all 342 scopes."""
    import trending_precompute

    captured = {}

    def _fake_run(report_date, periods):
        captured["periods"] = periods
        return {"scopes_written": 1, "scopes_failed": 0}

    monkeypatch.setattr(trending_precompute, "run", _fake_run)

    lambda_handler_module.lambda_handler({"mode": "precompute_trending", "period": "7d"}, None)

    assert captured["periods"] == ("7d",)


def test_lambda_handler_precompute_mode_defaults_to_every_period_when_absent(monkeypatch):
    """Omitting `period` (e.g. a manual test invoke) still covers all three periods in one call."""
    import trending_precompute

    captured = {}

    def _fake_run(report_date, periods):
        captured["periods"] = periods
        return {"scopes_written": 1, "scopes_failed": 0}

    monkeypatch.setattr(trending_precompute, "run", _fake_run)

    lambda_handler_module.lambda_handler({"mode": "precompute_trending"}, None)

    assert captured["periods"] == trending_precompute._PERIODS


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
