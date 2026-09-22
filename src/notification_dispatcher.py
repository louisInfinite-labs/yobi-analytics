"""Flat-path compatibility shim: re-exports the canonical nested notification dispatcher handler for the live Lambda's old handler string during migration."""

from notifications.notification_dispatcher import lambda_handler

__all__ = ["lambda_handler"]
