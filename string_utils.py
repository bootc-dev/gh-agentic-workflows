"""Small string utilities."""

import re

_SLUG_SEPARATOR_RE = re.compile(r"[^a-z0-9]+")


def slugify(text: str) -> str:
    """Convert ``text`` into a URL-friendly slug.

    The result is lowercase and contains only alphanumeric characters
    separated by single hyphens, with no leading or trailing hyphens.
    """
    return _SLUG_SEPARATOR_RE.sub("-", text.lower()).strip("-")
