"""V5.13: deploy the V5.12 organization-namespace fix to
yobi-analytics-ranking-reducer ONLY. Never touches api/collector/history-worker.

Sequence: read-only pre-check -> upload to a new S3 key -> update-function-code
(code only) -> read-only post-deploy verification (deployed package
downloaded and independently re-inspected). Never calls invoke().
"""

from __future__ import annotations

import hashlib
import sys
import time
import urllib.request
import zipfile
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

import boto3

FUNCTION_NAME = "yobi-analytics-ranking-reducer"
ARTIFACT_BUCKET = "yobi-analytics-lambda-artifacts-189461315571"

LOCAL_ARTIFACT = Path("build/lambda_deployment.zip")
EXPECTED_SHA256 = "f1ab581a90e16a236f8ba407ceac28a823cfe6050166293aaacc2a45318047f1"
EXPECTED_COMPRESSED_BYTES = 76_100_548

BASELINE = {"Handler": "analytics.ranking_reducer.lambda_handler", "Runtime": "python3.12", "MemorySize": 2048, "Timeout": 900}
ENV_KEYS = {"YOBI_HISTORY_BUCKET", "YOBI_STORAGE_BACKEND", "YOBI_TRENDING_CACHE_TABLE", "YOBI_VIDEO_MASTER_TABLE"}

WAIT_POLL_SECONDS = 5
WAIT_TIMEOUT_SECONDS = 300


class PreCheckFailed(RuntimeError):
    pass


class DeploymentFailed(RuntimeError):
    pass


@dataclass
class Snapshot:
    state: str
    last_update_status: str
    handler: str
    runtime: str
    memory_size: int
    timeout: int
    env_keys: set[str]
    code_sha256: str


def _snapshot(lambda_client) -> Snapshot:
    config = lambda_client.get_function(FunctionName=FUNCTION_NAME)["Configuration"]
    return Snapshot(
        state=config["State"],
        last_update_status=config["LastUpdateStatus"],
        handler=config["Handler"],
        runtime=config["Runtime"],
        memory_size=config["MemorySize"],
        timeout=config["Timeout"],
        env_keys=set(config.get("Environment", {}).get("Variables", {}).keys()),
        code_sha256=config["CodeSha256"],
    )


def _print(label: str, snap: Snapshot) -> None:
    print(f"  {label}: State={snap.state} LastUpdateStatus={snap.last_update_status}")
    print(f"    Handler={snap.handler} Runtime={snap.runtime} Memory={snap.memory_size} Timeout={snap.timeout}")
    print(f"    EnvKeys={sorted(snap.env_keys)}")
    print(f"    CodeSha256={snap.code_sha256}")


def stage_pre_check(lambda_client) -> Snapshot:
    print("=== V5.13.2: read-only production pre-check (ranking-reducer only) ===")
    snap = _snapshot(lambda_client)
    _print("ranking-reducer (before)", snap)
    problems = []
    if snap.state != "Active":
        problems.append(f"State={snap.state!r}")
    if snap.last_update_status != "Successful":
        problems.append(f"LastUpdateStatus={snap.last_update_status!r}")
    for field_name, expected in BASELINE.items():
        actual = {"Handler": snap.handler, "Runtime": snap.runtime, "MemorySize": snap.memory_size, "Timeout": snap.timeout}[field_name]
        if actual != expected:
            problems.append(f"{field_name}={actual!r} expected {expected!r}")
    if snap.env_keys != ENV_KEYS:
        problems.append(f"env keys={sorted(snap.env_keys)} expected {sorted(ENV_KEYS)}")
    if problems:
        raise PreCheckFailed("; ".join(problems))
    print("V5.13.2 PRE-CHECK: CLEAN\n")
    return snap


def stage_upload(s3_client) -> str:
    print("=== V5.13.3: upload artifact to a new S3 key ===")
    data = LOCAL_ARTIFACT.read_bytes()
    sha256 = hashlib.sha256(data).hexdigest()
    if sha256 != EXPECTED_SHA256 or len(data) != EXPECTED_COMPRESSED_BYTES:
        raise PreCheckFailed(f"local artifact mismatch: sha256={sha256} size={len(data)}")

    timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    key = f"ranking-reducer/{timestamp}-{EXPECTED_SHA256[:8]}.zip"
    if s3_client.list_objects_v2(Bucket=ARTIFACT_BUCKET, Prefix=key).get("KeyCount", 0) > 0:
        raise PreCheckFailed(f"S3 key {key!r} already exists")

    print(f"  Uploading to s3://{ARTIFACT_BUCKET}/{key} ...")
    s3_client.upload_file(str(LOCAL_ARTIFACT), ARTIFACT_BUCKET, key)

    size = s3_client.head_object(Bucket=ARTIFACT_BUCKET, Key=key)["ContentLength"]
    if size != EXPECTED_COMPRESSED_BYTES:
        raise PreCheckFailed(f"uploaded size {size} != expected")
    downloaded_sha256 = hashlib.sha256(s3_client.get_object(Bucket=ARTIFACT_BUCKET, Key=key)["Body"].read()).hexdigest()
    if downloaded_sha256 != EXPECTED_SHA256:
        raise PreCheckFailed("downloaded sha256 mismatch")
    print(f"  Verified: size={size} sha256={downloaded_sha256}\nV5.13.3 UPLOAD: VERIFIED\n")
    return key


def _wait_for_healthy(lambda_client) -> Snapshot:
    deadline = time.monotonic() + WAIT_TIMEOUT_SECONDS
    while True:
        snap = _snapshot(lambda_client)
        print(f"  ranking-reducer: State={snap.state} LastUpdateStatus={snap.last_update_status}")
        if snap.state == "Active" and snap.last_update_status == "Successful":
            return snap
        if snap.last_update_status == "Failed":
            raise DeploymentFailed("LastUpdateStatus=Failed")
        if time.monotonic() > deadline:
            raise DeploymentFailed(f"did not reach Active/Successful within {WAIT_TIMEOUT_SECONDS}s")
        time.sleep(WAIT_POLL_SECONDS)


def stage_deploy(lambda_client, s3_key: str) -> Snapshot:
    print("=== V5.13.3: code-only deployment (ranking-reducer ONLY) ===")
    lambda_client.update_function_code(FunctionName=FUNCTION_NAME, S3Bucket=ARTIFACT_BUCKET, S3Key=s3_key)
    snap = _wait_for_healthy(lambda_client)
    print(f"  ranking-reducer: HEALTHY (CodeSha256={snap.code_sha256})\n")
    return snap


def stage_verify_deployed_package(lambda_client, before: Snapshot, after: Snapshot) -> dict:
    print("=== V5.13.4: deployed-package verification ===")
    anomalies = []
    if after.code_sha256 == before.code_sha256:
        anomalies.append("CodeSha256 did not change")
    for field_name, expected in BASELINE.items():
        actual = {"Handler": after.handler, "Runtime": after.runtime, "MemorySize": after.memory_size, "Timeout": after.timeout}[field_name]
        if actual != expected:
            anomalies.append(f"{field_name} changed: {actual!r} != {expected!r}")
    if after.env_keys != ENV_KEYS:
        anomalies.append(f"env keys changed: {sorted(after.env_keys)}")

    resp = lambda_client.get_function(FunctionName=FUNCTION_NAME)
    out_path = Path("build/_deployed_ranking_reducer_v513.zip")
    urllib.request.urlretrieve(resp["Code"]["Location"], out_path)  # noqa: S310 -- AWS-issued presigned URL
    data = out_path.read_bytes()
    sha256 = hashlib.sha256(data).hexdigest()
    print(f"  deployed package sha256={sha256} size={len(data)}")
    if sha256 != EXPECTED_SHA256 or len(data) != EXPECTED_COMPRESSED_BYTES:
        anomalies.append("deployed package sha256/size mismatch")

    with zipfile.ZipFile(out_path) as zf:
        history_ranking_src = zf.read("analytics/history_ranking.py").decode("utf-8")
        ranking_reducer_src = zf.read("analytics/ranking_reducer.py").decode("utf-8")

    scopes_for_emits_org = '("org", dimensions.organization)' in history_ranking_src
    scope_field_accepts_org = '"org": {"organization": scope_value}' in ranking_reducer_src
    no_stale_organization_scope_key = '("organization", dimensions.organization)' not in history_ranking_src
    print(f"  _scopes_for emits ('org', ...): {scopes_for_emits_org}")
    print(f"  _scope_field has \"org\": {{\"organization\": scope_value}}: {scope_field_accepts_org}")
    print(f"  no stale ('organization', dimensions.organization) remains: {no_stale_organization_scope_key}")
    if not (scopes_for_emits_org and scope_field_accepts_org and no_stale_organization_scope_key):
        anomalies.append("organization namespace fix not found as expected in deployed code")

    global_unchanged = '("global", "global")' in history_ranking_src
    branch_unchanged = 'scopes.append(("branch", dimensions.branch))' in history_ranking_src
    creator_unchanged = '("creator", row.creator_id)' in history_ranking_src
    print(f"  global scope unchanged: {global_unchanged}")
    print(f"  branch scope unchanged: {branch_unchanged}")
    print(f"  creator scope unchanged: {creator_unchanged}")
    if not (global_unchanged and branch_unchanged and creator_unchanged):
        anomalies.append("creator/global/branch scope code looks different than expected")

    creator_summary_present = "def creator_summary_cache_key" not in ranking_reducer_src  # imported, not redefined
    org_leaderboard_call_present = "organization_leaderboard_cache_key(organization=organization" in ranking_reducer_src
    creator_summary_call_present = "creator_summary_cache_key(creator_id=creator_id" in ranking_reducer_src
    print(f"  creatorSummary write call present: {creator_summary_call_present}")
    print(f"  orgLeaderboard write call present: {org_leaderboard_call_present}")
    if not (creator_summary_call_present and org_leaderboard_call_present):
        anomalies.append("creatorSummary/orgLeaderboard write calls missing from deployed code")

    print(f"\nV5.13.4: {'CLEAN' if not anomalies else 'ANOMALIES: ' + '; '.join(anomalies)}\n")
    return {"anomalies": anomalies}


def main() -> int:
    lambda_client = boto3.client("lambda")
    s3_client = boto3.client("s3")

    if not LOCAL_ARTIFACT.exists():
        print(f"Local artifact not found: {LOCAL_ARTIFACT}")
        return 1

    try:
        before = stage_pre_check(lambda_client)
    except PreCheckFailed as exc:
        print(f"\nABORTED before any write: {exc}")
        return 1

    try:
        s3_key = stage_upload(s3_client)
    except PreCheckFailed as exc:
        print(f"\nABORTED before deployment: {exc}")
        return 1

    try:
        after = stage_deploy(lambda_client, s3_key)
    except DeploymentFailed as exc:
        print(f"\nDEPLOYMENT FAILED: {exc}")
        return 1

    result = stage_verify_deployed_package(lambda_client, before, after)

    print(f"s3Key: {s3_key}")
    print(f"ranking-reducer CodeSha256: {before.code_sha256} -> {after.code_sha256}")

    overall_ok = not result["anomalies"]
    print(f"\nOVERALL: {'PASS' if overall_ok else 'FAIL'}")
    return 0 if overall_ok else 1


if __name__ == "__main__":
    sys.exit(main())
