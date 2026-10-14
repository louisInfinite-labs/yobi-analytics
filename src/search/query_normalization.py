"""Backend-owned search query normalization -- the authoritative side of the title/topic comparison.

Uses the exact same convention tracking.video_topics.classify_video_topic already applies to video
titles (NFKC, then casefold), so a query and a title are always compared on equal footing. The
frontend performs its OWN lightweight normalization too (for its activation-threshold decision, see
frontend/dashboard/src/features/video-search/model/queryNormalization.ts), but this backend copy is
authoritative: it is never trusted to have already run correctly, and it is what every match decision
in this package actually uses.
"""

from __future__ import annotations

import unicodedata


def normalize_query(raw: str) -> str:
    """NFKC-normalize, trim, collapse internal whitespace, and casefold -- conservative normalization
    that never rewrites CJK text into a different form (NFKC only folds compatibility variants such as
    full-width/half-width, it does not transliterate)."""
    normalized = unicodedata.normalize("NFKC", raw).strip()
    normalized = " ".join(normalized.split())
    return normalized.casefold()
