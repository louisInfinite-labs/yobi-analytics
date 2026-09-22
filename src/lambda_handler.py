"""Flat-path compatibility shim: re-exports the canonical nested collector handler for the live Lambda's old handler string during migration."""

from api.lambda_handler import lambda_handler

__all__ = ["lambda_handler"]
