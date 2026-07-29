"""Unit tests for string_utils."""

import unittest

from string_utils import slugify, word_count


class WordCountTests(unittest.TestCase):
    def test_canonical_example(self):
        # The example from the issue: counts, case-folding, and punctuation
        # stripping all working together.
        result = word_count("The cat sat on the mat. The cat ran.")
        self.assertEqual(
            result,
            {"the": 3, "cat": 2, "sat": 1, "on": 1, "mat": 1, "ran": 1},
        )

    def test_empty_string(self):
        self.assertEqual(word_count(""), {})

    def test_punctuation_and_mixed_case(self):
        self.assertEqual(
            word_count("Hello, HELLO world!"),
            {"hello": 2, "world": 1},
        )

    def test_digits_are_counted_as_words(self):
        # _WORD_RE includes 0-9, so numeric tokens are counted too.
        self.assertEqual(
            word_count("abc 123 abc 123 123"),
            {"abc": 2, "123": 3},
        )


class SlugifyTests(unittest.TestCase):
    def test_basic(self):
        self.assertEqual(slugify("Hello, World!"), "hello-world")


if __name__ == "__main__":
    unittest.main()
