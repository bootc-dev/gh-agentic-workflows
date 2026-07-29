"""Small string utilities."""

import re

_SLUG_SEPARATOR_RE = re.compile(r"[^a-z0-9]+")
_WORD_RE = re.compile(r"[a-z0-9]+")


def slugify(text: str) -> str:
    """Convert ``text`` into a URL-friendly slug.

    The result is lowercase and contains only alphanumeric characters
    separated by single hyphens, with no leading or trailing hyphens.
    """
    return _SLUG_SEPARATOR_RE.sub("-", text.lower()).strip("-")


def word_count(text: str) -> dict:
    """Count how often each word appears in ``text``.

    Words are lowercased and stripped of surrounding punctuation, then split
    on whitespace. The result maps each word to the number of times it
    appears in the input string.
    """
    counts: dict = {}
    for word in _WORD_RE.findall(text.lower()):
        counts[word] = counts.get(word, 0) + 1
    return counts
