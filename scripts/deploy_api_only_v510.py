"""V5.10: deploy the V5.9 cache-only trending API to yobi-analytics-api ONLY
(never yobi-analytics-collector), then verify with real public HTTPS probes
and CloudWatch telemetry.

Sequence, each gating the next -- mirrors scripts/deploy_vspo_official_release.py's
structure but scoped to the API function alone:
1. Read-only pre-check of yobi-analytics-api against the known baseline.
2. Upload the already-verified local artifact to a new, unique S3 key.
3. update-function-code (code only) for yobi-analytics-api, waited healthy.
4. Read-only post-deploy verification: config unchanged except CodeSha256,
   the actual deployed package downloaded and independently re-verified.
5. Real public HTTPS probes against the live endpoint (never Lambda invoke()).
6. Read-only CloudWatch correlation for the probe window.

Never touches yobi-analytics-collector, DynamoDB writes, S3 history,
TrendingCache, Step Functions, schedules, or IAM/Terraform.
"""

from __future__ import annotations

import hashlib
import json
import sys
import time
import urllib.error
import urllib.request
import zipfile
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path

import boto3

API_FUNCTION = "yobi-analytics-api"
ARTIFACT_BUCKET = "yobi-analytics-lambda-artifacts-189461315571"
API_ENDPOINT = "https://k76ct6q0j0.execute-api.ap-northeast-1.amazonaws.com"

LOCAL_ARTIFACT = Path("build/lambda_deployment.zip")
EXPECTED_SHA256 = "7d198b168d3ec18908d1c5059988e53ed098402c14e8b5e4fcd389b90ab0b7ee"
EXPECTED_COMPRESSED_BYTES = 76_099_420

EXPECTED_CREATOR_COUNT = 113
EXPECTED_VSPO_OFFICIAL = {
    "creatorId": "vspo_official",
    "displayName": "ぶいすぽっ!【公式】",
    "organization": "vspo",
    "youtubeChannelId": "UCuI5XaO-6VkOEhHao6ij7JA",
    "active": True,
    "branch": "vspo_jp",
    "channelType": "group",
    "lifecycleStage": "active",
    "groupKey": ["NO"],
}

API_BASELINE = {"Handler": "api_handler.lambda_handler", "Runtime": "python3.12", "MemorySize": 1024, "Timeout": 60}
API_ENV_KEYS = {"YOBI_ADMIN_API_KEY_SECRET_NAME", "YOBI_STORAGE_BACKEND"}
API_RESERVED_CONCURRENCY = 50

WAIT_POLL_SECONDS = 5
WAIT_TIMEOUT_SECONDS = 300


class PreCheckFailed(RuntimeError):
    pass


class DeploymentFailed(RuntimeError):
    pass


@dataclass
class FunctionSnapshot:
    state: str
    last_update_status: str
    handler: str
    runtime: str
    memory_size: int
    timeout: int
    env_keys: set[str]
    code_sha256: str
    reserved_concurrency: int | None


def _snapshot(lambda_client) -> FunctionSnapshot:
    resp = lambda_client.get_function(FunctionName=API_FUNCTION)
    config = resp["Configuration"]
    concurrency = resp.get("Concurrency")
    return FunctionSnapshot(
        state=config["State"],
        last_update_status=config["LastUpdateStatus"],
        handler=config["Handler"],
        runtime=config["Runtime"],
        memory_size=config["MemorySize"],
        timeout=config["Timeout"],
        env_keys=set(config.get("Environment", {}).get("Variables", {}).keys()),
        code_sha256=config["CodeSha256"],
        reserved_concurrency=concurrency.get("ReservedConcurrentExecutions") if concurrency else None,
    )


def _print_snapshot(label: str, snap: FunctionSnapshot) -> None:
    print(f"  {label}: State={snap.state} LastUpdateStatus={snap.last_update_status}")
    print(f"    Handler={snap.handler} Runtime={snap.runtime} Memory={snap.memory_size} Timeout={snap.timeout}")
    print(f"    EnvKeys={sorted(snap.env_keys)} ReservedConcurrency={snap.reserved_concurrency}")
    print(f"    CodeSha256={snap.code_sha256}")


def stage_pre_check(lambda_client) -> FunctionSnapshot:
    print("=== V5.10.2: read-only production pre-check (api only) ===")
    snap = _snapshot(lambda_client)
    _print_snapshot("api (before)", snap)
    problems = []
    if snap.state != "Active":
        problems.append(f"State={snap.state!r}")
    if snap.last_update_status != "Successful":
        problems.append(f"LastUpdateStatus={snap.last_update_status!r}")
    if snap.handler != API_BASELINE["Handler"]:
        problems.append(f"Handler={snap.handler!r}")
    if snap.runtime != API_BASELINE["Runtime"]:
        problems.append(f"Runtime={snap.runtime!r}")
    if snap.memory_size != API_BASELINE["MemorySize"]:
        problems.append(f"MemorySize={snap.memory_size!r}")
    if snap.timeout != API_BASELINE["Timeout"]:
        problems.append(f"Timeout={snap.timeout!r}")
    if snap.env_keys != API_ENV_KEYS:
        problems.append(f"env keys={sorted(snap.env_keys)}")
    if snap.reserved_concurrency != API_RESERVED_CONCURRENCY:
        problems.append(f"ReservedConcurrency={snap.reserved_concurrency!r}")
    if problems:
        raise PreCheckFailed("; ".join(problems))
    print("V5.10.2 PRE-CHECK: CLEAN\n")
    return snap


def stage_upload(s3_client) -> str:
    print("=== V5.10.3: upload artifact to a new S3 key ===")
    local_bytes = LOCAL_ARTIFACT.read_bytes()
    local_sha256 = hashlib.sha256(local_bytes).hexdigest()
    if local_sha256 != EXPECTED_SHA256 or len(local_bytes) != EXPECTED_COMPRESSED_BYTES:
        raise PreCheckFailed(f"local artifact mismatch: sha256={local_sha256} size={len(local_bytes)}")

    timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    key = f"api-only/{timestamp}-{EXPECTED_SHA256[:8]}.zip"
    if s3_client.list_objects_v2(Bucket=ARTIFACT_BUCKET, Prefix=key).get("KeyCount", 0) > 0:
        raise PreCheckFailed(f"S3 key {key!r} already exists")

    print(f"  Uploading to s3://{ARTIFACT_BUCKET}/{key} ...")
    s3_client.upload_file(str(LOCAL_ARTIFACT), ARTIFACT_BUCKET, key)

    size = s3_client.head_object(Bucket=ARTIFACT_BUCKET, Key=key)["ContentLength"]
    if size != EXPECTED_COMPRESSED_BYTES:
        raise PreCheckFailed(f"uploaded size {size} != expected {EXPECTED_COMPRESSED_BYTES}")
    downloaded_sha256 = hashlib.sha256(s3_client.get_object(Bucket=ARTIFACT_BUCKET, Key=key)["Body"].read()).hexdigest()
    if downloaded_sha256 != EXPECTED_SHA256:
        raise PreCheckFailed(f"downloaded sha256 {downloaded_sha256} != expected")
    print(f"  Verified: size={size} sha256={downloaded_sha256}\nV5.10.3 UPLOAD: VERIFIED\n")
    return key


def _wait_for_healthy(lambda_client) -> FunctionSnapshot:
    deadline = time.monotonic() + WAIT_TIMEOUT_SECONDS
    while True:
        snap = _snapshot(lambda_client)
        print(f"  api: State={snap.state} LastUpdateStatus={snap.last_update_status}")
        if snap.state == "Active" and snap.last_update_status == "Successful":
            return snap
        if snap.last_update_status == "Failed":
            raise DeploymentFailed("api LastUpdateStatus=Failed")
        if time.monotonic() > deadline:
            raise DeploymentFailed(f"api did not reach Active/Successful within {WAIT_TIMEOUT_SECONDS}s")
        time.sleep(WAIT_POLL_SECONDS)


def stage_deploy(lambda_client, s3_key: str) -> FunctionSnapshot:
    print("=== V5.10.3: code-only deployment (api ONLY, collector untouched) ===")
    lambda_client.update_function_code(FunctionName=API_FUNCTION, S3Bucket=ARTIFACT_BUCKET, S3Key=s3_key)
    snap = _wait_for_healthy(lambda_client)
    print(f"  api: HEALTHY (CodeSha256={snap.code_sha256})\n")
    return snap


def _download_and_verify_deployed_package(lambda_client) -> dict:
    resp = lambda_client.get_function(FunctionName=API_FUNCTION)
    url = resp["Code"]["Location"]
    out_path = Path("build/_deployed_api_v510.zip")
    urllib.request.urlretrieve(url, out_path)  # noqa: S310 -- AWS-issued presigned HTTPS URL
    data = out_path.read_bytes()
    sha256 = hashlib.sha256(data).hexdigest()

    with zipfile.ZipFile(out_path) as zf:
        creators = json.loads(zf.read("creators.json"))
        read_api_src = zf.read("read_api.py").decode("utf-8")

    vspo_entries = [c for c in creators if c.get("creatorId") == "vspo_official"]
    return {
        "sha256": sha256,
        "sizeBytes": len(data),
        "creatorCount": len(creators),
        "vspoOfficialMatches": len(vspo_entries) == 1 and vspo_entries[0] == EXPECTED_VSPO_OFFICIAL,
        "maxLiveFallbackVideosAbsent": "MAX_LIVE_FALLBACK_VIDEOS" not in read_api_src,
        "rejectOversizedAbsent": "_reject_oversized_live_fallback" not in read_api_src,
        "boundedLiveLimitAbsent": "_bounded_live_limit" not in read_api_src,
        "computeGrowthResultsPresent": "def _compute_growth_results" in read_api_src,
    }


def stage_post_deploy_verify(lambda_client, before: FunctionSnapshot, after: FunctionSnapshot) -> dict:
    print("=== V5.10.4: deployed-package verification ===")
    anomalies = []
    if after.code_sha256 == before.code_sha256:
        anomalies.append("CodeSha256 did not change")
    for field_name, expected in API_BASELINE.items():
        actual = {"Handler": after.handler, "Runtime": after.runtime, "MemorySize": after.memory_size, "Timeout": after.timeout}[field_name]
        if actual != expected:
            anomalies.append(f"{field_name} changed: {actual!r} != {expected!r}")
    if after.env_keys != API_ENV_KEYS:
        anomalies.append(f"env keys changed: {sorted(after.env_keys)}")
    if after.reserved_concurrency != API_RESERVED_CONCURRENCY:
        anomalies.append(f"reserved concurrency changed: {after.reserved_concurrency}")

    pkg = _download_and_verify_deployed_package(lambda_client)
    print(f"  deployed package sha256={pkg['sha256']} size={pkg['sizeBytes']}")
    print(f"  creators={pkg['creatorCount']} vspoOfficialMatches={pkg['vspoOfficialMatches']}")
    print(
        f"  MAX_LIVE_FALLBACK_VIDEOS absent={pkg['maxLiveFallbackVideosAbsent']} "
        f"_reject_oversized_live_fallback absent={pkg['rejectOversizedAbsent']} "
        f"_bounded_live_limit absent={pkg['boundedLiveLimitAbsent']} "
        f"_compute_growth_results present={pkg['computeGrowthResultsPresent']}"
    )
    if pkg["sha256"] != EXPECTED_SHA256 or pkg["sizeBytes"] != EXPECTED_COMPRESSED_BYTES:
        anomalies.append("deployed package sha256/size mismatch")
    if pkg["creatorCount"] != EXPECTED_CREATOR_COUNT or not pkg["vspoOfficialMatches"]:
        anomalies.append("deployed creators.json mismatch")
    if not (pkg["maxLiveFallbackVideosAbsent"] and pkg["rejectOversizedAbsent"] and pkg["boundedLiveLimitAbsent"]):
        anomalies.append("dead live-fallback code still present in deployed package")
    if not pkg["computeGrowthResultsPresent"]:
        anomalies.append("_compute_growth_results missing from deployed package")

    print(f"V5.10.4: {'CLEAN' if not anomalies else 'ANOMALIES: ' + '; '.join(anomalies)}\n")
    return {"anomalies": anomalies, "pkg": pkg}


@dataclass
class ProbeResult:
    label: str
    url: str
    status: int
    latency_seconds: float
    body: dict | str
    error: str | None = None


def _http_get(url: str) -> ProbeResult:
    start = time.monotonic()
    try:
        with urllib.request.urlopen(url, timeout=65) as resp:  # noqa: S310
            body_bytes = resp.read()
            status = resp.status
    except urllib.error.HTTPError as exc:
        body_bytes = exc.read()
        status = exc.code
    latency = time.monotonic() - start
    try:
        body = json.loads(body_bytes.decode("utf-8"))
    except (json.JSONDecodeError, UnicodeDecodeError):
        body = body_bytes.decode("utf-8", errors="replace")
    return ProbeResult(label="", url=url, status=status, latency_seconds=latency, body=body)


def stage_https_probes(today_jst: str) -> list[ProbeResult]:
    print("=== V5.10.5: public HTTPS production regression (real GET requests only) ===")
    probes: list[tuple[str, str]] = [
        ("A: sakura_miko cache hit, limit omitted",
         f"{API_ENDPOINT}/creators/sakura_miko/trending?reportDate={today_jst}&timeZone=Asia/Tokyo&period=1d"),
        ("B: sakura_miko cache hit, limit=10",
         f"{API_ENDPOINT}/creators/sakura_miko/trending?reportDate={today_jst}&timeZone=Asia/Tokyo&period=1d&limit=10"),
        ("C: vspo_official genuine cache miss",
         f"{API_ENDPOINT}/creators/vspo_official/trending?reportDate={today_jst}&timeZone=Asia/Tokyo&period=1d"),
        ("D: organization vspo cache hit (verified row: 2026-09-12)",
         f"{API_ENDPOINT}/organizations/vspo/trending?reportDate=2026-09-12&timeZone=Asia/Tokyo&period=1d"),
        ("E (optional): sakura_miko non-canonical timeZone",
         f"{API_ENDPOINT}/creators/sakura_miko/trending?reportDate={today_jst}&timeZone=UTC&period=1d"),
    ]
    results = []
    for label, url in probes:
        result = _http_get(url)
        result.label = label
        results.append(result)
        body_preview = result.body if isinstance(result.body, str) else json.dumps(result.body)[:300]
        print(f"  {label}\n    -> HTTP {result.status} in {result.latency_seconds:.2f}s\n    body: {body_preview}")
    print()
    return results


def stage_cloudwatch(cloudwatch, logs, window_start: datetime, window_end: datetime) -> None:
    print("=== V5.10.6: read-only CloudWatch verification ===")
    for metric in ("Duration", "Errors", "Throttles", "ConcurrentExecutions"):
        resp = cloudwatch.get_metric_statistics(
            Namespace="AWS/Lambda", MetricName=metric,
            Dimensions=[{"Name": "FunctionName", "Value": API_FUNCTION}],
            StartTime=window_start, EndTime=window_end, Period=60,
            Statistics=["Maximum", "Sum"],
        )
        pts = sorted(resp["Datapoints"], key=lambda p: p["Timestamp"])
        print(f"  {metric}: {[(p['Timestamp'].strftime('%H:%M:%S'), p.get('Maximum'), p.get('Sum')) for p in pts]}")

    start_ms = int(window_start.timestamp() * 1000)
    end_ms = int(window_end.timestamp() * 1000)
    events = logs.filter_log_events(logGroupName=f"/aws/lambda/{API_FUNCTION}", startTime=start_ms, endTime=end_ms, limit=200)
    print("  Log events in window:")
    for e in events["events"]:
        msg = e["message"].rstrip()
        if msg.startswith("REPORT") or msg.startswith("START") or "timeout" in msg.lower() or "Task timed out" in msg:
            print(f"    {msg}")
    print()


def main() -> int:
    lambda_client = boto3.client("lambda")
    s3_client = boto3.client("s3")
    cloudwatch = boto3.client("cloudwatch")
    logs = boto3.client("logs")

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

    verify_result = stage_post_deploy_verify(lambda_client, before, after)

    window_start = datetime.now(timezone.utc)
    from zoneinfo import ZoneInfo
    today_jst = datetime.now(ZoneInfo("Asia/Tokyo")).date().isoformat()
    probe_results = stage_https_probes(today_jst)
    window_end = datetime.now(timezone.utc) + timedelta(seconds=5)

    time.sleep(15)  # let CloudWatch Logs/metrics ingest before querying
    stage_cloudwatch(cloudwatch, logs, window_start - timedelta(seconds=5), window_end + timedelta(seconds=15))

    print(f"s3Key: {s3_key}")
    print(f"api CodeSha256: {before.code_sha256} -> {after.code_sha256}")

    overall_ok = not verify_result["anomalies"]
    print(f"\nOVERALL: {'PASS' if overall_ok else 'FAIL'}")
    return 0 if overall_ok else 1


if __name__ == "__main__":
    sys.exit(main())
