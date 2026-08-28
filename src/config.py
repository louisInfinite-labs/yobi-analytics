"""Local environment configuration loading."""

from __future__ import annotations

import os

from dotenv import load_dotenv

load_dotenv()


class MissingAPIKeyError(RuntimeError):
    """Raised when YOUTUBE_API_KEY is not set."""


def get_api_key() -> str:
    api_key = os.getenv("YOUTUBE_API_KEY")
    if not api_key:
        raise MissingAPIKeyError(
            "YOUTUBE_API_KEY is not set. Copy .env.example to .env and add your key."
        )
    return api_key
