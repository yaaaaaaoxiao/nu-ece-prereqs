"""Regression tests for the prerequisite parser, using real catalog sentences.

Run: python -m unittest discover scraper
"""

import unittest

from prereqs import is_plain, parse_requirements

CS111, CS211, CS213 = "COMP_SCI 111-0", "COMP_SCI 211-0", "COMP_SCI 213-0"


class ParseRequirements(unittest.TestCase):
    def check(self, text, prereq, **expected):
        got = parse_requirements(text)
        self.assertEqual(got["prereq"], prereq)
        for key, value in expected.items():
            self.assertEqual(got[key], value, key)

    def test_single(self):
        self.check("Prerequisite: COMP_ENG 203-0 .", "COMP_ENG 203-0")

    def test_or_with_recommended(self):
        self.check("Prerequisite: COMP_SCI 111-0 or GEN_ENG 205-1 ; COMP_ENG 203-0 recommended.",
                   {"or": [CS111, "GEN_ENG 205-1"]}, recommended=["COMP_ENG 203-0"])

    def test_semicolons_are_and(self):
        self.check("Prerequisites: ELEC_ENG 202-0 ; PHYSICS 135-3 ; MATH 228-2 .",
                   {"and": ["ELEC_ENG 202-0", "PHYSICS 135-3", "MATH 228-2"]})

    def test_comma_list_is_and(self):
        self.check("Prerequisites: COMP_ENG 203-0 , ELEC_ENG 225-0 .",
                   {"and": ["COMP_ENG 203-0", "ELEC_ENG 225-0"]})

    def test_comma_list_ending_in_or_is_or(self):
        self.check("Prerequisite: COMP_SCI 150-0 , COMP_SCI 211-0 , GEN_ENG 150-0 , or GEN_ENG 151-0 , "
                   "or consent of instructor.",
                   {"or": ["COMP_SCI 150-0", CS211, "GEN_ENG 150-0", "GEN_ENG 151-0"]},
                   notes=["or instructor consent"])

    def test_parenthesised_groups(self):
        self.check("Prerequisites: ( COMP_ENG 205-0 or COMP_SCI 213-0 ) AND ( COMP_ENG 303-0 or COMP_ENG 355-0 ).",
                   {"and": [{"or": ["COMP_ENG 205-0", CS213]}, {"or": ["COMP_ENG 303-0", "COMP_ENG 355-0"]}]})

    def test_and_group_or_alternative(self):
        self.check("Prerequisite: Students must have completed ( ELEC_ENG 225-0 and COMP_SCI 211-0 ), "
                   "or MECH_ENG 333-0 , or graduate standing, or instructor consent.",
                   {"or": [{"and": ["ELEC_ENG 225-0", CS211]}, "MECH_ENG 333-0"]},
                   notes=["or instructor consent", "or graduate standing"])

    def test_leading_condition_is_a_note(self):
        self.check("Prerequisite: CE or EE major only and COMP_SCI 211-0 and ( COMP_ENG 205-0 or COMP_SCI 213-0 ).",
                   {"and": [CS211, {"or": ["COMP_ENG 205-0", CS213]}]}, notes=["CE or EE majors only"])

    def test_nested(self):
        self.check("Prerequisites: ( COMP_SCI 213-0 and ( COMP_SCI 211-0 or COMP_SCI 230-0)) or permission of instructor.",
                   {"and": [CS213, {"or": [CS211, "COMP_SCI 230-0"]}]})

    def test_corequisite(self):
        self.check("Corequisite: MATH 228-2 or equivalent.", None, coreq="MATH 228-2", notes=["or equivalent"])

    def test_remarks_in_parentheses_ignored(self):
        # "(former)" used to end the parse after MATH 214-0.
        self.check("Prerequisite: MATH 218-3 or MATH 214-0 (former) or MATH 220-2 or MATH 224-0 (former).",
                   {"or": ["MATH 218-3", "MATH 214-0", "MATH 220-2", "MATH 224-0"]})

    def test_comma_lists_decided_between_semicolons(self):
        self.check("Prerequisites: COMP_SCI 110-0 , COMP_SCI 111-0 , or COMP_SCI 150-0 ; GEN_ENG 241-0 ; MATH 228-1",
                   {"and": [{"or": ["COMP_SCI 110-0", CS111, "COMP_SCI 150-0"]}, "GEN_ENG 241-0", "MATH 228-1"]})

    def test_no_courses(self):
        self.check("Prerequisite: senior standing.", None, notes=["senior standing"])


class Cleanup(unittest.TestCase):
    ALIASES = {"CS": "COMP_SCI", "CE": "COMP_ENG"}

    def test_short_codes(self):
        got = parse_requirements("Prerequisite: Students must have completed ((CS 214 or CS 208) & "
                                 "(CS 213 or CE 205)), or be CS MS or CS PhD.", self.ALIASES)
        self.assertEqual(got["prereq"], {"and": [{"or": ["COMP_SCI 214-0", "COMP_SCI 208-0"]},
                                                 {"or": [CS213, "COMP_ENG 205-0"]}]})

    def test_missing_suffix_and_case(self):
        got = parse_requirements("Prerequisites: COMP_SCI 150 or Comp_sci 208.", self.ALIASES)
        self.assertEqual(got["prereq"], {"or": ["COMP_SCI 150-0", "COMP_SCI 208-0"]})

    def test_words_are_not_codes(self):
        # "CE or EE major" must not turn into course codes.
        got = parse_requirements("Prerequisite: CE or EE major only and COMP_SCI 211-0 .", self.ALIASES)
        self.assertEqual(got["prereq"], CS211)

    def test_exclusion_sentences_ignored(self):
        got = parse_requirements("Prerequisite: COMP_SCI 150 or GEN_ENG 150 or GEN_ENG 151. Students cannot "
                                 "concurrently be enrolled in COMP_SCI 180-0 or COMP_SCI 208-0 .", self.ALIASES)
        self.assertEqual(got["prereq"], {"or": ["COMP_SCI 150-0", "GEN_ENG 150-0", "GEN_ENG 151-0"]})


class IsPlain(unittest.TestCase):
    """Other departments' prerequisites are only trusted when the sentence is plain."""

    def test_plain(self):
        self.assertTrue(is_plain(""))
        self.assertTrue(is_plain("Prerequisite: COMP_SCI 211-0 ."))
        self.assertTrue(is_plain("Prerequisite: MATH 228-1 or MATH 230-0 (former) or MATH 230-1 ."))
        self.assertTrue(is_plain("Prerequisites: ( COMP_SCI 208-0 or COMP_SCI 214-0) and ( COMP_SCI 213-0 or COMP_ENG 205-0 )."))
        self.assertTrue(is_plain("Prerequisite: COMP_SCI 213-0 ; COMP_SCI 340-0 recommended."))

    def test_not_plain(self):
        # Commas are ambiguous ("A or B, C" is usually "(A or B) and C").
        self.assertFalse(is_plain("Prerequisites: GEN_ENG 150 or GEN_ENG 151, MATH 220-2 ."))
        self.assertFalse(is_plain("Prerequisite: MECH_ENG 233-0 or ELEC_ENG 221-0 , or consent of instructor."))
        self.assertFalse(is_plain("Prerequisites: Students must have completed PHYSICS 135-3 and knowledge of Fourier concepts."))
        self.assertFalse(is_plain("Prerequisite: COMP_SCI 1CA or instructor permission."))
        self.assertFalse(is_plain("Enrollment by application."))


if __name__ == "__main__":
    unittest.main()
