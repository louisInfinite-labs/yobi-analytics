"""R8C: one-time backfill of `title` onto existing tracking-manifest entries
from Video Master's own already-stored title -- no YouTube API calls.

Why this exists: video-ranking's metadata propagation (Phase C correction)
reads title/thumbnailUrl straight off each ManifestEntry, and every NEW
discovery already populates both going forward. But a manifest entry written
before this schema extension has `title=None`, even though Video Master
itself has always had a real title for that same video (title has been a
required Video Master field since Roadmap 1). Left alone, every pre-existing
video would show a null title in the ranking API/frontend indefinitely --
title is required for existing videos (thumbnail is not; see this script's
own docstring section below for why thumbnail is deliberately NOT backfilled
here).

SAFE BY DESIGN, unlike a full tracking_manifest.publish_tracking_manifest()
rebuild:

- publish_tracking_manifest's own write_shard is an UNCONDITIONAL S3 PutObject
  (no ETag/version check) -- see tracking_manifest.write_shard vs write_shard_
  if_version. Running it concurrently with collection.main's own incremental
  discovery patch (_patch_manifest_with_new_videos_if_configured, itself
  built on tracking_manifest.patch_shard's conditional write) can silently
  drop a just-discovered video from a shard: if the rebuild's own load_videos()
  snapshot was taken before that video's discovery landed in Video Master, but
  the rebuild's unconditional write for that same shard lands AFTER discovery's
  own conditional patch already added it, the rebuild simply overwrites it
  away. The video still exists in Video Master (so a later full rebuild would
  restore it), but is invisible to history_worker/collection until then --
  never an acceptable outcome for a one-time maintenance run's own side effect.
- This script never calls publish_tracking_manifest or write_shard at all. It
  patches ONLY the `title` field of entries that are missing one, via
  tracking_manifest.patch_shard -- the same bounded-retry, ETag-conditional
  read-modify-write loop discovery's own incremental patch already uses. Two
  writers built on patch_shard converge safely against each other (a losing
  writer's own patch is re-applied against the winner's already-persisted
  state, per patch_shard's own docstring); an unconditional rebuild racing
  a conditional patch does not.
- Every other field on a patched entry (creator_id, active, discovered_at,
  published_at, activity_state, topic, thumbnail_url) is carried over
  UNCHANGED from whatever the shard's own current state actually is at patch
  time -- never re-derived from Video Master, so this can never regress
  activity_state/topic to a stale Video Master snapshot the way an
  unconditional full rebuild reading a stale load_videos() list could.

THUMBNAIL POLICY (explicit product decision, not an oversight): existing
manifest entries are NOT backfilled with a thumbnail here. Video Master has
never stored a thumbnail for a pre-existing video (thumbnail_url did not
exist as a concept before this feature), so the only way to backfill one
would be a fresh YouTube videos.list call per old video -- a ~129k-video,
purely cosmetic API cost this project has decided is not worth paying.
thumbnailUrl staying null for an old video is a legitimate, permanent (not
"pending") state; the ranking API and frontend must treat it as "no image
available", not as an error or a sign collection is incomplete. New
discoveries continue to capture a real thumbnail going forward (tracking.
video_discovery/tracking.video_master), so this gap only ever shrinks.

Defaults to a dry run (report only, no writes). Pass --execute to write.
"""

from __future__ import annotations

import argparse
import os
import sys
from dataclasses import replace
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).parent.parent.parent / "src"))

from stores.dynamodb_store import load_videos  # noqa: E402
from stores.history_store import HISTORY_SHARD_COUNT  # noqa: E402
from tracking.tracking_manifest import ManifestEntry, S3TrackingManifestStore, patch_shard  # noqa: E402


def _patched_entry(entry: ManifestEntry, title_by_video_id: dict[str, str]) -> ManifestEntry:
    """Only ever sets `title` when the entry currently has none and Video
    Master has one -- never touches an entry that already has a title (even
    if it now differs from Video Master's, which is not this script's
    concern), and every other field is passed through via `replace` exactly
    as the shard's own current state already has it."""
    if entry.title is not None:
        return entry
    new_title = title_by_video_id.get(entry.video_id)
    if new_title is None:
        return entry
    return replace(entry, title=new_title)


def backfill_manifest_titles(*, execute: bool) -> dict[str, Any]:
    """Report (and, only with execute=True, patch) every manifest shard's own
    entries missing a title that Video Master already has one for.

    Reads (read_shard_for_patch -- never read_shard, which errors on a shard
    that hasn't been written yet) are always performed, dry run or not: a
    report with real counts requires seeing the manifest's actual current
    state, and read_shard_for_patch is a plain S3 GetObject, never a write.
    Only the `execute=True` branch calls patch_shard, and only for a shard
    that actually has at least one patchable entry -- a shard with nothing to
    patch is never written to at all, dry run or not.
    """
    bucket_name = os.environ.get("YOBI_HISTORY_BUCKET")
    if not bucket_name:
        raise RuntimeError("YOBI_HISTORY_BUCKET is not configured")
    store = S3TrackingManifestStore(bucket_name)
    title_by_video_id = {video.video_id: video.title for video in load_videos()}

    summary: dict[str, Any] = {
        "shardsInspected": 0,
        "entriesInspected": 0,
        "entriesMissingTitle": 0,
        "titlesAvailableInVideoMaster": 0,
        "entriesPatchable": 0,
        "entriesStillMissingTitle": 0,
        "shardsPatched": 0,
        "affectedShards": [],
    }

    for shard in range(HISTORY_SHARD_COUNT):
        entries, _version = store.read_shard_for_patch(shard)
        summary["shardsInspected"] += 1
        summary["entriesInspected"] += len(entries)

        missing_title = [entry for entry in entries if entry.title is None]
        summary["entriesMissingTitle"] += len(missing_title)

        patchable_ids = {
            entry.video_id for entry in missing_title if title_by_video_id.get(entry.video_id) is not None
        }
        summary["titlesAvailableInVideoMaster"] += len(patchable_ids)
        summary["entriesPatchable"] += len(patchable_ids)
        summary["entriesStillMissingTitle"] += len(missing_title) - len(patchable_ids)

        if not patchable_ids:
            continue
        summary["affectedShards"].append(shard)

        if execute:

            def _apply(current_entries: list[ManifestEntry], title_by_video_id=title_by_video_id) -> list[ManifestEntry]:
                return [_patched_entry(entry, title_by_video_id) for entry in current_entries]

            patch_shard(store, shard, _apply)
            summary["shardsPatched"] += 1

    return summary


def main(argv: list[str] | None = None) -> int:
    # allow_abbrev=False: the production write flag must be typed exactly; `--exe`/`--exec` must not enable writes.
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter, allow_abbrev=False
    )
    parser.add_argument(
        "--execute",
        action="store_true",
        help="Actually patch the tracking manifest. Without this flag, reports only (dry run).",
    )
    args = parser.parse_args(argv)

    mode = "EXECUTE (patching manifest shards)" if args.execute else "DRY RUN (no writes)"
    print(f"=== Manifest title backfill (R8C) -- {mode} ===\n")
    summary = backfill_manifest_titles(execute=args.execute)
    for key, value in summary.items():
        print(f"{key}: {value}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
