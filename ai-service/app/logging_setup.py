"""Process-wide logging configuration with secret redaction.

``configure_logging()`` is the first thing ``app.main`` runs. It sets the root
level and format, silences httpx/httpcore request logging (httpx logs every
request URL at INFO) and installs ``RedactingFilter`` on every root handler so
a secret that slips into a log line is masked before it is written.

Rules for all code (not enforceable here, so stated once): never log request
headers, ``tool_token``, the whole ``meta_data``, the arguments of tools that
need confirmation, or HTTP/LLM bodies longer than 300 characters.
"""

from __future__ import annotations

import logging
import re
from typing import Iterable

from app.config import settings

LOG_FORMAT = "%(asctime)s %(levelname)-7s %(name)s  %(message)s"
MASK = "***"

_QUERY_SECRET_RE = re.compile(r"(?i)([?&]key=)[^&\s]+")
_BEARER_RE = re.compile(r"(?i)(bearer\s+)[A-Za-z0-9._\-]+")
_API_HEADER_RE = re.compile(r"""(?i)(x-goog-api-key["']?\s*[:=]\s*["']?)[^"'\s,}]+""")
_QUIET_LOGGERS = ("httpx", "httpcore")


def _secret_values() -> Iterable[str]:
    for value in (settings.GEMINI_API_KEY, settings.AI_SERVICE_TOKEN):
        if isinstance(value, str) and len(value.strip()) >= 4:
            yield value.strip()


def redact(text: str) -> str:
    """Mask configured secrets, key query parameters, bearer tokens and API-key headers."""
    if not text:
        return text
    out = text
    for secret in _secret_values():
        if secret in out:
            out = out.replace(secret, MASK)
    out = _QUERY_SECRET_RE.sub(lambda m: m.group(1) + MASK, out)
    out = _BEARER_RE.sub(lambda m: m.group(1) + MASK, out)
    out = _API_HEADER_RE.sub(lambda m: m.group(1) + MASK, out)
    return out


class RedactingFilter(logging.Filter):
    """Rewrites a record's message (and traceback text) with secrets masked."""

    _formatter = logging.Formatter()

    def filter(self, record: logging.LogRecord) -> bool:
        try:
            message = record.getMessage()
        except Exception:  # a broken %-format must never kill logging
            message = str(record.msg)
        redacted = redact(message)
        if redacted != message or record.args:
            record.msg = redacted
            record.args = None
        if record.exc_info and not record.exc_text:
            record.exc_text = self._formatter.formatException(record.exc_info)
        if record.exc_text:
            record.exc_text = redact(record.exc_text)
        if record.stack_info:
            record.stack_info = redact(record.stack_info)
        return True


def quiet_http_loggers() -> None:
    """httpx logs every request URL at INFO; keep it at WARNING."""
    for name in _QUIET_LOGGERS:
        logging.getLogger(name).setLevel(logging.WARNING)


def configure_logging() -> None:
    """Configure the root logger once; safe to call more than once."""
    logging.basicConfig(level=settings.LOG_LEVEL, format=LOG_FORMAT)
    logging.getLogger().setLevel(settings.LOG_LEVEL)
    quiet_http_loggers()
    for handler in logging.getLogger().handlers:
        if not any(isinstance(f, RedactingFilter) for f in handler.filters):
            handler.addFilter(RedactingFilter())
