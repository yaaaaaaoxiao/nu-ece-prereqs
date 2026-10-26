"""Tests for reading requirement lists from catalog major/minor pages.

Run: python -m unittest discover scraper
"""

import unittest

from programs import core_lists, merge_core, need_from, parse_program

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


DEGREE = """
<div id="textcontainer">
  <h2>Requirements (48 units)</h2>
  <h3>Core Courses (26 units) 1</h3>
  <table><tbody>
    <tr class="areaheader"><td>4 mathematics courses</td></tr>
    <tr class="areaheader"><td>4 units of basic science: 2</td></tr>
    <tr><td class="codecol">PHYSICS 135-2</td><td>General Physics</td></tr>
    <tr class="areaheader"><td>7 social sciences/humanities courses</td></tr>
  </tbody></table>
  <h3>Major Program (22 units)</h3>
  <table><tbody>
    <tr class="areaheader"><td>2 required courses</td></tr>
    <tr><td class="codecol">COMP_SCI 211-0</td><td>Programming</td></tr>
    <tr><td class="codecol">COMP_SCI 213-0</td><td>Systems</td></tr>
  </tbody></table>
  <h3>Project course list</h3>
  <table><tbody>
    <tr><td class="codecol">COMP_SCI 311-0</td><td>Inclusive Making</td></tr>
    <tr class="orclass"><td class="codecol">or COMP_SCI 412-0</td><td>Data Privacy</td></tr>
  </tbody></table>
  <h2>Concentrations</h2>
  <h3>Systems</h3>
  <table><tbody><tr><td class="codecol">COMP_SCI 322-0</td><td>Compilers</td></tr></tbody></table>
</div>
"""

SCHOOL = """
<div id="requirementstextcontainer">
  <h4>Core Courses (26 units)</h4>
  <h4>\u200bMathematics (4 units)</h4>
  <table><tbody>
    <tr><td class="codecol">MATH 220-1</td><td>Calculus</td></tr>
    <tr><td class="codecol">MATH 220-2</td><td>Calculus</td></tr>
  </tbody></table>
  <h4>Basic Sciences (4 units)</h4>
  <table><tbody><tr><td class="codecol">PHYSICS 135-1</td><td>General Physics</td></tr></tbody></table>
</div>
"""


class CoreRequirements(unittest.TestCase):
    def test_degree_core_areas_flatten_and_until(self):
        lists, notes = parse_program(DEGREE, {"Project course list": {"kind": "elective", "need": 2, "flatten": True}},
                                     until="Concentrations")
        by_label = {l["label"]: l for l in lists}
        science = by_label["Basic science"]
        self.assertEqual((science["kind"], science["items"]), ("core", [[["PHYSICS 135-2"]]]))
        self.assertNotIn("Mathematics", by_label)  # named but listed on the school page
        self.assertEqual(by_label["Project course list"]["items"], [[["COMP_SCI 311-0"]], [["COMP_SCI 412-0"]]])
        self.assertNotIn("Systems", by_label)  # after "Concentrations"
        self.assertFalse(any("social sciences" in n for n in notes))

    def test_school_core_fills_in_and_degree_wins(self):
        lists, _ = parse_program(DEGREE)
        core = core_lists(SCHOOL, {"Mathematics (4 units)": {"label": "Mathematics", "kind": "core"},
                                   "Basic Sciences (4 units)": {"label": "Basic science", "kind": "core"}},
                          "requirementstextcontainer")
        merged = merge_core(lists, core)
        self.assertEqual([l["label"] for l in merged][:3], ["Mathematics", "Basic science", "2 required courses"])
        self.assertEqual(merged[0]["items"], [[["MATH 220-1"]], [["MATH 220-2"]]])
        self.assertEqual(merged[1]["items"], [[["PHYSICS 135-2"]]])  # the degree page's own science


if __name__ == "__main__":
    unittest.main()
