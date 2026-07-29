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


def count_vowels_6895903(text: str) -> int:
    """Count the vowels (a, e, i, o, u) in ``text``.

    Matching is case-insensitive, so for example ``"Hello World"`` contains
    three vowels (``e``, ``o``, ``o``).
    """
    return sum(char in "aeiou" for char in text.lower())


def reverse_words_13710540(text: str) -> str:
    """Reverse the order of words in ``text`` while keeping each word intact.

    Words are split on whitespace and rejoined with a single space, so for
    example ``"the quick brown fox"`` becomes ``"fox brown quick the"``.
    """
    return " ".join(reversed(text.split()))
