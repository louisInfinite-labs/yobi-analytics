"""Production-path <-> cost-model parity guard (AWS Cost Recovery, third pass,
Scope L).

Purpose: prevent the exact failure class that started this whole task --
a cost-control mechanism existing somewhere in the repository while
production's actual deployed schedule/target graph doesn't use it (the
original bug: collect_history_shard's due-scheduling logic existed and was
tested, but the production Step Functions path hadn't been wired to call it
under the assumptions the cost model was built on).

These are deliberately static/structural checks against the real deployed
configuration (terraform/*.tf) and the real production code paths those
files point at -- not mocks of "what production should do." A cost
optimization is only "active" when it is reachable from here; this file is
what keeps that true as the repository changes.

Terraform is asserted against as plain text (regex/substring), not parsed as
HCL -- this repo has no HCL parser dependency, and the properties checked
here (which resource a schedule's target block points at, whether a `state`
line is set to "DISABLED") are simple, stable substrings that a real change
to the deployed graph would necessarily also change, so this remains a
meaningful regression guard without adding a new dependency.
"""

from __future__ import annotations

import re
from pathlib import Path

TERRAFORM_DIR = Path(__file__).parent.parent / "terraform"
SRC_DIR = Path(__file__).parent.parent / "src"


def _read(relative_path: str) -> str:
    return (TERRAFORM_DIR / relative_path).read_text(encoding="utf-8")


def _read_src(relative_path: str) -> str:
    return (SRC_DIR / relative_path).read_text(encoding="utf-8")


def _schedule_block(terraform_text: str, schedule_name: str) -> str:
    """Extract one `resource "aws_scheduler_schedule" "<schedule_name>" { ... }`
    block's raw text by brace-matching, so assertions below only ever look
    inside the one schedule they claim to -- never accidentally matching a
    substring that happens to appear in a different, unrelated schedule."""
    marker = f'resource "aws_scheduler_schedule" "{schedule_name}"'
    start = terraform_text.index(marker)
    brace_start = terraform_text.index("{", start)
    depth = 0
    for index in range(brace_start, len(terraform_text)):
        if terraform_text[index] == "{":
            depth += 1
        elif terraform_text[index] == "}":
            depth -= 1
            if depth == 0:
                return terraform_text[brace_start : index + 1]
    raise AssertionError(f"Unbalanced braces while extracting schedule {schedule_name!r}")


# --- 1. Daily history collection reaches the due-aware worker, not the legacy collector --


def test_daily_collection_schedule_targets_the_step_functions_state_machine():
    """The production-intended daily history path: EventBridge Scheduler ->
    Step Functions (daily_history), never a direct Lambda invoke of the
    legacy heavy collector. This is the exact fact that was wrong before
    this branch's first pass -- pinning it here so a future edit can't
    silently revert the cutover without a test failing."""
    block = _schedule_block(_read("eventbridge.tf"), "daily_collection")

    assert "aws_sfn_state_machine.daily_history.arn" in block
    assert "aws_lambda_function.collector.arn" not in block


def test_daily_collection_schedule_is_not_disabled():
    block = _schedule_block(_read("eventbridge.tf"), "daily_collection")

    assert 'state                        = "DISABLED"' not in block
    assert 'state = "DISABLED"' not in block


def test_daily_history_state_machine_invokes_the_real_due_aware_history_worker():
    """The Step Functions definition's own CollectHistoryShards states must
    invoke the real history_worker Lambda (api.history_worker_handler ->
    collection.history_worker.collect_history_shard), never the legacy
    collector."""
    history_tf = _read("history.tf")

    assert "aws_lambda_function.history_worker.arn" in history_tf
    assert "aws_lambda_function.collector.arn" not in history_tf


# --- 2. No scheduled legacy full-catalog collector path is active ----------


def test_discovery_only_schedule_uses_the_light_discovery_mode_not_the_heavy_collector():
    """discovery_only is the *only* schedule that still targets the collector
    Lambda -- and it must invoke it in the light discovery_only mode
    (collection.main.run_discovery), never the heavy default mode
    (collection.main.main, which does full per-video YouTube statistics
    collection and has no schedule of its own anywhere)."""
    block = _schedule_block(_read("eventbridge.tf"), "discovery_only")

    assert "aws_lambda_function.collector.arn" in block
    assert '"discovery_only"' in block or "discovery_only" in block


def test_no_enabled_schedule_targets_the_legacy_collector_lambda_except_discovery_only():
    """Every aws_scheduler_schedule resource in this file that targets the
    collector Lambda AND is currently enabled must be discovery_only (light
    mode) -- proving there is no other currently-active schedule that would
    invoke collection.main.main()'s O(total catalog) YouTube-collection
    path. R7 (AWS Cost Recovery): trending_precompute_batches -- previously
    the one other, already-Terraform-disabled schedule targeting this same
    Lambda -- was removed entirely (not merely left disabled), along with
    the analytics/trending_precompute.py module it targeted, so it no longer
    appears here at all."""
    eventbridge_tf = _read("eventbridge.tf")
    schedule_names = re.findall(r'resource "aws_scheduler_schedule" "(\w+)"', eventbridge_tf)

    collector_targeting_schedules = [
        name for name in schedule_names if "aws_lambda_function.collector.arn" in _schedule_block(eventbridge_tf, name)
    ]
    enabled_collector_targeting_schedules = [
        name
        for name in collector_targeting_schedules
        if not re.search(r'state\s*=\s*"DISABLED"', _schedule_block(eventbridge_tf, name))
    ]

    assert set(collector_targeting_schedules) == {"discovery_only"}
    assert enabled_collector_targeting_schedules == ["discovery_only"]


# --- 3. Legacy precompute schedule/module are fully removed, not disabled --


def test_trending_precompute_batches_schedule_and_module_are_both_fully_removed():
    """R7 (AWS Cost Recovery): the legacy trending_precompute pipeline's
    schedule resource and its own Python module must both be gone entirely
    -- not merely disabled -- now that ranking_reducer.py is unambiguously
    the only writer of YobiTrendingCache."""
    eventbridge_tf = _read("eventbridge.tf")
    schedule_names = set(re.findall(r'resource "aws_scheduler_schedule" "(\w+)"', eventbridge_tf))

    assert "trending_precompute_batches" not in schedule_names
    assert "precompute_trending" not in eventbridge_tf
    assert not (SRC_DIR / "analytics" / "trending_precompute.py").exists()


# --- 4. Production-intended history path uses S3 carry-forward -------------


def test_history_worker_source_uses_carry_forward_for_non_due_videos():
    """Structural, source-level proof (independent of the dynamic tests
    elsewhere) that the real collect_history_shard function -- the one
    api.history_worker_handler.lambda_handler actually calls, which
    terraform/history.tf's own Step Functions definition actually invokes --
    contains the carry-forward mechanism, not just that some function
    somewhere in the repo has it."""
    history_worker_source = _read_src("collection/history_worker.py")

    assert "_carry_forward_non_due_rows" in history_worker_source
    assert "select_due_video_ids" in history_worker_source


def test_history_worker_handler_calls_collect_history_shard():
    """The real deployed Lambda entry point (api.history_worker_handler,
    handler = "api.history_worker_handler.lambda_handler" in
    terraform/lambda.tf) must call the due-aware collect_history_shard --
    not some other, older collection function."""
    handler_source = _read_src("api/history_worker_handler.py")

    assert "collect_history_shard(" in handler_source


# --- 5. Production-intended history path does not use full-catalog topic reads --


def test_history_worker_handler_does_not_use_the_full_catalog_topic_batch_get():
    """AWS Cost Recovery second pass removed the daily full-catalog
    get_video_topics BatchGetItem from the production handler in favor of
    the manifest's own persisted topic -- pinned here so it can't silently
    come back. Checks for an actual call/import, not just the bare
    substring, since the handler's own docstring legitimately mentions
    get_video_topics in prose (explaining what it *used to* call).

    R7 (AWS Cost Recovery): history_worker_handler.py no longer forwards
    result.topic_by_video anywhere itself -- its one consumer (the topic
    leaderboard's creator_topic_partials aggregation) was removed as a
    zero-production-consumer feature. The manifest-sourced, no-BatchGetItem
    topic classification this guard actually protects still lives one level
    down, in collect_history_shard's own _resolve_manifest_topics (see
    history_worker.py) -- explicitly kept (R6/R7's own scope) as the topic
    metadata a future same-creator topic video ranking will need."""
    handler_source = _read_src("api/history_worker_handler.py")
    worker_source = _read_src("collection/history_worker.py")

    assert "get_video_topics(" not in handler_source
    assert "import get_video_topics" not in handler_source
    assert "_resolve_manifest_topics(" in worker_source
    assert "get_video_topics(" not in worker_source


# --- 6. Discovery no longer depends on the daily full VideoMaster Scan -----


def test_run_discovery_does_not_call_load_videos_unconditionally():
    """AWS Cost Recovery third pass: run_discovery's known-ids derivation must
    go through _known_ids_by_creator (manifest-first, VideoMaster Scan only
    as the no-manifest-configured local/dev fallback), never call
    load_videos() directly and unconditionally the way it used to."""
    main_source = _read_src("collection/main.py")

    run_discovery_start = main_source.index("def run_discovery()")
    run_discovery_end = main_source.index("\ndef ", run_discovery_start + 1)
    run_discovery_body = main_source[run_discovery_start:run_discovery_end]

    assert "_known_ids_by_creator()" in run_discovery_body
    assert "load_videos()" not in run_discovery_body


def test_run_discovery_patches_the_manifest_incrementally_not_a_full_republish():
    main_source = _read_src("collection/main.py")

    run_discovery_start = main_source.index("def run_discovery()")
    run_discovery_end = main_source.index("\ndef ", run_discovery_start + 1)
    run_discovery_body = main_source[run_discovery_start:run_discovery_end]

    assert "_patch_manifest_with_new_videos_if_configured(" in run_discovery_body
    assert "_publish_manifest_if_configured(" not in run_discovery_body
