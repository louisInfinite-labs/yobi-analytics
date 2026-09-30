"""Static, text-level structural check for terraform/lambda.tf's `api` Lambda
environment block (PR #60 review fix, F1/F2): the `api` Lambda serves
GET /subscribers/leaderboard (stores.subscriber_ranking_store) and the
trending-cache S3 archive fallback (stores.trending_cache_archive_store),
both of which call `from_environment()` reading YOBI_HISTORY_BUCKET at
runtime -- an unconfigured bucket previously meant either an unhandled 500
(subscriber leaderboard) or a silently-broken archive fallback.

No `terraform` CLI is available in this environment, so this is a best-effort
textual substitute (substring/slice check against the raw .tf source), not a
substitute for `terraform fmt -check`/`terraform validate` before this is
ever applied -- see tests/test_terraform_execution_lock_structure.py's own
module docstring for the same caveat.
"""

from __future__ import annotations

import pathlib

REPO_ROOT = pathlib.Path(__file__).resolve().parent.parent
LAMBDA_TF = (REPO_ROOT / "terraform" / "lambda.tf").read_text()


def _resource_block(source: str, resource_line: str) -> str:
    start = source.index(resource_line)
    next_resource = source.find('\nresource "', start + len(resource_line))
    return source[start : next_resource if next_resource != -1 else len(source)]


def test_api_lambda_has_the_history_bucket_env_var():
    block = _resource_block(LAMBDA_TF, 'resource "aws_lambda_function" "api"')
    assert "YOBI_HISTORY_BUCKET = aws_s3_bucket.history.id" in block


def test_api_lambda_history_bucket_uses_the_same_reference_every_other_lambda_uses():
    """Must reuse the existing `aws_s3_bucket.history.id` reference -- not a
    second/parallel bucket variable of its own."""
    collector_block = _resource_block(LAMBDA_TF, 'resource "aws_lambda_function" "collector"')
    history_worker_block = _resource_block(LAMBDA_TF, 'resource "aws_lambda_function" "history_worker"')
    ranking_reducer_block = _resource_block(LAMBDA_TF, 'resource "aws_lambda_function" "ranking_reducer"')
    api_block = _resource_block(LAMBDA_TF, 'resource "aws_lambda_function" "api"')

    for block in (collector_block, history_worker_block, ranking_reducer_block, api_block):
        assert "YOBI_HISTORY_BUCKET" in block
        assert "aws_s3_bucket.history.id" in block
