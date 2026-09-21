"""One-time controlled deployment (Task V5.4/V5.5/V5.6): ship the VSPO-official
creators.json update to production by code-only Lambda deployment.

Sequence, each gating the next:
1. Read-only pre-check of yobi-analytics-collector and yobi-analytics-api
   against the known Terraform-declared baseline. Aborts before touching S3
   or Lambda if anything unexpected is found.
2. Upload the local, already-verified build/lambda_deployment.zip to a new,
   unique S3 key (never overwrites/reuses an existing object).
3. update-function-code (code only, no configuration change) for the
   collector first, waited to Active/Successful before touching the API at
   all. If the collector update fails, this script stops -- the API is never
   touched.
4. Same update-function-code for the API, once the collector is confirmed
   healthy.
5. Read-only post-deploy verification: configuration unchanged except
   CodeSha256, both functions on the identical artifact, and the actual
   deployed package downloaded and independently re-verified (byte hash +
   creators.json contents + KNOWN_INCOMPLETE_LEGACY_DATES + discovery docs).

Never calls invoke() on either function. Never touches DynamoDB, S3 history,
Step Functions, IAM, Terraform, or schedules.
"""

from __future__ import annotations

import hashlib
import json
import sys
import time
import urllib.request
import zipfile
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path

import boto3

COLLECTOR_FUNCTION = "yobi-analytics-collector"
API_FUNCTION = "yobi-analytics-api"
ARTIFACT_BUCKET = "yobi-analytics-lambda-artifacts-189461315571"

LOCAL_ARTIFACT = Path("build/lambda_deployment.zip")
EXPECTED_SHA256 = "4c821d44334995c26231dde12a7944471dbb717dd41a30ce68f57aebab49def1"
EXPECTED_COMPRESSED_BYTES = 76_100_595
EXPECTED_UNCOMPRESSED_BYTES = 214_604_831

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

COLLECTOR_BASELINE = {
    "Handler": "api.lambda_handler.lambda_handler",
    "Runtime": "python3.12",
    "MemorySize": 1024,
    "Timeout": 900,
}
COLLECTOR_ENV_KEYS = {"YOUTUBE_API_KEY_SECRET_NAME", "YOBI_DATA_DIR", "YOBI_HISTORY_BUCKET", "YOBI_STORAGE_BACKEND"}

API_BASELINE = {
    "Handler": "api.api_handler.lambda_handler",
    "Runtime": "python3.12",
    "MemorySize": 1024,
    "Timeout": 60,
}
API_ENV_KEYS = {"YOBI_ADMIN_API_KEY_SECRET_NAME", "YOBI_STORAGE_BACKEND"}
API_RESERVED_CONCURRENCY = 50

WAIT_POLL_SECONDS = 5
WAIT_TIMEOUT_SECONDS = 300


class PreCheckFailed(RuntimeError):
    """Raised when a production Lambda's live configuration does not match
    the expected baseline -- aborts before any S3/Lambda write."""


class DeploymentFailed(RuntimeError):
    """Raised when update-function-code does not reach Active/Successful in time."""


@dataclass
class FunctionSnapshot:
    name: str
    state: str
    last_update_status: str
    handler: str
    runtime: str
    memory_size: int
    timeout: int
    env_keys: set[str]
    code_sha256: str
    reserved_concurrency: int | None


def _snapshot(lambda_client, function_name: str) -> FunctionSnapshot:
    resp = lambda_client.get_function(FunctionName=function_name)
    config = resp["Configuration"]
    concurrency = resp.get("Concurrency")
    reserved = concurrency.get("ReservedConcurrentExecutions") if concurrency else None
    return FunctionSnapshot(
        name=function_name,
        state=config["State"],
        last_update_status=config["LastUpdateStatus"],
        handler=config["Handler"],
        runtime=config["Runtime"],
        memory_size=config["MemorySize"],
        timeout=config["Timeout"],
        env_keys=set(config.get("Environment", {}).get("Variables", {}).keys()),
        code_sha256=config["CodeSha256"],
        reserved_concurrency=reserved,
    )


def _print_snapshot(label: str, snap: FunctionSnapshot) -> None:
    print(f"  {label}: State={snap.state} LastUpdateStatus={snap.last_update_status}")
    print(f"    Handler={snap.handler} Runtime={snap.runtime} Memory={snap.memory_size} Timeout={snap.timeout}")
    print(f"    EnvKeys={sorted(snap.env_keys)}")
    print(f"    ReservedConcurrency={snap.reserved_concurrency}")
    print(f"    CodeSha256={snap.code_sha256}")


def _check_in_flight(cloudwatch, function_name: str) -> int:
    """Best-effort read-only signal: sum of ConcurrentExecutions samples over
    the last 5 minutes. Zero does not prove nothing is running (metric
    granularity), but a nonzero value is a real, actionable red flag."""
    now = datetime.now(timezone.utc)
    resp = cloudwatch.get_metric_statistics(
        Namespace="AWS/Lambda",
        MetricName="ConcurrentExecutions",
        Dimensions=[{"Name": "FunctionName", "Value": function_name}],
        StartTime=now - timedelta(minutes=5),
        EndTime=now,
        Period=60,
        Statistics=["Maximum"],
    )
    return int(max((point["Maximum"] for point in resp.get("Datapoints", [])), default=0))


def stage_v5_4(lambda_client, cloudwatch) -> tuple[FunctionSnapshot, FunctionSnapshot]:
    print("=== V5.4: read-only production pre-check ===")
    collector = _snapshot(lambda_client, COLLECTOR_FUNCTION)
    api = _snapshot(lambda_client, API_FUNCTION)
    _print_snapshot("collector (before)", collector)
    _print_snapshot("api (before)", api)

    problems: list[str] = []
    if collector.state != "Active":
        problems.append(f"collector State={collector.state!r}, expected Active")
    if collector.last_update_status != "Successful":
        problems.append(f"collector LastUpdateStatus={collector.last_update_status!r}, expected Successful")
    if collector.handler != COLLECTOR_BASELINE["Handler"]:
        problems.append(f"collector Handler={collector.handler!r}, expected {COLLECTOR_BASELINE['Handler']!r}")
    if collector.runtime != COLLECTOR_BASELINE["Runtime"]:
        problems.append(f"collector Runtime={collector.runtime!r}, expected {COLLECTOR_BASELINE['Runtime']!r}")
    if collector.memory_size != COLLECTOR_BASELINE["MemorySize"]:
        problems.append(f"collector MemorySize={collector.memory_size!r}, expected {COLLECTOR_BASELINE['MemorySize']!r}")
    if collector.timeout != COLLECTOR_BASELINE["Timeout"]:
        problems.append(f"collector Timeout={collector.timeout!r}, expected {COLLECTOR_BASELINE['Timeout']!r}")
    if collector.env_keys != COLLECTOR_ENV_KEYS:
        problems.append(f"collector env keys={sorted(collector.env_keys)}, expected {sorted(COLLECTOR_ENV_KEYS)}")

    if api.state != "Active":
        problems.append(f"api State={api.state!r}, expected Active")
    if api.last_update_status != "Successful":
        problems.append(f"api LastUpdateStatus={api.last_update_status!r}, expected Successful")
    if api.handler != API_BASELINE["Handler"]:
        problems.append(f"api Handler={api.handler!r}, expected {API_BASELINE['Handler']!r}")
    if api.runtime != API_BASELINE["Runtime"]:
        problems.append(f"api Runtime={api.runtime!r}, expected {API_BASELINE['Runtime']!r}")
    if api.memory_size != API_BASELINE["MemorySize"]:
        problems.append(f"api MemorySize={api.memory_size!r}, expected {API_BASELINE['MemorySize']!r}")
    if api.timeout != API_BASELINE["Timeout"]:
        problems.append(f"api Timeout={api.timeout!r}, expected {API_BASELINE['Timeout']!r}")
    if api.env_keys != API_ENV_KEYS:
        problems.append(f"api env keys={sorted(api.env_keys)}, expected {sorted(API_ENV_KEYS)}")
    if api.reserved_concurrency != API_RESERVED_CONCURRENCY:
        problems.append(f"api ReservedConcurrency={api.reserved_concurrency!r}, expected {API_RESERVED_CONCURRENCY!r}")

    collector_in_flight = _check_in_flight(cloudwatch, COLLECTOR_FUNCTION)
    print(f"  collector ConcurrentExecutions (last 5 min, max sample): {collector_in_flight}")
    if collector_in_flight > 0:
        problems.append(f"collector shows {collector_in_flight} concurrent execution(s) in the last 5 minutes")

    if problems:
        print("\nV5.4 PRE-CHECK FAILED:")
        for p in problems:
            print(f"  - {p}")
        raise PreCheckFailed("; ".join(problems))

    print("V5.4 PRE-CHECK: CLEAN\n")
    return collector, api


def stage_v5_5_upload(s3_client) -> str:
    print("=== V5.5: upload artifact to a new S3 key ===")
    local_bytes = LOCAL_ARTIFACT.read_bytes()
    local_sha256 = hashlib.sha256(local_bytes).hexdigest()
    if local_sha256 != EXPECTED_SHA256:
        raise PreCheckFailed(f"local artifact SHA256 {local_sha256} != expected {EXPECTED_SHA256}")
    if len(local_bytes) != EXPECTED_COMPRESSED_BYTES:
        raise PreCheckFailed(f"local artifact size {len(local_bytes)} != expected {EXPECTED_COMPRESSED_BYTES}")

    timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    sha_prefix = EXPECTED_SHA256[:8]
    key = f"collector-api/{timestamp}-{sha_prefix}.zip"

    existing = s3_client.list_objects_v2(Bucket=ARTIFACT_BUCKET, Prefix=key)
    if existing.get("KeyCount", 0) > 0:
        raise PreCheckFailed(f"S3 key {key!r} already exists -- refusing to overwrite")

    print(f"  Uploading to s3://{ARTIFACT_BUCKET}/{key} ...")
    s3_client.upload_file(str(LOCAL_ARTIFACT), ARTIFACT_BUCKET, key)

    head = s3_client.head_object(Bucket=ARTIFACT_BUCKET, Key=key)
    uploaded_size = head["ContentLength"]
    print(f"  Uploaded object size: {uploaded_size} (expected {EXPECTED_COMPRESSED_BYTES})")
    if uploaded_size != EXPECTED_COMPRESSED_BYTES:
        raise PreCheckFailed(f"uploaded object size {uploaded_size} != expected {EXPECTED_COMPRESSED_BYTES}")

    print("  Downloading uploaded object back to verify SHA256 round-trip...")
    downloaded = s3_client.get_object(Bucket=ARTIFACT_BUCKET, Key=key)["Body"].read()
    downloaded_sha256 = hashlib.sha256(downloaded).hexdigest()
    print(f"  Downloaded object SHA256: {downloaded_sha256}")
    if downloaded_sha256 != EXPECTED_SHA256:
        raise PreCheckFailed(f"downloaded object SHA256 {downloaded_sha256} != expected {EXPECTED_SHA256}")

    print("V5.5 UPLOAD: VERIFIED\n")
    return key


def _wait_for_healthy(lambda_client, function_name: str) -> FunctionSnapshot:
    deadline = time.monotonic() + WAIT_TIMEOUT_SECONDS
    while True:
        snap = _snapshot(lambda_client, function_name)
        print(f"  {function_name}: State={snap.state} LastUpdateStatus={snap.last_update_status}")
        if snap.state == "Active" and snap.last_update_status == "Successful":
            return snap
        if snap.last_update_status == "Failed":
            raise DeploymentFailed(f"{function_name} LastUpdateStatus=Failed")
        if time.monotonic() > deadline:
            raise DeploymentFailed(f"{function_name} did not reach Active/Successful within {WAIT_TIMEOUT_SECONDS}s")
        time.sleep(WAIT_POLL_SECONDS)


def stage_v5_5_deploy(lambda_client, s3_key: str) -> tuple[FunctionSnapshot, FunctionSnapshot]:
    print("=== V5.5: code-only deployment (collector first, then api) ===")
    print(f"  Deploying {COLLECTOR_FUNCTION} ...")
    lambda_client.update_function_code(FunctionName=COLLECTOR_FUNCTION, S3Bucket=ARTIFACT_BUCKET, S3Key=s3_key)
    collector_after = _wait_for_healthy(lambda_client, COLLECTOR_FUNCTION)
    print(f"  {COLLECTOR_FUNCTION}: HEALTHY (CodeSha256={collector_after.code_sha256})\n")

    print(f"  Deploying {API_FUNCTION} ...")
    lambda_client.update_function_code(FunctionName=API_FUNCTION, S3Bucket=ARTIFACT_BUCKET, S3Key=s3_key)
    api_after = _wait_for_healthy(lambda_client, API_FUNCTION)
    print(f"  {API_FUNCTION}: HEALTHY (CodeSha256={api_after.code_sha256})\n")

    return collector_after, api_after


def _download_and_verify_deployed_package(lambda_client, function_name: str, out_path: Path) -> dict:
    resp = lambda_client.get_function(FunctionName=function_name)
    url = resp["Code"]["Location"]
    urllib.request.urlretrieve(url, out_path)  # noqa: S310 -- AWS-issued presigned HTTPS URL, not user input
    data = out_path.read_bytes()
    sha256 = hashlib.sha256(data).hexdigest()

    with zipfile.ZipFile(out_path) as zf:
        creators = json.loads(zf.read("creators.json"))
        dynamodb_store_src = zf.read("stores/dynamodb_store.py").decode("utf-8")
        discovery_docs = [n for n in zf.namelist() if n.startswith("googleapiclient/discovery_cache/documents/")]

    known_incomplete_line = next(
        (line for line in dynamodb_store_src.splitlines() if line.startswith("KNOWN_INCOMPLETE_LEGACY_DATES")), None
    )
    vspo_entries = [c for c in creators if c.get("creatorId") == "vspo_official"]

    return {
        "function": function_name,
        "sha256": sha256,
        "sizeBytes": len(data),
        "creatorCount": len(creators),
        "vspoOfficialCount": len(vspo_entries),
        "vspoOfficialMatches": vspo_entries[0] == EXPECTED_VSPO_OFFICIAL if vspo_entries else False,
        "knownIncompleteLegacyDatesLine": known_incomplete_line,
        "discoveryDocCount": len(discovery_docs),
        "discoveryDocs": discovery_docs,
    }


def stage_v5_6(lambda_client, collector_before: FunctionSnapshot, api_before: FunctionSnapshot) -> dict:
    print("=== V5.6: read-only post-deploy verification ===")
    collector_after = _snapshot(lambda_client, COLLECTOR_FUNCTION)
    api_after = _snapshot(lambda_client, API_FUNCTION)
    _print_snapshot("collector (after)", collector_after)
    _print_snapshot("api (after)", api_after)

    anomalies: list[str] = []
    if collector_after.code_sha256 == collector_before.code_sha256:
        anomalies.append("collector CodeSha256 did not change")
    if api_after.code_sha256 == api_before.code_sha256:
        anomalies.append("api CodeSha256 did not change")
    if collector_after.code_sha256 != api_after.code_sha256:
        anomalies.append("collector and api CodeSha256 differ -- not the same artifact")
    if (collector_after.handler, collector_after.runtime, collector_after.memory_size, collector_after.timeout) != (
        COLLECTOR_BASELINE["Handler"], COLLECTOR_BASELINE["Runtime"], COLLECTOR_BASELINE["MemorySize"], COLLECTOR_BASELINE["Timeout"]
    ):
        anomalies.append("collector configuration changed unexpectedly")
    if collector_after.env_keys != COLLECTOR_ENV_KEYS:
        anomalies.append("collector env keys changed unexpectedly")
    if (api_after.handler, api_after.runtime, api_after.memory_size, api_after.timeout) != (
        API_BASELINE["Handler"], API_BASELINE["Runtime"], API_BASELINE["MemorySize"], API_BASELINE["Timeout"]
    ):
        anomalies.append("api configuration changed unexpectedly")
    if api_after.env_keys != API_ENV_KEYS:
        anomalies.append("api env keys changed unexpectedly")
    if api_after.reserved_concurrency != API_RESERVED_CONCURRENCY:
        anomalies.append("api reserved concurrency changed unexpectedly")

    print("\n  Downloading and independently verifying deployed packages...")
    collector_pkg = _download_and_verify_deployed_package(
        lambda_client, COLLECTOR_FUNCTION, Path("build/_deployed_collector.zip")
    )
    api_pkg = _download_and_verify_deployed_package(lambda_client, API_FUNCTION, Path("build/_deployed_api.zip"))
    for pkg in (collector_pkg, api_pkg):
        print(f"  {pkg['function']}: sha256={pkg['sha256']} size={pkg['sizeBytes']}")
        print(
            f"    creators={pkg['creatorCount']} vspoOfficialCount={pkg['vspoOfficialCount']} "
            f"vspoOfficialMatches={pkg['vspoOfficialMatches']}"
        )
        print(f"    {pkg['knownIncompleteLegacyDatesLine']}")
        print(f"    discoveryDocs={pkg['discoveryDocs']}")
        if pkg["sha256"] != EXPECTED_SHA256:
            anomalies.append(f"{pkg['function']} deployed package sha256 mismatch")
        if pkg["creatorCount"] != EXPECTED_CREATOR_COUNT:
            anomalies.append(f"{pkg['function']} deployed creator count != {EXPECTED_CREATOR_COUNT}")
        if pkg["vspoOfficialCount"] != 1 or not pkg["vspoOfficialMatches"]:
            anomalies.append(f"{pkg['function']} deployed vspo_official entry missing/mismatched")
        if pkg["discoveryDocCount"] != 1:
            anomalies.append(f"{pkg['function']} deployed discovery doc count != 1")

    return {
        "collector_after": collector_after,
        "api_after": api_after,
        "collector_pkg": collector_pkg,
        "api_pkg": api_pkg,
        "anomalies": anomalies,
    }


def main() -> int:
    lambda_client = boto3.client("lambda")
    cloudwatch = boto3.client("cloudwatch")
    s3_client = boto3.client("s3")

    if not LOCAL_ARTIFACT.exists():
        print(f"Local artifact not found: {LOCAL_ARTIFACT}")
        return 1

    try:
        collector_before, api_before = stage_v5_4(lambda_client, cloudwatch)
    except PreCheckFailed as exc:
        print(f"\nABORTED before any write: {exc}")
        return 1

    try:
        s3_key = stage_v5_5_upload(s3_client)
    except PreCheckFailed as exc:
        print(f"\nABORTED before Lambda deployment: {exc}")
        return 1

    try:
        collector_after, api_after = stage_v5_5_deploy(lambda_client, s3_key)
    except DeploymentFailed as exc:
        print(f"\nDEPLOYMENT FAILED: {exc}")
        return 1

    result = stage_v5_6(lambda_client, collector_before, api_before)

    print(f"\ns3Key: {s3_key}")
    print(f"collector CodeSha256: {collector_before.code_sha256} -> {collector_after.code_sha256}")
    print(f"api CodeSha256:       {api_before.code_sha256} -> {api_after.code_sha256}")

    if result["anomalies"]:
        print("\nANOMALIES:")
        for a in result["anomalies"]:
            print(f"  - {a}")
        print("\nOVERALL: FAIL")
        return 1

    print("\nOVERALL: PASS")
    return 0


if __name__ == "__main__":
    sys.exit(main())
