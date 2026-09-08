"""Redact opaque desktop handoff credentials from process HTTP access logs."""
import logging
import re

_TOKEN = re.compile(r"wt_[A-Za-z0-9_-]{43}")


class HandoffTokenFilter(logging.Filter):
    def filter(self, record):
        if isinstance(record.msg, str):
            record.msg = _TOKEN.sub("[handoff-redacted]", record.msg)
        if isinstance(record.args, tuple):
            record.args = tuple(_TOKEN.sub("[handoff-redacted]", arg) if isinstance(arg, str) else arg for arg in record.args)
        elif isinstance(record.args, dict):
            record.args = {key: _TOKEN.sub("[handoff-redacted]", value) if isinstance(value, str) else value for key, value in record.args.items()}
        return True


def install_access_log_redaction():
    logger = logging.getLogger("uvicorn.access")
    if not any(isinstance(item, HandoffTokenFilter) for item in logger.filters):
        logger.addFilter(HandoffTokenFilter())
