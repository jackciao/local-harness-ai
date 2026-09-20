#!/usr/bin/env python3
"""Small regression check for launcher settings and timing parsing."""

import unittest

from qwen_local_gui import parse_context, parse_timing_line


class LauncherHelpersTest(unittest.TestCase):
    def test_context_and_timing(self):
        self.assertEqual(parse_context("32768"), 32768)
        with self.assertRaises(ValueError):
            parse_context("18434")
        self.assertEqual(
            parse_timing_line(
                "eval time = 3512.16 ms / 93 tokens (37.77 ms per token, 26.48 tokens per second)"
            ),
            [("generation", 93, 26.48)],
        )


if __name__ == "__main__":
    unittest.main()
