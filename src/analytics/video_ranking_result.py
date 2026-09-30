"""Build the daily per-creator video-ranking JSON RESULT payload (video-
ranking Phase C) from Phase B's pure calculation
(analytics.video_ranking.build_creator_video_catalog).

Purely a builder -- no S3, no boto3, no persistence dependency at all (see
stores.video_ranking_store for the S3-only writer this feeds). Mirrors
analytics.subscriber_ranking_result's own split from its calculation module.

Phase C storage correction: the persisted payload holds exactly one
canonical row per video (a "videos" list), never four separately ranked/
duplicated row sets (total/1d/7d/30d) -- metric selection, topic filtering,
and ranking all happen at READ time instead (analytics.video_ranking.
rank_video_rows, called from api.read_api.get_video_ranking).
"""

from __future__ import annotations

from datetime import date
from typing import Any

from analytics.video_ranking import GROWTH_METRICS, VideoRankingRow


def build_video_ranking_result(
    *, report_date: date, creator_id: str, generated_at: str, rows: list[VideoRankingRow]
) -> dict[str, Any] | None:
    """Build the one-object-per-creator-per-report-date result payload, or
    None when this creator has no eligible videos at all today -- mirrors
    build_subscriber_ranking_result's own "skip, don't persist an empty/
    misleading result" convention. The caller is expected to simply not call
    the S3 store's write_result in that case.
    """
    if not rows:
        return None

    return {
        "reportDate": report_date.isoformat(),
        "creatorId": creator_id,
        "generatedAt": generated_at,
        "videos": [_serialize_row(row) for row in rows],
    }


def _serialize_row(row: VideoRankingRow) -> dict[str, Any]:
    serialized: dict[str, Any] = {
        "videoId": row.video_id,
        "creatorId": row.creator_id,
        "topic": row.topic,
        "contentType": row.content_type,
        "liveStatus": row.live_status,
        "currentViewCount": row.current_view_count,
        "title": row.title,
        "thumbnailUrl": row.thumbnail_url,
        "publishedAt": row.published_at,
        "discoveredAt": row.discovered_at,
    }
    for period in GROWTH_METRICS:
        serialized[f"anchor{period}ViewCount"] = row.anchor_view_counts.get(period)
    return serialized
