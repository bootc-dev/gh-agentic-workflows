"""Small string utilities."""

import re

_NON_ALNUM_RUN = re.compile(r"[^a-z0-9]+")


def slugify(text: str) -> str:
    """Convert ``text`` into a URL-friendly slug.

    The text is lowercased, runs of whitespace and punctuation are replaced
    with a single hyphen, and any leading or trailing hyphens are stripped.
    The result contains only lowercase alphanumeric characters and internal
    hyphens (no double hyphens).
    """
    return _NON_ALNUM_RUN.sub("-", text.lower()).strip("-")
