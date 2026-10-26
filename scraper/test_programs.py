"""Tests for reading requirement lists from catalog major/minor pages.

Run: python -m unittest discover scraper
"""

import unittest

from programs import need_from, parse_program

PAGE = """
<div id="textcontainer">
  <p>Students must also complete the requirements of their home school.</p>
  <h2>Requirements</h2>
  <table><tbody>
    <tr class="areaheader"><td>Core Courses (2 units of computer science)</td></tr>
    <tr><td class="codecol">COMP_SCI 150-0</td><td>Fundamentals of Programming</td></tr>
    <tr><td class="codecol">COMP_SCI 180-0</td><td>Software Design</td></tr>
    <tr class="orclass"><td class="codecol orclass">or COMP_SCI 111-0</td><td>Fundamentals</td></tr>
    <tr class="areasubheader"><td>Statistics Foundations (choose one)</td></tr>
    <tr><td class="codecol">GEN_ENG 231-0</td><td>Probability (Formerly IEMS 202)</td></tr>
    <tr><td class="codecol">IEMS 201-0</td><td>Statistics</td></tr>
    <tr class="areaheader"><td>Life sciences (choose one)</td></tr>
    <tr><td class="codecol">BIOL_SCI 201-0</td><td>Molecular Biology</td></tr>
    <tr class="areaheader"><td>6 courses chosen from the tracks below 4</td></tr>
  </tbody></table>
  <h3>Upper-level Courses</h3>
  <p>Students must complete 2 upper-level courses.</p>
  <table><tbody>
    <tr><td class="codecol">MATH 310-1 &amp; MATH 310-2</td><td>Probability</td></tr>
    <tr><td class="codecol">MATH 320-1</td><td>Real Analysis</td></tr>
  </tbody></table>
  <dl class="sc_footnotes"><dd><p>Each course must be taken with its lab.</p></dd></dl>
</div>
"""


class NeedFrom(unittest.TestCase):
    def test_counts(self):
        self.assertEqual(need_from("11 required courses"), 11)
        self.assertEqual(need_from("4 courses chosen from the options below"), 4)
        self.assertEqual(need_from("1 design course from the options below"), 1)
        self.assertEqual(need_from("Statistics Foundations (choose one)"), 1)
        self.assertEqual(need_from("Elective Courses (2 units)"), 2)
        self.assertIsNone(need_from("Circuits and Electronics Track"))


class ParseProgram(unittest.TestCase):
    def setUp(self):
        self.lists, self.notes = parse_program(PAGE, {"Life sciences (choose one)": None})
        self.by_label = {l["label"]: l for l in self.lists}

    def test_alternatives_and_kinds(self):
        core = self.by_label["Core Courses (2 units of computer science)"]
        self.assertEqual(core["kind"], "required")
        self.assertEqual(core["need"], 2)
        self.assertEqual(core["items"], [[["COMP_SCI 150-0"]], [["COMP_SCI 180-0"], ["COMP_SCI 111-0"]]])

    def test_choose_one_and_codes_only_from_code_column(self):
        stats = self.by_label["Statistics Foundations (choose one)"]
        self.assertEqual(stats["need"], 1)
        # "Formerly IEMS 202" in the title column must not become a course.
        self.assertEqual(stats["items"], [[["GEN_ENG 231-0"]], [["IEMS 201-0"]]])

    def test_sequences_in_a_named_section(self):
        upper = self.by_label["Upper-level Courses"]
        self.assertEqual(upper["kind"], "track")
        self.assertIsNone(upper["need"])
        self.assertEqual(upper["items"], [[["MATH 310-1", "MATH 310-2"]], [["MATH 320-1"]]])

    def test_ignored_lists_and_notes(self):
        self.assertNotIn("Life sciences (choose one)", self.by_label)
        self.assertIn("Students must complete 2 upper-level courses.", self.notes)
        self.assertIn("6 courses chosen from the tracks below", self.notes)
        # Before the requirements start, and footnotes, aren't rules.
        self.assertFalse(any("home school" in n or "lab" in n for n in self.notes))


if __name__ == "__main__":
    unittest.main()
