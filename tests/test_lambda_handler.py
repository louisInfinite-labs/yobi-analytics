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
