"""Flat-path compatibility shim: re-exports the canonical nested API handler for the live Lambda's old handler string during migration."""

from api.api_handler import lambda_handler

__all__ = ["lambda_handler"]
