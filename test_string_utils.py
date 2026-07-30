"""Unit tests for string_utils."""

import unittest

from string_utils import (
    slugify,
    word_count,
    reverse_words_13710540,
    count_vowels_6895903,
    count_vowels_21523607,
)


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


class ReverseWordsTests(unittest.TestCase):
    def test_canonical_example(self):
        self.assertEqual(
            reverse_words_13710540("the quick brown fox"),
            "fox brown quick the",
        )

    def test_empty_string(self):
        self.assertEqual(reverse_words_13710540(""), "")

    def test_single_word(self):
        self.assertEqual(reverse_words_13710540("hello"), "hello")

    def test_whitespace_is_collapsed(self):
        # Runs of whitespace collapse to single spaces and leading/trailing
        # whitespace is dropped, since bare str.split() discards empty tokens.
        self.assertEqual(reverse_words_13710540("  the   quick  "), "quick the")


class CountVowelsTests(unittest.TestCase):
    def test_canonical_example(self):
        # The example from the issue: "Hello World" has three vowels.
        self.assertEqual(count_vowels_6895903("Hello World"), 3)

    def test_empty_string(self):
        self.assertEqual(count_vowels_6895903(""), 0)

    def test_case_insensitive(self):
        # All five vowels in both cases are counted.
        self.assertEqual(count_vowels_6895903("AEIOUaeiou"), 10)

    def test_no_vowels(self):
        self.assertEqual(count_vowels_6895903("rhythm xyz!"), 0)


class CountVowels21523607Tests(unittest.TestCase):
    def test_canonical_example(self):
        # The example from the issue: "Hello World" has three vowels.
        self.assertEqual(count_vowels_21523607("Hello World"), 3)

    def test_empty_string(self):
        self.assertEqual(count_vowels_21523607(""), 0)

    def test_case_insensitive(self):
        # All five vowels in both cases are counted.
        self.assertEqual(count_vowels_21523607("AEIOUaeiou"), 10)

    def test_no_vowels(self):
        self.assertEqual(count_vowels_21523607("rhythm xyz!"), 0)


class SlugifyTests(unittest.TestCase):
    def test_basic(self):
        self.assertEqual(slugify("Hello, World!"), "hello-world")


if __name__ == "__main__":
    unittest.main()
