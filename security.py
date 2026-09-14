"""Standalone stdlib-only input-safety helpers for a tiny URL-shortener service.

No imports from sibling files; safe to use in isolation.
"""

from __future__ import annotations

import unicodedata
from urllib.parse import urlsplit, urlunsplit

_ALLOWED_SCHEMES = ("http", "https")


def _strip_control_characters(value: str) -> str:
    """Remove Unicode control/format characters (categories starting with 'C')."""
    return "".join(ch for ch in value if unicodedata.category(ch)[0] != "C")


def sanitize_url(url: str) -> str:
    """Validate and normalize a URL for safe storage/redirection.

    Rejects anything that is not a well-formed http(s) URL, and strips
    control characters (e.g. embedded newlines, NUL bytes) from the input
    before validation.

    Raises:
        ValueError: if `url` is not a string, is empty/whitespace, has no
            network location, or does not use an http(s) scheme.
    """
    if not isinstance(url, str):
        raise ValueError("url must be a string")

    cleaned = _strip_control_characters(url).strip()
    if not cleaned:
        raise ValueError("url must not be empty")

    parts = urlsplit(cleaned)

    scheme = parts.scheme.lower()
    if scheme not in _ALLOWED_SCHEMES:
        raise ValueError(f"unsupported URL scheme: {parts.scheme!r}")

    if not parts.netloc:
        raise ValueError("url must include a network location (host)")

    return urlunsplit((scheme, parts.netloc, parts.path, parts.query, parts.fragment))


def audit(candidates: list[str]) -> list[bool]:
    """Return a list of booleans indicating which candidate URLs are safe."""
    results = []
    for candidate in candidates:
        try:
            sanitize_url(candidate)
        except ValueError:
            results.append(False)
        else:
            results.append(True)
    return results
