"""Flat-path compatibility shim: re-exports the canonical nested ranking reducer handler for the live Lambda's old handler string during migration."""

from analytics.ranking_reducer import lambda_handler

__all__ = ["lambda_handler"]
