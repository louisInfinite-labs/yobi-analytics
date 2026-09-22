"""Flat-path compatibility shim: re-exports the canonical nested history worker handler for the live Lambda's old handler string during migration."""

from api.history_worker_handler import lambda_handler

__all__ = ["lambda_handler"]
